import fs from "node:fs";
import Database from "better-sqlite3";
import type Sqlite from "better-sqlite3";
import { AirevError } from "../shared/errors.js";
import {
  ABORT_AFTER_MS,
  type ClaimEmitted,
  type EditPost,
  type EditPre,
  type EventEnvelope,
  type Finding,
  type HunkCreated,
  type HunkLineageLinked,
  type LineageLinked,
  type OriginConfirmed,
} from "../shared/types.js";
import { readEvents } from "./events.js";
import type { Workspace } from "./paths.js";
import { dbPath } from "./paths.js";

export const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS edit_events (
  operation_id TEXT PRIMARY KEY, file TEXT, agent TEXT, session_ref TEXT,
  pre_blob_hash TEXT, result_blob_hash TEXT,
  status TEXT CHECK(status IN ('completed','failed','aborted','pending')),
  ts_pre TEXT, ts_post TEXT, transcript_line INTEGER);
CREATE INDEX IF NOT EXISTS idx_edit_file ON edit_events(file, ts_pre);
CREATE TABLE IF NOT EXISTS hunks (
  hunk_instance_id TEXT PRIMARY KEY, ingest_job_id TEXT, file TEXT,
  base_revision_ref TEXT, head_revision_ref TEXT,
  old_blob_hash TEXT, new_blob_hash TEXT,
  old_start INTEGER, old_lines INTEGER, new_start INTEGER, new_lines INTEGER,
  hunk_ordinal INTEGER, oversize INTEGER DEFAULT 0,
  edit_capture_status TEXT, lineage_status TEXT, context_status TEXT,
  method TEXT, confidence REAL);
CREATE TABLE IF NOT EXISTS hunk_lineage (predecessor_id TEXT, successor_id TEXT, similarity REAL,
  PRIMARY KEY(predecessor_id, successor_id));
CREATE TABLE IF NOT EXISTS lineage_links (hunk_instance_id TEXT, operation_id TEXT,
  PRIMARY KEY(hunk_instance_id, operation_id));
CREATE TABLE IF NOT EXISTS claims (claim_id TEXT PRIMARY KEY, hunk_ref TEXT, kind TEXT,
  value TEXT, confidence REAL, reason TEXT, run_id TEXT, evidence_json TEXT);
CREATE INDEX IF NOT EXISTS idx_claims_hunk ON claims(hunk_ref, kind);
CREATE TABLE IF NOT EXISTS origin_confirmed (hunk_ref TEXT, attribute TEXT, confirmed_value TEXT,
  actor_id TEXT, ts TEXT, PRIMARY KEY(hunk_ref, attribute));
CREATE TABLE IF NOT EXISTS findings (finding_id TEXT PRIMARY KEY, hunk_ref TEXT, lens TEXT,
  severity TEXT, outcome TEXT, verification_level TEXT, disposition TEXT,
  location_file TEXT, location_line INTEGER, rule_ref TEXT, reason TEXT, fix_hint TEXT,
  target_revision_ref TEXT, spec_digest TEXT, policy_digest TEXT, run_id TEXT, evidence_json TEXT);
CREATE TABLE IF NOT EXISTS ingest_runs (job_id TEXT PRIMARY KEY, base_revision_ref TEXT,
  head_revision_ref TEXT, input_digest TEXT, ts TEXT);
CREATE TABLE IF NOT EXISTS spec_index (req_id TEXT, file TEXT, section TEXT, heading TEXT,
  body_digest TEXT, tokens TEXT);
`;

export function openDb(ws: Workspace): Sqlite.Database {
  const db = new Database(dbPath(ws));
  db.pragma("journal_mode = WAL");
  try {
    db.exec(DDL);
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS spec_fts USING fts5(req_id, heading, body, file, section)");
  } catch (e) {
    db.close();
    throw new AirevError("corrupt", `projections.dbが破損しています。airev rebuild を実行してください: ${String(e)}`);
  }
  return db;
}

export function openDbChecked(ws: Workspace): Sqlite.Database {
  // 破損検出(E-02): integrity check
  try {
    const db = openDb(ws);
    db.pragma("quick_check");
    return db;
  } catch (e) {
    if (e instanceof AirevError) throw e;
    throw new AirevError("corrupt", `projections.dbが破損しています。airev rebuild を実行してください: ${String(e)}`);
  }
}

/** 単一イベントをprojectionへ適用(rebuildと増分適用の共通reducer) */
export function applyEvent(db: Sqlite.Database, env: EventEnvelope): void {
  switch (env.type) {
    case "edit_pre": {
      const p = env.payload as EditPre;
      db.prepare(
        `INSERT INTO edit_events(operation_id, file, agent, session_ref, pre_blob_hash, status, ts_pre, transcript_line)
         VALUES (?,?,?,?,?, 'pending', ?, ?)
         ON CONFLICT(operation_id) DO NOTHING`,
      ).run(p.operation_id, p.file, p.agent, p.session_ref, p.pre_blob_hash, env.ts, p.conversation_ref?.transcript_line ?? null);
      break;
    }
    case "edit_post": {
      const p = env.payload as EditPost;
      // 孤児post(preなし)はprojection行を作らない(v0.3)。再適用(既にcompleted)はno-op
      const row = db.prepare("SELECT status FROM edit_events WHERE operation_id=?").get(p.operation_id) as
        | { status: string }
        | undefined;
      if (!row) {
        db.prepare(
          `INSERT INTO meta(key,value) VALUES('orphan_posts','1')
           ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)`,
        ).run();
      } else if (row.status === "pending") {
        db.prepare(
          `UPDATE edit_events SET result_blob_hash=?, ts_post=?, status=CASE WHEN ?='success' THEN 'completed' ELSE 'failed' END
           WHERE operation_id=?`,
        ).run(p.result_blob_hash, env.ts, p.tool_status, p.operation_id);
      }
      break;
    }
    case "ingest_run": {
      const p = env.payload as { job_id: string; base_revision_ref: string; head_revision_ref: string; input_digest: string };
      db.prepare(
        `INSERT INTO ingest_runs(job_id, base_revision_ref, head_revision_ref, input_digest, ts) VALUES (?,?,?,?,?)
         ON CONFLICT(job_id) DO NOTHING`,
      ).run(p.job_id, p.base_revision_ref, p.head_revision_ref, p.input_digest, env.ts);
      break;
    }
    case "hunk_created": {
      const p = env.payload as HunkCreated;
      db.prepare(
        `INSERT INTO hunks(hunk_instance_id, ingest_job_id, file, base_revision_ref, head_revision_ref,
           old_blob_hash, new_blob_hash, old_start, old_lines, new_start, new_lines, hunk_ordinal, oversize)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(hunk_instance_id) DO NOTHING`,
      ).run(
        p.hunk_instance_id, p.ingest_job_id, p.file, p.base_revision_ref, p.head_revision_ref,
        p.old_blob_hash, p.new_blob_hash, p.old_start, p.old_lines, p.new_start, p.new_lines,
        p.hunk_ordinal, p.oversize ? 1 : 0,
      );
      break;
    }
    case "lineage_linked": {
      const p = env.payload as LineageLinked;
      if (p.edit_capture_status === "captured") {
        db.prepare(
          `UPDATE hunks SET edit_capture_status='captured', lineage_status=?, context_status=?, method=?, confidence=? WHERE hunk_instance_id=?`,
        ).run(p.lineage_status, p.context_status, p.method, p.confidence, p.hunk_instance_id);
        for (const op of p.edit_event_refs) {
          db.prepare(`INSERT INTO lineage_links(hunk_instance_id, operation_id) VALUES (?,?) ON CONFLICT DO NOTHING`).run(
            p.hunk_instance_id, op,
          );
        }
      } else {
        db.prepare(
          `UPDATE hunks SET edit_capture_status='uncaptured', lineage_status=NULL, context_status=NULL, method='none', confidence=NULL WHERE hunk_instance_id=?`,
        ).run(p.hunk_instance_id);
      }
      break;
    }
    case "hunk_lineage_linked": {
      const p = env.payload as HunkLineageLinked;
      db.prepare(`INSERT INTO hunk_lineage(predecessor_id, successor_id, similarity) VALUES (?,?,?) ON CONFLICT DO NOTHING`).run(
        p.predecessor_id, p.successor_id, p.similarity,
      );
      break;
    }
    case "claim_emitted": {
      const p = env.payload as ClaimEmitted;
      db.prepare(
        `INSERT INTO claims(claim_id, hunk_ref, kind, value, confidence, reason, run_id, evidence_json)
         VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(claim_id) DO NOTHING`,
      ).run(p.claim_id, p.hunk_ref, p.kind, p.value, p.confidence, p.reason, p.run_id, JSON.stringify(p.evidence_refs));
      break;
    }
    case "finding": {
      const p = env.payload as Finding;
      db.prepare(
        `INSERT INTO findings(finding_id, hunk_ref, lens, severity, outcome, verification_level, disposition,
           location_file, location_line, rule_ref, reason, fix_hint, target_revision_ref, spec_digest, policy_digest, run_id, evidence_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(finding_id) DO NOTHING`,
      ).run(
        p.finding_id, p.hunk_ref, p.lens, p.severity, p.outcome, p.verification_level, p.disposition,
        p.location?.file ?? null, p.location?.line ?? null, p.rule_ref, p.reason, p.fix_hint,
        p.target_revision_ref, p.spec_digest, p.policy_digest, p.run_id, JSON.stringify(p.evidence_refs),
      );
      break;
    }
    case "origin_confirmed": {
      const p = env.payload as OriginConfirmed;
      db.prepare(
        `INSERT INTO origin_confirmed(hunk_ref, attribute, confirmed_value, actor_id, ts) VALUES (?,?,?,?,?)
         ON CONFLICT(hunk_ref, attribute) DO UPDATE SET confirmed_value=excluded.confirmed_value, actor_id=excluded.actor_id, ts=excluded.ts`,
      ).run(p.hunk_ref, p.attribute, p.confirmed_value, p.actor_id, env.ts);
      break;
    }
    case "analysis_run":
    case "generation_started":
      break; // メタデータのみ(projection不要)
    default:
      break; // 未知イベントは無視(前方互換)
  }
}

/** post無しpreのaborted/pending導出(ingest時)。transcript終了 or 24h経過→aborted */
export function derivePendingStatuses(db: Sqlite.Database, now: Date, isSessionEnded: (sessionRef: string) => boolean): void {
  const rows = db.prepare(`SELECT operation_id, session_ref, ts_pre FROM edit_events WHERE status='pending'`).all() as {
    operation_id: string;
    session_ref: string;
    ts_pre: string;
  }[];
  for (const r of rows) {
    const age = now.getTime() - new Date(r.ts_pre).getTime();
    if (age >= ABORT_AFTER_MS || isSessionEnded(r.session_ref)) {
      db.prepare(`UPDATE edit_events SET status='aborted' WHERE operation_id=?`).run(r.operation_id);
    }
  }
}

export interface RebuildResult {
  applied: number;
  corruptLines: number;
  orphanPosts: number;
}

/** イベントストアからprojection全再構築(U-01)。LLM/diff/類似度の再計算なし */
export function rebuild(ws: Workspace): RebuildResult {
  if (fs.existsSync(dbPath(ws))) fs.rmSync(dbPath(ws));
  for (const suffix of ["-wal", "-shm"]) {
    const f = dbPath(ws) + suffix;
    if (fs.existsSync(f)) fs.rmSync(f);
  }
  const db = openDb(ws);
  const all: EventEnvelope[] = [];
  let corrupt = 0;
  for (const file of ["edits", "analysis", "decisions"] as const) {
    const r = readEvents(ws, file);
    all.push(...r.events);
    corrupt += r.corruptLines;
  }
  all.sort((a, b) => (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0)); // ULID時系列順
  const tx = db.transaction(() => {
    for (const env of all) applyEvent(db, env);
  });
  tx();
  const orphanRow = db.prepare("SELECT value FROM meta WHERE key='orphan_posts'").get() as { value: string } | undefined;
  const res = { applied: all.length, corruptLines: corrupt, orphanPosts: orphanRow ? Number(orphanRow.value) : 0 };
  db.close();
  return res;
}

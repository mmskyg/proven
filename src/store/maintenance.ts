import fs from "node:fs";
import path from "node:path";
import { AirevError } from "../shared/errors.js";
import { SCHEMA_VERSION, type EventEnvelope } from "../shared/types.js";
import { readEvents } from "./events.js";
import { deleteObject, getObject, hasObject, listObjects } from "./objects.js";
import { openDbChecked } from "./projections.js";
import { eventsDir, exportsDir, type Workspace } from "./paths.js";

/** purge(F-11): スナップショット本体・派生キャッシュのみ削除。イベントは削除しない */
export function runPurge(ws: Workspace, before: Date): { deleted: number; kept: number } {
  if (Number.isNaN(before.getTime())) throw new AirevError("input", "purge --before の日付が不正です");
  // hash→最終参照時刻(edit events)
  const lastRef = new Map<string, number>();
  const edits = readEvents(ws, "edits");
  for (const e of edits.events) {
    const t = new Date(e.ts).getTime();
    const p = e.payload as { pre_blob_hash?: string | null; result_blob_hash?: string | null };
    for (const h of [p.pre_blob_hash, p.result_blob_hash]) {
      if (h) lastRef.set(h, Math.max(lastRef.get(h) ?? 0, t));
    }
  }
  // 最新ingestのbase/head manifest(とその参照ファイル)は保護
  const protectedHashes = new Set<string>();
  const db = openDbChecked(ws);
  try {
    const latest = db
      .prepare("SELECT base_revision_ref, head_revision_ref FROM ingest_runs ORDER BY ts DESC, job_id DESC LIMIT 1")
      .get() as { base_revision_ref: string; head_revision_ref: string } | undefined;
    if (latest) {
      for (const ref of [latest.base_revision_ref, latest.head_revision_ref]) {
        if (ref.startsWith("worktree:")) {
          const mh = ref.slice("worktree:".length);
          protectedHashes.add(mh);
          try {
            const buf = getObject(ws, mh);
            if (buf) {
              const m = JSON.parse(buf.toString()) as { files: { content_sha256: string }[] };
              for (const f of m.files) protectedHashes.add(f.content_sha256);
            }
          } catch {
            /* ignore */
          }
        }
      }
    }
  } finally {
    db.close();
  }
  let deleted = 0;
  let kept = 0;
  const cutoff = before.getTime();
  for (const hash of listObjects(ws)) {
    if (protectedHashes.has(hash)) {
      kept++;
      continue;
    }
    const t = lastRef.get(hash);
    if (t !== undefined && t < cutoff) {
      deleteObject(ws, hash);
      deleted++;
    } else if (t === undefined && cutoff > Date.now() - 0) {
      kept++; // 参照不明は保守的に保持
    } else {
      kept++;
    }
  }
  // 派生キャッシュ
  const norm = path.join(exportsDir(ws), "hunk-norms.json");
  if (fs.existsSync(norm) && fs.statSync(norm).mtimeMs < cutoff) fs.rmSync(norm);
  return { deleted, kept };
}

// ---- provenance.jsonl export(3.2b) ----

export function exportProvenance(ws: Workspace): { path: string; records: number } {
  const db = openDbChecked(ws);
  try {
    const hunks = db
      .prepare(
        `SELECT hunk_instance_id, file, base_revision_ref, head_revision_ref, edit_capture_status,
                lineage_status, context_status, old_blob_hash, new_blob_hash
         FROM hunks ORDER BY hunk_instance_id ASC`,
      )
      .all() as {
      hunk_instance_id: string;
      file: string;
      base_revision_ref: string;
      head_revision_ref: string;
      edit_capture_status: string | null;
      lineage_status: string | null;
      context_status: string | null;
      old_blob_hash: string | null;
      new_blob_hash: string | null;
    }[];
    const linkStmt = db.prepare("SELECT operation_id FROM lineage_links WHERE hunk_instance_id=? ORDER BY operation_id");
    const claimStmt = db.prepare("SELECT kind, value, confidence, reason FROM claims WHERE hunk_ref=? ORDER BY kind, claim_id");
    const ocStmt = db.prepare("SELECT attribute, confirmed_value, actor_id FROM origin_confirmed WHERE hunk_ref=? ORDER BY attribute");
    const lines: string[] = [];
    for (const h of hunks) {
      const rec = {
        schema_version: SCHEMA_VERSION,
        hunk_instance_id: h.hunk_instance_id,
        file: h.file,
        base_revision_ref: h.base_revision_ref,
        head_revision_ref: h.head_revision_ref,
        edit_capture_status: h.edit_capture_status ?? "uncaptured",
        lineage_status: h.lineage_status,
        context_status: h.context_status,
        edit_event_refs: (linkStmt.all(h.hunk_instance_id) as { operation_id: string }[]).map((r) => r.operation_id),
        claims: (claimStmt.all(h.hunk_instance_id) as { kind: string; value: string; confidence: number; reason: string }[]).map(
          (c) => ({ kind: c.kind, value: c.value, confidence: c.confidence, reason: c.reason }),
        ),
        origin_confirmed: ocStmt.all(h.hunk_instance_id),
        snapshot_refs: [h.old_blob_hash, h.new_blob_hash]
          .filter((x): x is string => x !== null)
          .map((hash) => ({ hash, purged: !hasObject(ws, hash) })),
      };
      lines.push(JSON.stringify(rec));
    }
    const p = path.join(exportsDir(ws), "provenance.jsonl");
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, lines.join("\n") + (lines.length ? "\n" : ""));
    fs.renameSync(tmp, p); // atomic(中断時も旧export非破壊=S-09d)
    return { path: p, records: lines.length };
  } finally {
    db.close();
  }
}

// ---- migrate(E-48: 機構の骨格) ----

export interface MigrationDef {
  from: number;
  to: number;
  rename_fields?: Record<string, Record<string, string>>; // event_type → {old: new}
  fail?: boolean; // テスト用の失敗注入
}

export function runMigrate(ws: Workspace, def: MigrationDef): { migrated: number; noop: boolean } {
  const dir = eventsDir(ws);
  const backup = `${dir}.bak-migrate`;
  const files = ["edits.jsonl", "analysis.jsonl", "decisions.jsonl"].filter((f) => fs.existsSync(path.join(dir, f)));
  // 冪等: すべて既にto以上ならno-op
  let needs = false;
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
      if (!line) continue;
      try {
        const env = JSON.parse(line) as EventEnvelope;
        if (env.schema_version < def.to) needs = true;
      } catch {
        continue;
      }
    }
  }
  if (!needs) return { migrated: 0, noop: true };
  // バックアップ→変換→失敗時復元(非破壊)
  fs.cpSync(dir, backup, { recursive: true });
  let migrated = 0;
  try {
    for (const f of files) {
      const p = path.join(dir, f);
      const out: string[] = [];
      for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        if (!line) continue;
        const env = JSON.parse(line) as EventEnvelope & { payload: Record<string, unknown> };
        if (env.schema_version === def.from) {
          const renames = def.rename_fields?.[env.type];
          if (renames) {
            for (const [oldK, newK] of Object.entries(renames)) {
              if (oldK in env.payload) {
                env.payload[newK] = env.payload[oldK];
                delete env.payload[oldK];
              }
            }
          }
          env.schema_version = def.to;
          migrated++;
        }
        out.push(JSON.stringify(env));
      }
      if (def.fail) throw new Error("migration failure injected");
      fs.writeFileSync(p, out.join("\n") + (out.length ? "\n" : ""));
    }
  } catch (e) {
    // 復元(元ファイル非破壊)
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(backup, dir);
    throw new AirevError("corrupt", `migrate失敗(元ファイルへ復元しました): ${String(e)}`);
  }
  fs.rmSync(backup, { recursive: true, force: true });
  return { migrated, noop: false };
}

// ---- eval(受入計測) ----

export function pct(numer: number, denom: number): string {
  if (denom === 0) return "n=0(算出不能)";
  return `${(Math.round((numer / denom) * 1000) / 10).toFixed(1)}% (${numer}/${denom})`; // 小数1桁四捨五入+分母併記
}

export function evalCaptureState(ws: Workspace): { linked: number; uncaptured: number; broken: number; total: number; lines: string[] } {
  const db = openDbChecked(ws);
  try {
    const latest = db.prepare("SELECT job_id FROM ingest_runs ORDER BY ts DESC, job_id DESC LIMIT 1").get() as
      | { job_id: string }
      | undefined;
    if (!latest) throw new AirevError("empty", "ingestが未実行です");
    const rows = db
      .prepare("SELECT edit_capture_status, lineage_status FROM hunks WHERE ingest_job_id=?")
      .all(latest.job_id) as { edit_capture_status: string | null; lineage_status: string | null }[];
    const total = rows.length;
    const uncaptured = rows.filter((r) => r.edit_capture_status === "uncaptured").length;
    const broken = rows.filter((r) => r.lineage_status === "broken").length;
    const linked = rows.filter((r) => r.lineage_status === "linked").length;
    const lines = [
      `uncaptured率: ${pct(uncaptured, total)}`,
      `broken率: ${pct(broken, total)}`,
      `来歴不明率(uncaptured∪broken): ${pct(uncaptured + broken, total)}`,
      `linked率: ${pct(linked, total)}`,
    ];
    return { linked, uncaptured, broken, total, lines };
  } finally {
    db.close();
  }
}

/** eval lineage/claims: --answersファイル({id: true/false})による正誤集計(対話の非対話版) */
export function evalAccuracy(
  ws: Workspace,
  kind: "lineage" | "claims",
  sample: number,
  answers: Record<string, boolean>,
): { sampled: number; judged: number; correct: number; lines: string[] } {
  const db = openDbChecked(ws);
  try {
    const ids =
      kind === "lineage"
        ? (db.prepare("SELECT hunk_instance_id AS id FROM hunks ORDER BY hunk_instance_id").all() as { id: string }[])
        : (db.prepare("SELECT claim_id AS id FROM claims WHERE kind IN ('instructed','spec_support') ORDER BY claim_id").all() as {
            id: string;
          }[]);
    const population = ids.length;
    const n = Math.min(sample, population); // sample超過は全数に切詰め(S-08)
    const sampled = ids.slice(0, n).map((r) => r.id);
    let judged = 0;
    let correct = 0;
    for (const id of sampled) {
      if (id in answers) {
        judged++;
        if (answers[id]) correct++;
      }
    }
    return {
      sampled: n,
      judged,
      correct,
      lines: [`sample: ${n}/${population}`, `正解率: ${pct(correct, judged)}`],
    };
  } finally {
    db.close();
  }
}

export function evalTriageLog(ws: Workspace, entry?: { reached: boolean; note?: string }): { entries: number; reachedRate: string } {
  const p = path.join(exportsDir(ws), "triage-log.jsonl");
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  if (entry) {
    fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  }
  const rows = fs.existsSync(p)
    ? fs
        .readFileSync(p, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { reached: boolean })
    : [];
  const reached = rows.filter((r) => r.reached).length;
  return { entries: rows.length, reachedRate: pct(reached, rows.length) };
}

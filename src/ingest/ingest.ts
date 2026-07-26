import fs from "node:fs";
import path from "node:path";
import { ulid } from "ulid";
import { loadConfig } from "../shared/config.js";
import { AirevError } from "../shared/errors.js";
import { sha256 } from "../shared/hash.js";
import {
  type HunkCreated,
  type HunkLineageLinked,
  type IngestRun,
  type LineageLinked,
  JACCARD_THRESHOLD,
} from "../shared/types.js";
import { appendEvent, readEvents } from "../store/events.js";
import { getObject } from "../store/objects.js";
import { applyEvent, derivePendingStatuses, openDbChecked } from "../store/projections.js";
import type { Workspace } from "../store/paths.js";
import {
  gitNoIndexHunks,
  hunkInstanceId,
  hunkJaccard,
  isOversizeHunk,
  normalizedChangedLines,
  type RawHunk,
} from "./diff.js";
import { attributeHunk, computeFileLineage, isSessionEnded } from "./lineage.js";
import { buildWorktreeRevision, buildCommitRevision, fileContent, manifestMap, repoId, resolveRevision } from "./revision.js";
import { emitClaimsForHunk } from "../claims/heuristics.js";

export interface IngestSummary {
  jobId: string;
  baseRef: string;
  headRef: string;
  hunks: number;
  linked: number;
  uncaptured: number;
  broken: number;
  excludedFiles: number;
  skippedFiles: string[]; // binary/oversize等レビュー対象外
  orphanPosts: number;
  noop: boolean;
  claims: Record<string, number>;
  warnings: string[];
}

export function runIngest(ws: Workspace, opts: { range?: string } = {}): IngestSummary {
  const cfg = loadConfig(ws.airevDir);
  const db = openDbChecked(ws);
  const warnings: string[] = [];
  try {
    // hookが追記した未反映イベントをprojectionへ同期(applyEventは再適用安全)
    const editsRead = readEvents(ws, "edits");
    if (editsRead.corruptLines > 0)
      warnings.push(`edits.jsonlに破損行${editsRead.corruptLines}件(skip)。airev rebuild --verify を推奨`);
    const syncTx = db.transaction(() => {
      for (const env of editsRead.events) applyEvent(db, env);
    });
    syncTx();
    // 端点決定
    let baseRef: string;
    let headRef: string;
    let excludedCount = 0;
    if (opts.range) {
      const m = opts.range.split("..");
      if (m.length !== 2 || !m[0] || !m[1]) throw new AirevError("input", `--range はA..B形式で指定してください: ${opts.range}`);
      baseRef = buildCommitRevision(ws, m[0]).ref;
      headRef = buildCommitRevision(ws, m[1]).ref;
    } else {
      const last = db
        .prepare("SELECT head_revision_ref FROM ingest_runs ORDER BY ts DESC, job_id DESC LIMIT 1")
        .get() as { head_revision_ref: string } | undefined;
      const wt = buildWorktreeRevision(ws);
      excludedCount = wt.excludedCount;
      headRef = wt.rev.ref;
      baseRef = last ? last.head_revision_ref : commitHeadRefOrEmpty(ws) ?? headRef;
    }
    if (excludedCount > 0) warnings.push(`exclude対象${excludedCount}件は追跡外です`);

    // 冪等判定
    const inputDigest = sha256(`${baseRef}\n${headRef}`);
    const dup = db.prepare("SELECT job_id FROM ingest_runs WHERE input_digest=?").get(inputDigest) as
      | { job_id: string }
      | undefined;
    if (dup) {
      return emptySummary(dup.job_id, baseRef, headRef, true, warnings);
    }

    const base = resolveRevision(ws, baseRef);
    const head = resolveRevision(ws, headRef);
    const baseMap = manifestMap(base.manifest);
    const headMap = manifestMap(head.manifest);

    // 変更ファイル集合
    const paths = new Set<string>([...baseMap.keys(), ...headMap.keys()]);
    const changed: string[] = [];
    const skippedFiles: string[] = [];
    for (const p of [...paths].sort()) {
      const b = baseMap.get(p);
      const h = headMap.get(p);
      if (b?.content_sha256 === h?.content_sha256) continue;
      if ((b && b.binary) || (h && h.binary)) {
        skippedFiles.push(p); // レビュー対象外一覧
        continue;
      }
      changed.push(p);
    }
    if (changed.length === 0 && skippedFiles.length === 0) {
      throw new AirevError("empty", "対象なし(baseとheadに差分がありません)");
    }

    // pending→aborted導出(4.1)
    derivePendingStatuses(db, new Date(), isSessionEnded);

    const jobId = ulid();
    const runPayload: IngestRun = {
      job_id: jobId,
      base_revision_ref: baseRef,
      head_revision_ref: headRef,
      diff_algorithm: "myers",
      tool_version: "airev/0.1.0",
      input_digest: inputDigest,
    };
    applyAndAppend(ws, db, "analysis", "ingest_run", runPayload);

    const rid = repoId(ws);
    const counters = { linked: 0, uncaptured: 0, broken: 0 };
    const claimCounters: Record<string, number> = {};
    let hunkTotal = 0;

    // 後継判定用の正規化変更行ストア(派生キャッシュ)
    const normStore = loadNormStore(ws);

    for (const file of changed) {
      const bEntry = baseMap.get(file);
      const hEntry = headMap.get(file);
      const oldContent = bEntry ? fileContent(ws, bEntry) : null;
      const newContent = hEntry ? fileContent(ws, hEntry) : null;
      if ((bEntry && oldContent === null) || (hEntry && newContent === null)) {
        warnings.push(`${file}: スナップショット未保存(purge済み等)のためdiff不能。レビュー対象外`);
        skippedFiles.push(file);
        continue;
      }
      const hunks = gitNoIndexHunks(oldContent, newContent);
      if (hunks.length === 0) continue;

      // completed編集イベント(このファイル)
      const evRows = db
        .prepare(
          `SELECT operation_id, pre_blob_hash, result_blob_hash, session_ref, transcript_line
           FROM edit_events WHERE file=? AND status='completed' ORDER BY ts_pre ASC, operation_id ASC`,
        )
        .all(file) as {
        operation_id: string;
        pre_blob_hash: string | null;
        result_blob_hash: string | null;
        session_ref: string;
        transcript_line: number | null;
      }[];
      const events: { operationId: string; pre: string; post: string; sessionRef: string; transcriptLine: number | null }[] = [];
      for (const r of evRows) {
        const pre = r.pre_blob_hash ? getObject(ws, r.pre_blob_hash)?.toString("utf8") ?? null : "";
        const post = r.result_blob_hash ? getObject(ws, r.result_blob_hash)?.toString("utf8") ?? null : "";
        if (pre === null || post === null) continue; // スナップショット欠落は連鎖対象外
        events.push({ operationId: r.operation_id, pre, post, sessionRef: r.session_ref, transcriptLine: r.transcript_line });
      }
      const lineage = computeFileLineage(oldContent ?? "", newContent ?? "", events);

      let ordinal = 0;
      for (const hunk of hunks) {
        ordinal++;
        hunkTotal++;
        const hid = hunkInstanceId({
          repoId: rid,
          baseRef,
          headRef,
          filePath: file,
          hunk,
          ordinal,
          oldBlobHash: bEntry?.content_sha256 ?? null,
          newBlobHash: hEntry?.content_sha256 ?? null,
        });
        const created: HunkCreated = {
          hunk_instance_id: hid,
          ingest_job_id: jobId,
          file,
          base_revision_ref: baseRef,
          head_revision_ref: headRef,
          old_blob_hash: bEntry?.content_sha256 ?? null,
          new_blob_hash: hEntry?.content_sha256 ?? null,
          old_start: hunk.oldStart,
          old_lines: hunk.oldLines,
          new_start: hunk.newStart,
          new_lines: hunk.newLines,
          hunk_ordinal: ordinal,
          oversize: isOversizeHunk(hunk),
        };
        applyAndAppend(ws, db, "analysis", "hunk_created", created);

        // 後継判定(Jaccard≥0.6)
        const norm = normalizedChangedLines(hunk);
        let best: { id: string; sim: number } | null = null;
        for (const [pid, pnorm] of Object.entries(normStore)) {
          if (pid === hid || pnorm.file !== file) continue;
          const sim = hunkJaccard(pnorm.norm, norm);
          if (sim >= JACCARD_THRESHOLD && (!best || sim > best.sim)) best = { id: pid, sim };
        }
        if (best) {
          const link: HunkLineageLinked = { predecessor_id: best.id, successor_id: hid, similarity: round2(best.sim) };
          applyAndAppend(ws, db, "analysis", "hunk_lineage_linked", link);
        }
        normStore[hid] = { file, norm };

        // 帰属
        const attr = attributeHunk(lineage, hunk);
        const transcriptBroken =
          attr.refs.length > 0 &&
          events
            .filter((e) => attr.refs.includes(e.operationId))
            .some((e) => e.transcriptLine === null || !e.sessionRef || !fs.existsSync(e.sessionRef));
        let linkEvent: LineageLinked;
        if (attr.status === "uncaptured") {
          counters.uncaptured++;
          linkEvent = {
            hunk_instance_id: hid,
            edit_capture_status: "uncaptured",
            edit_event_refs: [],
            method: "none",
            confidence: null,
          };
        } else {
          if (attr.status === "linked") counters.linked++;
          else counters.broken++;
          linkEvent = {
            hunk_instance_id: hid,
            edit_capture_status: "captured",
            lineage_status: attr.status,
            context_status: transcriptBroken ? "transcript_broken" : "ok",
            edit_event_refs: attr.refs,
            method: "blob-chain",
            confidence: attr.confidence ?? 0.4,
          };
        }
        applyAndAppend(ws, db, "analysis", "lineage_linked", linkEvent);

        // claim付与(ヒューリスティック・LLM OFF)
        const emitted = emitClaimsForHunk(ws, db, {
          hunkId: hid,
          file,
          hunk,
          attribution: attr,
          events,
          gapCause: attr.gapCause,
        });
        for (const k of emitted) claimCounters[k] = (claimCounters[k] ?? 0) + 1;
      }
    }
    saveNormStore(ws, normStore);
    const orphanRow = db.prepare("SELECT value FROM meta WHERE key='orphan_posts'").get() as { value: string } | undefined;
    return {
      jobId,
      baseRef,
      headRef,
      hunks: hunkTotal,
      linked: counters.linked,
      uncaptured: counters.uncaptured,
      broken: counters.broken,
      excludedFiles: excludedCount,
      skippedFiles,
      orphanPosts: orphanRow ? Number(orphanRow.value) : 0,
      noop: false,
      claims: claimCounters,
      warnings,
    };
  } finally {
    db.close();
  }
}

function commitHeadRefOrEmpty(ws: Workspace): string | null {
  try {
    return buildCommitRevision(ws, "HEAD").ref;
  } catch {
    return null;
  }
}

function emptySummary(jobId: string, baseRef: string, headRef: string, noop: boolean, warnings: string[]): IngestSummary {
  return {
    jobId,
    baseRef,
    headRef,
    hunks: 0,
    linked: 0,
    uncaptured: 0,
    broken: 0,
    excludedFiles: 0,
    skippedFiles: [],
    orphanPosts: 0,
    noop,
    claims: {},
    warnings,
  };
}

function applyAndAppend(ws: Workspace, db: ReturnType<typeof openDbChecked>, file: "analysis", type: string, payload: unknown): void {
  const env = appendEvent(ws, file, type, payload);
  applyEvent(db, env);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// 後継判定用の正規化変更行ストア(派生キャッシュ。purge対象)
function normStorePath(ws: Workspace): string {
  return path.join(ws.airevDir, "exports", "hunk-norms.json");
}
function loadNormStore(ws: Workspace): Record<string, { file: string; norm: string }> {
  const p = normStorePath(ws);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}
function saveNormStore(ws: Workspace, store: Record<string, { file: string; norm: string }>): void {
  const p = normStorePath(ws);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, p);
}

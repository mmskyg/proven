import fs from "node:fs";
import type Sqlite from "better-sqlite3";
import { ulid } from "ulid";
import { sha256 } from "../shared/hash.js";
import {
  HEURISTIC_CONF_MAX,
  INDETERMINATE,
  type ClaimEmitted,
  type EvidenceRef,
} from "../shared/types.js";
import { appendEvent } from "../store/events.js";
import { applyEvent } from "../store/projections.js";
import type { Workspace } from "../store/paths.js";
import { searchSpec, tokenize } from "../spec/index.js";
import type { RawHunk } from "../ingest/diff.js";
import type { HunkAttribution } from "../ingest/lineage.js";

/**
 * ヒューリスティックclaim付与(詳細設計書4.4・LLM OFF既定)。
 * claim根拠規則(v0.3): value≠判定不能→evidence非空+confidence必須 / 判定不能→reason必須。
 */

interface ClaimInput {
  hunkId: string;
  file: string;
  hunk: RawHunk;
  attribution: HunkAttribution;
  events: { operationId: string; sessionRef: string; transcriptLine: number | null }[];
  gapCause: { whitespaceOnly: boolean } | null;
}

interface UserUtterance {
  text: string;
  line: number;
  path: string;
}

/** transcript(JSONL)からtranscript_line以前の直近user発話を最大3件取得 */
export function recentUserUtterances(sessionRef: string, beforeLine: number | null, max = 3): UserUtterance[] {
  if (!sessionRef || !fs.existsSync(sessionRef)) return [];
  const lines = fs.readFileSync(sessionRef, "utf8").split("\n");
  const out: UserUtterance[] = [];
  const limit = beforeLine === null ? lines.length : Math.min(beforeLine, lines.length);
  for (let i = limit - 1; i >= 0 && out.length < max; i--) {
    const line = lines[i];
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      const role = obj?.message?.role ?? obj?.role ?? obj?.type;
      if (role === "user") {
        const content = obj?.message?.content ?? obj?.content ?? "";
        const text =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content.map((c: { text?: string }) => c?.text ?? "").join(" ")
              : "";
        if (text.trim()) out.push({ text, line: i + 1, path: sessionRef });
      }
    } catch {
      continue;
    }
  }
  return out;
}

function hunkIdentifiers(file: string, hunk: RawHunk): string[] {
  const base = file.split("/").pop() ?? file;
  const stem = base.replace(/\.[^.]+$/, "");
  const ids = new Set<string>([base.toLowerCase(), stem.toLowerCase()]);
  for (const l of [...hunk.addedLines, ...hunk.removedLines]) for (const t of tokenize(l)) ids.add(t);
  return [...ids];
}

function matchRate(utterance: string, identifiers: string[]): { rate: number; hit: string[] } {
  const utTokens = new Set(tokenize(utterance));
  const utLower = utterance.toLowerCase();
  const hit = identifiers.filter((id) => utTokens.has(id) || (id.length >= 4 && utLower.includes(id)));
  const denom = Math.min(identifiers.length, 20) || 1;
  return { rate: Math.min(1, hit.length / Math.min(denom, 6)), hit };
}

function emit(ws: Workspace, db: Sqlite.Database, runId: string, c: Omit<ClaimEmitted, "claim_id" | "run_id">): void {
  const payload: ClaimEmitted = { claim_id: ulid(), run_id: runId, ...c };
  const env = appendEvent(ws, "analysis", "claim_emitted", payload);
  applyEvent(db, env);
}

/** 1 hunk分のclaimを算出しイベント化。戻り値=付与したkindのリスト(集計用) */
export function emitClaimsForHunk(ws: Workspace, db: Sqlite.Database, input: ClaimInput): string[] {
  const runId = ulid();
  const emittedKinds: string[] = [];
  const identifiers = hunkIdentifiers(input.file, input.hunk);

  // --- instructed ---
  let instructedValue = INDETERMINATE;
  let instructedConf = 0;
  let instructedReason = "";
  let instructedEvidence: EvidenceRef[] = [];
  const linkedEvents = input.events.filter((e) =>
    input.attribution.refs.length ? input.attribution.refs.includes(e.operationId) : false,
  );
  if (input.attribution.status === "uncaptured") {
    instructedReason = "編集イベントが捕捉されていないため会話と照合できない";
  } else if (linkedEvents.length === 0) {
    instructedReason = "帰属イベントに会話文脈参照がない";
  } else {
    const ev = linkedEvents[0];
    if (ev.transcriptLine === null || !fs.existsSync(ev.sessionRef)) {
      instructedReason = "transcriptが読めない(context_status=transcript_broken)";
    } else {
      const utterances = recentUserUtterances(ev.sessionRef, ev.transcriptLine, 3);
      if (utterances.length === 0) {
        instructedReason = "直近のuser発話が見つからない";
      } else {
        let best: { u: UserUtterance; rate: number; hit: string[] } | null = null;
        for (const u of utterances) {
          const m = matchRate(u.text, identifiers);
          if (!best || m.rate > best.rate) best = { u, rate: m.rate, hit: m.hit };
        }
        if (best && best.rate >= 0.3) {
          instructedValue = "あり";
          instructedConf = Math.min(HEURISTIC_CONF_MAX, 0.3 + best.rate * 0.2);
          instructedReason = `直近user発話に対象語(${best.hit.slice(0, 3).join(", ")})が含まれる`;
          instructedEvidence = [
            { type: "transcript", path: best.u.path, line: best.u.line, quote_digest: sha256(best.u.text) },
          ];
        } else {
          // v0.3境界: 3発話すべて検索して一致ゼロ→「なし」(conf 0.3)
          instructedValue = "なし";
          instructedConf = 0.3;
          instructedReason = "直近3発話に対象語の一致なし";
          instructedEvidence = utterances.map((u) => ({
            type: "transcript" as const,
            path: u.path,
            line: u.line,
            quote_digest: sha256(u.text),
          }));
        }
      }
    }
  }
  emit(ws, db, runId, {
    hunk_ref: input.hunkId,
    kind: "instructed",
    value: instructedValue,
    confidence: instructedValue === INDETERMINATE ? 0 : instructedConf,
    reason: instructedReason,
    evidence_refs: instructedValue === INDETERMINATE ? [] : instructedEvidence,
  });
  emittedKinds.push("instructed");

  // --- spec_support ---
  const hit = searchSpec(ws, identifiers);
  let specValue = INDETERMINATE;
  let specConf = 0;
  let specReason = "";
  let specEvidence: EvidenceRef[] = [];
  const specCount = (db.prepare("SELECT COUNT(*) AS c FROM spec_index").get() as { c: number }).c;
  if (specCount === 0) {
    specReason = "照合先の仕様書が未登録";
  } else if (hit && hit.req_id) {
    specValue = "支持";
    specConf = HEURISTIC_CONF_MAX;
    specReason = `仕様${hit.req_id}(${hit.heading})に関連語が一致`;
    specEvidence = [{ type: "spec", file: hit.file, req_id: hit.req_id, section: hit.section }];
  } else {
    // ヒットなし/req_idなし段落トップ → 判定不能(「記載なし」と断定しない=v0.3)
    specReason = hit ? "req_id付き仕様段落へのヒットなし" : "仕様検索にヒットなし";
  }
  emit(ws, db, runId, {
    hunk_ref: input.hunkId,
    kind: "spec_support",
    value: specValue,
    confidence: specValue === INDETERMINATE ? 0 : specConf,
    reason: specReason,
    evidence_refs: specValue === INDETERMINATE ? [] : specEvidence,
  });
  emittedKinds.push("spec_support");

  // --- necessity ---
  const incidental = isIncidentalHunk(input.hunk);
  let necValue: string;
  let necConf: number;
  let necReason: string;
  let necEvidence: EvidenceRef[] = [];
  if (instructedValue === "あり" || specValue === "支持") {
    necValue = "essential";
    necConf = Math.min(HEURISTIC_CONF_MAX, Math.max(instructedConf, specConf));
    necReason = instructedValue === "あり" ? "明示指示ありのため" : "仕様支持ありのため";
    necEvidence = instructedValue === "あり" ? instructedEvidence : specEvidence;
  } else if (incidental) {
    necValue = "incidental";
    necConf = 0.4;
    necReason = "import入替・整形のみの変更";
    necEvidence = linkedEvents.length
      ? [{ type: "edit_event", operation_id: linkedEvents[0].operationId }]
      : input.events.length
        ? [{ type: "edit_event", operation_id: input.events[0].operationId }]
        : [];
    if (necEvidence.length === 0) {
      necValue = INDETERMINATE;
      necConf = 0;
      necReason = "整形のみだが根拠イベントがない";
    }
  } else if (instructedValue === "なし") {
    necValue = "unsolicited候補";
    necConf = 0.4;
    necReason = `明示指示なし+仕様支持${specValue === INDETERMINATE ? "判定不能" : "なし"}(判定不能由来の低confidence推定)`;
    necEvidence = instructedEvidence.length
      ? instructedEvidence
      : linkedEvents.map((e) => ({ type: "edit_event" as const, operation_id: e.operationId }));
    if (necEvidence.length === 0) {
      necValue = INDETERMINATE;
      necConf = 0;
      necReason = "unsolicited推定の根拠となる会話・イベントがない";
    }
  } else {
    necValue = INDETERMINATE;
    necConf = 0;
    necReason = "指示・仕様のいずれも判定できない";
  }
  emit(ws, db, runId, {
    hunk_ref: input.hunkId,
    kind: "necessity",
    value: necValue,
    confidence: necValue === INDETERMINATE ? 0 : necConf,
    reason: necReason,
    evidence_refs: necValue === INDETERMINATE ? [] : necEvidence,
  });
  emittedKinds.push(`necessity:${necValue}`);

  // --- nolineage_cause(uncaptured/brokenのみ・原因はclaim) ---
  if (input.attribution.status !== "linked" && input.gapCause) {
    const cause = input.gapCause.whitespaceOnly ? "formatter" : "manual-edit";
    emit(ws, db, runId, {
      hunk_ref: input.hunkId,
      kind: "nolineage_cause",
      value: cause,
      confidence: input.gapCause.whitespaceOnly ? 0.5 : 0.4,
      reason: input.gapCause.whitespaceOnly ? "断絶区間のdiffが空白・整形のみ" : "断絶区間に内容変更がある",
      evidence_refs: input.events.length
        ? [{ type: "edit_event", operation_id: input.events[0].operationId }]
        : [{ type: "spec", file: input.file, req_id: null, section: "gap" }],
    });
    emittedKinds.push(`nolineage_cause:${cause}`);
  }
  return emittedKinds;
}

export function isIncidentalHunk(h: RawHunk): boolean {
  const strip = (s: string) => s.trim();
  const removed = h.removedLines.map(strip).filter((l) => l !== "");
  const added = h.addedLines.map(strip).filter((l) => l !== "");
  if (removed.length === 0 && added.length === 0) return true; // 空白のみ
  const isImport = (l: string) => /^(import\s|from\s+\S+\s+import|const\s+\w+\s*=\s*require\()/.test(l);
  if (removed.every(isImport) && added.every(isImport)) return true; // import入替
  // 整形のみ(非空白文字列が集合として一致)
  const squash = (ls: string[]) => ls.map((l) => l.replace(/\s+/g, "")).sort().join("\n");
  return squash(removed) === squash(added) && removed.length > 0;
}

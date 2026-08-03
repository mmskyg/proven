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
import { lookupReq, searchSpec, specParagraph, tokenize } from "../spec/index.js";
import { adapterById, claudeCodeAdapter } from "../agents/index.js";
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
  events: { operationId: string; sessionRef: string; transcriptLine: number | null; agent?: string }[];
  gapCause: { whitespaceOnly: boolean } | null;
}

interface UserUtterance {
  text: string;
  line: number;
  path: string;
}

/**
 * 仕様書がそのコードより後に書かれたか(REQ-824/826)。
 *
 * 捕捉済みの編集イベントの時刻だけで判定する(観測第一)。
 * - true  … 仕様書の最初の編集が、この変更を作った編集より後 = 事後の追記
 * - false … 仕様書の方が先にある = 事前の根拠として使える
 * - null  … どちらかの編集が捕捉されていない。断定しない
 *
 * 比較対象は **この変更を作った編集(refSupport=author)** に限る(REQ-826)。
 * 位置が重なるだけの編集(touched)まで含めると、READMEのように何度も触るファイルでは
 * 「そのファイルを最初に触った時刻」まで遡ってしまい、後から書いた行なのに
 * 仕様書より前と判定される。実測でこの誤判定が3件出た。
 *
 * 仕様書側は段落単位ではなくファイル単位の近似(段落の作成時刻を保持していないため)。
 * 以前から存在する仕様書に今回追記した場合は「先にあった」と扱う(緩い側に倒す)。
 */
function specWrittenAfterCode(
  db: Sqlite.Database,
  specFile: string,
  attribution: HunkAttribution,
): boolean | null {
  // author が取れないとき(refSupport未算出・touchedのみ)は断定しない。
  // 「この変更を作った編集」が特定できていない以上、前後関係も言えない
  const authorOps = (attribution.refSupport ?? [])
    .filter((r) => r.support === "author")
    .map((r) => r.operation_id);
  if (authorOps.length === 0) return null;
  const holes = authorOps.map(() => "?").join(",");
  const code = db
    .prepare(
      `SELECT MIN(ts_pre) AS first FROM edit_events
       WHERE operation_id IN (${holes}) AND status='completed' AND ts_pre IS NOT NULL`,
    )
    .get(...authorOps) as { first: string | null } | undefined;
  const spec = db
    .prepare(
      "SELECT MIN(ts_pre) AS first FROM edit_events WHERE file=? AND status='completed' AND ts_pre IS NOT NULL",
    )
    .get(specFile) as { first: string | null } | undefined;
  if (!code?.first || !spec?.first) return null;
  return spec.first > code.first;
}

/**
 * transcriptからtranscript_line以前の直近user発話を最大3件取得。
 * 形式はハーネスごとに違う(Claude CodeはJSONL / codexはrollout)ため、
 * アダプタのreadUtterancesへ委譲する。未対応ハーネスは空配列(=判定不能へ倒す)。
 */
export function recentUserUtterances(
  sessionRef: string,
  beforeLine: number | null,
  max = 3,
  agent = "claude-code",
): UserUtterance[] {
  const adapter = adapterById(agent) ?? claudeCodeAdapter;
  if (!adapter.readUtterances) return [];
  return adapter.readUtterances(sessionRef, beforeLine, max);
}

/**
 * 対象一致に数えない汎用語(REQ-703)。
 * `user` `message` のような語はどの発話にも出るため、これで一致しても
 * 「その変更を指示した」証拠にならない(実測で誤断定の原因になっていた)。
 */
/** 探索する編集前user発話の上限(REQ-702)。到達しても否定の証拠にはしない */
const UTTERANCE_SCAN_MAX = 200;

const GENERIC_TOKENS = new Set([
  "user", "message", "type", "types", "data", "value", "values", "name", "names", "file", "files",
  "path", "paths", "text", "string", "number", "boolean", "object", "array", "list", "item", "items",
  "test", "tests", "code", "line", "lines", "result", "results", "error", "errors", "status", "input",
  "output", "config", "option", "options", "key", "keys", "id", "ids", "index", "count", "size",
  "return", "const", "let", "var", "function", "class", "import", "export", "async", "await", "null",
  "true", "false", "this", "new", "case", "default", "public", "private", "static", "interface",
  "実装", "変更", "修正", "追加", "対応", "確認", "作成", "処理", "使用", "実行", "設定", "問題",
]);

export interface HunkTargets {
  /** ファイル名・パス(basename と拡張子なし stem) */
  fileNames: string[];
  /** 変更行に含まれる固有識別子(汎用語を除く) */
  symbols: string[];
  /** 変更行が明示参照しているREQ-ID(コメント等)。最も強い紐づけ根拠(REQ-709) */
  reqRefs: string[];
}

/**
 * 断定に使える「特徴的な」対象語か(REQ-709)。
 * 実測で、日本語2-gramの断片(「方が」「の組」「る場」)や短い英単語が
 * 無関係な発話と一致して誤断定を生んでいた。断定にはこの条件を課す。
 */
export function isDistinctiveTarget(t: string): boolean {
  if (GENERIC_TOKENS.has(t)) return false;
  return isCjkToken(t) ? t.length >= 4 : t.length >= 6;
}

/** hunkの「変更対象」を取り出す(REQ-703)。汎用語は対象一致に数えない */
export function hunkTargets(file: string, hunk: RawHunk): HunkTargets {
  const base = file.split("/").pop() ?? file;
  const stem = base.replace(/\.[^.]+$/, "");
  const symbols = new Set<string>();
  const reqRefs = new Set<string>();
  for (const l of [...hunk.addedLines, ...hunk.removedLines]) {
    for (const m of l.match(/REQ-\d+/g) ?? []) reqRefs.add(m);
    for (const t of tokenize(l)) {
      // 日本語は2-gramで切られるため、ASCII識別子と同じ長さ閾値にすると全部落ちる
      if (!isCjkToken(t) && t.length < 4) continue;
      if (GENERIC_TOKENS.has(t)) continue;
      if (t === stem.toLowerCase() || t === base.toLowerCase()) continue;
      symbols.add(t);
    }
    // 日本語は2-gramでは断片すぎるため、連続する日本語列そのものも対象語に持つ
    for (const run of l.match(/[぀-ヿ一-鿿]{4,}/g) ?? []) symbols.add(run.toLowerCase());
  }
  return { fileNames: [base.toLowerCase(), stem.toLowerCase()], symbols: [...symbols], reqRefs: [...reqRefs] };
}

/** 後方互換: 従来の識別子一覧(仕様検索の候補抽出に使う) */
function hunkIdentifiers(file: string, hunk: RawHunk): string[] {
  const t = hunkTargets(file, hunk);
  return [...t.fileNames, ...t.symbols];
}

/** 日本語(2-gramで切られる)トークンか */
function isCjkToken(t: string): boolean {
  return /[぀-ヿ一-鿿]/.test(t);
}

function containsToken(utterance: string, token: string): boolean {
  const utTokens = new Set(tokenize(utterance));
  if (utTokens.has(token)) return true;
  const minLen = isCjkToken(token) ? 2 : 4;
  return token.length >= minLen && utterance.toLowerCase().includes(token);
}

/**
 * 発話がこのhunkを指示していると言えるか(REQ-703)。
 * 「変更対象(固有識別子)」と「要求された操作」の双方が同一発話に現れることを要求する。
 * ファイル名だけの一致では断定しない(同名ファイルが複数ありうるため)。
 */
export function instructionMatch(
  utterance: string,
  targets: HunkTargets,
): { matched: boolean; hitSymbols: string[]; hitFiles: string[] } {
  // REQ-709: 断定に使うのは特徴的な対象語のみ(短い語・日本語2-gram断片は除外)
  const hitSymbols = targets.symbols.filter((s) => isDistinctiveTarget(s) && containsToken(utterance, s));
  const hitFiles = targets.fileNames.filter((f) => f && containsToken(utterance, f));
  const targetIdentified = hitSymbols.length >= 2 || (hitFiles.length > 0 && hitSymbols.length >= 1);
  return { matched: targetIdentified, hitSymbols, hitFiles };
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
  /**
   * 断定(claim)とは別に持つ観測(REQ-701)。
   * 「探索範囲内に明示指示を検出できなかった」は事実の否定ではないが、
   * レビュー優先度の材料としては有効なので、claim値と分けて保持する。
   */
  let instructedObservation: "found" | "no_match_in_scope" | "not_searchable" = "not_searchable";
  const linkedEvents = input.events.filter((e) =>
    input.attribution.refs.length ? input.attribution.refs.includes(e.operationId) : false,
  );
  if (input.attribution.status === "uncaptured") {
    instructedReason = "編集イベントが捕捉されていないため会話と照合できない";
  } else if (input.attribution.status === "candidate") {
    // 帰属が候補どまりの段階で会話と照合すると、推定の上に推定を重ねることになる(REQ-411)
    instructedReason = "帰属が候補どまり(連鎖断絶)のため、会話との照合は行わない";
  } else if (linkedEvents.length === 0) {
    instructedReason = "帰属イベントに会話文脈参照がない";
  } else {
    const ev = linkedEvents[0];
    if (ev.transcriptLine === null || !fs.existsSync(ev.sessionRef)) {
      instructedReason = "transcriptが読めない(context_status=transcript_broken)";
    } else {
      // REQ-702: 探索範囲は「編集より前の同一セッションの全user発話」。
      // 直近N件に限ると、少し前にある指示を見落として誤った断定につながる
      const utterances = recentUserUtterances(ev.sessionRef, ev.transcriptLine, UTTERANCE_SCAN_MAX, ev.agent);
      if (utterances.length === 0) {
        instructedReason = "編集より前のuser発話が見つからない";
      } else {
        const targets = hunkTargets(input.file, input.hunk);
        let best: { u: UserUtterance; hit: string[] } | null = null;
        for (const u of utterances) {
          const m = instructionMatch(u.text, targets);
          if (m.matched) {
            const hit = [...m.hitSymbols, ...m.hitFiles];
            if (!best || hit.length > best.hit.length) best = { u, hit };
          }
        }
        if (best) {
          // REQ-703: 変更対象が発話中で特定できている場合のみ断定する
          instructedValue = "あり";
          instructedConf = Math.min(HEURISTIC_CONF_MAX, 0.3 + Math.min(best.hit.length, 3) * 0.05);
          instructedReason = `user発話で変更対象が特定されている(${best.hit.slice(0, 3).join(", ")})`;
          instructedEvidence = [
            { type: "transcript", path: best.u.path, line: best.u.line, quote_digest: sha256(best.u.text) },
          ];
          instructedObservation = "found";
        } else {
          // REQ-701: 「探して見つからなかった」を「指示されていない」と断定しない。
          // 探索範囲の完全性・言い換え・同意表現の解決を保証できないため判定不能とする。
          // ただし「探したが検出できなかった」という観測はレビュー優先度の材料として残す
          instructedReason = `探索範囲内に明示指示を検出できず(探索: 同一セッションの編集前user発話${utterances.length}件)`;
          instructedObservation = "no_match_in_scope";
          instructedEvidence = utterances.slice(0, 3).map((u) => ({
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
  // REQ-710: 変更行がREQ-IDを明示参照しているなら、その要求だけを見る。
  // FTSの類似検索は別の要求を拾いうるため、明示参照があるときは検索結果を使わない
  //
  // REQ-824: 支持と判定する前に、その仕様書がコードより後に書かれていないかを見る。
  // 後から書いた仕様は「この変更は仕様に沿っている」の根拠にならない。
  // (実測: 実装を終えてから仕様書を追加しただけで unsolicited候補 が11件→0件になった。
  //  順序を見ないと、後付けで自分のやったことを何でも正当化できてしまう)
  const specTargets = hunkTargets(input.file, input.hunk);
  const explicitReq = specTargets.reqRefs.map((r) => lookupReq(ws, r)).find((r) => r !== null) ?? null;
  const hit = explicitReq ?? searchSpec(ws, identifiers);
  let specValue = INDETERMINATE;
  let specConf = 0;
  let specReason = "";
  let specEvidence: EvidenceRef[] = [];
  const specCount = (db.prepare("SELECT COUNT(*) AS c FROM spec_index").get() as { c: number }).c;
  if (specCount === 0) {
    specReason = "照合先の仕様書が未登録";
  } else if (hit && hit.req_id) {
    // REQ-704: FTSヒットは候補抽出まで。段落本文にhunkの対象が現れない一致は「支持」にしない。
    // 「既存テストが通ること」のような一般的要求に技術名が含まれるだけで紐づくのを防ぐ
    const paragraph = specParagraph(ws, hit.section) ?? "";
    const targets = specTargets;
    // REQ-709/710: 最も強い根拠は、変更行がそのREQ-IDを明示参照していること
    const explicitRef = targets.reqRefs.includes(hit.req_id);
    // 明示参照があるのに別のREQが候補に挙がった場合は断定しない(取り違えの防止・REQ-710)
    const refMismatch = !explicitRef && targets.reqRefs.length > 0;
    const bodyHits = explicitRef
      ? [hit.req_id]
      : [...targets.symbols, ...targets.fileNames].filter(
          (t) => t && isDistinctiveTarget(t) && paragraph.toLowerCase().includes(t),
        );
    if (refMismatch) {
      specReason = `変更行は${targets.reqRefs.slice(0, 2).join(", ")}を参照しているが、候補仕様(${hit.req_id})と一致しない`;
    } else if (bodyHits.length > 0) {
      const base = explicitRef
        ? `変更行が仕様${hit.req_id}(${hit.heading})を明示参照`
        : `仕様${hit.req_id}(${hit.heading})の本文が変更対象(${bodyHits.slice(0, 3).join(", ")})に言及`;
      const posthoc = specWrittenAfterCode(db, hit.file, input.attribution);
      specEvidence = [{ type: "spec", file: hit.file, req_id: hit.req_id, section: hit.section }];
      specConf = HEURISTIC_CONF_MAX;
      if (posthoc === true) {
        // 支持にはしない。necessity も essential にならないので unsolicited候補 のまま残る
        specValue = "事後";
        specReason = `${base}。ただし ${hit.file} はこの変更より後に書かれており、事前の根拠にならない`;
      } else if (posthoc === null) {
        specValue = "支持";
        specReason = `${base}(仕様書の作成時期は未観測)`;
      } else {
        specValue = "支持";
        specReason = base;
      }
    } else {
      specReason = `候補仕様${hit.req_id}は見つかったが、本文に変更対象への言及がない(関連語一致のみ)`;
    }
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
  } else if (instructedObservation === "no_match_in_scope") {
    // 「指示がなかった」の断定ではなく、「探索範囲内に見つからなかった」という観測に基づく
    // レビュー優先度シグナル(REQ-701)。confidenceは断定より低く置く
    necValue = "unsolicited候補";
    necConf = 0.3;
    // 事後の仕様書は「なし」で片付けず、そう判定した理由まで出す。
    // 利用者から見ると仕様書は存在するので、黙って「支持なし」だと理由が分からない(REQ-824)
    const specPhrase =
      specValue === "事後"
        ? "仕様書はあるがコードより後に書かれており事前の根拠にならない"
        : `仕様支持${specValue === INDETERMINATE ? "判定不能" : "なし"}`;
    necReason = `探索範囲内に明示指示を検出できず+${specPhrase}(観測に基づく優先度シグナルであり、指示がなかったことの断定ではない)`;
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

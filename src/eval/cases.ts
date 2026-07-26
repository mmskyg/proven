import { ProvenError } from "../shared/errors.js";
import { SCHEMA_VERSION } from "../shared/types.js";
import { openDbChecked } from "../store/projections.js";
import { getObject } from "../store/objects.js";
import type { Workspace } from "../store/paths.js";
import { fileContent, manifestMap, resolveRevision } from "../ingest/revision.js";
import { gitNoIndexHunks } from "../ingest/diff.js";
import fs from "node:fs";

/**
 * 受入計測ケースの生成(AIエージェントが判定を代行できる形式)。
 * 判定に必要な証拠をすべて同梱し、判定基準(rubric)も添える。
 * 出力を読んだAI(またはヒト)が verdict を返せば --submit で取り込める。
 */

export type EvalKind = "lineage" | "claims";

export interface EvalCase {
  case_id: string; // 判定対象の識別子(hunk_instance_id または claim_id)
  kind: EvalKind;
  question: string; // このケースで判定してほしいこと
  subject: Record<string, unknown>; // 判定対象(ツールの主張)
  evidence: Record<string, unknown>; // 判定に使う証拠(diff・発話・仕様など)
  allowed_verdicts: string[];
}

export interface EvalCasePack {
  schema_version: number;
  kind: EvalKind;
  generated_from: { base_revision_ref: string; head_revision_ref: string };
  population: number;
  sampled: number;
  rubric: string[]; // 判定基準(AIが迷わないように明文化)
  output_contract: Record<string, unknown>; // 返してほしいJSONの形
  cases: EvalCase[];
}

const LINEAGE_RUBRIC = [
  "この変更(hunk)を実際に作った編集イベントを、ツールが正しく特定できているかを判定してください。",
  "correct = 帰属が事実と一致(linkedなら挙がっているイベントがこの変更を作った / uncapturedならhook外の変更である)。",
  "incorrect = 事実と食い違う(別の編集に帰属している、捕捉済みなのにuncapturedとされている、など)。",
  "unsure = 証拠が足りず判断できない。推測でcorrect/incorrectを付けないでください。",
  "判定は提示された証拠のみに基づいてください。証拠にない事実を仮定しないこと。",
  // REQ-304: 帰属判定は会話ではなくblobチェーンで行っているため、機械的証拠を主とする
  "主たる証拠は attribution_basis です。これは編集前後の内容ハッシュ(blobチェーン)と、そのイベント自身が作った差分です。",
  // REQ-308: overlapは「同じ文字列の変更行が含まれる」までしか意味しない。帰属の十分条件ではない
  "attribution_basis.overlap は『そのイベントの差分に、hunkと同じ文字列の変更行が含まれる』ことのみを意味します。",
  "overlap は帰属の十分条件ではありません。頻出行(`}` や `return null;` 等)の偶然一致、formatterによる削除・再追加、" +
    "一度作られた行が消えて別の主体が同じ文字列を再追加したケースがあり得ます。位置・重複・後続変更を併せて判断してください。",
  "会話引用(transcript_quotes)は補助証拠です。引用が無いこと自体はunsureの理由になりません(帰属判定は会話に依存しません)。",
  "other_events_on_same_file は対照証拠です。非帰属イベントの方がhunkをよく説明できる場合はincorrectを検討してください。",
];

const CLAIMS_RUBRIC = [
  "ツールが付けたclaim(由来の推定)の根拠が、その主張を支持しているかを判定してください。",
  "correct = 提示された根拠がclaimの値を妥当に支持している(引用が実際に該当し、結論が飛躍していない)。",
  "incorrect = 根拠が主張を支持していない(引用が無関係、結論が飛躍、値が明らかに誤り)。",
  "unsure = 根拠が不足していて妥当性を判断できない。",
  "値が『判定不能』のclaimは、そう判定したこと自体が妥当か(本当に判断材料がないか)を見てください。",
];

const OUTPUT_CONTRACT = {
  format: "JSON",
  shape: {
    judgments: [{ case_id: "string", verdict: "correct | incorrect | unsure", reason: "string(短く根拠を書く)" }],
  },
  note: "cases配列と同じcase_idで返してください。判定できないものはunsureにし、省略しないでください。",
};

interface HunkRow {
  hunk_instance_id: string;
  file: string;
  new_start: number;
  new_lines: number;
  old_start: number;
  old_lines: number;
  base_revision_ref: string;
  head_revision_ref: string;
  edit_capture_status: string | null;
  lineage_status: string | null;
  context_status: string | null;
  confidence: number | null;
}

/** transcriptから指定行付近の発話を引用(証拠用) */
function quoteAround(sessionRef: string, line: number | null, maxBack = 3): { role: string; line: number; text: string }[] {
  if (!sessionRef || !fs.existsSync(sessionRef) || line === null) return [];
  const lines = fs.readFileSync(sessionRef, "utf8").split("\n");
  const out: { role: string; line: number; text: string }[] = [];
  for (let i = Math.min(line, lines.length) - 1; i >= 0 && out.length < maxBack; i--) {
    if (!lines[i]) continue;
    try {
      const o = JSON.parse(lines[i]);
      const role = o?.message?.role ?? o?.role;
      if (role !== "user" && role !== "assistant") continue;
      const c = o?.message?.content ?? o?.content ?? "";
      const text =
        typeof c === "string" ? c : Array.isArray(c) ? c.map((x: { text?: string }) => x?.text ?? "").join(" ") : "";
      if (text.trim()) out.push({ role, line: i + 1, text: text.slice(0, 400) });
    } catch {
      continue;
    }
  }
  return out.reverse();
}

/** hunkの実体(変更行)を復元。証拠テキストと機械的証拠の突き合わせに使う */
function resolveHunk(ws: Workspace, h: HunkRow): { addedLines: string[]; removedLines: string[]; text: string } {
  try {
    const base = resolveRevision(ws, h.base_revision_ref);
    const head = resolveRevision(ws, h.head_revision_ref);
    const b = manifestMap(base.manifest).get(h.file);
    const hd = manifestMap(head.manifest).get(h.file);
    const oldC = b ? fileContent(ws, b) : null;
    const newC = hd ? fileContent(ws, hd) : null;
    if (oldC === null && newC === null) {
      return { addedLines: [], removedLines: [], text: "(スナップショット未保存のためdiffを復元できません)" };
    }
    const hunks = gitNoIndexHunks(oldC, newC);
    const match = hunks.find((x) => x.newStart === h.new_start && x.newLines === h.new_lines);
    const target = match ?? hunks[0];
    if (!target) return { addedLines: [], removedLines: [], text: "(該当hunkを復元できません)" };
    return {
      addedLines: target.addedLines,
      removedLines: target.removedLines,
      text: [
        `@@ -${target.oldStart},${target.oldLines} +${target.newStart},${target.newLines} @@`,
        ...target.removedLines.map((l) => `-${l}`),
        ...target.addedLines.map((l) => `+${l}`),
      ].join("\n"),
    };
  } catch (e) {
    return { addedLines: [], removedLines: [], text: `(diff復元不能: ${String(e)})` };
  }
}

/** hunkの実diffを復元(証拠として提示するため) */
function hunkDiffText(ws: Workspace, h: HunkRow): string {
  return resolveHunk(ws, h).text;
}

const EVENT_DIFF_MAX_LINES = 20;

export interface AttributionBasis {
  pre_blob: string | null;
  post_blob: string | null;
  event_diff: string;
  introduced_lines: string[];
  removed_lines: string[];
  /** 一致行のうち情報量のあるもの(頻出の定型行を除く)の数。証拠の強さの目安(REQ-309) */
  informative_matches: number;
  overlap: "full" | "partial" | "none" | "unknown";
  /** overlapの意味を限定する注記。過剰な結論を防ぐ(REQ-308) */
  overlap_note: string;
}

/**
 * 一致行の情報量判定(REQ-309)。
 * `}` `);` `return null;` のような定型行は偶然一致しやすく、単独では証拠にならない。
 */
const KEYWORDS = new Set([
  "return", "null", "true", "false", "else", "const", "let", "var", "new", "this", "void", "undefined",
  "if", "for", "while", "break", "continue", "try", "catch", "finally", "throw", "case", "switch",
  "default", "import", "export", "function", "class", "async", "await", "type", "interface", "enum",
  "public", "private", "protected", "static", "readonly", "from", "as", "in", "of", "do", "end", "def",
  "string", "number", "boolean", "any", "unknown", "never", "object",
]);

export function isInformativeLine(line: string): boolean {
  const t = line.trim();
  if (t.length < 8) return false;
  if (!/[A-Za-z0-9_぀-ヿ一-鿿]/.test(t)) return false; // 記号のみ
  if (/["'`].{4,}["'`]/.test(t)) return true; // 長いリテラルを含む
  // 予約語だけで構成される定型行(`return null;` 等)は固有の情報を持たない
  const idents = (t.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []).filter((w) => !KEYWORDS.has(w));
  if (idents.length >= 2) return true;
  return t.length >= 40 && idents.length >= 1;
}

/** 多重度を保った積(Set比較だと同じ行の複数出現を1回の一致でfull扱いしてしまう) */
function multisetIntersect(target: string[], source: string[]): string[] {
  const remaining = new Map<string, number>();
  for (const l of source) remaining.set(l, (remaining.get(l) ?? 0) + 1);
  const out: string[] = [];
  for (const l of target) {
    const c = remaining.get(l) ?? 0;
    if (c > 0) {
      remaining.set(l, c - 1);
      out.push(l);
    }
  }
  return out;
}

const OVERLAP_NOTE =
  "このイベントの差分に、hunkと同じ文字列の変更行が含まれることのみを示す。帰属の十分条件ではない" +
  "(頻出行の偶然一致・formatterの削除再追加・別主体による同一文字列の再追加があり得る)";

/**
 * 帰属判定が実際に使っている機械的証拠を組み立てる(REQ-301/302)。
 * 編集イベントのpre/post内容から、そのイベント自身が作った差分を復元し、
 * hunkの変更行をどれだけ説明できるか(overlap)を出す。
 * 会話引用ではなくこれが帰属の根拠なので、判定者はこれを見て検証できる。
 */
export function attributionBasis(
  ws: Workspace,
  ev: { pre_blob_hash: string | null; result_blob_hash: string | null },
  hunk: { addedLines: string[]; removedLines: string[] },
): AttributionBasis {
  const short = (h: string | null): string | null => (h ? h.slice(0, 12) : null);
  const pre = ev.pre_blob_hash ? getObject(ws, ev.pre_blob_hash)?.toString("utf8") ?? null : "";
  const post = ev.result_blob_hash ? getObject(ws, ev.result_blob_hash)?.toString("utf8") ?? null : "";
  if (pre === null || post === null) {
    return {
      pre_blob: short(ev.pre_blob_hash),
      post_blob: short(ev.result_blob_hash),
      event_diff: "(スナップショットが残っていないため、このイベントの差分を復元できません)",
      introduced_lines: [],
      removed_lines: [],
      informative_matches: 0,
      overlap: "unknown",
      overlap_note: OVERLAP_NOTE,
    };
  }
  const evHunks = gitNoIndexHunks(pre, post);
  // 符号付き(追加は追加どうし・削除は削除どうし)かつ多重度を保って突き合わせる(REQ-309)
  const introduced = multisetIntersect(
    hunk.addedLines,
    evHunks.flatMap((x) => x.addedLines),
  );
  const removed = multisetIntersect(
    hunk.removedLines,
    evHunks.flatMap((x) => x.removedLines),
  );
  const changedTotal = hunk.addedLines.length + hunk.removedLines.length;
  const matched = introduced.length + removed.length;
  const informativeMatches = [...introduced, ...removed].filter(isInformativeLine).length;
  const overlap: AttributionBasis["overlap"] =
    changedTotal === 0 ? "unknown" : matched === 0 ? "none" : matched >= changedTotal ? "full" : "partial";

  const diffLines: string[] = [];
  for (const x of evHunks) {
    diffLines.push(`@@ -${x.oldStart},${x.oldLines} +${x.newStart},${x.newLines} @@`);
    for (const l of x.removedLines) diffLines.push(`-${l}`);
    for (const l of x.addedLines) diffLines.push(`+${l}`);
    if (diffLines.length > EVENT_DIFF_MAX_LINES) break;
  }
  const truncated = diffLines.length > EVENT_DIFF_MAX_LINES;
  return {
    pre_blob: short(ev.pre_blob_hash),
    post_blob: short(ev.result_blob_hash),
    event_diff:
      diffLines.length === 0
        ? "(このイベントは内容を変更していません)"
        : diffLines.slice(0, EVENT_DIFF_MAX_LINES).join("\n") + (truncated ? "\n…(以下省略)" : ""),
    introduced_lines: introduced,
    removed_lines: removed,
    informative_matches: informativeMatches,
    overlap,
    overlap_note: OVERLAP_NOTE,
  };
}

export function buildCasePack(ws: Workspace, kind: EvalKind, sample: number): EvalCasePack {
  const db = openDbChecked(ws);
  try {
    const latest = db
      .prepare("SELECT job_id, base_revision_ref, head_revision_ref FROM ingest_runs ORDER BY ts DESC, job_id DESC LIMIT 1")
      .get() as { job_id: string; base_revision_ref: string; head_revision_ref: string } | undefined;
    if (!latest) throw new ProvenError("empty", "ingestが未実行です。`proven ingest` を先に実行してください");

    const cases: EvalCase[] = [];
    let population = 0;

    if (kind === "lineage") {
      const rows = db
        .prepare(
          `SELECT hunk_instance_id, file, new_start, new_lines, old_start, old_lines,
                  base_revision_ref, head_revision_ref, edit_capture_status, lineage_status, context_status, confidence
           FROM hunks ORDER BY hunk_instance_id`,
        )
        .all() as HunkRow[];
      population = rows.length;
      for (const h of rows.slice(0, Math.min(sample, rows.length))) {
        // 1操作N ファイルに対応するため、イベントは (operation_id, file) で絞る
        const links = db
          .prepare(
            `SELECT e.operation_id, e.agent, e.ts_pre, e.ts_post, e.session_ref, e.transcript_line, e.status,
                    e.pre_blob_hash, e.result_blob_hash
             FROM lineage_links l JOIN edit_events e ON e.operation_id = l.operation_id
             WHERE l.hunk_instance_id = ? AND e.file = ? ORDER BY e.ts_pre`,
          )
          .all(h.hunk_instance_id, h.file) as {
          operation_id: string;
          agent: string;
          ts_pre: string;
          ts_post: string | null;
          session_ref: string;
          transcript_line: number | null;
          status: string;
          pre_blob_hash: string | null;
          result_blob_hash: string | null;
        }[];
        // 同ファイルの他イベント(誤帰属を見抜くための対照証拠)
        const otherEvents = db
          .prepare(
            `SELECT operation_id, ts_pre, status, pre_blob_hash, result_blob_hash FROM edit_events
             WHERE file = ? AND operation_id NOT IN (SELECT operation_id FROM lineage_links WHERE hunk_instance_id = ?)
             ORDER BY ts_pre LIMIT 5`,
          )
          .all(h.file, h.hunk_instance_id) as {
          operation_id: string;
          ts_pre: string;
          status: string;
          pre_blob_hash: string | null;
          result_blob_hash: string | null;
        }[];
        const hunkBody = resolveHunk(ws, h);
        const causeClaim = db
          .prepare("SELECT value, confidence, reason FROM claims WHERE hunk_ref=? AND kind='nolineage_cause'")
          .get(h.hunk_instance_id) as { value: string; confidence: number; reason: string } | undefined;

        cases.push({
          case_id: h.hunk_instance_id,
          kind: "lineage",
          question:
            h.edit_capture_status === "uncaptured"
              ? "この変更は本当にhook外(手編集・formatter等)で作られたものですか? それとも挙がっていない捕捉済み編集が作ったものですか?"
              : "この変更を作ったのは、ツールが挙げている編集イベントで正しいですか?",
          subject: {
            file: h.file,
            location: `${h.file}:${h.new_start}`,
            tool_says: {
              edit_capture_status: h.edit_capture_status,
              lineage_status: h.lineage_status,
              context_status: h.context_status,
              confidence: h.confidence,
              attributed_events: links.map((l) => l.operation_id),
            },
            cause_claim: causeClaim ?? null,
          },
          evidence: {
            hunk_diff: hunkBody.text,
            // 帰属判定の実体はblobチェーン。会話引用は補助(REQ-301/302/304)
            attributed_events: links.map((l) => ({
              operation_id: l.operation_id,
              agent: l.agent,
              edited_at: l.ts_pre,
              status: l.status,
              attribution_basis: attributionBasis(ws, l, hunkBody),
              transcript_quotes: quoteAround(l.session_ref, l.transcript_line),
            })),
            // 対照証拠にも同じ機械的証拠を付ける(REQ-303)
            other_events_on_same_file: otherEvents.map((o) => ({
              operation_id: o.operation_id,
              edited_at: o.ts_pre,
              status: o.status,
              attribution_basis: attributionBasis(ws, o, hunkBody),
            })),
          },
          allowed_verdicts: ["correct", "incorrect", "unsure"],
        });
      }
    } else {
      const rows = db
        .prepare(
          `SELECT c.claim_id, c.hunk_ref, c.kind, c.value, c.confidence, c.reason, c.evidence_json,
                  h.file, h.new_start, h.new_lines, h.old_start, h.old_lines,
                  h.base_revision_ref, h.head_revision_ref, h.edit_capture_status, h.lineage_status,
                  h.context_status, h.confidence AS hconf
           FROM claims c JOIN hunks h ON h.hunk_instance_id = c.hunk_ref
           WHERE c.kind IN ('instructed','spec_support') ORDER BY c.claim_id`,
        )
        .all() as (HunkRow & {
        claim_id: string;
        hunk_ref: string;
        kind: string;
        value: string;
        confidence: number;
        reason: string;
        evidence_json: string;
        hconf: number | null;
      })[];
      population = rows.length;
      for (const c of rows.slice(0, Math.min(sample, rows.length))) {
        const evidence = JSON.parse(c.evidence_json) as { type: string; [k: string]: unknown }[];
        const materialized = evidence.map((ev) => {
          if (ev.type === "transcript") {
            const q = quoteAround(ev.path as string, (ev.line as number) + 1, 1);
            return { ...ev, quoted_text: q[0]?.text ?? "(引用元を復元できません)" };
          }
          if (ev.type === "spec") {
            const db2 = openDbChecked(ws);
            try {
              const row = db2
                .prepare("SELECT heading, tokens FROM spec_index WHERE file=? AND section=? LIMIT 1")
                .get(ev.file as string, ev.section as string) as { heading: string; tokens: string } | undefined;
              return { ...ev, spec_excerpt: row ? `${row.heading}: ${row.tokens.slice(0, 200)}` : "(仕様節を復元できません)" };
            } finally {
              db2.close();
            }
          }
          return ev;
        });
        cases.push({
          case_id: c.claim_id,
          kind: "claims",
          question: `このclaim(${c.kind}=${c.value})の根拠は、その主張を妥当に支持していますか?`,
          subject: {
            location: `${c.file}:${c.new_start}`,
            claim_kind: c.kind,
            claim_value: c.value,
            confidence: c.confidence,
            tool_reason: c.reason,
          },
          evidence: {
            hunk_diff: hunkDiffText(ws, c),
            claim_evidence: materialized,
          },
          allowed_verdicts: ["correct", "incorrect", "unsure"],
        });
      }
    }

    return {
      schema_version: SCHEMA_VERSION,
      kind,
      generated_from: { base_revision_ref: latest.base_revision_ref, head_revision_ref: latest.head_revision_ref },
      population,
      sampled: cases.length,
      rubric: kind === "lineage" ? LINEAGE_RUBRIC : CLAIMS_RUBRIC,
      output_contract: OUTPUT_CONTRACT,
      cases,
    };
  } finally {
    db.close();
  }
}

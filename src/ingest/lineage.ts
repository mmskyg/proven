import fs from "node:fs";
import { myersDiff, splitLines, type DiffOp, type RawHunk } from "./diff.js";
import { isDistinctiveLine, isInformativeLine, longestInformativeRun, multisetIntersect } from "../shared/lines.js";

/**
 * provenance map方式のlineage構築(詳細設計書4.3)。
 * segments = [gap][event][gap][event]...[gap] を左から処理し、
 * 各イベントの寄与span(head座標系)を合成写像で追跡する。
 * gap(手編集/formatter等)に潰されたspanはtainted(→broken判定)。
 */

export interface EventSpan {
  operationId: string;
  start: number; // head(現時点)座標系の行位置(0-origin)
  len: number; // 0=削除anchor
  tainted: boolean;
}

export interface GapSpan {
  gapIndex: number;
  whitespaceOnly: boolean;
  start: number;
  len: number;
}

/** 各イベント自身が作った変更行(内容一致による候補検出に使う・REQ-403) */
export interface EventContent {
  operationId: string;
  addedLines: string[];
  removedLines: string[];
  /** イベント全体の変更行数。巨大イベントの偶然一致を弱めるため(REQ-408) */
  size: number;
}

export interface FileLineage {
  eventSpans: EventSpan[];
  gapSpans: GapSpan[];
  eventContents: EventContent[];
  hadGap: boolean;
  chainComplete: boolean; // gapなしで base→head が繋がった
}

interface Segment {
  kind: "event" | "gap";
  operationId?: string;
  gapIndex?: number;
  whitespaceOnly?: boolean;
  ops: DiffOp[];
  newLineCount: number;
}

function isWhitespaceOnlyChange(_ops: DiffOp[], aLines: string[], bLines: string[]): boolean {
  // formatter判定: 非空白文字列が全体として一致すれば整形のみ(インデント・改行位置の変更を含む)
  const strip = (s: string) => s.replace(/\s+/g, "");
  return strip(aLines.join("")) === strip(bLines.join(""));
}

/** 位置写像: ops(old→new)で位置posを移す。deleted時はanchor位置を返す */
function mapPosition(ops: DiffOp[], pos: number): { pos: number; deleted: boolean } {
  for (const op of ops) {
    if (op.type === "equal" || op.type === "del") {
      if (pos >= op.aStart && pos < op.aStart + op.len) {
        if (op.type === "equal") return { pos: op.bStart + (pos - op.aStart), deleted: false };
        return { pos: op.bStart, deleted: true };
      }
    }
  }
  // どのランにも含まれない(末尾以降) → 末尾へ
  let lastB = 0;
  for (const op of ops) {
    if (op.type === "equal" || op.type === "ins") lastB = Math.max(lastB, op.bStart + op.len);
    else lastB = Math.max(lastB, op.bStart);
  }
  return { pos: lastB, deleted: false };
}

function mapSpan(ops: DiffOp[], span: { start: number; len: number }): { start: number; len: number; anyDeleted: boolean } {
  if (span.len === 0) {
    const m = mapPosition(ops, span.start);
    return { start: m.pos, len: 0, anyDeleted: m.deleted };
  }
  let minPos = Infinity;
  let maxPos = -Infinity;
  let anyDeleted = false;
  let survivors = 0;
  let anchor = 0;
  for (let i = 0; i < span.len; i++) {
    const m = mapPosition(ops, span.start + i);
    if (m.deleted) {
      anyDeleted = true;
      anchor = m.pos;
    } else {
      survivors++;
      minPos = Math.min(minPos, m.pos);
      maxPos = Math.max(maxPos, m.pos);
    }
  }
  if (survivors === 0) return { start: anchor, len: 0, anyDeleted: true };
  return { start: minPos, len: maxPos - minPos + 1, anyDeleted };
}

function spansFromOps(ops: DiffOp[]): { start: number; len: number }[] {
  const out: { start: number; len: number }[] = [];
  for (const op of ops) {
    if (op.type === "ins") out.push({ start: op.bStart, len: op.len });
    else if (op.type === "del") out.push({ start: op.bStart, len: 0 }); // 削除anchor
  }
  return out;
}

/**
 * ファイル単位のlineage計算。
 * events: completedのみ・時系列順。各イベントのpre/post内容は呼び出し側が解決して渡す。
 */
export function computeFileLineage(
  baseContent: string,
  headContent: string,
  events: { operationId: string; pre: string; post: string }[],
): FileLineage {
  const eventSpans: EventSpan[] = [];
  const gapSpans: GapSpan[] = [];
  // 各イベント自身が作った変更行(連鎖が切れたときの候補検出用)
  const eventContents: EventContent[] = events.map((ev) => {
    const a = splitLines(ev.pre);
    const b = splitLines(ev.post);
    const added: string[] = [];
    const removed: string[] = [];
    for (const op of myersDiff(a, b)) {
      if (op.type === "ins") for (let i = 0; i < op.len; i++) added.push(b[op.bStart + i]);
      else if (op.type === "del") for (let i = 0; i < op.len; i++) removed.push(a[op.aStart + i]);
    }
    return { operationId: ev.operationId, addedLines: added, removedLines: removed, size: added.length + removed.length };
  });
  // セグメント列構築
  const segments: Segment[] = [];
  let cursor = baseContent;
  let gapIndex = 0;
  let hadGap = false;
  for (const ev of events) {
    if (cursor !== ev.pre) {
      const a = splitLines(cursor);
      const b = splitLines(ev.pre);
      const ops = myersDiff(a, b);
      segments.push({ kind: "gap", gapIndex, whitespaceOnly: isWhitespaceOnlyChange(ops, a, b), ops, newLineCount: b.length });
      gapIndex++;
      hadGap = true;
      cursor = ev.pre;
    }
    const a = splitLines(ev.pre);
    const b = splitLines(ev.post);
    segments.push({ kind: "event", operationId: ev.operationId, ops: myersDiff(a, b), newLineCount: b.length });
    cursor = ev.post;
  }
  if (cursor !== headContent) {
    const a = splitLines(cursor);
    const b = splitLines(headContent);
    const ops = myersDiff(a, b);
    segments.push({ kind: "gap", gapIndex, whitespaceOnly: isWhitespaceOnlyChange(ops, a, b), ops, newLineCount: b.length });
    hadGap = true;
  }

  // 左→右へ写像合成
  for (const seg of segments) {
    // 既存spanを写像
    for (const s of eventSpans) {
      const m = mapSpan(seg.ops, s);
      s.start = m.start;
      s.len = m.len;
      if (seg.kind === "gap" && m.anyDeleted) s.tainted = true; // gapに潰された
    }
    for (const g of gapSpans) {
      const m = mapSpan(seg.ops, g);
      g.start = m.start;
      g.len = m.len;
    }
    // 自身の寄与spanを追加
    if (seg.kind === "event") {
      for (const s of spansFromOps(seg.ops)) {
        eventSpans.push({ operationId: seg.operationId!, start: s.start, len: s.len, tainted: false });
      }
    } else {
      for (const s of spansFromOps(seg.ops)) {
        gapSpans.push({ gapIndex: seg.gapIndex!, whitespaceOnly: seg.whitespaceOnly!, start: s.start, len: s.len });
      }
    }
  }
  return { eventSpans, gapSpans, eventContents, hadGap, chainComplete: !hadGap && events.length > 0 };
}

function intersects(span: { start: number; len: number }, hunkStart0: number, hunkLen: number): boolean {
  // hunkLen=0(削除hunk)はanchor点。span.len=0も点。点は±1行の近傍まで許容
  const aLo = span.len === 0 ? span.start - 1 : span.start;
  const aHi = span.len === 0 ? span.start + 1 : span.start + span.len - 1;
  const bLo = hunkLen === 0 ? hunkStart0 - 1 : hunkStart0;
  const bHi = hunkLen === 0 ? hunkStart0 + 1 : hunkStart0 + hunkLen - 1;
  return aLo <= bHi && bLo <= aHi;
}

export interface HunkAttribution {
  status: "linked" | "broken" | "candidate" | "uncaptured";
  refs: string[]; // operation_id。candidateでは「候補」であって確定帰属ではない(REQ-402)
  confidence: number | null;
  gapCause: { whitespaceOnly: boolean } | null; // uncaptured/broken時の原因gap
  /** 帰属の導出方式。candidateはblob-chainではなく内容一致(REQ-402) */
  method?: "blob-chain" | "content-match";
  /** candidate時の根拠(REQ-410の「観測事実」を出すため) */
  candidateEvidence?: {
    matchedLines: string[];
    runLength: number;
    bothSides: boolean;
    ambiguous: boolean;
  };
  /**
   * 各refについて、その編集自身の差分がhunkの変更行を含むか(REQ-501)。
   * 位置が重なる≠その行を書いた、を区別するための観測事実。
   */
  refSupport?: { operation_id: string; support: RefSupport }[];
}

export type RefSupport = "author" | "touched" | "unknown";

/** refごとの内容裏付けを判定する(REQ-501/502)。新しい推定は増やさず、既存の突き合わせ規則をそのまま使う */
export function refSupportOf(contents: EventContent[], refs: string[], hunk: RawHunk): {
  operation_id: string;
  support: RefSupport;
}[] {
  return refs.map((id) => {
    const c = contents.find((x) => x.operationId === id);
    if (!c) return { operation_id: id, support: "unknown" as RefSupport };
    return { operation_id: id, support: authorSupport(hunk, c) ? "author" : "touched" };
  });
}

/**
 * この編集がこのhunkを作ったと言えるか(REQ-501/502 + REQ-835)。
 *
 * 旧規則は「一致した行のうち1本でも isInformativeLine を満たすこと」だけだった。
 * これは1行単位では正しい(定型行1本の一致は偶然でありうる)が、**連言を見ていない**。
 * 偶然の一致は孤立して起きるもので、連続した並びや全行被覆の形にはならない。
 *
 * 実測(このリポジトリ294 hunk)で author 被覆は 53.7%。落ちているのは
 * 「変更行がどれも単独では弱い」小さな修正——最も多い編集形——だった。
 *
 * そこで次のいずれかを満たせば author とする:
 *  (a) 一致行に informative なものが1本でもある(従来規則。定型行の門はそのまま)
 *  (b) 一致行が hunk 側・イベント側の**双方で連続2行以上**をなす(並び自体が情報)
 *  (c) イベントの差分が hunk の変更行を**全て**含み、hunk が2行以上(全被覆は偶然の形ではない)
 *
 * `const x = 500;` 単独は (a)(b)(c) いずれも満たさず touched のまま。
 */
function authorSupport(hunk: RawHunk, c: EventContent): boolean {
  const matched = [
    ...multisetIntersect(hunk.addedLines, c.addedLines),
    ...multisetIntersect(hunk.removedLines, c.removedLines),
  ];
  // (a) 従来規則
  if (matched.some(isInformativeLine)) return true;
  if (matched.length === 0) return false;
  // (b) 連続した並び(informativeness は問わない。並んでいること自体が根拠)
  if (contiguousRun(hunk.addedLines, c.addedLines) >= 2) return true;
  if (contiguousRun(hunk.removedLines, c.removedLines) >= 2) return true;
  // (c) hunkの変更行をイベントが全て含む。
  // 「2行以上」は added / removed の**片側で**数える。両者の合計にすると
  // 1行置換(added 1 + removed 1)が該当してしまい、(a)で弾いたはずの
  // 「弱い行1本」が裏口から author になる
  const added = hunk.addedLines.filter((l) => l.trim() !== "");
  const removed = hunk.removedLines.filter((l) => l.trim() !== "");
  const multiLine = added.length >= 2 || removed.length >= 2;
  if (multiLine && matched.length >= added.length + removed.length) return true;
  return false;
}

/** target の並びが source にそのまま現れる最長の長さ(informativeness は問わない) */
function contiguousRun(target: string[], source: string[]): number {
  let best = 0;
  for (let i = 0; i < target.length; i++) {
    if (target[i].trim() === "") continue;
    const start = source.indexOf(target[i]);
    if (start < 0) continue;
    let run = 0;
    let s = start;
    let t = i;
    while (t < target.length && s < source.length && target[t] === source[s] && target[t].trim() !== "") {
      run++;
      t++;
      s++;
    }
    best = Math.max(best, run);
  }
  return best;
}

const CANDIDATE_CONF_MAX = 0.4;

/**
 * 連鎖が切れて位置で追えないとき、内容一致で候補を探す(REQ-403〜409)。
 * 見つからなければnull(=従来どおりuncaptured)。
 * 内容一致は帰属の確定根拠ではないので、confidenceは構造的broken(0.4)を超えない。
 */
export function findContentCandidates(
  contents: EventContent[],
  hunk: RawHunk,
): { refs: string[]; confidence: number; evidence: NonNullable<HunkAttribution["candidateEvidence"]> } | null {
  interface Scored {
    operationId: string;
    score: number;
    matched: string[];
    runLength: number;
    bothSides: boolean;
  }
  const scored: Scored[] = [];
  for (const c of contents) {
    // 符号を区別して突き合わせる(追加は追加どうし・削除は削除どうし)
    const addMatched = multisetIntersect(hunk.addedLines, c.addedLines).filter(isInformativeLine);
    const delMatched = multisetIntersect(hunk.removedLines, c.removedLines).filter(isInformativeLine);
    const matched = [...addMatched, ...delMatched];
    if (matched.length === 0) continue;

    const runLength = Math.max(
      longestInformativeRun(hunk.addedLines, c.addedLines),
      longestInformativeRun(hunk.removedLines, c.removedLines),
    );
    const distinctive = matched.some(isDistinctiveLine);
    // 候補として採る条件: 情報量のある連続2行以上、または特徴的な1行(REQ-405)
    if (runLength < 2 && !distinctive) continue;

    let score = runLength >= 2 ? 0.3 : 0.2;
    const bothSides = addMatched.length > 0 && delMatched.length > 0;
    if (bothSides) score += 0.1;
    // 巨大イベントの偶然一致を弱める(REQ-408)
    if (c.size > 50 && matched.length / c.size < 0.1) score -= 0.1;
    score = Math.max(0.1, Math.min(CANDIDATE_CONF_MAX, Number(score.toFixed(2))));
    scored.push({ operationId: c.operationId, score, matched, runLength, bothSides });
  }
  if (scored.length === 0) return null;

  const best = Math.max(...scored.map((s) => s.score));
  const top = scored.filter((s) => s.score === best);
  const ambiguous = top.length > 1;
  // 同点なら1つに絞らない。confidenceも上げない(REQ-407)
  const confidence = ambiguous ? Math.min(0.2, best) : best;
  return {
    refs: top.map((s) => s.operationId),
    confidence,
    evidence: {
      matchedLines: top[0].matched.slice(0, 5),
      runLength: Math.max(...top.map((s) => s.runLength)),
      bothSides: top.some((s) => s.bothSides),
      ambiguous,
    },
  };
}

/** hunk(git座標: newStart 1-origin)へのイベント帰属(4.3 step4) */
export function attributeHunk(lineage: FileLineage, hunk: RawHunk): HunkAttribution {
  const start0 = hunk.newLines === 0 ? hunk.newStart : hunk.newStart - 1; // 0-origin化(削除hunkのnewStartは直前行)
  const len = hunk.newLines;
  const hitUntainted = new Set<string>();
  const hitTainted = new Set<string>();
  for (const s of lineage.eventSpans) {
    if (intersects(s, start0, len)) {
      if (s.tainted) hitTainted.add(s.operationId);
      else hitUntainted.add(s.operationId);
    }
  }
  let gapCause: { whitespaceOnly: boolean } | null = null;
  for (const g of lineage.gapSpans) {
    if (intersects(g, start0, len)) {
      gapCause = { whitespaceOnly: g.whitespaceOnly };
      break;
    }
  }
  // 既存の構造的判定は変更しない(REQ-412/506)。candidateはuncapturedだった一部だけを引き取る
  if (hitUntainted.size > 0) {
    const refs = [...hitUntainted, ...hitTainted];
    return {
      status: "linked",
      refs,
      confidence: 1.0,
      gapCause: null,
      method: "blob-chain",
      refSupport: refSupportOf(lineage.eventContents, refs, hunk),
    };
  }
  if (hitTainted.size > 0) {
    const refs = [...hitTainted];
    return {
      status: "broken",
      refs,
      confidence: 0.4,
      gapCause,
      method: "blob-chain",
      refSupport: refSupportOf(lineage.eventContents, refs, hunk),
    };
  }
  const candidate = findContentCandidates(lineage.eventContents, hunk);
  if (candidate) {
    return {
      status: "candidate",
      refs: candidate.refs,
      confidence: candidate.confidence,
      gapCause,
      method: "content-match",
      candidateEvidence: candidate.evidence,
      // candidateは内容一致で選ばれているので、定義上すべてauthor(候補)
      refSupport: refSupportOf(lineage.eventContents, candidate.refs, hunk),
    };
  }
  return { status: "uncaptured", refs: [], confidence: null, gapCause };
}

export function isSessionEnded(sessionRef: string): boolean {
  // MVP近似: transcriptが消えていれば終了扱い(実運用は24hフォールバックが主)
  return !sessionRef || !fs.existsSync(sessionRef);
}

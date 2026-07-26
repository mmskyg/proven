import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sha256, sha256OfParts } from "../shared/hash.js";
import { OVERSIZE_HUNK_LINES } from "../shared/types.js";

// ---------- own Myers diff (lineage内部のprovenance map用) ----------

export type DiffOp =
  | { type: "equal"; aStart: number; bStart: number; len: number }
  | { type: "del"; aStart: number; bStart: number; len: number } // bStart=削除位置anchor
  | { type: "ins"; aStart: number; bStart: number; len: number }; // aStart=挿入位置anchor

export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** 行単位Myers差分(O(ND))。equal/del/insのラン列を返す */
export function myersDiff(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const offset = max;
  let v = new Array<number>(2 * max + 1).fill(0);
  const trace: number[][] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1]; // down (insert from b)
      } else {
        x = v[offset + k - 1] + 1; // right (delete from a)
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice());
        break outer;
      }
    }
  }
  // backtrack
  type Step = { x: number; y: number };
  const pathSteps: Step[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 2; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vd[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      pathSteps.push({ x: x - 1, y: y - 1 }); // equal
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) {
        pathSteps.push({ x: -1, y: prevY }); // insert b[prevY]
      } else {
        pathSteps.push({ x: prevX, y: -1 }); // delete a[prevX]
      }
      x = prevX;
      y = prevY;
    }
  }
  while (x > 0 && y > 0) {
    pathSteps.push({ x: x - 1, y: y - 1 });
    x--;
    y--;
  }
  while (x > 0) pathSteps.push({ x: --x, y: -1 });
  while (y > 0) pathSteps.push({ x: -1, y: --y });
  pathSteps.reverse();
  // ラン化
  const ops: DiffOp[] = [];
  let ai = 0;
  let bi = 0;
  for (const s of pathSteps) {
    if (s.x >= 0 && s.y >= 0) {
      const last = ops[ops.length - 1];
      if (last && last.type === "equal" && last.aStart + last.len === s.x) last.len++;
      else ops.push({ type: "equal", aStart: s.x, bStart: s.y, len: 1 });
      ai = s.x + 1;
      bi = s.y + 1;
    } else if (s.y === -1) {
      const last = ops[ops.length - 1];
      if (last && last.type === "del" && last.aStart + last.len === s.x) last.len++;
      else ops.push({ type: "del", aStart: s.x, bStart: bi, len: 1 });
      ai = s.x + 1;
    } else {
      const last = ops[ops.length - 1];
      if (last && last.type === "ins" && last.bStart + last.len === s.y) last.len++;
      else ops.push({ type: "ins", aStart: ai, bStart: s.y, len: 1 });
      bi = s.y + 1;
    }
  }
  return ops;
}

// ---------- git diff --no-index によるhunk抽出(diff契約) ----------

export interface RawHunk {
  oldStart: number; // 1-origin(削除0行のときはgit流儀: 直前行)
  oldLines: number;
  newStart: number;
  newLines: number;
  addedLines: string[]; // +行の内容
  removedLines: string[]; // -行の内容
}

const DIFF_FLAGS = ["--diff-algorithm=myers", "--unified=0", "--no-ext-diff", "--no-textconv", "--no-color"];

/** git diff --no-index(固定フラグ)で2内容のhunkを取る(詳細設計書 diff契約) */
export function gitNoIndexHunks(oldContent: string | null, newContent: string | null): RawHunk[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proven-diff-"));
  try {
    const aPath = path.join(dir, "a");
    const bPath = path.join(dir, "b");
    fs.writeFileSync(aPath, oldContent ?? "");
    fs.writeFileSync(bPath, newContent ?? "");
    let out: string;
    try {
      out = execFileSync("git", ["diff", "--no-index", ...DIFF_FLAGS, "--", oldContent === null ? "/dev/null" : aPath, newContent === null ? "/dev/null" : bPath], {
        maxBuffer: 64 * 1024 * 1024,
      }).toString();
    } catch (e: any) {
      // git diffは差分ありでexit 1を返す
      if (e && typeof e.status === "number" && e.stdout) out = e.stdout.toString();
      else throw e;
    }
    return parseUnifiedHunks(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function parseUnifiedHunks(diffText: string): RawHunk[] {
  const hunks: RawHunk[] = [];
  let cur: RawHunk | null = null;
  for (const line of diffText.split("\n")) {
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (m) {
      cur = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        addedLines: [],
        removedLines: [],
      };
      hunks.push(cur);
    } else if (cur) {
      if (line.startsWith("+") && !line.startsWith("+++")) cur.addedLines.push(line.slice(1));
      else if (line.startsWith("-") && !line.startsWith("---")) cur.removedLines.push(line.slice(1));
    }
  }
  return hunks;
}

// ---------- hunk_instance_id(3.6) ----------

export function normalizedChangedLines(h: RawHunk): string {
  const norm = (l: string) => l.replace(/\s+$/, "");
  return [...h.removedLines.map((l) => `-${norm(l)}`), ...h.addedLines.map((l) => `+${norm(l)}`)].join("\n");
}

export function hunkInstanceId(args: {
  repoId: string;
  baseRef: string;
  headRef: string;
  filePath: string;
  hunk: RawHunk;
  ordinal: number;
  oldBlobHash: string | null;
  newBlobHash: string | null;
}): string {
  const h = args.hunk;
  return sha256OfParts([
    args.repoId,
    args.baseRef,
    args.headRef,
    args.filePath,
    h.oldStart,
    h.oldLines,
    h.newStart,
    h.newLines,
    args.ordinal,
    args.oldBlobHash ?? "-",
    args.newBlobHash ?? "-",
    normalizedChangedLines(h),
    "myers",
  ]);
}

export function isOversizeHunk(h: RawHunk): boolean {
  return h.addedLines.length + h.removedLines.length > OVERSIZE_HUNK_LINES;
}

/** hunk後継類似度: 正規化変更行トークン集合のJaccard(v0.3) */
export function hunkJaccard(aNormLines: string, bNormLines: string): number {
  const tok = (s: string) => new Set(s.match(/[A-Za-z_][A-Za-z0-9_]+|[^\sA-Za-z0-9]/g) ?? []);
  const A = tok(aNormLines);
  const B = tok(bNormLines);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export function digestOf(text: string): string {
  return sha256(text);
}

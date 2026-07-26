// 行の情報量判定と、符号付き・多重度保存の突き合わせ(REQ-403/404)。
// 帰属の候補検出(lineage)と受入計測の証拠(eval)で共用する。

const KEYWORDS = new Set([
  "return", "null", "true", "false", "else", "const", "let", "var", "new", "this", "void", "undefined",
  "if", "for", "while", "break", "continue", "try", "catch", "finally", "throw", "case", "switch",
  "default", "import", "export", "function", "class", "async", "await", "type", "interface", "enum",
  "public", "private", "protected", "static", "readonly", "from", "as", "in", "of", "do", "end", "def",
  "string", "number", "boolean", "any", "unknown", "never", "object",
]);

/**
 * 情報量のある行か(REQ-404)。
 * `}` `return null;` のような定型行は偶然一致しやすく、単独では証拠にならない。
 */
export function isInformativeLine(line: string): boolean {
  const t = line.trim();
  if (t.length < 8) return false;
  if (!/[A-Za-z0-9_぀-ヿ一-鿿]/.test(t)) return false; // 記号のみ
  if (/["'`].{4,}["'`]/.test(t)) return true; // 長いリテラルを含む
  const idents = (t.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []).filter((w) => !KEYWORDS.has(w));
  if (idents.length >= 2) return true;
  return t.length >= 40 && idents.length >= 1;
}

/** 特徴的な1行か(REQ-405-2)。単独でも候補の根拠になりうる強さ */
export function isDistinctiveLine(line: string): boolean {
  if (!isInformativeLine(line)) return false;
  const t = line.trim();
  return t.length >= 40 || /["'`].{4,}["'`]/.test(t);
}

/**
 * 多重度を保った積(REQ-403)。
 * Set比較だと、target側に同じ行が複数あってもsource側1回の出現で全て一致扱いになる。
 */
export function multisetIntersect(target: string[], source: string[]): string[] {
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

/**
 * targetの並びのうち、sourceにも同じ順序で連続して現れる情報量のある行の最長連長(REQ-405-1)。
 * 「たまたま同じ行が散在している」ことと「同じ塊が入っている」ことを区別する。
 */
export function longestInformativeRun(target: string[], source: string[]): number {
  let best = 0;
  for (let i = 0; i < target.length; i++) {
    const startIdx = source.indexOf(target[i]);
    if (startIdx < 0 || !isInformativeLine(target[i])) continue;
    let run = 0;
    let s = startIdx;
    let t = i;
    while (t < target.length && s < source.length && target[t] === source[s] && isInformativeLine(target[t])) {
      run++;
      t++;
      s++;
    }
    best = Math.max(best, run);
  }
  return best;
}

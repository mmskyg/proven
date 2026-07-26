// 対象: S-01 lineage property必須ケース + S-02 hunk ID衝突 + 4.3アルゴリズム単体
import { describe, expect, it } from "vitest";
import { gitNoIndexHunks, hunkInstanceId, hunkJaccard, myersDiff, normalizedChangedLines, splitLines, type RawHunk } from "../src/ingest/diff.js";
import { attributeHunk, computeFileLineage } from "../src/ingest/lineage.js";
import { JACCARD_THRESHOLD } from "../src/shared/types.js";

function reconstruct(a: string[], ops: ReturnType<typeof myersDiff>, b: string[]): void {
  // diffの健全性: opsからbを再構成できる
  const out: string[] = [];
  for (const op of ops) {
    if (op.type === "equal") for (let i = 0; i < op.len; i++) out.push(a[op.aStart + i]);
    if (op.type === "ins") for (let i = 0; i < op.len; i++) out.push(b[op.bStart + i]);
  }
  expect(out).toEqual(b);
}

describe("myersDiff", () => {
  it("等価・挿入・削除・置換のラン化とb再構成", () => {
    const cases: [string, string][] = [
      ["a\nb\nc", "a\nX\nc"],
      ["a\nb\nc", "a\nb\nc\nd"],
      ["a\nb\nc\nd", "a\nd"],
      ["", "x\ny"],
      ["x\ny", ""],
      ["1\n2\n3\n4\n5", "0\n1\n3\n5\n6"],
    ];
    for (const [A, B] of cases) {
      const a = splitLines(A);
      const b = splitLines(B);
      reconstruct(a, myersDiff(a, b), b);
    }
  });
});

function attributeAll(base: string, head: string, events: { operationId: string; pre: string; post: string }[]) {
  const lineage = computeFileLineage(base, head, events);
  const hunks = gitNoIndexHunks(base, head);
  return hunks.map((h) => ({ hunk: h, attr: attributeHunk(lineage, h) }));
}

describe("S-01: lineage property必須ケース", () => {
  const base = "l1\nl2\nl3\nl4\nl5\n";

  it("単一編集→linked(confidence 1.0)", () => {
    const post = "l1\nEDITED\nl3\nl4\nl5\n";
    const res = attributeAll(base, post, [{ operationId: "e1", pre: base, post }]);
    expect(res).toHaveLength(1);
    expect(res[0].attr.status).toBe("linked");
    expect(res[0].attr.refs).toEqual(["e1"]);
    expect(res[0].attr.confidence).toBe(1.0);
  });

  it("挿入後再編集: 両イベントに帰属(多段編集)", () => {
    const p1 = "l1\nNEW\nl2\nl3\nl4\nl5\n"; // e1: 挿入
    const p2 = "l1\nNEW-EDITED\nl2\nl3\nl4\nl5\n"; // e2: 挿入行を再編集
    const res = attributeAll(base, p2, [
      { operationId: "e1", pre: base, post: p1 },
      { operationId: "e2", pre: p1, post: p2 },
    ]);
    const target = res.find((r) => r.hunk.addedLines.includes("NEW-EDITED"))!;
    expect(target.attr.status).toBe("linked");
    expect(new Set(target.attr.refs)).toEqual(new Set(["e1", "e2"]));
  });

  it("部分削除: 削除hunk(new_lines=0)がanchor交差で帰属", () => {
    const post = "l1\nl2\nl4\nl5\n"; // l3削除
    const res = attributeAll(base, post, [{ operationId: "e1", pre: base, post }]);
    expect(res).toHaveLength(1);
    expect(res[0].hunk.newLines).toBe(0);
    expect(res[0].attr.status).toBe("linked");
    expect(res[0].attr.refs).toEqual(["e1"]);
  });

  it("全削除: 帰属が失われない", () => {
    const post = "";
    const res = attributeAll(base, post, [{ operationId: "e1", pre: base, post }]);
    expect(res).toHaveLength(1);
    expect(res[0].attr.status).toBe("linked");
  });

  it("同一行複数編集: 最後の編集だけを由来としない", () => {
    const p1 = "l1\nv1\nl3\nl4\nl5\n";
    const p2 = "l1\nv2\nl3\nl4\nl5\n";
    const res = attributeAll(base, p2, [
      { operationId: "e1", pre: base, post: p1 },
      { operationId: "e2", pre: p1, post: p2 },
    ]);
    expect(new Set(res[0].attr.refs)).toEqual(new Set(["e1", "e2"]));
  });

  it("無関係な編集はリンクされない(過剰帰属もFAIL)", () => {
    const p1 = "EDIT-TOP\nl2\nl3\nl4\nl5\n"; // e1: 先頭
    const p2 = "EDIT-TOP\nl2\nl3\nl4\nEDIT-BOTTOM\n"; // e2: 末尾
    const res = attributeAll(base, p2, [
      { operationId: "e1", pre: base, post: p1 },
      { operationId: "e2", pre: p1, post: p2 },
    ]);
    expect(res).toHaveLength(2);
    const top = res.find((r) => r.hunk.addedLines.includes("EDIT-TOP"))!;
    const bottom = res.find((r) => r.hunk.addedLines.includes("EDIT-BOTTOM"))!;
    expect(top.attr.refs).toEqual(["e1"]);
    expect(bottom.attr.refs).toEqual(["e2"]);
  });

  it("N-20: 捕捉編集と手編集の混在をhunk単位で分離", () => {
    const p1 = "l1\nCAPTURED\nl3\nl4\nl5\n"; // e1(captured)
    const head = "l1\nCAPTURED\nl3\nl4\nMANUAL\nl5\n"; // 手編集で挿入(gap)
    const res = attributeAll(base, head, [{ operationId: "e1", pre: base, post: p1 }]);
    const cap = res.find((r) => r.hunk.addedLines.includes("CAPTURED"))!;
    const man = res.find((r) => r.hunk.addedLines.includes("MANUAL"))!;
    expect(cap.attr.status).toBe("linked");
    expect(man.attr.status).toBe("uncaptured");
    expect(man.attr.refs).toEqual([]);
    expect(man.attr.confidence).toBeNull();
  });

  it("N-21: formatterによる全体整形→broken+原因formatter", () => {
    const p1 = "l1\nCAPTURED\nl3\nl4\nl5\n";
    const head = "  l1\n  CAPTURED\n  l3\n  l4\n  l5\n"; // 全行インデント(空白のみ変更)
    const res = attributeAll(base, head, [{ operationId: "e1", pre: base, post: p1 }]);
    for (const r of res) {
      expect(["broken", "uncaptured"]).toContain(r.attr.status);
      if (r.attr.gapCause) expect(r.attr.gapCause.whitespaceOnly).toBe(true);
    }
    // 少なくとも1つはbroken(捕捉イベントの痕跡が近傍にある)
    expect(res.some((r) => r.attr.status === "broken")).toBe(true);
  });

  it("イベントゼロ→全hunk uncaptured(E-20相当の単体)", () => {
    const head = "l1\nCHANGED\nl3\nl4\nl5\n";
    const res = attributeAll(base, head, []);
    expect(res[0].attr.status).toBe("uncaptured");
  });
});

describe("S-02: hunk_instance_id衝突", () => {
  const mkHunk = (oldStart: number, newStart: number, added: string[]): RawHunk => ({
    oldStart,
    oldLines: 0,
    newStart,
    newLines: added.length,
    addedLines: added,
    removedLines: [],
  });
  const baseArgs = {
    repoId: "r1",
    baseRef: "commit:a",
    headRef: "worktree:b",
    oldBlobHash: "h1",
    newBlobHash: "h2",
  };

  it("同一ファイル内の同内容hunk複数(座標・序数で区別)", () => {
    const h1 = hunkInstanceId({ ...baseArgs, filePath: "a.ts", hunk: mkHunk(1, 2, ["same"]), ordinal: 1 });
    const h2 = hunkInstanceId({ ...baseArgs, filePath: "a.ts", hunk: mkHunk(10, 12, ["same"]), ordinal: 2 });
    expect(h1).not.toBe(h2);
  });

  it("別ファイルの同内容(パスで区別)", () => {
    const h1 = hunkInstanceId({ ...baseArgs, filePath: "a.ts", hunk: mkHunk(1, 2, ["same"]), ordinal: 1 });
    const h2 = hunkInstanceId({ ...baseArgs, filePath: "b.ts", hunk: mkHunk(1, 2, ["same"]), ordinal: 1 });
    expect(h1).not.toBe(h2);
  });

  it("同座標・同内容でも端点revision違いで区別", () => {
    const h1 = hunkInstanceId({ ...baseArgs, filePath: "a.ts", hunk: mkHunk(1, 2, ["same"]), ordinal: 1 });
    const h2 = hunkInstanceId({ ...baseArgs, headRef: "worktree:c", filePath: "a.ts", hunk: mkHunk(1, 2, ["same"]), ordinal: 1 });
    expect(h1).not.toBe(h2);
  });

  it("normalized_changed_lines: 末尾空白のみ正規化", () => {
    const h = mkHunk(1, 2, ["x  ", "y"]);
    expect(normalizedChangedLines(h)).toBe("+x\n+y");
  });
});

describe("hunkJaccard(閾値0.6=S-04境界の単体)", () => {
  it("同一→1.0 / 無関係→低 / 閾値判定", () => {
    expect(hunkJaccard("+const a = 1", "+const a = 1")).toBe(1);
    expect(hunkJaccard("+const a = 1", "+totally different words")).toBeLessThan(JACCARD_THRESHOLD);
    const sim = hunkJaccard("+const value = compute(x)", "+const value = compute(y)");
    expect(sim).toBeGreaterThanOrEqual(JACCARD_THRESHOLD); // 軽微変更は後継接続
  });
});

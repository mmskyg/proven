// 対象: 帰属状態 candidate(docs/spec-lineage-candidate.md REQ-401〜412)
// 期待値は実装アルゴリズムではなく「誰がどの変更をしたか」というシナリオ上の事実から決める。
import { afterEach, describe, expect, it } from "vitest";
import { attributeHunk, computeFileLineage, findContentCandidates, type EventContent } from "../src/ingest/lineage.js";
import { gitNoIndexHunks, type RawHunk } from "../src/ingest/diff.js";
import { isDistinctiveLine, isInformativeLine } from "../src/shared/lines.js";
import { runIngest } from "../src/ingest/ingest.js";
import { openDb } from "../src/store/projections.js";
import { runTriage } from "../src/triage/triage.js";
import { runAsk } from "../src/ask/ask.js";
import { capturedEdit, cleanup, initProven, makeRepo, manualEdit, type Fixture } from "./helpers.js";

let fx: Fixture | undefined;
afterEach(() => {
  if (fx) cleanup(fx);
  fx = undefined;
});

const A = "const cacheLayerHandle = buildCacheLayer(options);";
const B = "  registerCacheInvalidation(cacheLayerHandle, ttlSeconds);";
const filler = (n: number): string => Array.from({ length: n }, (_, i) => `filler-line-${i}`).join("\n");

/** 変更行だけを与えて候補判定を直接見る(diffエンジンの都合に左右されないため) */
function hunkOf(added: string[], removed: string[] = []): RawHunk {
  return { oldStart: 1, oldLines: removed.length, newStart: 1, newLines: added.length, addedLines: added, removedLines: removed };
}
function content(operationId: string, added: string[], removed: string[] = []): EventContent {
  return { operationId, addedLines: added, removedLines: removed, size: added.length + removed.length };
}

describe("候補検出のガード(REQ-403〜408)", () => {
  it("情報量のある連続2行が一致すれば候補(confidence 0.3)", () => {
    const r = findContentCandidates([content("op1", [A, B])], hunkOf([A, B]));
    expect(r).not.toBeNull();
    expect(r!.refs).toEqual(["op1"]);
    expect(r!.confidence).toBe(0.3);
    expect(r!.evidence.runLength).toBeGreaterThanOrEqual(2);
  });

  it("特徴的な1行のみなら候補だがconfidenceは0.2", () => {
    const r = findContentCandidates([content("op1", [A])], hunkOf([A]));
    expect(r!.confidence).toBe(0.2);
  });

  it("追加側と削除側の双方が一致すれば加点(ただし0.4上限・REQ-409)", () => {
    const r = findContentCandidates([content("op1", [A, B], [A + " // old"])], hunkOf([A, B], [A + " // old"]));
    expect(r!.evidence.bothSides).toBe(true);
    expect(r!.confidence).toBeLessThanOrEqual(0.4);
    expect(r!.confidence).toBeGreaterThan(0.3);
  });

  it("`}` だけの一致は候補にしない(REQ-404)", () => {
    expect(findContentCandidates([content("op1", ["}"])], hunkOf(["}"]))).toBeNull();
  });

  it("`return null;` だけの一致は候補にしない(REQ-404)", () => {
    expect(findContentCandidates([content("op1", ["  return null;"])], hunkOf(["  return null;"]))).toBeNull();
  });

  it("定型2行(`if (x) {` + `return null;`)は2行でも候補にしない(REQ-404/405)", () => {
    const lines = ["  if (x) {", "    return null;"];
    expect(findContentCandidates([content("op1", lines)], hunkOf(lines))).toBeNull();
  });

  it("符号違い: イベントが削除した行を、hunkの追加行の一致としない(REQ-403)", () => {
    expect(findContentCandidates([content("op1", [], [A, B])], hunkOf([A, B]))).toBeNull();
  });

  it("多重度: イベントが1回しか作っていない行を、hunkの2回分の一致にしない(REQ-403)", () => {
    // 1行分しか一致しないので、連続2行の条件を満たさず「特徴的な1行」扱いに留まる
    const r = findContentCandidates([content("op1", [A])], hunkOf([A, A]));
    expect(r!.confidence).toBe(0.2);
    expect(r!.evidence.runLength).toBeLessThan(2);
  });

  it("同一内容を2つのイベントが作った場合、1つに断定せずambiguousにする(REQ-407)", () => {
    const r = findContentCandidates([content("op1", [A, B]), content("op2", [A, B])], hunkOf([A, B]));
    expect(r!.refs.sort()).toEqual(["op1", "op2"]);
    expect(r!.evidence.ambiguous).toBe(true);
    expect(r!.confidence).toBeLessThanOrEqual(0.2); // 曖昧なぶん上げない
  });

  it("巨大イベントの偶然ヒットは弱める(REQ-408)", () => {
    const huge = content("op1", [A, B, ...Array.from({ length: 200 }, (_, i) => `unrelated-line-${i}`)]);
    const small = content("op2", [A, B]);
    const rHuge = findContentCandidates([huge], hunkOf([A, B]))!;
    const rSmall = findContentCandidates([small], hunkOf([A, B]))!;
    expect(rHuge.confidence).toBeLessThan(rSmall.confidence);
  });

  it("イベントが無ければ候補なし(REQ-406)", () => {
    expect(findContentCandidates([], hunkOf([A, B]))).toBeNull();
  });

  it("情報量のある一致が無ければ候補なし", () => {
    expect(findContentCandidates([content("op1", [A, B])], hunkOf(["zzz-manual", "yyy-manual"]))).toBeNull();
  });
});

describe("帰属への反映(REQ-401/402/412)", () => {
  /** AIが先頭に作ったブロックを、hook外の編集が末尾へ移動させたケース(連鎖が切れる) */
  function movedBlock(): ReturnType<typeof attributeHunk> {
    const base = `${filler(10)}\n`;
    const afterAi = `top-marker\n${A}\n${B}\n${filler(10)}\n`;
    const head = `${filler(10)}\nbottom-marker\n${A}\n${B}\n`;
    const lineage = computeFileLineage(base, head, [{ operationId: "op1", pre: base, post: afterAi }]);
    const hunks = gitNoIndexHunks(base, head);
    expect(hunks.length).toBe(1);
    return attributeHunk(lineage, hunks[0]);
  }

  it("連鎖が切れても内容一致があればuncapturedではなくcandidateにする", () => {
    const attr = movedBlock();
    expect(attr.status).toBe("candidate");
    expect(attr.refs).toEqual(["op1"]);
    expect(attr.method).toBe("content-match"); // blob-chainと区別して記録する
    expect(attr.confidence as number).toBeLessThanOrEqual(0.4); // 構造的brokenを超えない
  });

  it("非退行: 連鎖が健全ならlinked(1.0)のまま", () => {
    const base = `${filler(5)}\n`;
    const head = `${filler(5)}\n${A}\n`;
    const lineage = computeFileLineage(base, head, [{ operationId: "op1", pre: base, post: head }]);
    const attr = attributeHunk(lineage, gitNoIndexHunks(base, head)[0]);
    expect(attr.status).toBe("linked");
    expect(attr.confidence).toBe(1.0);
    expect(attr.method).toBe("blob-chain");
  });

  it("非退行: 内容一致が無ければ従来どおりuncaptured(refs空・confidence null)", () => {
    const base = `${filler(5)}\n`;
    const head = `${filler(5)}\nzzz-manual-only\n`;
    const lineage = computeFileLineage(base, head, []);
    const attr = attributeHunk(lineage, gitNoIndexHunks(base, head)[0]);
    expect(attr.status).toBe("uncaptured");
    expect(attr.refs).toEqual([]);
    expect(attr.confidence).toBeNull();
  });
});

describe("行の情報量判定(REQ-404/405)", () => {
  it("定型行は非情報的、固有識別子やリテラルを含む行は情報的", () => {
    for (const weak of ["}", "  );", "return null;", "", "   ", "else {", "const x = 1;"]) {
      expect(isInformativeLine(weak)).toBe(false);
    }
    for (const strong of [A, B, 'throw new ProvenError("input", "未対応です");']) {
      expect(isInformativeLine(strong)).toBe(true);
    }
  });

  it("特徴的な1行(長い/長いリテラルを含む)だけがdistinctive", () => {
    expect(isDistinctiveLine(A)).toBe(true);
    expect(isDistinctiveLine("buildCache(opts);")).toBe(false); // 情報量はあるが短い
    expect(isDistinctiveLine("}")).toBe(false);
  });
});

describe("下流の扱い(REQ-411)", () => {
  /** hook外の編集がAIの作ったブロックを移動させ、連鎖が切れた状態のリポジトリ */
  function candidateRepo(): Fixture {
    const f = makeRepo({ "src/a.ts": `${filler(10)}\n` });
    initProven(f);
    capturedEdit(f, "src/a.ts", `top-marker\n${A}\n${B}\n${filler(10)}\n`);
    manualEdit(f, "src/a.ts", `${filler(10)}\nbottom-marker\n${A}\n${B}\n`);
    return f;
  }

  it("ingestの集計でcandidateをlinkedにもuncapturedにも数えず、method/confidenceを永続化する", () => {
    fx = candidateRepo();
    const r = runIngest(fx.ws, {});
    expect(r.candidate).toBeGreaterThan(0);
    const db = openDb(fx.ws);
    const row = db
      .prepare("SELECT lineage_status, method, confidence FROM hunks WHERE lineage_status='candidate' LIMIT 1")
      .get() as { lineage_status: string; method: string; confidence: number } | undefined;
    db.close();
    expect(row).toBeDefined();
    expect(row!.method).toBe("content-match");
    expect(row!.confidence).toBeLessThanOrEqual(0.4);
  });

  it("triageはcandidateを精読対象に含めつつ、uncapturedとは区別して表示する", () => {
    fx = candidateRepo();
    runIngest(fx.ws, {});
    const t = runTriage(fx.ws);
    const row = t.rows.find((r) => r.lineage_status === "candidate");
    expect(row).toBeDefined();
    expect(row!.factors.some((f) => f.factor === "no-lineage")).toBe(true); // 帰属未確定なので精読対象
    expect(row!.edit_capture_status).toBe("captured"); // uncapturedとは区別される
  });

  it("askはcandidateを「hook外の変更」と表示せず、候補として提示する", () => {
    fx = candidateRepo();
    runIngest(fx.ws, {});
    const db = openDb(fx.ws);
    const h = db.prepare("SELECT file, new_start FROM hunks WHERE lineage_status='candidate' LIMIT 1").get() as {
      file: string;
      new_start: number;
    };
    db.close();
    const res = runAsk(fx.ws, `${h.file}:${h.new_start}`, "なぜこの変更?");
    const text = res.sections.observed.join("\n");
    expect(text).not.toContain("hook外の変更");
    expect(text).toContain("候補");
    expect(text).toContain("判定不能");
  });
});

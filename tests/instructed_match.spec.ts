// 対象: 指示判定を対象語の一致数だけで決めない (REQ-831)
import { afterEach, describe, expect, it } from "vitest";
import { instructionMatch, hunkTargets } from "../src/claims/heuristics.js";
import { runIngest } from "../src/ingest/ingest.js";
import { openDb } from "../src/store/projections.js";
import { capturedEdit, cleanup, initProven, makeRepo, writeTranscript, type Fixture } from "./helpers.js";

const fixtures: Fixture[] = [];
function repo(files: Record<string, string> = {}): Fixture {
  const fx = makeRepo(files);
  fixtures.push(fx);
  return fx;
}
afterEach(() => {
  for (const fx of fixtures.splice(0)) cleanup(fx);
});

function targetsOf(file: string, added: string[]) {
  return hunkTargets(file, {
    oldStart: 1,
    oldLines: 0,
    newStart: 1,
    newLines: added.length,
    addedLines: added,
    removedLines: [],
  } as never);
}

function refSupports(fx: Fixture, file: string): string[] {
  const db = openDb(fx.ws);
  try {
    return (
      db
        .prepare(
          `SELECT DISTINCT l.support AS support FROM lineage_links l
             JOIN hunks h ON h.hunk_instance_id = l.hunk_instance_id
            WHERE h.file=? AND l.support IS NOT NULL`,
        )
        .all(file) as { support: string }[]
    ).map((r) => r.support);
  } finally {
    db.close();
  }
}

function hasAuthorRef(fx: Fixture, file: string): boolean {
  return refSupports(fx, file).includes("author");
}

function instructedClaim(fx: Fixture, file: string): { value: string; reason: string } {
  const db = openDb(fx.ws);
  try {
    const row = db
      .prepare(
        `SELECT c.value AS value, c.reason AS reason FROM claims c
           JOIN hunks h ON h.hunk_instance_id = c.hunk_ref
          WHERE c.kind='instructed' AND h.file=? LIMIT 1`,
      )
      .get(file) as { value: string; reason: string } | undefined;
    return row ?? { value: "(なし)", reason: "" };
  } finally {
    db.close();
  }
}

describe("REQ-831-C 否定表現を伴う発話は根拠に採用しない", () => {
  const t = targetsOf("parser.ts", ["export function parseConfigValue() { return fooParserState; }"]);

  it("「〜は変更しないで」では断定しない", () => {
    const m = instructionMatch("parseConfigValue と fooParserState は変更しないで", t);
    expect(m.matched).toBe(false);
    expect(m.suppressed).toBe(true);
  });

  it("同じ文でも別の節にある指示は生き残る", () => {
    // 「Aは触らないで、Bを直して」: 対象語を含む節に否定が無ければ採用してよい
    const m = instructionMatch("ログ出力は変更しないで、parseConfigValue と fooParserState を直して", t);
    expect(m.matched).toBe(true);
    expect(m.suppressed).toBe(false);
  });

  it("「忘れないで」は肯定の指示として扱う", () => {
    const m = instructionMatch("parseConfigValue と fooParserState の修正を忘れないで", t);
    expect(m.matched).toBe(true);
    expect(m.suppressed).toBe(false);
  });

  it("1つの節に否定と対象語が2つ以上あるときは採用しない(係り受けを推測しない)", () => {
    const m = instructionMatch("parseConfigValue を触らず fooParserState を直す", t);
    expect(m.matched).toBe(false);
    expect(m.suppressed).toBe(true);
  });
});

describe("REQ-831-A ファイル名の脚にも汎用語検査を課す", () => {
  it("汎用語幹(index)＋遠い1語では断定しない", () => {
    const t = targetsOf("index.ts", ["const cacheWarmupHandle = 1;"]);
    // "index" は GENERIC_TOKENS だが、旧実装ではファイル名の脚に汎用語検査が無かったため
    // 「index に一致 + 遠い1語」で断定に至っていた
    const m = instructionMatch("index の再構築の件と、あとで cacheWarmupHandle も見ておいて", t);
    expect(m.matched).toBe(false);
  });

  it("拡張子つきのファイル名一致は強い信号として残る", () => {
    const t = targetsOf("parser.ts", ["const cacheWarmupHandle = 1;"]);
    const m = instructionMatch("parser.ts の cacheWarmupHandle を直して", t);
    expect(m.matched).toBe(true);
  });
});

describe("REQ-831-B 会話窓をlinkedEvents[0]に固定しない", () => {
  it("同じhunkにtouchedとauthorが両方紐づくとき、author側の窓の指示を拾う", () => {
    // refs の順序は span 挿入順なので、先頭は「先に触った」イベント(=touched)になる。
    // 旧実装は linkedEvents[0] 固定だったため、そちらのセッション(雑談のみ)を見て
    // 判定不能に落ちていた。author を優先すれば指示が見つかる
    const fx = repo({ "svc.ts": "l1\nl2\nl3\nl4\nl5\n" });
    initProven(fx);
    // 1回目: 雑談セッション。同じ行を中間状態にする(最終hunkには残らない=touched)
    const tr1 = writeTranscript(fx, "s1", [{ role: "user", text: "今日は天気がいいですね" }]);
    capturedEdit(fx, "svc.ts", "l1\nl2\nl3\nl4\n中間状態\n", { transcript: tr1 });
    // 2回目: 明示指示のあるセッションで最終形を書く(=author)。
    // 行は identifier 2つ以上にする。1識別子の短い行は isInformativeLine を通らず
    // author と認められないため、author優先の経路ではなくフォールバックを試すことになる
    const tr2 = writeTranscript(fx, "s2", [
      { role: "user", text: "retryBackoffMillis を svc.ts に追加して" },
    ]);
    capturedEdit(
      fx,
      "svc.ts",
      "l1\nl2\nl3\nl4\nconst retryBackoffMillis = computeBackoffBudget(runtimeConfig);\n",
      { transcript: tr2 },
    );
    runIngest(fx.ws);

    expect(hasAuthorRef(fx, "svc.ts")).toBe(true); // 前提: author優先の経路を通っていること
    expect(instructedClaim(fx, "svc.ts").value).toBe("あり");
  });
});

describe("REQ-831-B M2 探索窓は author の窓に限る(変更より後の発話を入れない)", () => {
  it("同一hunkにauthorと後続のtouchedがあるとき、後続窓の事後の言及で断定しない", () => {
    const fx = repo({ "svc.ts": "l1\nl2\nl3\nl4\nl5\n" });
    initProven(fx);
    // author: 指示のないセッション。identifier 2つ以上で isInformativeLine を通す
    const trA = writeTranscript(fx, "sA", [{ role: "user", text: "今日は天気がいいですね" }]);
    capturedEdit(
      fx,
      "svc.ts",
      "l1\nl2\nl3\nl4\nconst retryBackoffMillis = computeBackoffBudget(runtimeConfig);\n",
      { transcript: trA },
    );
    // touched: 変更「後」の言及があるセッション。隣接に無情報の行を足して同一hunkに畳む。
    // 追加行自体は isInformativeLine を通らないので author にはならない
    const trB = writeTranscript(fx, "sB", [
      { role: "user", text: "retryBackoffMillis と computeBackoffBudget の追加、いいですね" },
    ]);
    capturedEdit(
      fx,
      "svc.ts",
      "l1\nl2\nl3\nl4\nconst retryBackoffMillis = computeBackoffBudget(runtimeConfig);\n// note\n",
      { transcript: trB },
    );
    runIngest(fx.ws);

    // 前提: この hunk が author と touched の両方を持つこと。
    // isInformativeLine を誰かが変えたらここで気づけるようにしておく
    const sup = refSupports(fx, "svc.ts");
    expect(sup).toContain("author");
    expect(sup).toContain("touched");

    // 変更より後の言及なので指示ではない
    expect(instructedClaim(fx, "svc.ts").value).toBe("判定不能");
  });
});

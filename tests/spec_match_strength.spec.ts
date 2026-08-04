// 対象: 仕様一致の強さ(語の識別力・次点との差)と循環参照 (REQ-832)
import { afterEach, describe, expect, it } from "vitest";
import { runIngest } from "../src/ingest/ingest.js";
import { openDb } from "../src/store/projections.js";
import { buildSpecIndex, paragraphFrequency } from "../src/spec/index.js";
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

function specClaims(fx: Fixture, file: string): { value: string; reason: string }[] {
  const db = openDb(fx.ws);
  try {
    return db
      .prepare(
        `SELECT c.value AS value, c.reason AS reason FROM claims c
           JOIN hunks h ON h.hunk_instance_id = c.hunk_ref
          WHERE c.kind='spec_support' AND h.file=?`,
      )
      .all(file) as { value: string; reason: string }[];
  } finally {
    db.close();
  }
}

/** どこにでも auditLogger が出る仕様書。頻出語で紐づけてはいけない */
const COMMON_SPEC = [
  "# 仕様",
  "",
  "REQ-701 認証は auditLogger を使うこと。",
  "",
  "REQ-702 課金は auditLogger を使うこと。",
  "",
  "REQ-703 配信は auditLogger を使うこと。",
  "",
  "REQ-704 検索は auditLogger を使うこと。",
  "",
  "REQ-705 通知は auditLogger を使うこと。",
  "",
].join("\n");

describe("REQ-832-B 語の識別力で判定する", () => {
  it("全段落に出る一般語1件だけでは支持にしない", () => {
    const fx = repo({ "src/app.ts": "l1\nl2\nl3\n", "docs/spec.md": COMMON_SPEC });
    initProven(fx);
    const tr = writeTranscript(fx, "s1", [{ role: "user", text: "無関係の雑談" }]);
    // auditLogger は5段落すべてに出る = 識別力が無い。
    // 旧実装は「本文に1件でも一致すれば支持」だったのでここが支持になっていた
    capturedEdit(fx, "src/app.ts", "l1\nauditLogger.write();\nl3\n", { transcript: tr });
    runIngest(fx.ws);

    const values = specClaims(fx, "src/app.ts").map((c) => c.value);
    expect(values).not.toContain("支持");
  });

  it("頻度の算出が日本語でも動く(トークン列で照合する)", () => {
    const fx = repo({ "docs/spec.md": COMMON_SPEC.replace(/auditLogger/g, "監査ログ") });
    initProven(fx);
    buildSpecIndex(fx.ws);
    // tokens列は2-gram("監査","査ロ","ログ")なので、生の部分文字列照合だと常に0件になる
    const f = paragraphFrequency(fx.ws, "監査ログ");
    expect(f.hits).toBeGreaterThanOrEqual(5);
  });

  it("1段落にしか出ない語なら1件でも支持になる", () => {
    const spec = [
      "# 仕様",
      "",
      "REQ-801 payloadCacheWarmup を導入する。",
      "",
      "REQ-802 認証は監査ログを残すこと。",
      "",
    ].join("\n");
    const fx = repo({ "src/app.ts": "l1\nl2\nl3\n", "docs/spec.md": spec });
    initProven(fx);
    const tr = writeTranscript(fx, "s1", [{ role: "user", text: "無関係の雑談" }]);
    capturedEdit(fx, "src/app.ts", "l1\nconst payloadCacheWarmup = 1;\nl3\n", { transcript: tr });
    runIngest(fx.ws);

    expect(specClaims(fx, "src/app.ts").map((c) => c.value)).toContain("支持");
  });
});

describe("REQ-832-A 仕様書自身の変更を、その仕様書の要求で支持しない", () => {
  it("循環参照は支持にならない", () => {
    const fx = repo({ "docs/spec.md": "# 仕様\n\nREQ-901 payloadCacheWarmup を導入する。\n" });
    initProven(fx);
    const tr = writeTranscript(fx, "s1", [{ role: "user", text: "無関係の雑談" }]);
    // 仕様書自身を編集する。REQ-901 を明示参照するが、それは自分が書いている要求
    capturedEdit(
      fx,
      "docs/spec.md",
      "# 仕様\n\nREQ-901 payloadCacheWarmup を導入する。詳細を追記した。\n",
      { transcript: tr },
    );
    runIngest(fx.ws);

    const claims = specClaims(fx, "docs/spec.md");
    expect(claims.map((c) => c.value)).not.toContain("支持");
    expect(claims.some((c) => c.reason.includes("循環"))).toBe(true);
  });
});

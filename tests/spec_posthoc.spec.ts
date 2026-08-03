// 対象: 後から書いた仕様書を事前の根拠に数えない(docs/spec-setup-gaps.md REQ-824)
import { afterEach, describe, expect, it } from "vitest";
import { runIngest } from "../src/ingest/ingest.js";
import { runTriage } from "../src/triage/triage.js";
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

/** ts_pre はミリ秒精度なので、順序を確実にするため間を空ける */
function tick(): void {
  const until = Date.now() + 5;
  while (Date.now() < until) {
    /* busy wait */
  }
}

function specClaims(fx: Fixture, file: string): { value: string; reason: string }[] {
  const db = openDb(fx.ws);
  try {
    return db
      .prepare(
        `SELECT c.value AS value, c.reason AS reason
           FROM claims c JOIN hunks h ON h.hunk_instance_id = c.hunk_ref
          WHERE c.kind='spec_support' AND h.file=?`,
      )
      .all(file) as { value: string; reason: string }[];
  } finally {
    db.close();
  }
}

function specClaim(fx: Fixture, file: string): { value: string; reason: string } {
  const db = openDb(fx.ws);
  try {
    const row = db
      .prepare(
        `SELECT c.value AS value, c.reason AS reason
           FROM claims c JOIN hunks h ON h.hunk_instance_id = c.hunk_ref
          WHERE c.kind='spec_support' AND h.file=? LIMIT 1`,
      )
      .get(file) as { value: string; reason: string } | undefined;
    return row ?? { value: "(なし)", reason: "" };
  } finally {
    db.close();
  }
}

const SPEC = "# 仕様\n\nREQ-901 payloadCacheを導入する。\n";

describe("REQ-824 仕様書がコードより後なら事後として区別する", () => {
  it("実装→仕様書の順に書いたら 事後 になり、unsolicited候補のまま残る", () => {
    const fx = repo({ "src/app.ts": "l1\nl2\nl3\n" });
    initProven(fx);
    const tr = writeTranscript(fx, "s1", [{ role: "user", text: "無関係の雑談" }]);
    // 先にコードを書く
    capturedEdit(fx, "src/app.ts", "l1\npayloadCache() // REQ-901\nl3\n", { transcript: tr });
    tick();
    // 後から仕様書を足して辻褄を合わせる
    capturedEdit(fx, "docs/spec.md", SPEC, { transcript: tr });
    runIngest(fx.ws);

    const claim = specClaim(fx, "src/app.ts");
    expect(claim.value).toBe("事後");
    expect(claim.reason).toContain("後に書かれており");

    // 事後は essential にならない = レビュー対象として残り続ける
    const row = runTriage(fx.ws).rows.find((r) => r.file === "src/app.ts")!;
    expect(row.necessity).toBe("unsolicited候補");
    expect(row.factors.some((f) => f.factor === "unsolicited-candidate")).toBe(true);
    // 「仕様支持なし」で片付けず、仕様書は在るが後付けである旨を出す
    expect(row.necessityReason).toContain("コードより後に書かれており");
  });

  it("仕様書→実装の順なら 支持 になる", () => {
    const fx = repo({ "src/app.ts": "l1\nl2\nl3\n" });
    initProven(fx);
    const tr = writeTranscript(fx, "s1", [{ role: "user", text: "無関係の雑談" }]);
    capturedEdit(fx, "docs/spec.md", SPEC, { transcript: tr });
    tick();
    capturedEdit(fx, "src/app.ts", "l1\npayloadCache() // REQ-901\nl3\n", { transcript: tr });
    runIngest(fx.ws);

    const claim = specClaim(fx, "src/app.ts");
    expect(claim.value).toBe("支持");
    expect(claim.reason).not.toContain("後に書かれており");
  });

  it("仕様書の編集が捕捉されていなければ断定せず 支持 のまま、未観測と明記する", () => {
    // 最初から存在する(=編集イベントが無い)仕様書。実運用で最も多い形
    const fx = repo({ "src/app.ts": "l1\nl2\nl3\n", "docs/spec.md": SPEC });
    initProven(fx);
    const tr = writeTranscript(fx, "s1", [{ role: "user", text: "無関係の雑談" }]);
    capturedEdit(fx, "src/app.ts", "l1\npayloadCache() // REQ-901\nl3\n", { transcript: tr });
    runIngest(fx.ws);

    const claim = specClaim(fx, "src/app.ts");
    expect(claim.value).toBe("支持");
    expect(claim.reason).toContain("未観測");
  });

  it("REQ-826: 同じファイルを前から触っていても、仕様書より後に書いた行は事後にしない", () => {
    // 実測で出た誤判定の再現。READMEのように朝から何度も触るファイルでは、
    // 「そのファイルの最初の編集」まで遡ると、後から書いた行なのに仕様書より前に見える
    const fx = repo({ "src/app.ts": "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n" });
    initProven(fx);
    const tr = writeTranscript(fx, "s1", [{ role: "user", text: "無関係の雑談" }]);
    // 1) 同じファイルの離れた場所を先に触る(このhunkにとっては touched)
    capturedEdit(fx, "src/app.ts", "早い変更\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n", { transcript: tr });
    tick();
    // 2) 仕様書を書く
    capturedEdit(fx, "docs/spec.md", SPEC, { transcript: tr });
    tick();
    // 3) 仕様書より後に、別の箇所へ実装を書く(このhunkの author)
    capturedEdit(fx, "src/app.ts", "早い変更\nl2\nl3\nl4\nl5\nl6\nl7\npayloadCache() // REQ-901\n", {
      transcript: tr,
    });
    runIngest(fx.ws);

    // このファイルには hunk が2つできるので、どれも事後になっていないことを見る
    const values = specClaims(fx, "src/app.ts").map((c) => c.value);
    expect(values).toContain("支持");
    expect(values).not.toContain("事後");
  });

  it("既存の仕様書へ今回追記した場合は緩い側(先にあった)に倒す", () => {
    const fx = repo({ "src/app.ts": "l1\nl2\nl3\n" });
    initProven(fx);
    const tr = writeTranscript(fx, "s1", [{ role: "user", text: "無関係の雑談" }]);
    capturedEdit(fx, "docs/spec.md", "# 仕様\n\nREQ-900 既存の要求。\n", { transcript: tr });
    tick();
    capturedEdit(fx, "src/app.ts", "l1\npayloadCache() // REQ-901\nl3\n", { transcript: tr });
    tick();
    capturedEdit(fx, "docs/spec.md", `${SPEC}\nREQ-900 既存の要求。\n`, { transcript: tr });
    runIngest(fx.ws);

    // ファイルの初回編集はコードより前なので 支持。段落単位で追わない近似の帰結
    expect(specClaim(fx, "src/app.ts").value).toBe("支持");
  });
});

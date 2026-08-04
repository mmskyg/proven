// 対象: 後から書いた仕様書を事前の根拠に数えない / 発話でない行を指示に数えない
//       (docs/spec-setup-gaps.md REQ-824/826/827)
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runIngest } from "../src/ingest/ingest.js";
import { runTriage } from "../src/triage/triage.js";
import { readClaudeUtterances } from "../src/agents/claudeCode.js";
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

  it("REQ-830: 仕様書は前から在っても、その要求を後から追記したなら事後", () => {
    // REQ-824の初版はファイル単位で見ていたため、このケースを「支持」にしていた。
    // REQ-830 で内容ベースにしたので、要求そのものの前後で判定される。
    // 期待値を閾値に合わせるのではなく、期待値の方が古い近似を写していた
    const fx = repo({ "src/app.ts": "l1\nl2\nl3\n" });
    initProven(fx);
    const tr = writeTranscript(fx, "s1", [{ role: "user", text: "無関係の雑談" }]);
    // V: 仕様書は前から在るが REQ-901 は無い
    capturedEdit(fx, "docs/spec.md", "# 仕様\n\nREQ-900 既存の要求。\n", { transcript: tr });
    tick();
    // T: コードを書く
    capturedEdit(fx, "src/app.ts", "l1\npayloadCache() // REQ-901\nl3\n", { transcript: tr });
    tick();
    // W: 後から REQ-901 を足す(＝後付けの正当化)
    capturedEdit(fx, "docs/spec.md", `${SPEC}\nREQ-900 既存の要求。\n`, { transcript: tr });
    runIngest(fx.ws);

    expect(specClaim(fx, "src/app.ts").value).toBe("事後");
  });

  it("REQ-830 c-1: 決定的な区間に捕捉外の変更があれば事後と断定しない", () => {
    const fx = repo({ "src/app.ts": "l1\nl2\nl3\n" });
    initProven(fx);
    const tr = writeTranscript(fx, "s1", [{ role: "user", text: "無関係の雑談" }]);
    // V: REQ-901 を含まない状態を捕捉
    capturedEdit(fx, "docs/spec.md", "# 仕様\n\nREQ-900 既存の要求。\n", { transcript: tr });
    tick();
    // (V, T] に捕捉外の編集で REQ-901 を足す(hookを通さず直接書く)
    fs.writeFileSync(path.join(fx.dir, "docs/spec.md"), `${SPEC}\nREQ-900 既存の要求。\n`);
    tick();
    // T: コードを書く。この時点では REQ-901 は既に在った
    capturedEdit(fx, "src/app.ts", "l1\npayloadCache() // REQ-901\nl3\n", { transcript: tr });
    runIngest(fx.ws);

    // V の result と head の内容が食い違う = 決定的な区間が観測できていない → 断定しない
    const claim = specClaim(fx, "src/app.ts");
    expect(claim.value).toBe("支持");
    expect(claim.reason).toContain("前後関係は未観測");
  });

  it("REQ-830 c-2: 仕様とコードを同一操作で書いた場合は事後にしない", () => {
    const fx = repo({ "src/app.ts": "l1\nl2\nl3\n" });
    initProven(fx);
    const tr = writeTranscript(fx, "s1", [{ role: "user", text: "無関係の雑談" }]);
    const op = "op_same";
    capturedEdit(fx, "src/app.ts", "l1\npayloadCache() // REQ-901\nl3\n", { transcript: tr, toolUseId: op });
    capturedEdit(fx, "docs/spec.md", SPEC, { transcript: tr, toolUseId: op });
    runIngest(fx.ws);

    expect(specClaim(fx, "src/app.ts").value).toBe("支持");
  });

  it("REQ-830 手順3: 仕様書がコードより後に新規作成された(pre が NULL)なら事後", () => {
    const fx = repo({ "src/app.ts": "l1\nl2\nl3\n" });
    initProven(fx);
    const tr = writeTranscript(fx, "s1", [{ role: "user", text: "無関係の雑談" }]);
    capturedEdit(fx, "src/app.ts", "l1\npayloadCache() // REQ-901\nl3\n", { transcript: tr });
    tick();
    // 仕様書はこの時点で初めて作られる = 最古の捕捉編集の pre_blob_hash が NULL
    capturedEdit(fx, "docs/spec.md", SPEC, { transcript: tr });
    runIngest(fx.ws);

    expect(specClaim(fx, "src/app.ts").value).toBe("事後");
  });
});

describe("REQ-827 role=userでも人の発話でない行は指示として読まない", () => {
  it("コンパクション要約とスラッシュコマンド出力を除き、チャネル経由の発話は残す", () => {
    const fx = repo({ "a.ts": "x\n" });
    const p = path.join(fx.transcriptDir, "t.jsonl");
    fs.writeFileSync(
      p,
      [
        // 本物の発話(Discord経由。isMetaが付くが人の指示)
        JSON.stringify({
          isMeta: true,
          message: {
            role: "user",
            content: '<channel source="plugin:discord:discord" chat_id="1" user="akita">READMEを直して</channel>',
          },
        }),
        // コンパクション要約(機械が書いた要約。技術用語だらけ)
        JSON.stringify({
          isCompactSummary: true,
          message: { role: "user", content: "This session is being continued... sqlite database filter" },
        }),
        // スラッシュコマンドの実行と出力
        JSON.stringify({ message: { role: "user", content: "<command-name>/compact</command-name>" } }),
        JSON.stringify({ message: { role: "user", content: "<local-command-stdout>Compacted</local-command-stdout>" } }),
      ].join("\n") + "\n",
    );
    const got = readClaudeUtterances(p, null, 10).map((u) => u.text);
    expect(got).toHaveLength(1);
    expect(got[0]).toContain("READMEを直して");
    // 伝送メタデータ(全発話に必ず入る固定語)は本文として残さない
    expect(got[0]).not.toContain("discord");
    expect(got[0]).not.toContain("<channel");
  });
});

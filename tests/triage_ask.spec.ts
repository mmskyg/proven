// 対象: N-31〜N-41 / E-34〜E-39
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { ProvenError } from "../src/shared/errors.js";
import { openDb } from "../src/store/projections.js";
import { runIngest } from "../src/ingest/ingest.js";
import { renderTriageMd, renderTriageText, runTriage } from "../src/triage/triage.js";
import { confirmOrigin, recordFinding, renderAsk, runAsk } from "../src/ask/ask.js";
import { verifyDecisionsChain } from "../src/store/events.js";
import { capturedEdit, cleanup, initProven, makeRepo, manualEdit, writeTranscript, type Fixture } from "./helpers.js";

let fx: Fixture;
afterEach(() => cleanup(fx));

function setConfig(mutate: (cfg: Record<string, any>) => void): void {
  const p = path.join(fx.ws.provenDir, "config.yaml");
  const cfg = YAML.parse(fs.readFileSync(p, "utf8"));
  mutate(cfg);
  fs.writeFileSync(p, YAML.stringify(cfg));
}

function standardScenario(): void {
  fx = makeRepo({
    "src/auth/session.ts": "a1\na2\na3\n",
    "src/util.ts": 'import a from "a"\nimport b from "b"\nbody()\n',
    "docs/spec.md": "# 仕様\n\nREQ-001 認証はauthGuardを使う。",
  });
  initProven(fx);
  setConfig((c) => (c.triage = { boundary_paths: ["src/auth/**"] }));
  const tr = writeTranscript(fx, "s1", [{ role: "user", text: "無関係の雑談" }]);
  capturedEdit(fx, "src/auth/session.ts", "a1\nsneakyPersist()\na3\n", { transcript: tr }); // unsolicited候補+境界
  capturedEdit(fx, "src/util.ts", 'import b from "b"\nimport a from "a"\nbody()\n', { transcript: tr }); // incidental
  manualEdit(fx, "README.md", "manual\n"); // uncaptured
  runIngest(fx.ws);
}

describe("triage(N-31〜N-36)", () => {
  it("N-31/N-32/N-33/N-34: 加点合成・内訳表示・軽確認分類・来歴不明加点", () => {
    standardScenario();
    const r = runTriage(fx.ws);
    // 最上位=境界(+40)+unsolicited(+30)=70
    expect(r.rows[0].file).toBe("src/auth/session.ts");
    expect(r.rows[0].score).toBe(70);
    expect(r.rows[0].factors.map((f) => f.factor).sort()).toEqual(["boundary-path", "unsolicited-candidate"]);
    // 全行に内訳(factors配列)がある
    for (const row of r.rows) expect(Array.isArray(row.factors)).toBe(true);
    // incidental→軽確認(-30)
    const inc = r.rows.find((x) => x.file === "src/util.ts")!;
    expect(inc.group).toBe("light");
    expect(inc.factors.some((f) => f.factor === "incidental" && f.points === -30)).toBe(true);
    // uncaptured→来歴不明+25
    const unc = r.rows.find((x) => x.file === "README.md")!;
    expect(unc.factors.some((f) => f.factor === "no-lineage" && f.points === 25)).toBe(true);
    // テキスト表示に内訳と来歴サマリ
    const text = renderTriageText(r);
    expect(text).toContain("boundary-path");
    expect(text).toContain("来歴不明");
  });

  it("N-36: mdレポート(サマリ/精読リスト/来歴内訳/unsolicited一覧)", () => {
    standardScenario();
    const r = runTriage(fx.ws);
    const md = renderTriageMd(r);
    expect(md).toContain("# proven triageレポート");
    expect(md).toContain("## 精読リスト");
    expect(md).toContain("## unsolicited一覧");
    expect(md).toContain("uncaptured");
  });

  it("E-34: ingest未実行はempty(exit 1相当)", () => {
    fx = makeRepo({ "a.ts": "x\n" });
    initProven(fx);
    try {
      runTriage(fx.ws);
      expect.unreachable();
    } catch (e) {
      expect((e as ProvenError).category).toBe("empty");
    }
  });

  it("E-35: 不正glob(boundary_paths)はinput(exit 2相当)", () => {
    fx = makeRepo({ "a.ts": "x\n" });
    initProven(fx);
    manualEdit(fx, "a.ts", "y\n");
    runIngest(fx.ws);
    setConfig((c) => (c.triage = { boundary_paths: [""] })); // 空glob=不正
    try {
      runTriage(fx.ws);
      expect.unreachable();
    } catch (e) {
      expect((e as ProvenError).category).toBe("input");
    }
  });
});

describe("ask(N-37〜N-41 / E-36〜E-38)", () => {
  it("N-37/N-41: 4区分構造・LLM OFFでは推測セクションなし・AI説明は引用+注記", () => {
    fx = makeRepo({ "src/app.ts": "l1\nl2\nl3\n", "docs/spec.md": "# s\n\nREQ-001 sessionStoreを使う。" });
    initProven(fx);
    const tr = writeTranscript(fx, "s1", [
      { role: "user", text: "src/app.ts をsessionStore対応にして" },
      { role: "assistant", text: "sessionStoreを使うよう変更します" },
    ]);
    capturedEdit(fx, "src/app.ts", "l1\nsessionStore()\nl3\n", { transcript: tr });
    runIngest(fx.ws);
    const db = openDb(fx.ws);
    const hunkId = (db.prepare("SELECT hunk_instance_id FROM hunks").get() as { hunk_instance_id: string }).hunk_instance_id;
    db.close();
    const a = runAsk(fx.ws, hunkId, "なぜ?");
    expect(a.sections.observed.length).toBeGreaterThan(0);
    expect(a.sections.aiExplanation[0]).toContain("真の理由の保証ではありません"); // M-10注記
    expect(a.sections.specRelation[0]).toContain("支持");
    expect(a.sections.speculation).toBeNull(); // LLM OFF
    const text = renderAsk(a);
    expect(text).toContain("【観測事実】");
    expect(text).not.toContain("【現在コードからの推測】");
  });

  it("N-38: file:line指定で最新ingestのhunkに解決", () => {
    fx = makeRepo({ "src/app.ts": "l1\nl2\nl3\n" });
    initProven(fx);
    capturedEdit(fx, "src/app.ts", "l1\nCHANGED\nl3\n");
    runIngest(fx.ws);
    const a = runAsk(fx.ws, "src/app.ts:2", "");
    expect(a.file).toBe("src/app.ts");
  });

  it("N-39: confirmで属性単位のorigin_confirmed+チェーン正常+人間確定値が優先表示", () => {
    fx = makeRepo({ "src/app.ts": "l1\nl2\nl3\n" });
    initProven(fx);
    capturedEdit(fx, "src/app.ts", "l1\nX\nl3\n");
    runIngest(fx.ws);
    const db1 = openDb(fx.ws);
    const hunkId = (db1.prepare("SELECT hunk_instance_id FROM hunks").get() as { hunk_instance_id: string }).hunk_instance_id;
    db1.close();
    confirmOrigin(fx.ws, hunkId, "instructed", "yes", "akita@example.com");
    expect(verifyDecisionsChain(fx.ws).ok).toBe(true);
    const a = runAsk(fx.ws, hunkId, "");
    expect(a.sections.specRelation.join("\n")).toContain("人間確定値: instructed=yes");
    // 不正値はinput
    try {
      confirmOrigin(fx.ws, hunkId, "instructed", "maybe", "a");
      expect.unreachable();
    } catch (e) {
      expect((e as ProvenError).category).toBe("input");
    }
  });

  it("N-40: finding記録(unverified/open)", () => {
    fx = makeRepo({ "src/app.ts": "l1\nl2\nl3\n" });
    initProven(fx);
    capturedEdit(fx, "src/app.ts", "l1\nX\nl3\n");
    runIngest(fx.ws);
    const db1 = openDb(fx.ws);
    const hunkId = (db1.prepare("SELECT hunk_instance_id FROM hunks").get() as { hunk_instance_id: string }).hunk_instance_id;
    db1.close();
    const fid = recordFinding(fx.ws, hunkId, "命名が仕様と不一致では?", "manual");
    const db = openDb(fx.ws);
    const f = db.prepare("SELECT verification_level, disposition, reason FROM findings WHERE finding_id=?").get(fid) as {
      verification_level: string;
      disposition: string;
      reason: string;
    };
    expect(f.verification_level).toBe("unverified");
    expect(f.disposition).toBe("open");
    db.close();
  });

  it("E-36/E-38: 存在しないhunk=empty / uncaptured hunkは経緯なし明示", () => {
    fx = makeRepo({ "a.ts": "x\n" });
    initProven(fx);
    manualEdit(fx, "a.ts", "y\n");
    runIngest(fx.ws);
    try {
      runAsk(fx.ws, "deadbeef", "");
      expect.unreachable();
    } catch (e) {
      expect((e as ProvenError).category).toBe("empty");
    }
    const a = runAsk(fx.ws, "a.ts:1", "");
    expect(a.noLineage).toBe(true);
    expect(renderAsk(a)).toContain("経緯情報なし");
  });
});

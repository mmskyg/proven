// 対象: N-46〜N-50 / E-40〜E-46 / U-07(契約部分)
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AirevError } from "../src/shared/errors.js";
import { openDb, rebuild } from "../src/store/projections.js";
import { runIngest } from "../src/ingest/ingest.js";
import { applyGuard, generateGuardPrompt, loadPolicy } from "../src/policy/policy.js";
import { runPrecheck } from "../src/policy/precheck.js";
import { capturedEdit, cleanup, initAirev, makeRepo, manualEdit, writeTranscript, type Fixture } from "./helpers.js";

let fx: Fixture;
afterEach(() => cleanup(fx));

const POLICY_OK = `charter:
  - lens: security
    description: 認証を必ず見る
requirements: "REQ-\\\\d+"
anti_patterns:
  - id: AP-001
    title: 生SQL禁止
    reason: 監査ログが乗らない
    detect: {type: regex, pattern: "SELECT .* FROM"}
    severity: block
expectations:
  - {type: new_dependency_reason}
  - {type: hunk_note_required, when: unsolicited}
  - {type: manual, text: "UI変更はスクショ添付"}
`;

function writePolicy(text: string): void {
  fs.writeFileSync(path.join(fx.ws.airevDir, "policy.yaml"), text);
}

describe("policy(N-46/N-47/E-40〜E-43)", () => {
  it("N-46: 正常policyがRule型(source=policy)へ変換", () => {
    fx = makeRepo({ "a.ts": "x\n" });
    initAirev(fx);
    writePolicy(POLICY_OK);
    const r = loadPolicy(fx.ws)!;
    expect(r.lintErrors.filter((e) => !e.startsWith("警告:"))).toHaveLength(0);
    expect(r.rules[0]).toMatchObject({ rule_id: "AP-001", source: "policy", severity: "block" });
  });

  it("N-47: guard --applyはマーカー区間のみ置換(区間外不変)", () => {
    fx = makeRepo({ "a.ts": "x\n" });
    initAirev(fx);
    writePolicy(POLICY_OK);
    fs.writeFileSync(path.join(fx.dir, "CLAUDE.md"), "# 既存の内容\nkeep-me\n");
    const r = loadPolicy(fx.ws)!;
    applyGuard(fx.ws, generateGuardPrompt(r.policy));
    const md1 = fs.readFileSync(path.join(fx.dir, "CLAUDE.md"), "utf8");
    expect(md1).toContain("keep-me");
    expect(md1).toContain("生SQL禁止");
    // 再適用しても重複しない(マーカー区間置換)
    applyGuard(fx.ws, generateGuardPrompt(r.policy));
    const md2 = fs.readFileSync(path.join(fx.dir, "CLAUDE.md"), "utf8");
    expect(md2.match(/airev:guard start/g)?.length).toBe(1);
  });

  it("E-40: スキーマ違反は全違反列挙", () => {
    fx = makeRepo({ "a.ts": "x\n" });
    initAirev(fx);
    writePolicy("anti_patterns:\n  - id: A\n  - title: B\n"); // 必須キー欠落×複数
    const r = loadPolicy(fx.ws)!;
    expect(r.lintErrors.filter((e) => !e.startsWith("警告:")).length).toBeGreaterThanOrEqual(2);
  });

  it("E-42: コンパイル不能regex→precheckは安全側で中止(exit 2相当)", () => {
    fx = makeRepo({ "a.ts": "x\n" });
    initAirev(fx);
    manualEdit(fx, "a.ts", "y\n");
    writePolicy(`anti_patterns:\n  - id: AP-BAD\n    title: t\n    reason: r\n    detect: {type: regex, pattern: "[invalid"}\n`);
    try {
      runPrecheck(fx.ws);
      expect.unreachable();
    } catch (e) {
      expect((e as AirevError).category).toBe("input");
      expect((e as AirevError).message).toContain("中止");
    }
  });

  it("E-43: learnルールとのrule_id重複はpolicy優先+警告", () => {
    fx = makeRepo({ "a.ts": "x\n" });
    initAirev(fx);
    writePolicy(POLICY_OK);
    fs.writeFileSync(
      path.join(fx.ws.airevDir, "rules", "dup.yaml"),
      `rule_id: AP-001\nsource: learn\nsource_finding_ref: f1\nlanguages: null\nscope: null\npattern: {type: regex, expr: "x"}\nseverity: warn\ndescription: dup\ntest_examples: {positive: [], negative: []}\nowner: null\nexpiry: null\nstats: {applied: 0, hit: 0, false_positive: 0}\n`,
    );
    const r = loadPolicy(fx.ws)!;
    expect(r.lintErrors.some((e) => e.startsWith("警告:") && e.includes("AP-001"))).toBe(true);
    expect(r.rules.filter((x) => x.rule_id === "AP-001")).toHaveLength(1);
    expect(r.rules.find((x) => x.rule_id === "AP-001")!.source).toBe("policy");
  });
});

describe("precheck(N-48〜N-50 / E-41/E-44〜E-46 / U-07)", () => {
  it("N-48/N-49: 新規block違反はgate、既存違反はwarn格下げでgateなし", () => {
    fx = makeRepo({ "db.ts": 'run("SELECT id FROM users")\nok()\n' }); // base時点から違反あり
    initAirev(fx);
    writePolicy(POLICY_OK);
    // 既存違反のみ→gateしない
    manualEdit(fx, "db.ts", 'run("SELECT id FROM users")\nok()\nharmless()\n');
    const r1 = runPrecheck(fx.ws);
    expect(r1.gate).toBe(false);
    const existing = r1.findings.filter((f) => f.lens === "anti_pattern");
    expect(existing.every((f) => f.severity === "warn")).toBe(true); // 既存はwarn格下げ
    // 新規違反追加→gate(tool-confirmed/fail/block)
    manualEdit(fx, "db.ts", 'run("SELECT id FROM users")\nok()\nharmless()\nrun("SELECT * FROM secrets")\n');
    const r2 = runPrecheck(fx.ws);
    expect(r2.gate).toBe(true);
    const nf = r2.findings.find((f) => f.severity === "block")!;
    expect(nf.verification_level).toBe("tool-confirmed");
    expect(nf.outcome).toBe("fail");
    // U-07契約: location/rule_ref/reason/fix_hint
    expect(nf.location?.file).toBe("db.ts");
    expect(typeof nf.location?.line).toBe("number");
    expect(nf.rule_ref).toBe("AP-001");
    expect(nf.reason.length).toBeGreaterThan(0);
    expect(nf.fix_hint).toBeTruthy();
  });

  it("U-07: rebuild後もfindingが完全再現される", () => {
    fx = makeRepo({ "db.ts": "clean()\n" });
    initAirev(fx);
    writePolicy(POLICY_OK);
    manualEdit(fx, "db.ts", 'clean()\nrun("SELECT * FROM t")\n');
    const r = runPrecheck(fx.ws);
    const before = r.findings.filter((f) => f.lens === "anti_pattern").map((f) => ({ ...f }));
    rebuild(fx.ws);
    const db = openDb(fx.ws);
    const rows = db
      .prepare("SELECT rule_ref, location_file, location_line, reason, fix_hint, verification_level FROM findings WHERE lens='anti_pattern'")
      .all() as Record<string, unknown>[];
    db.close();
    expect(rows.length).toBe(before.length);
    expect(rows[0].rule_ref).toBe("AP-001");
    expect(rows[0].fix_hint).toBeTruthy(); // イベントに本体記録→rebuild再現
  });

  it("N-50: expectations機械判定+PR下書き生成+注記で充足", () => {
    fx = makeRepo({ "src/app.ts": "l1\nl2\nl3\n", "package-lock.json": "{}\n" });
    initAirev(fx);
    writePolicy(POLICY_OK);
    const tr = writeTranscript(fx, "s1", [{ role: "user", text: "雑談のみ" }]);
    capturedEdit(fx, "src/app.ts", "l1\nl2\nl3\nsneaky()\n", { transcript: tr }); // unsolicited
    manualEdit(fx, "package-lock.json", '{"new": "dep"}\n'); // lockfile変更
    const r = runPrecheck(fx.ws);
    const dep = r.expectations.find((e) => e.type === "new_dependency_reason")!;
    expect(dep.satisfied).toBe(false); // 理由未記入
    const note = r.expectations.find((e) => e.type === "hunk_note_required")!;
    expect(note.satisfied).toBe(false); // unsolicitedに注記なし
    const man = r.expectations.find((e) => e.type === "manual")!;
    expect(man.satisfied).toBeNull(); // 表示のみ
    expect(fs.existsSync(r.prDraftPath)).toBe(true);
    const draft = fs.readFileSync(r.prDraftPath, "utf8");
    expect(draft).toContain("## 来歴サマリ");
    expect(draft).toContain("## unsolicited変更の理由");
    // 注記を記入→再precheckで充足
    const noted = draft.replace(/\(ここに記入\)/g, "理由を書きました");
    fs.writeFileSync(r.prDraftPath, noted);
    const r2 = runPrecheck(fx.ws);
    expect(r2.expectations.find((e) => e.type === "hunk_note_required")!.satisfied).toBe(true);
    expect(r2.expectations.find((e) => e.type === "new_dependency_reason")!.satisfied).toBe(true);
  });

  it("E-44: policy変更で旧findingはstale化しgate対象外(fresh条件)", () => {
    fx = makeRepo({ "db.ts": "clean()\n" });
    initAirev(fx);
    writePolicy(POLICY_OK);
    manualEdit(fx, "db.ts", 'run("SELECT * FROM t")\n');
    const r1 = runPrecheck(fx.ws);
    expect(r1.gate).toBe(true);
    // policyからAP-001を除去(=旧findingはstale)。違反行はそのまま
    writePolicy("anti_patterns: []\n");
    const r2 = runPrecheck(fx.ws);
    expect(r2.gate).toBe(false); // 旧findingのpolicy_digest不一致→fresh条件を満たさない
  });

  it("E-45: req_coverageはunverifiedでgate対象外", () => {
    fx = makeRepo({ "a.ts": "x\n" });
    initAirev(fx);
    writePolicy("anti_patterns: []\n");
    manualEdit(fx, "a.ts", "y\n");
    const r = runPrecheck(fx.ws);
    const req = r.findings.find((f) => f.lens === "req_coverage")!;
    expect(req.verification_level).toBe("unverified");
    expect(r.gate).toBe(false);
  });

  it("E-46: policyなしでも動作(unsolicited一覧+PR下書き)", () => {
    fx = makeRepo({ "a.ts": "x\n" });
    initAirev(fx);
    manualEdit(fx, "a.ts", "y\n");
    const r = runPrecheck(fx.ws);
    expect(fs.existsSync(r.prDraftPath)).toBe(true);
    expect(r.gate).toBe(false);
  });

  it("E-41: detect.type=llmはskipped明示(黙って無視しない)", () => {
    fx = makeRepo({ "a.ts": "x\n" });
    initAirev(fx);
    writePolicy(`anti_patterns:\n  - id: AP-L\n    title: t\n    reason: r\n    detect: {type: llm, pattern: "設計逸脱を見つけて"}\n    severity: warn\n`);
    manualEdit(fx, "a.ts", "y\n");
    const r = runPrecheck(fx.ws);
    expect(r.warnings.some((w) => w.includes("llm") && w.includes("skipped"))).toBe(true);
  });
});

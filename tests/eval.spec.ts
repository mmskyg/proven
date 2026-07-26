// 対象: AIネイティブ受入計測(emit-cases / submit / report)。U-09の拡張
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ProvenError } from "../src/shared/errors.js";
import { buildCasePack } from "../src/eval/cases.js";
import { reportEval, submitJudgments } from "../src/eval/judgments.js";
import { openDb, rebuild } from "../src/store/projections.js";
import { runIngest } from "../src/ingest/ingest.js";
import { capturedEdit, cleanup, initProven, makeRepo, manualEdit, writeTranscript, type Fixture } from "./helpers.js";

let fx: Fixture;
afterEach(() => cleanup(fx));

function scenario(): { hunkIds: string[]; claimIds: string[] } {
  fx = makeRepo({ "src/app.ts": "l1\nl2\nl3\n", "docs/spec.md": "# 仕様\n\nREQ-001 cacheLayerを使う。" });
  initProven(fx);
  const tr = writeTranscript(fx, "s1", [
    { role: "user", text: "src/app.ts をcacheLayer対応にして" },
    { role: "assistant", text: "cacheLayerを導入します" },
  ]);
  capturedEdit(fx, "src/app.ts", "l1\nconst c = cacheLayer()\nl3\n", { transcript: tr });
  manualEdit(fx, "README.md", "manual\n");
  runIngest(fx.ws);
  const db = openDb(fx.ws);
  const hunkIds = (db.prepare("SELECT hunk_instance_id AS id FROM hunks ORDER BY id").all() as { id: string }[]).map((r) => r.id);
  const claimIds = (
    db.prepare("SELECT claim_id AS id FROM claims WHERE kind IN ('instructed','spec_support') ORDER BY id").all() as {
      id: string;
    }[]
  ).map((r) => r.id);
  db.close();
  return { hunkIds, claimIds };
}

function writeJudgments(entries: { case_id: string; verdict: string; reason?: string }[]): string {
  const p = path.join(os.tmpdir(), `proven-judg-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify({ judgments: entries.map((e) => ({ reason: "", ...e })) }));
  return p;
}

describe("emit-cases(AIエージェント連携契約)", () => {
  it("lineageケースに判定用の証拠一式とrubric・出力契約が含まれる", () => {
    scenario();
    const pack = buildCasePack(fx.ws, "lineage", 50);
    expect(pack.schema_version).toBe(1);
    expect(pack.rubric.length).toBeGreaterThan(0);
    expect(pack.output_contract).toHaveProperty("shape");
    expect(pack.cases.length).toBe(pack.sampled);
    for (const c of pack.cases) {
      expect(c.allowed_verdicts).toEqual(["correct", "incorrect", "unsure"]);
      expect(typeof c.question).toBe("string");
      expect(c.subject).toHaveProperty("tool_says");
      // 判定に必要な証拠: 実diffと帰属イベント、対照用の同ファイル他イベント
      expect(typeof (c.evidence as { hunk_diff: string }).hunk_diff).toBe("string");
      expect((c.evidence as { hunk_diff: string }).hunk_diff).toMatch(/^@@|復元/);
      expect(c.evidence).toHaveProperty("attributed_events");
      expect(c.evidence).toHaveProperty("other_events_on_same_file");
    }
    // capturedなケースにはtranscript引用が付く(P4の根拠提示)
    const captured = pack.cases.find(
      (c) => (c.subject as { tool_says: { edit_capture_status: string } }).tool_says.edit_capture_status === "captured",
    );
    expect(captured).toBeDefined();
    const evs = (captured!.evidence as { attributed_events: { transcript_quotes: unknown[] }[] }).attributed_events;
    expect(evs[0].transcript_quotes.length).toBeGreaterThan(0);
  });

  it("claimsケースは根拠(発話引用・仕様抜粋)を実体化して同梱する", () => {
    scenario();
    const pack = buildCasePack(fx.ws, "claims", 50);
    expect(pack.cases.length).toBeGreaterThan(0);
    const withEvidence = pack.cases.find(
      (c) => ((c.evidence as { claim_evidence: unknown[] }).claim_evidence ?? []).length > 0,
    );
    expect(withEvidence).toBeDefined();
    const ev = (withEvidence!.evidence as { claim_evidence: Record<string, unknown>[] }).claim_evidence[0];
    // transcript由来なら引用文、spec由来なら仕様抜粋が実体化される
    expect(ev.quoted_text !== undefined || ev.spec_excerpt !== undefined).toBe(true);
  });

  it("sample超過は全数に切詰め、ingest未実行はempty", () => {
    const { hunkIds } = scenario();
    expect(buildCasePack(fx.ws, "lineage", 999).sampled).toBe(hunkIds.length);
    cleanup(fx);
    fx = makeRepo({ "a.ts": "x\n" });
    initProven(fx);
    try {
      buildCasePack(fx.ws, "lineage", 10);
      expect.unreachable();
    } catch (e) {
      expect((e as ProvenError).category).toBe("empty");
    }
  });
});

describe("submit/report(検証の格付け=設計原則2)", () => {
  it("AI判定はunverified・人間判定はhuman-confirmedとして区別記録される", () => {
    const { hunkIds } = scenario();
    const aiFile = writeJudgments([{ case_id: hunkIds[0], verdict: "correct" }]);
    const r1 = submitJudgments(fx.ws, "lineage", aiFile, { judge: "ai", actorId: "tester", model: "test-model" });
    expect(r1.accepted).toBe(1);
    expect(r1.verificationLevel).toContain("unverified");
    const humanFile = writeJudgments([{ case_id: hunkIds[1], verdict: "correct" }]);
    submitJudgments(fx.ws, "lineage", humanFile, { judge: "human", actorId: "akita" });
    const db = openDb(fx.ws);
    const rows = db.prepare("SELECT judge, verification_level, model FROM eval_judgments ORDER BY judge").all() as {
      judge: string;
      verification_level: string;
      model: string | null;
    }[];
    db.close();
    expect(rows).toEqual([
      { judge: "ai", verification_level: "unverified", model: "test-model" },
      { judge: "human", verification_level: "human-confirmed", model: null },
    ]);
  });

  it("受入合否は人間確認済みのみで判定し、AI判定だけでは判定不能", () => {
    const { hunkIds } = scenario();
    // AI判定を全件correctで入れても合否は出ない
    submitJudgments(fx.ws, "lineage", writeJudgments(hunkIds.map((id) => ({ case_id: id, verdict: "correct" }))), {
      judge: "ai",
      actorId: "tester",
    });
    const r1 = reportEval(fx.ws, "lineage");
    expect(r1.ai.judged).toBe(hunkIds.length);
    expect(r1.acceptancePassed).toBeNull(); // AI判定だけでは判定しない
    expect(r1.lines.join("\n")).toContain("判定不能");
    // 人間確認を入れると合否が出る
    submitJudgments(fx.ws, "lineage", writeJudgments(hunkIds.map((id) => ({ case_id: id, verdict: "correct" }))), {
      judge: "human",
      actorId: "akita",
    });
    const r2 = reportEval(fx.ws, "lineage");
    expect(r2.acceptancePassed).toBe(true);
    expect(r2.human.rate).toContain("100.0%");
  });

  it("unsureは母数から除外され、AIと人間の不一致・要確認ケースが提示される", () => {
    const { hunkIds } = scenario();
    submitJudgments(
      fx.ws,
      "lineage",
      writeJudgments([
        { case_id: hunkIds[0], verdict: "incorrect" },
        { case_id: hunkIds[1], verdict: "unsure" },
      ]),
      { judge: "ai", actorId: "tester" },
    );
    const r1 = reportEval(fx.ws, "lineage");
    expect(r1.ai.unsure).toBe(1);
    expect(r1.ai.rate).toContain("(0/1)"); // unsureは母数外
    expect(r1.needsHumanReview.sort()).toEqual([hunkIds[0], hunkIds[1]].sort()); // incorrect/unsureは要人間確認
    // 人間がAIと違う判定 → 不一致として提示
    submitJudgments(fx.ws, "lineage", writeJudgments([{ case_id: hunkIds[0], verdict: "correct" }]), {
      judge: "human",
      actorId: "akita",
    });
    const r2 = reportEval(fx.ws, "lineage");
    expect(r2.disagreements).toEqual([{ case_id: hunkIds[0], ai: "incorrect", human: "correct" }]);
    expect(r2.needsHumanReview).toEqual([hunkIds[1]]); // 人間が見たものは要確認から外れる
  });

  it("判定はイベントに記録されrebuildで完全再現する(U-01の不変条件)", () => {
    const { hunkIds } = scenario();
    submitJudgments(fx.ws, "lineage", writeJudgments([{ case_id: hunkIds[0], verdict: "correct" }]), {
      judge: "ai",
      actorId: "tester",
      model: "m1",
    });
    submitJudgments(fx.ws, "lineage", writeJudgments([{ case_id: hunkIds[1], verdict: "incorrect" }]), {
      judge: "human",
      actorId: "akita",
    });
    const before = JSON.stringify(reportEval(fx.ws, "lineage"));
    rebuild(fx.ws);
    expect(JSON.stringify(reportEval(fx.ws, "lineage"))).toBe(before);
  });

  it("不正な判定ファイル・未知case_idを安全に扱う", () => {
    const { hunkIds } = scenario();
    const bad = path.join(os.tmpdir(), `proven-bad-${process.pid}.json`);
    fs.writeFileSync(bad, "{not json");
    try {
      submitJudgments(fx.ws, "lineage", bad, { judge: "ai", actorId: "t" });
      expect.unreachable();
    } catch (e) {
      expect((e as ProvenError).category).toBe("input");
    }
    fs.writeFileSync(bad, JSON.stringify({ wrong_key: [] }));
    try {
      submitJudgments(fx.ws, "lineage", bad, { judge: "ai", actorId: "t" });
      expect.unreachable();
    } catch (e) {
      expect((e as ProvenError).category).toBe("input");
    }
    // 未知case_idは無視しつつ既知分は受理(黙って全体を失敗させない)
    const mixed = writeJudgments([
      { case_id: hunkIds[0], verdict: "correct" },
      { case_id: "deadbeef-unknown", verdict: "correct" },
    ]);
    const r = submitJudgments(fx.ws, "lineage", mixed, { judge: "ai", actorId: "t" });
    expect(r.accepted).toBe(1);
    expect(r.unknownCases).toEqual(["deadbeef-unknown"]);
  });
});

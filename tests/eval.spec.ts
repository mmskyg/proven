// 対象: AIネイティブ受入計測(emit-cases / submit / report)。U-09の拡張
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ProvenError } from "../src/shared/errors.js";
import { attributionBasis, buildCasePack, isInformativeLine } from "../src/eval/cases.js";
import { reportEval, submitJudgments } from "../src/eval/judgments.js";
import { openDb, rebuild } from "../src/store/projections.js";
import { putObject } from "../src/store/objects.js";
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

describe("受入合否の最低サンプル数(REQ-305)", () => {
  /** 25ファイルを1つずつ捕捉つきで編集し、25 hunkの母集団を作る */
  function bigScenario(): string[] {
    fx = makeRepo(Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`src/f${i}.ts`, "a\n"])));
    initProven(fx);
    for (let i = 0; i < 25; i++) capturedEdit(fx, `src/f${i}.ts`, `a\nb${i}\n`);
    runIngest(fx.ws);
    const db = openDb(fx.ws);
    const ids = (db.prepare("SELECT hunk_instance_id AS id FROM hunks ORDER BY id").all() as { id: string }[]).map((r) => r.id);
    db.close();
    return ids;
  }

  it("20件未満はPASSを出さず「サンプル不足」と表示する", () => {
    const ids = bigScenario();
    submitJudgments(
      fx.ws,
      "lineage",
      writeJudgments(ids.slice(0, 19).map((id) => ({ case_id: id, verdict: "correct" }))),
      { judge: "human", actorId: "akita" },
    );
    const r = reportEval(fx.ws, "lineage");
    expect(r.human.correct).toBe(19);
    expect(r.acceptancePassed).toBeNull();
    expect(r.lines.join("\n")).toContain("サンプル不足 19/20");
    expect(r.lines.join("\n")).not.toContain("PASS");
  });

  it("20件以上で基準を満たせばPASSになる", () => {
    const ids = bigScenario();
    submitJudgments(
      fx.ws,
      "lineage",
      writeJudgments(ids.slice(0, 20).map((id) => ({ case_id: id, verdict: "correct" }))),
      { judge: "human", actorId: "akita" },
    );
    const r = reportEval(fx.ws, "lineage");
    expect(r.acceptancePassed).toBe(true);
    expect(r.lines.join("\n")).toContain("PASS");
  });

  it("基準割れは件数が少なくてもFAILとして出す(事実は隠さない)", () => {
    const ids = bigScenario();
    submitJudgments(
      fx.ws,
      "lineage",
      writeJudgments([
        { case_id: ids[0], verdict: "correct" },
        { case_id: ids[1], verdict: "incorrect" },
      ]),
      { judge: "human", actorId: "akita" },
    );
    const r = reportEval(fx.ws, "lineage");
    expect(r.acceptancePassed).toBe(false);
    expect(r.lines.join("\n")).toContain("FAIL");
  });
});

describe("帰属の機械的証拠(REQ-301〜303)", () => {
  it("lineageケースにblobチェーン由来のattribution_basisが入る", () => {
    scenario();
    const pack = buildCasePack(fx.ws, "lineage", 50);
    const captured = pack.cases.find(
      (c) => (c.subject as { tool_says: { edit_capture_status: string } }).tool_says.edit_capture_status === "captured",
    );
    expect(captured).toBeDefined();
    const evs = (
      captured!.evidence as {
        attributed_events: { attribution_basis: { overlap: string; introduced_lines: string[]; event_diff: string; pre_blob: string | null } }[];
      }
    ).attributed_events;
    expect(evs.length).toBeGreaterThan(0);
    const basis = evs[0].attribution_basis;
    // 帰属イベントはhunkの追加行を実際に作っているので overlap は full/partial
    expect(["full", "partial"]).toContain(basis.overlap);
    expect(basis.introduced_lines.length).toBeGreaterThan(0);
    expect(basis.event_diff).toMatch(/^@@/);
    expect(basis.pre_blob).not.toBeNull();
  });

  it("対照用の非帰属イベントにも同じ機械的証拠が付く", () => {
    fx = makeRepo({ "src/a.ts": "l1\nl2\n" });
    initProven(fx);
    capturedEdit(fx, "src/a.ts", "l1\nl2\nadded-by-first\n");
    capturedEdit(fx, "src/other.ts", "x\n");
    runIngest(fx.ws);
    const pack = buildCasePack(fx.ws, "lineage", 50);
    const target = pack.cases.find((c) => (c.subject as { file: string }).file === "src/a.ts");
    expect(target).toBeDefined();
    const others = (
      target!.evidence as { other_events_on_same_file: { attribution_basis?: { overlap: string } }[] }
    ).other_events_on_same_file;
    for (const o of others) expect(o.attribution_basis).toBeDefined();
  });

  it("rubricが機械的証拠を主・会話引用を補助と明示する(REQ-304)", () => {
    scenario();
    const rubric = buildCasePack(fx.ws, "lineage", 5).rubric.join("\n");
    expect(rubric).toContain("attribution_basis");
    expect(rubric).toContain("引用が無いこと自体はunsureの理由になりません");
  });
});

describe("機械的証拠の過剰断定を防ぐ(REQ-308/309)", () => {
  /** 与えた内容でpre/postのblobを作り、attributionBasisへ渡せる形にする */
  function ev(pre: string, post: string): { pre_blob_hash: string; result_blob_hash: string } {
    return {
      pre_blob_hash: putObject(fx.ws, Buffer.from(pre)).hash,
      result_blob_hash: putObject(fx.ws, Buffer.from(post)).hash,
    };
  }

  it("多重度を保つ: イベントが1回しか追加していない行を、hunkの2回分の一致にしない", () => {
    fx = makeRepo({ "a.ts": "x\n" });
    initProven(fx);
    const line = "const veryDistinctIdentifier = computeSomething();";
    const basis = attributionBasis(fx.ws, ev("base\n", `base\n${line}\n`), {
      addedLines: [line, line], // hunk側は2回追加
      removedLines: [],
    });
    expect(basis.introduced_lines).toEqual([line]); // 1回だけ一致
    expect(basis.overlap).toBe("partial"); // fullにしない
  });

  it("符号を区別する: イベントが削除した行を、hunkの追加行の一致としない", () => {
    fx = makeRepo({ "a.ts": "x\n" });
    initProven(fx);
    const line = "const veryDistinctIdentifier = computeSomething();";
    const basis = attributionBasis(fx.ws, ev(`base\n${line}\n`, "base\n"), {
      addedLines: [line],
      removedLines: [],
    });
    expect(basis.introduced_lines).toEqual([]);
    expect(basis.overlap).toBe("none");
  });

  it("定型行だけの一致は情報量ゼロとして数える(単独では証拠にしない)", () => {
    fx = makeRepo({ "a.ts": "x\n" });
    initProven(fx);
    const basis = attributionBasis(fx.ws, ev("base\n", "base\n}\n"), { addedLines: ["}"], removedLines: [] });
    expect(basis.introduced_lines).toEqual(["}"]);
    expect(basis.informative_matches).toBe(0); // overlapは付くが証拠強度はゼロ
  });

  it("isInformativeLine: 定型行は非情報的、固有識別子やリテラルを含む行は情報的", () => {
    for (const weak of ["}", "  );", "return null;", "", "   ", "else {"]) {
      expect(isInformativeLine(weak)).toBe(false);
    }
    for (const strong of [
      "const veryDistinctIdentifier = computeSomething();",
      'throw new ProvenError("input", "指定のハーネスは未対応です");',
      "export function attributionBasis(ws, ev, hunk) {",
    ]) {
      expect(isInformativeLine(strong)).toBe(true);
    }
  });

  it("overlapに意味の限定注記が付き、rubricも十分条件と説明しない", () => {
    fx = makeRepo({ "a.ts": "x\n" });
    initProven(fx);
    const basis = attributionBasis(fx.ws, ev("base\n", "base\nfoo\n"), { addedLines: ["foo"], removedLines: [] });
    expect(basis.overlap_note).toContain("帰属の十分条件ではない");
    scenarioRubric();
  });

  function scenarioRubric(): void {
    cleanup(fx);
    scenario();
    const rubric = buildCasePack(fx.ws, "lineage", 5).rubric.join("\n");
    expect(rubric).toContain("帰属の十分条件ではありません");
    expect(rubric).not.toContain("実際に作ったことを意味します");
  }
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
    // REQ-305: 基準は満たしていても最低サンプル数(20件)に届かないうちはPASSを出さない
    expect(r2.human.rate).toContain("100.0%");
    expect(r2.acceptancePassed).toBeNull();
    expect(r2.lines.join("\n")).toContain("サンプル不足");
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

describe("claim証拠の強化(REQ-601/602/604)", () => {
  it("REQ-601: spec_excerptがトークン列ではなく仕様書の実本文になる", () => {
    scenario();
    const pack = buildCasePack(fx.ws, "claims", 50);
    const withSpec = pack.cases.find((c) =>
      ((c.evidence as { claim_evidence: Record<string, unknown>[] }).claim_evidence ?? []).some(
        (e) => e.type === "spec",
      ),
    );
    expect(withSpec).toBeDefined();
    const ev = (withSpec!.evidence as { claim_evidence: Record<string, unknown>[] }).claim_evidence.find(
      (e) => e.type === "spec",
    )!;
    const excerpt = ev.spec_excerpt as string;
    expect(excerpt).toContain("REQ-001"); // 実本文にはREQ-IDがそのまま入る
    expect(excerpt).toContain("cacheLayer");
    expect(excerpt).not.toMatch(/ケー ーシ シュ/); // 2-gramトークン列になっていない
  });

  it("REQ-602: 判定不能の妥当性を確かめるcontextが付く", () => {
    scenario();
    const pack = buildCasePack(fx.ws, "claims", 50);
    const indeterminate = pack.cases.find((c) => (c.subject as { claim_value: string }).claim_value === "判定不能");
    expect(indeterminate).toBeDefined();
    const ctx = (indeterminate!.evidence as { context: Record<string, unknown> }).context;
    expect(ctx).toBeDefined();
    expect(ctx).toHaveProperty("edit_capture_status");
    expect(ctx).toHaveProperty("transcript_available");
    expect(ctx).toHaveProperty("spec_index");
  });

  it("REQ-604: 長いdiffは打ち切られる", () => {
    fx = makeRepo({ "docs/spec.md": "# s\n\nREQ-001 要件。" });
    initProven(fx);
    capturedEdit(fx, "src/big.ts", Array.from({ length: 200 }, (_, i) => `line-${i}`).join("\n") + "\n");
    runIngest(fx.ws);
    const pack = buildCasePack(fx.ws, "claims", 50);
    const big = pack.cases.find((c) => (c.subject as { location: string }).location.startsWith("src/big.ts"));
    expect(big).toBeDefined();
    const diff = (big!.evidence as { hunk_diff: string }).hunk_diff;
    expect(diff.split("\n").length).toBeLessThanOrEqual(41);
    expect(diff).toContain("行省略");
  });
});

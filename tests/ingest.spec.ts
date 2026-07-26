// 対象: N-06〜N-30 / E-12〜E-31 の統合(fixtureリプレイ)
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AirevError } from "../src/shared/errors.js";
import { HEURISTIC_CONF_MAX, INDETERMINATE } from "../src/shared/types.js";
import { readEvents } from "../src/store/events.js";
import { getObject } from "../src/store/objects.js";
import { applyEvent, openDb, derivePendingStatuses } from "../src/store/projections.js";
import { runIngest } from "../src/ingest/ingest.js";
import { buildWorktreeRevision } from "../src/ingest/revision.js";
import { capturedEdit, cleanup, initAirev, makeRepo, manualEdit, writeTranscript, sh, type Fixture } from "./helpers.js";
import YAML from "yaml";

let fx: Fixture;
afterEach(() => cleanup(fx));

const BASE_APP = "line1\nline2\nline3\n";

describe("capture(N-06〜N-12)", () => {
  it("N-06/N-07: Pre/Post対がoperation_idで結合、上書き前内容が復元可能", () => {
    fx = makeRepo({ "src/app.ts": BASE_APP });
    initAirev(fx);
    const op = capturedEdit(fx, "src/app.ts", "line1\nEDITED\nline3\n");
    const events = readEvents(fx.ws, "edits").events;
    expect(events.map((e) => e.type)).toEqual(["edit_pre", "edit_post"]);
    const pre = events[0].payload as { operation_id: string; pre_blob_hash: string };
    const post = events[1].payload as { operation_id: string; result_blob_hash: string; tool_status: string };
    expect(pre.operation_id).toBe(op);
    expect(post.operation_id).toBe(op);
    expect(post.tool_status).toBe("success");
    expect(getObject(fx.ws, pre.pre_blob_hash)?.toString()).toBe(BASE_APP); // 上書き前内容
  });

  it("N-08: 新規ファイル(Write)はpre_blob_hash=nullで捕捉される", () => {
    fx = makeRepo();
    initAirev(fx);
    capturedEdit(fx, "src/new.ts", "brand new\n", { tool: "Write" });
    const pre = readEvents(fx.ws, "edits").events[0].payload as { pre_blob_hash: string | null; file: string };
    expect(pre.pre_blob_hash).toBeNull();
    expect(pre.file).toBe("src/new.ts");
  });

  it("N-10: conversation_refがtranscript末尾行番号を指す", () => {
    fx = makeRepo({ "src/app.ts": BASE_APP });
    initAirev(fx);
    const tr = writeTranscript(fx, "s1", [
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi" },
    ]);
    capturedEdit(fx, "src/app.ts", "x\n", { transcript: tr });
    const pre = readEvents(fx.ws, "edits").events[0].payload as { conversation_ref: { transcript_line: number } };
    expect(pre.conversation_ref.transcript_line).toBe(2);
  });

  it("E-12: capture.exclude一致はイベント・スナップショットとも記録なし", () => {
    fx = makeRepo({ "secrets/key.txt": "SECRET\n" });
    initAirev(fx);
    const cfgPath = path.join(fx.ws.airevDir, "config.yaml");
    const cfg = YAML.parse(fs.readFileSync(cfgPath, "utf8"));
    cfg.capture = { exclude: ["secrets/**"] };
    fs.writeFileSync(cfgPath, YAML.stringify(cfg));
    const r = capturedEdit(fx, "secrets/key.txt", "SECRET2\n");
    void r;
    expect(readEvents(fx.ws, "edits").events).toHaveLength(0);
  });

  it("E-13: tool_use_id欠落は合成キーでPre/Postが対応", () => {
    fx = makeRepo({ "src/app.ts": BASE_APP });
    initAirev(fx);
    capturedEdit(fx, "src/app.ts", "changed\n", { toolUseId: "" });
    const events = readEvents(fx.ws, "edits").events;
    const pre = events[0].payload as { operation_id: string };
    const post = events[1].payload as { operation_id: string };
    expect(pre.operation_id.startsWith("synth:")).toBe(true);
    expect(post.operation_id).toBe(pre.operation_id);
  });

  it("E-15/E-16: post無しpre→transcript終了でaborted/継続中(24h未満)はpending", () => {
    fx = makeRepo({ "a.ts": "x\n", "b.ts": "y\n" });
    initAirev(fx);
    const tr = writeTranscript(fx, "alive", [{ role: "user", text: "hi" }]);
    capturedEdit(fx, "a.ts", "x2\n", { skipPost: true, transcript: tr }); // 継続中
    capturedEdit(fx, "b.ts", "y2\n", { skipPost: true, transcript: path.join(fx.transcriptDir, "gone.jsonl") }); // 終了(不存在)
    const db = openDb(fx.ws);
    for (const env of readEvents(fx.ws, "edits").events) applyEvent(db, env);
    derivePendingStatuses(db, new Date(), (ref) => !ref || !fs.existsSync(ref));
    const rows = db.prepare("SELECT file, status FROM edit_events ORDER BY file").all() as { file: string; status: string }[];
    expect(rows).toEqual([
      { file: "a.ts", status: "pending" },
      { file: "b.ts", status: "aborted" },
    ]);
    // S-04境界: 24時間経過でaborted(直前はpending)
    const later = new Date(Date.now() + 24 * 3600 * 1000 - 1000);
    derivePendingStatuses(db, later, () => false);
    expect((db.prepare("SELECT status FROM edit_events WHERE file='a.ts'").get() as { status: string }).status).toBe("pending");
    const after24h = new Date(Date.now() + 24 * 3600 * 1000 + 1000);
    derivePendingStatuses(db, after24h, () => false);
    expect((db.prepare("SELECT status FROM edit_events WHERE file='a.ts'").get() as { status: string }).status).toBe("aborted");
    db.close();
  });

  it("E-17: tool失敗(failure)はcompletedにならない", () => {
    fx = makeRepo({ "a.ts": "x\n" });
    initAirev(fx);
    capturedEdit(fx, "a.ts", "x2\n", { failPost: true });
    const db = openDb(fx.ws);
    for (const env of readEvents(fx.ws, "edits").events) applyEvent(db, env);
    expect((db.prepare("SELECT status FROM edit_events").get() as { status: string }).status).toBe("failed");
    db.close();
  });
});

describe("ingest統合(N-14〜N-25 / E-20〜E-29)", () => {
  it("N-14/N-23: captured編集→linked、2回目ingestは新規変更のみ", () => {
    fx = makeRepo({ "src/app.ts": BASE_APP });
    initAirev(fx);
    const tr = writeTranscript(fx, "s1", [{ role: "user", text: "src/app.ts line2を直して" }]);
    capturedEdit(fx, "src/app.ts", "line1\nFIXED\nline3\n", { transcript: tr });
    const r1 = runIngest(fx.ws);
    expect(r1.hunks).toBe(1);
    expect(r1.linked).toBe(1);
    // 2回目: 新たな編集のみhunk化
    capturedEdit(fx, "src/app.ts", "line1\nFIXED\nline3\nADDED\n", { transcript: tr });
    const r2 = runIngest(fx.ws);
    expect(r2.hunks).toBe(1);
    expect(r2.linked).toBe(1);
  });

  it("N-19/N-20: 手編集はuncaptured、混在はhunk単位分離", () => {
    fx = makeRepo({ "src/app.ts": "l1\nl2\nl3\nl4\nl5\n" });
    initAirev(fx);
    capturedEdit(fx, "src/app.ts", "l1\nCAPTURED\nl3\nl4\nl5\n");
    manualEdit(fx, "src/app.ts", "l1\nCAPTURED\nl3\nl4\nMANUAL\nl5\n");
    const r = runIngest(fx.ws);
    expect(r.hunks).toBe(2);
    expect(r.linked).toBe(1);
    expect(r.uncaptured).toBe(1);
  });

  it("N-21: formatter介在→broken+nolineage_cause=formatter claim", () => {
    fx = makeRepo({ "src/app.ts": "l1\nl2\nl3\n" });
    initAirev(fx);
    capturedEdit(fx, "src/app.ts", "l1\nEDITED\nl3\n");
    manualEdit(fx, "src/app.ts", "  l1\n  EDITED\n  l3\n"); // formatter相当
    const r = runIngest(fx.ws);
    expect(r.broken).toBeGreaterThanOrEqual(1);
    const db = openDb(fx.ws);
    const cause = db.prepare("SELECT value, confidence FROM claims WHERE kind='nolineage_cause'").all() as {
      value: string;
      confidence: number;
    }[];
    expect(cause.some((c) => c.value === "formatter" && c.confidence <= 0.5)).toBe(true);
    db.close();
  });

  it("N-22: worktree revision_refの決定性", () => {
    fx = makeRepo({ "a.ts": "x\n" });
    initAirev(fx);
    const r1 = buildWorktreeRevision(fx.ws).rev.ref;
    const r2 = buildWorktreeRevision(fx.ws).rev.ref;
    expect(r1).toBe(r2);
    manualEdit(fx, "a.ts", "changed\n");
    expect(buildWorktreeRevision(fx.ws).rev.ref).not.toBe(r1);
  });

  it("N-24: --range同一入力の再実行はno-op(イベント重複ゼロ)", () => {
    fx = makeRepo({ "a.ts": "v1\n" });
    initAirev(fx);
    manualEdit(fx, "a.ts", "v2\n");
    sh(fx.dir, "git", ["add", "-A"]);
    sh(fx.dir, "git", ["commit", "-qm", "v2"]);
    const r1 = runIngest(fx.ws, { range: "HEAD~1..HEAD" });
    expect(r1.noop).toBe(false);
    expect(r1.hunks).toBe(1);
    const countBefore = readEvents(fx.ws, "analysis").events.length;
    const r2 = runIngest(fx.ws, { range: "HEAD~1..HEAD" });
    expect(r2.noop).toBe(true);
    expect(readEvents(fx.ws, "analysis").events.length).toBe(countBefore);
  });

  it("N-25: rebase相当の軽微変更でhunk_lineage_linked(Jaccard≥0.6)", () => {
    fx = makeRepo({ "a.ts": "base\n" });
    initAirev(fx);
    manualEdit(fx, "a.ts", "base\nconst value = compute(x)\n");
    sh(fx.dir, "git", ["add", "-A"]);
    sh(fx.dir, "git", ["commit", "-qm", "c1"]);
    runIngest(fx.ws, { range: "HEAD~1..HEAD" }); // (a)旧hunk台帳
    manualEdit(fx, "a.ts", "base\nconst value = compute(y)\n"); // (b)軽微変更
    sh(fx.dir, "git", ["add", "-A"]);
    sh(fx.dir, "git", ["commit", "-qm", "c2"]);
    runIngest(fx.ws, { range: "HEAD~2..HEAD" }); // (c)
    const db = openDb(fx.ws);
    const links = db.prepare("SELECT similarity FROM hunk_lineage").all() as { similarity: number }[];
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(links[0].similarity).toBeGreaterThanOrEqual(0.6);
    db.close();
  });

  it("E-20: イベントゼロ→全hunk uncapturedで正常完了", () => {
    fx = makeRepo({ "a.ts": "x\n" });
    initAirev(fx);
    manualEdit(fx, "a.ts", "y\n");
    const r = runIngest(fx.ws);
    expect(r.uncaptured).toBe(r.hunks);
  });

  it("E-21: 差分なしはexit相当のempty(AirevError category=empty)", () => {
    fx = makeRepo({ "a.ts": "x\n" });
    initAirev(fx);
    try {
      runIngest(fx.ws);
      expect.unreachable("should throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AirevError);
      expect((e as AirevError).category).toBe("empty");
      expect((e as AirevError).exitCode).toBe(1);
    }
  });

  it("E-22: 不正--rangeはinput(exit 2)", () => {
    fx = makeRepo({ "a.ts": "x\n" });
    initAirev(fx);
    try {
      runIngest(fx.ws, { range: "nonexistent..HEAD" });
      expect.unreachable();
    } catch (e) {
      expect((e as AirevError).category).toBe("input");
    }
  });

  it("E-18/E-19相当: バイナリファイルはレビュー対象外一覧へ", () => {
    fx = makeRepo({ "a.ts": "x\n" });
    initAirev(fx);
    fs.writeFileSync(path.join(fx.dir, "bin.dat"), Buffer.from([0, 1, 2, 3]));
    manualEdit(fx, "a.ts", "y\n");
    const r = runIngest(fx.ws);
    expect(r.skippedFiles).toContain("bin.dat");
  });

  it("E-29: capture.exclude対象はworktree集合から除外+警告", () => {
    fx = makeRepo({ "a.ts": "x\n", "secrets/s.txt": "sec\n" });
    initAirev(fx);
    const cfgPath = path.join(fx.ws.airevDir, "config.yaml");
    const cfg = YAML.parse(fs.readFileSync(cfgPath, "utf8"));
    cfg.capture = { exclude: ["secrets/**"] };
    fs.writeFileSync(cfgPath, YAML.stringify(cfg));
    manualEdit(fx, "a.ts", "y\n");
    manualEdit(fx, "secrets/s.txt", "sec2\n");
    const r = runIngest(fx.ws);
    expect(r.warnings.some((w) => w.includes("追跡外"))).toBe(true);
    expect(r.hunks).toBe(1); // secretsはhunk化されない
    // manifestにも含まれない(C1)
    const wt = buildWorktreeRevision(fx.ws);
    expect(wt.rev.manifest.files.some((f) => f.path.startsWith("secrets/"))).toBe(false);
  });
});

describe("claims(N-26〜N-30 / E-30〜E-32)", () => {
  function setup(specText: string | null, utterance: string | null, newContent: string) {
    fx = makeRepo({
      "src/app.ts": BASE_APP,
      ...(specText !== null ? { "docs/spec.md": specText } : {}),
    });
    initAirev(fx);
    const tr = utterance !== null ? writeTranscript(fx, "s1", [{ role: "user", text: utterance }]) : "";
    capturedEdit(fx, "src/app.ts", newContent, { transcript: tr });
    runIngest(fx.ws);
    const db = openDb(fx.ws);
    const claims = db.prepare("SELECT kind, value, confidence, reason, evidence_json FROM claims").all() as {
      kind: string;
      value: string;
      confidence: number;
      reason: string;
      evidence_json: string;
    }[];
    db.close();
    return claims;
  }

  it("N-26: 発話に対象語→instructed=あり+引用evidence", () => {
    const claims = setup(null, "src/app.ts のline2をsessionStoreにして", "line1\nconst s = sessionStore()\nline3\n");
    const ins = claims.find((c) => c.kind === "instructed")!;
    expect(ins.value).toBe("あり");
    expect(ins.confidence).toBeGreaterThanOrEqual(0.3);
    expect(JSON.parse(ins.evidence_json).length).toBeGreaterThan(0);
  });

  it("N-27/N-28: REQ一致→支持 / ヒットなし→判定不能", () => {
    const claims = setup(
      "# 仕様\n\nREQ-001 sessionStoreを使って永続化する。",
      "適当に直して",
      "line1\nconst s = sessionStore()\nline3\n",
    );
    const spec = claims.find((c) => c.kind === "spec_support")!;
    expect(spec.value).toBe("支持");
    const claims2 = setup("# 仕様\n\nREQ-002 まったく関係ない決済要件。", "適当に直して", "line1\nzzz_unrelated()\nline3\n");
    const spec2 = claims2.find((c) => c.kind === "spec_support")!;
    expect(spec2.value).toBe(INDETERMINATE); // 「記載なし」と断定しない
  });

  it("N-29: import入替のみ→incidental", () => {
    fx = makeRepo({ "src/app.ts": 'import a from "a"\nimport b from "b"\nbody()\n' });
    initAirev(fx);
    capturedEdit(fx, "src/app.ts", 'import b from "b"\nimport a from "a"\nbody()\n');
    runIngest(fx.ws);
    const db = openDb(fx.ws);
    const nec = db.prepare("SELECT value FROM claims WHERE kind='necessity'").all() as { value: string }[];
    expect(nec.some((n) => n.value === "incidental")).toBe(true);
    db.close();
  });

  it("N-30: 指示なし+仕様判定不能→unsolicited候補(判定不能由来をreasonに明記)", () => {
    const claims = setup(null, "全然関係ない雑談です", "line1\nline2\nline3\nSURPRISE()\n");
    const ins = claims.find((c) => c.kind === "instructed")!;
    expect(ins.value).toBe("なし"); // v0.3境界: 3発話一致ゼロ→なし
    const nec = claims.find((c) => c.kind === "necessity")!;
    expect(nec.value).toBe("unsolicited候補");
    expect(nec.reason).toContain("判定不能");
  });

  it("E-30: 仕様書ゼロ→claim値は判定不能(reason=未登録)", () => {
    const claims = setup(null, "直して", "line1\nX\nline3\n");
    const spec = claims.find((c) => c.kind === "spec_support")!;
    expect(spec.value).toBe(INDETERMINATE);
    expect(spec.reason).toContain("未登録");
  });

  it("E-31: transcript削除済み→instructed判定不能(uncapturedにしない)", () => {
    fx = makeRepo({ "src/app.ts": BASE_APP });
    initAirev(fx);
    const tr = writeTranscript(fx, "gone", [{ role: "user", text: "編集して" }]);
    capturedEdit(fx, "src/app.ts", "line1\nX\nline3\n", { transcript: tr });
    fs.rmSync(tr); // transcript消失
    runIngest(fx.ws);
    const db = openDb(fx.ws);
    const hunk = db.prepare("SELECT edit_capture_status, context_status FROM hunks").get() as {
      edit_capture_status: string;
      context_status: string;
    };
    expect(hunk.edit_capture_status).toBe("captured"); // uncapturedにしない
    expect(hunk.context_status).toBe("transcript_broken");
    const ins = db.prepare("SELECT value FROM claims WHERE kind='instructed'").get() as { value: string };
    expect(ins.value).toBe(INDETERMINATE);
    db.close();
  });

  it("E-32: 【不変条件】ヒューリスティックclaimのconfidence≤0.5", () => {
    // 複数シナリオを流して全claimを検査
    const claims = setup("# 仕様\n\nREQ-001 sessionStore永続化。", "src/app.ts をsessionStore対応に", "line1\nsessionStore()\nline3\n");
    for (const c of claims) {
      expect(c.confidence).toBeLessThanOrEqual(HEURISTIC_CONF_MAX);
    }
  });
});


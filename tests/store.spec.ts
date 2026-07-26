// 対象: N-11/N-39/N-43/N-44/E-01/E-14/E-47/E-48/U-08 + objects/イベントストア
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendEvent, readEvents, rotate, verifyDecisionsChain } from "../src/store/events.js";
import { getObject, isStorable, putObject } from "../src/store/objects.js";
import { applyEvent, openDb, rebuild } from "../src/store/projections.js";
import { runMigrate, runPurge, pct } from "../src/store/maintenance.js";
import { OVERSIZE_BYTES } from "../src/shared/types.js";
import { cleanup, initAirev, makeRepo, type Fixture } from "./helpers.js";

let fx: Fixture;
afterEach(() => cleanup(fx));

describe("objects (content-addressed)", () => {
  it("N-11: 同一内容は1オブジェクトのみ(重複排除)", () => {
    fx = makeRepo();
    initAirev(fx);
    const a = putObject(fx.ws, Buffer.from("hello\n"));
    const b = putObject(fx.ws, Buffer.from("hello\n"));
    expect(a.hash).toBe(b.hash);
    expect(getObject(fx.ws, a.hash)?.toString()).toBe("hello\n");
  });

  it("E-18/E-19: binary・5MB超は本文非保存(マーカーのみ)", () => {
    fx = makeRepo();
    initAirev(fx);
    const bin = putObject(fx.ws, Buffer.from([0x00, 0x01, 0x02]));
    expect(bin.stored).toBe(false);
    const big = putObject(fx.ws, Buffer.alloc(OVERSIZE_BYTES + 1, 97));
    expect(big.stored).toBe(false);
    // 境界: ちょうど5MBはstorable(S-04)
    expect(isStorable(Buffer.alloc(OVERSIZE_BYTES, 97))).toBe(true);
    expect(isStorable(Buffer.alloc(OVERSIZE_BYTES + 1, 97))).toBe(false);
  });
});

describe("イベントストア", () => {
  it("append→read往復・ULID時系列順", () => {
    fx = makeRepo();
    initAirev(fx);
    appendEvent(fx.ws, "analysis", "test_a", { n: 1 });
    appendEvent(fx.ws, "analysis", "test_b", { n: 2 });
    const r = readEvents(fx.ws, "analysis");
    expect(r.events.map((e) => e.type)).toEqual(["test_a", "test_b"]);
    expect(r.corruptLines).toBe(0);
  });

  it("E-01: 破損行はskipしカウント、後続行は正常処理", () => {
    fx = makeRepo();
    initAirev(fx);
    appendEvent(fx.ws, "analysis", "before", {});
    fs.appendFileSync(path.join(fx.ws.airevDir, "events", "analysis.jsonl"), "{{{broken json\n");
    appendEvent(fx.ws, "analysis", "after", {});
    const r = readEvents(fx.ws, "analysis");
    expect(r.corruptLines).toBe(1);
    expect(r.events.map((e) => e.type)).toEqual(["before", "after"]);
  });

  it("N-39: decisionsは全行prev_record_hash連鎖(genesisから)", () => {
    fx = makeRepo();
    initAirev(fx);
    appendEvent(fx.ws, "decisions", "origin_confirmed", { hunk_ref: "h1", attribute: "instructed", confirmed_value: "yes", actor_id: "t" });
    appendEvent(fx.ws, "decisions", "origin_confirmed", { hunk_ref: "h1", attribute: "necessity", confirmed_value: "essential", actor_id: "t" });
    const lines = fs
      .readFileSync(path.join(fx.ws.airevDir, "events", "decisions.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(lines[0].prev_record_hash).toBe("genesis");
    expect(typeof lines[1].prev_record_hash).toBe("string");
    expect(lines[1].prev_record_hash).not.toBe("genesis");
    expect(verifyDecisionsChain(fx.ws).ok).toBe(true);
  });

  it("E-47: 後続行が存在する行の改変を検出(位置を提示)", () => {
    fx = makeRepo();
    initAirev(fx);
    for (let i = 0; i < 3; i++) {
      appendEvent(fx.ws, "decisions", "origin_confirmed", { hunk_ref: `h${i}`, attribute: "instructed", confirmed_value: "yes", actor_id: "t" });
    }
    const p = path.join(fx.ws.airevDir, "events", "decisions.jsonl");
    const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
    const tampered = JSON.parse(lines[0]);
    tampered.payload.confirmed_value = "no"; // 改ざん
    lines[0] = JSON.stringify(tampered);
    fs.writeFileSync(p, lines.join("\n") + "\n");
    const v = verifyDecisionsChain(fx.ws);
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toContain("decisions.jsonl:2"); // 次行との不整合として検出
    expect(v.note).toContain("末尾行");
  });

  it("N-44/U-08: rotate世代切替+世代跨ぎ検証+跨ぎ改変検出", () => {
    fx = makeRepo();
    initAirev(fx);
    appendEvent(fx.ws, "decisions", "origin_confirmed", { hunk_ref: "h1", attribute: "instructed", confirmed_value: "yes", actor_id: "t" });
    const r = rotate(fx.ws, "decisions");
    expect(r.generation).toBe(1);
    expect(fs.existsSync(path.join(fx.ws.airevDir, "events", "archive", r.archived))).toBe(true);
    appendEvent(fx.ws, "decisions", "origin_confirmed", { hunk_ref: "h2", attribute: "necessity", confirmed_value: "essential", actor_id: "t" });
    expect(verifyDecisionsChain(fx.ws).ok).toBe(true);
    // 世代跨ぎで保護される行(generation_started=後続行あり)を改変
    const p = path.join(fx.ws.airevDir, "events", "decisions.jsonl");
    const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
    const gen = JSON.parse(lines[0]);
    expect(gen.type).toBe("generation_started");
    gen.payload.last_record_hash = "0".repeat(64);
    lines[0] = JSON.stringify(gen);
    fs.writeFileSync(p, lines.join("\n") + "\n");
    expect(verifyDecisionsChain(fx.ws).ok).toBe(false);
    // rotateしたイベントもreadEventsで読める(世代跨ぎ読取)
    const all = readEvents(fx.ws, "decisions");
    expect(all.events.filter((e) => e.type === "origin_confirmed").length).toBe(2);
    expect(all.generations).toBe(1);
  });

  it("E-14: 孤児postはprojection行を作らず警告カウント", () => {
    fx = makeRepo();
    initAirev(fx);
    appendEvent(fx.ws, "edits", "edit_post", { operation_id: "no_pre", result_blob_hash: null, tool_status: "success" });
    const r = rebuild(fx.ws);
    expect(r.orphanPosts).toBe(1);
    const db = openDb(fx.ws);
    expect(db.prepare("SELECT COUNT(*) c FROM edit_events").get()).toEqual({ c: 0 });
    db.close();
  });

  it("E-48: migration機構(rename適用・冪等・失敗時非破壊)", () => {
    fx = makeRepo();
    initAirev(fx);
    appendEvent(fx.ws, "analysis", "test_ev", { old_name: 1 });
    const before = fs.readFileSync(path.join(fx.ws.airevDir, "events", "analysis.jsonl"), "utf8");
    // 失敗注入 → 非破壊
    expect(() => runMigrate(fx.ws, { from: 1, to: 2, rename_fields: { test_ev: { old_name: "new_name" } }, fail: true })).toThrow();
    expect(fs.readFileSync(path.join(fx.ws.airevDir, "events", "analysis.jsonl"), "utf8")).toBe(before);
    // 正常適用
    const r1 = runMigrate(fx.ws, { from: 1, to: 2, rename_fields: { test_ev: { old_name: "new_name" } } });
    expect(r1.noop).toBe(false);
    expect(r1.migrated).toBeGreaterThan(0);
    const migrated = readEvents(fx.ws, "analysis").events.find((e) => e.type === "test_ev");
    expect((migrated?.payload as Record<string, unknown>).new_name).toBe(1);
    expect(migrated?.schema_version).toBe(2);
    // 冪等
    const r2 = runMigrate(fx.ws, { from: 1, to: 2 });
    expect(r2.noop).toBe(true);
  });

  it("N-43: purgeはスナップショットのみ削除しイベントは無傷", () => {
    fx = makeRepo();
    initAirev(fx);
    const { hash } = putObject(fx.ws, Buffer.from("old content\n"));
    // 古いイベントとして参照を記録
    const env = appendEvent(fx.ws, "edits", "edit_pre", {
      operation_id: "op1",
      agent: "claude-code",
      session_ref: "",
      file: "a.txt",
      pre_blob_hash: hash,
      tool: "Edit",
      conversation_ref: null,
    });
    // イベントtsを過去に偽装(purge判定はイベントts基準)
    const p = path.join(fx.ws.airevDir, "events", "edits.jsonl");
    const line = JSON.parse(fs.readFileSync(p, "utf8").trim());
    line.ts = "2000-01-01T00:00:00.000Z";
    fs.writeFileSync(p, JSON.stringify(line) + "\n");
    const eventsBefore = fs.readFileSync(p, "utf8");
    const r = runPurge(fx.ws, new Date("2001-01-01"));
    expect(r.deleted).toBeGreaterThanOrEqual(1);
    expect(getObject(fx.ws, hash)).toBeNull(); // スナップショット削除
    expect(fs.readFileSync(p, "utf8")).toBe(eventsBefore); // イベント無傷
    void env;
  });

  it("E-49相当: pctの丸め規則(小数1桁四捨五入・分母併記・n=0)", () => {
    fx = makeRepo(); // afterEach用
    expect(pct(3, 13)).toBe("23.1% (3/13)");
    expect(pct(2, 13)).toBe("15.4% (2/13)");
    expect(pct(0, 0)).toBe("n=0(算出不能)");
  });
});

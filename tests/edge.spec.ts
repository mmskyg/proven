// 追加縁ケース: E-11/E-23a/E-26/E-28/N-45/S-09c
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { OVERSIZE_HUNK_LINES } from "../src/shared/types.js";
import { readEvents } from "../src/store/events.js";
import { openDb } from "../src/store/projections.js";
import { exportProvenance, runPurge } from "../src/store/maintenance.js";
import { runIngest } from "../src/ingest/ingest.js";
import { runTriage } from "../src/triage/triage.js";
import { runCapture } from "../src/capture/capture.js";
import { capturedEdit, cleanup, cli, initAirev, makeRepo, manualEdit, readFileIn, type Fixture } from "./helpers.js";

let fx: Fixture;
afterEach(() => cleanup(fx));

it("E-11: symlinkの実体がリポジトリ外なら捕捉対象外", () => {
  fx = makeRepo({ "a.ts": "x\n" });
  initAirev(fx);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "airev-out-"));
  try {
    fs.writeFileSync(path.join(outside, "real.txt"), "outside\n");
    fs.symlinkSync(path.join(outside, "real.txt"), path.join(fx.dir, "link.txt"));
    const r = runCapture(fx.ws, "pre", {
      session_id: "s",
      cwd: fx.dir,
      tool_name: "Edit",
      tool_input: { file_path: path.join(fx.dir, "link.txt") },
      tool_use_id: "t1",
    });
    expect(r.recorded).toBe(false);
    expect(r.reason).toBe("excluded-or-outside");
    expect(readEvents(fx.ws, "edits").events).toHaveLength(0);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

it("E-23a: gitバイナリ不在はexit 3", () => {
  fx = makeRepo({ "a.ts": "x\n" });
  initAirev(fx);
  const tsx = path.join(process.cwd(), "node_modules", ".bin", "tsx");
  const main = path.join(process.cwd(), "src", "cli", "main.ts");
  // nodeは必要なのでnodeのみのPATHを合成
  const bindir = fs.mkdtempSync(path.join(os.tmpdir(), "airev-bin-"));
  try {
    fs.symlinkSync(process.execPath, path.join(bindir, "node"));
    const r = spawnSync(tsx, [main, "ingest"], { cwd: fx.dir, encoding: "utf8", env: { ...process.env, PATH: bindir }, timeout: 60000 });
    expect(r.status).toBe(3);
  } finally {
    fs.rmSync(bindir, { recursive: true, force: true });
  }
});

it("E-28: 300行超hunkはoversizeフラグ+triage警告(分割しない=Phase 1)", () => {
  fx = makeRepo({ "big.ts": "base\n" });
  initAirev(fx);
  const big = "base\n" + Array.from({ length: OVERSIZE_HUNK_LINES + 10 }, (_, i) => `added-${i}`).join("\n") + "\n";
  manualEdit(fx, "big.ts", big);
  const r = runIngest(fx.ws);
  expect(r.hunks).toBe(1);
  const db = openDb(fx.ws);
  expect((db.prepare("SELECT oversize FROM hunks").get() as { oversize: number }).oversize).toBe(1);
  db.close();
  const t = runTriage(fx.ws);
  expect(t.warnings.some((w) => w.includes("oversize"))).toBe(true);
  expect(t.rows).toHaveLength(1); // 分割されない
});

it("E-26/S-09c: purge済みスナップショット参照はpurged=true表示、lineageはイベントから再構築可", () => {
  fx = makeRepo({ "a.ts": "v1\n" });
  initAirev(fx);
  capturedEdit(fx, "a.ts", "v2\n");
  runIngest(fx.ws);
  // イベントtsを過去に偽装してpurge対象化
  const p = path.join(fx.ws.airevDir, "events", "edits.jsonl");
  const lines = fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const o = JSON.parse(l);
      o.ts = "2000-01-01T00:00:00.000Z";
      return JSON.stringify(o);
    });
  fs.writeFileSync(p, lines.join("\n") + "\n");
  runPurge(fx.ws, new Date("2001-01-01"));
  exportProvenance(fx.ws);
  const prov = fs
    .readFileSync(path.join(fx.ws.airevDir, "exports", "provenance.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const withPurged = prov.filter((r: { snapshot_refs: { purged: boolean }[] }) => r.snapshot_refs.some((s) => s.purged));
  expect(withPurged.length).toBeGreaterThanOrEqual(1); // purged=true が表示される
  // lineage情報自体はイベントから維持されている
  const db = openDb(fx.ws);
  expect((db.prepare("SELECT COUNT(*) c FROM lineage_links").get() as { c: number }).c).toBeGreaterThanOrEqual(1);
  db.close();
});

it("N-45: config llm.enabled true は送信対象プレビューを表示して反映", () => {
  fx = makeRepo();
  initAirev(fx);
  const r = cli(fx.dir, ["config", "llm.enabled", "true"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("送信対象");
  expect(r.stdout).toContain("除外");
  expect(readFileIn(fx, ".airev/config.yaml")).toContain("enabled: true");
});

it("nested repo: captureは編集ファイル基準でリポジトリ解決(cwdが外側でも内側の.airevへ)", () => {
  // 外側repo(=.airev未初期化)の中に内側repo(airev init済み)を作る
  fx = makeRepo();
  const inner = path.join(fx.dir, "inner");
  fs.mkdirSync(inner);
  spawnSync("git", ["init", "-q"], { cwd: inner });
  spawnSync("git", ["-C", inner, "config", "user.email", "t@e.com"]);
  spawnSync("git", ["-C", inner, "config", "user.name", "t"]);
  fs.writeFileSync(path.join(inner, "a.ts"), "x\n");
  spawnSync("git", ["-C", inner, "add", "-A"]);
  spawnSync("git", ["-C", inner, "commit", "-qm", "i"]);
  const r0 = cli(inner, ["init", "--yes"]);
  expect(r0.code).toBe(0);
  const input = JSON.stringify({
    session_id: "s",
    cwd: fx.dir, // ← 外側をcwdにする(ネスト誤帰属の再現条件)
    tool_name: "Edit",
    tool_input: { file_path: path.join(inner, "a.ts") },
    tool_use_id: "t_nested",
  });
  expect(cli(fx.dir, ["capture", "--phase", "pre"], input).code).toBe(0);
  const innerEvents = path.join(inner, ".airev", "events", "edits.jsonl");
  expect(fs.existsSync(innerEvents)).toBe(true); // 内側の.airevに記録される
  expect(fs.readFileSync(innerEvents, "utf8")).toContain("t_nested");
});

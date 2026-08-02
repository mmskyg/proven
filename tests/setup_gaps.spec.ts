// 対象: 設定の穴が静かに結果を劣化させる問題 REQ-820/821/822/823
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { globalClaudeSettingsPath, runInit } from "../src/cli/init.js";
import { pendingDecisions } from "../src/shared/decisions.js";
import { loadConfig, saveConfig } from "../src/shared/config.js";
import { buildWorktreeRevision } from "../src/ingest/revision.js";
import { cleanup, makeRepo, type Fixture } from "./helpers.js";

const fixtures: Fixture[] = [];
function repo(files: Record<string, string> = {}): Fixture {
  const fx = makeRepo(files);
  fixtures.push(fx);
  return fx;
}
afterEach(() => {
  for (const fx of fixtures.splice(0)) cleanup(fx);
});

describe("REQ-822 exclude件数はproven自身を数えない", () => {
  it(".proven/config.yaml がgit管理下でも exclude 0件のまま", () => {
    const fx = repo({ "a.ts": "export const a = 1;\n" });
    runInit(fx.ws, { yes: true, isTTY: false });
    // 実運用と同じく .proven/config.yaml を追跡対象に入れる
    fs.writeFileSync(path.join(fx.dir, ".gitignore"), ".proven/events/\n.proven/objects/\n");
    const { excludedCount } = buildWorktreeRevision(fx.ws);
    expect(excludedCount).toBe(0);
  });

  it("利用者が capture.exclude で外したファイルは数える", () => {
    const fx = repo({ "a.ts": "export const a = 1;\n", "secret.txt": "x\n" });
    runInit(fx.ws, { yes: true, isTTY: false });
    const cfg = loadConfig(fx.ws.provenDir);
    cfg.capture.exclude = ["secret.txt"];
    saveConfig(fx.ws.provenDir, cfg);
    expect(buildWorktreeRevision(fx.ws).excludedCount).toBe(1);
  });
});

describe("REQ-821 仕様書が1件も当たらないことを黙って通さない", () => {
  it("仕様書ゼロなら『REQ-IDが無い』ではなく置き場の問題として出す", () => {
    const fx = repo({ "README.md": "# root にしか仕様書が無いリポジトリ\n" });
    const r = runInit(fx.ws, { yes: true, isTTY: false });
    const joined = r.messages.join("\n");
    expect(joined).toContain("spec_sources");
    expect(joined).not.toContain("REQ-xxx形式のIDが見つかりません");
  });

  it("仕様書が有ってREQ-IDだけ無い場合は従来どおりIDの話をする", () => {
    const fx = repo({ "docs/spec.md": "# 仕様\n\n本文だけでIDは無い\n" });
    const r = runInit(fx.ws, { yes: true, isTTY: false });
    const joined = r.messages.join("\n");
    expect(joined).toContain("REQ-xxx形式のIDが見つかりません");
  });
});

describe("REQ-823 未決の設定は決め方つきで読み上げる", () => {
  it("初期状態では reviewer_id / spec_sources / policy / boundary_paths が未決", () => {
    const fx = repo({ "a.ts": "export const a = 1;\n" });
    runInit(fx.ws, { yes: true, isTTY: false });
    const keys = pendingDecisions(fx.ws).map((d) => d.key);
    expect(keys).toContain("reviewer_id");
    expect(keys).toContain("spec_sources");
    expect(keys).toContain("policy");
    expect(keys).toContain("triage.boundary_paths");
  });

  it("決めた項目は消える", () => {
    const fx = repo({ "docs/spec.md": "# REQ-001 仕様\n" });
    runInit(fx.ws, { yes: true, isTTY: false });
    const cfg = loadConfig(fx.ws.provenDir);
    cfg.reviewer_id = "akita";
    cfg.triage.boundary_paths = ["src/auth/**"];
    saveConfig(fx.ws.provenDir, cfg);
    fs.writeFileSync(path.join(fx.dir, ".proven", "policy.yaml"), "version: 1\nrules: []\n");
    expect(pendingDecisions(fx.ws)).toEqual([]);
  });

  it("未決には『何が起きるか』と『決め方』が必ず付く", () => {
    const fx = repo({ "a.ts": "export const a = 1;\n" });
    runInit(fx.ws, { yes: true, isTTY: false });
    for (const d of pendingDecisions(fx.ws)) {
      expect(d.risk.length).toBeGreaterThan(0);
      expect(d.howTo.length).toBeGreaterThan(0);
    }
  });

  it("initの出力に未決が載る", () => {
    const fx = repo({ "a.ts": "export const a = 1;\n" });
    const r = runInit(fx.ws, { yes: true, isTTY: false });
    expect(r.messages.some((m) => m.startsWith("未決: "))).toBe(true);
  });
});

describe("REQ-820 hookの登録先とその限界", () => {
  it("既定(リポジトリ内)ではcwd依存であることを警告する", () => {
    const fx = repo({ "a.ts": "export const a = 1;\n" });
    const r = runInit(fx.ws, { yes: true, isTTY: false });
    const joined = r.messages.join("\n");
    expect(joined).toContain("このリポジトリをcwdにして起動したセッションだけ");
    expect(joined).toContain("--global");
  });

  it("--global はユーザー全体設定へ書き、cwd非依存だと伝える", () => {
    const fx = repo({ "a.ts": "export const a = 1;\n" });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "proven-home-"));
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = home;
    try {
      const r = runInit(fx.ws, { yes: true, isTTY: false, global: true, agents: ["claude-code"] });
      const settingsPath = globalClaudeSettingsPath();
      expect(settingsPath).toBe(path.join(home, "settings.json"));
      const written = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      const cmds = JSON.stringify(written.hooks);
      expect(cmds).toContain("proven capture --phase pre");
      expect(cmds).toContain("proven capture --phase post");
      // リポジトリ側には書かない
      expect(fs.existsSync(path.join(fx.dir, ".claude", "settings.json"))).toBe(false);
      expect(r.messages.join("\n")).toContain("どのディレクトリで起動したセッションからでも");
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prev;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

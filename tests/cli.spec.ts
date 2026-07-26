// 対象: S-06 F-00マトリクス(exit code/JSON純度/非TTY) / N-01〜N-05 / E-02/E-03/E-07/E-08/E-10/E-23b/E-49 / S-10
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, cli, initAirev, makeRepo, manualEdit, readFileIn, type Fixture } from "./helpers.js";

let fx: Fixture;
afterEach(() => cleanup(fx));

describe("init(N-01〜N-05 / S-10)", () => {
  it("N-01/N-02: --yesで既定値初期化・llm.enabled=false・0700/0600", () => {
    fx = makeRepo({ "docs/spec.md": "# s\n\nREQ-001 要件。" });
    const r = cli(fx.dir, ["init", "--yes"]);
    expect(r.code).toBe(0);
    const cfg = readFileIn(fx, ".airev/config.yaml");
    expect(cfg).toContain("enabled: false");
    const st = fs.statSync(path.join(fx.dir, ".airev"));
    expect(st.mode & 0o777).toBe(0o700);
  });

  it("N-03/N-04: hooksラッパー登録(既存保持)+.airev/前置の.gitignore", () => {
    fx = makeRepo();
    const settingsPath = path.join(fx.dir, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] } }));
    const r = cli(fx.dir, ["init", "--yes"]);
    expect(r.code).toBe(0);
    const settings = JSON.parse(readFileIn(fx, ".claude/settings.json"));
    const preCmds = settings.hooks.PreToolUse.flatMap((e: any) => e.hooks.map((h: any) => h.command));
    expect(preCmds).toContain("echo hi"); // 既存保持
    expect(preCmds.some((c: string) => c.includes("airev capture --phase pre") && c.includes("|| true"))).toBe(true); // 失敗封じ込めラッパー
    const gi = readFileIn(fx, ".gitignore");
    expect(gi).toContain(".airev/events/");
    expect(gi).toContain(".airev/objects/");
    expect(gi).not.toMatch(/^events\/$/m); // 無関係な同名dirをignoreしない
  });

  it("N-05a/N-05b: REQあり登録 / REQなしは運用提案", () => {
    fx = makeRepo({ "docs/spec.md": "# s\n\nREQ-001 要件。" });
    const r1 = cli(fx.dir, ["init", "--yes"]);
    expect(r1.stdout).not.toContain("REQ-xxx形式のIDが見つかりません");
    cleanup(fx);
    fx = makeRepo({ "docs/spec.md": "# s\n\nIDなしの仕様。" });
    const r2 = cli(fx.dir, ["init", "--yes"]);
    expect(r2.stdout).toContain("REQ-xxx形式のIDが見つかりません");
  });

  it("S-10: init再実行で重複追記なし / 不正settings.jsonは非破壊でexit 2", () => {
    fx = makeRepo();
    cli(fx.dir, ["init", "--yes"]);
    cli(fx.dir, ["init", "--yes"]);
    const gi = readFileIn(fx, ".gitignore");
    expect(gi.match(/\.airev\/events\//g)?.length).toBe(1);
    const settings = JSON.parse(readFileIn(fx, ".claude/settings.json"));
    const cmds = settings.hooks.PreToolUse.flatMap((e: any) => e.hooks.map((h: any) => h.command));
    expect(cmds.filter((c: string) => c.includes("airev capture")).length).toBe(1);
    // 不正JSON
    cleanup(fx);
    fx = makeRepo();
    const sp = path.join(fx.dir, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, "{broken json");
    const r = cli(fx.dir, ["init", "--yes"]);
    expect(r.code).toBe(2);
    expect(readFileIn(fx, ".claude/settings.json")).toBe("{broken json"); // 非破壊
  });

  it("E-03: 非TTYで--yesなしはexit 2", () => {
    fx = makeRepo();
    const r = cli(fx.dir, ["init"]);
    expect(r.code).toBe(2);
  });
});

describe("F-00マトリクス(S-06サブセット)", () => {
  it("E-07: 未知サブコマンド/不正フラグはexit 2", () => {
    fx = makeRepo();
    expect(cli(fx.dir, ["nonexistent"]).code).toBe(2);
    expect(cli(fx.dir, ["ingest", "--bogus-flag"]).code).toBe(2);
  });

  it("E-21/E-34: 正常系空振りはexit 1", () => {
    fx = makeRepo({ "a.ts": "x\n" });
    initAirev(fx);
    expect(cli(fx.dir, ["ingest"]).code).toBe(1); // 差分なし
    expect(cli(fx.dir, ["triage"]).code).toBe(1); // ingest未実行
  });

  it("E-23b: git管理外はexit 2", () => {
    fx = makeRepo();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "airev-outside-"));
    try {
      const r = cli(outside, ["ingest"]);
      expect(r.code).toBe(2);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("E-49: purge不正日付はexit 2", () => {
    fx = makeRepo();
    initAirev(fx);
    expect(cli(fx.dir, ["purge", "--before", "not-a-date"]).code).toBe(2);
  });

  it("E-02: projections.db破壊はexit 4+rebuild案内", () => {
    fx = makeRepo({ "a.ts": "x\n" });
    initAirev(fx);
    manualEdit(fx, "a.ts", "y\n");
    cli(fx.dir, ["ingest"]);
    fs.writeFileSync(path.join(fx.dir, ".airev", "projections.db"), "garbage-not-sqlite");
    for (const suffix of ["-wal", "-shm"]) {
      const f = path.join(fx.dir, ".airev", `projections.db${suffix}`);
      if (fs.existsSync(f)) fs.rmSync(f);
    }
    const r = cli(fx.dir, ["triage"]);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain("rebuild");
  });

  it("--json純度: stdoutはJSONのみ(エンベロープ付き)", () => {
    fx = makeRepo({ "a.ts": "x\n" });
    initAirev(fx);
    manualEdit(fx, "a.ts", "y\n");
    const r = cli(fx.dir, ["ingest", "--json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout); // パース失敗=純度違反
    expect(parsed.schema_version).toBe(1);
    expect(parsed.command).toBe("ingest");
    expect(parsed.status).toBe("ok");
    expect(parsed).toHaveProperty("data");
    expect(parsed).toHaveProperty("warnings");
  });

  it("precheck gate: block違反でexit 10", () => {
    fx = makeRepo({ "db.ts": "clean()\n" });
    initAirev(fx);
    fs.writeFileSync(
      path.join(fx.dir, ".airev", "policy.yaml"),
      'anti_patterns:\n  - id: AP-001\n    title: 生SQL\n    reason: r\n    detect: {type: regex, pattern: "SELECT .* FROM"}\n    severity: block\n',
    );
    manualEdit(fx, "db.ts", 'run("SELECT * FROM t")\n');
    const r = cli(fx.dir, ["precheck"]);
    expect(r.code).toBe(10);
  });
});

describe("capture無害性(E-08/E-10/U-06aの単体)", () => {
  it("E-08: transcript不在でもexit 0+capture-errors.logなし(正常記録)or記録", () => {
    fx = makeRepo({ "a.ts": "x\n" });
    initAirev(fx);
    const input = JSON.stringify({
      session_id: "s",
      transcript_path: "/nonexistent/tr.jsonl",
      cwd: fx.dir,
      tool_name: "Edit",
      tool_input: { file_path: path.join(fx.dir, "a.ts") },
      tool_use_id: "t1",
    });
    const r = cli(fx.dir, ["capture", "--phase", "pre"], input);
    expect(r.code).toBe(0);
  });

  it("E-10: リポジトリ外ファイルは記録せずexit 0", () => {
    fx = makeRepo();
    initAirev(fx);
    const input = JSON.stringify({
      session_id: "s",
      cwd: fx.dir,
      tool_name: "Edit",
      tool_input: { file_path: "/etc/hostname" },
      tool_use_id: "t1",
    });
    const r = cli(fx.dir, ["capture", "--phase", "pre"], input);
    expect(r.code).toBe(0);
    const p = path.join(fx.dir, ".airev", "events", "edits.jsonl");
    expect(!fs.existsSync(p) || fs.readFileSync(p, "utf8").trim() === "").toBe(true); // 何も記録しない
  });

  it("U-06a単体: 壊れたstdin・objects書込不可でもexit 0", () => {
    fx = makeRepo({ "a.ts": "x\n" });
    initAirev(fx);
    expect(cli(fx.dir, ["capture", "--phase", "pre"], "not json at all").code).toBe(0);
    // objects書込不可
    const objDir = path.join(fx.dir, ".airev", "objects");
    fs.chmodSync(objDir, 0o500);
    try {
      const input = JSON.stringify({
        session_id: "s",
        cwd: fx.dir,
        tool_name: "Edit",
        tool_input: { file_path: path.join(fx.dir, "a.ts") },
        tool_use_id: "t2",
      });
      expect(cli(fx.dir, ["capture", "--phase", "pre"], input).code).toBe(0);
    } finally {
      fs.chmodSync(objDir, 0o700);
    }
  });

  it("U-06b: hookラッパーはバイナリ不在でも編集をブロックしない(|| true封じ込め)", () => {
    fx = makeRepo();
    initAirev(fx);
    const settings = JSON.parse(readFileIn(fx, ".claude/settings.json"));
    const cmd: string = settings.hooks.PreToolUse.flatMap((e: any) => e.hooks.map((h: any) => h.command)).find((c: string) =>
      c.includes("airev capture"),
    );
    // airevバイナリが存在しない環境でラッパーコマンドを実行(PATHから消す)
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const code = (() => {
      try {
        execSync(cmd, { cwd: fx.dir, env: { PATH: "/usr/bin:/bin" }, stdio: "pipe" });
        return 0;
      } catch (e: any) {
        return e.status ?? 1;
      }
    })();
    expect(code).toBe(0); // || true により常に0
  });
});

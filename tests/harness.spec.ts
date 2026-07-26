// 対象: マルチハーネス対応(docs/spec-multi-harness.md) REQ-201/205〜228/230〜232
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { hookCommand, isLegacyHookCommand } from "../src/cli/init.js";
import { runCapture } from "../src/capture/capture.js";
import { resolveAgent, filesFromPatch } from "../src/agents/index.js";
import { runIngest } from "../src/ingest/ingest.js";
import { openDb } from "../src/store/projections.js";
import { cleanup, cli, initProven, makeRepo, provenShimDir, readFileIn, sh, type Fixture } from "./helpers.js";

/** edits.jsonlを読む */
function editEvents(fx: Fixture): { type: string; payload: Record<string, unknown> }[] {
  return readFileIn(fx, ".proven/events/edits.jsonl")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** codexのPreToolUse/PostToolUse payload(実測形) */
function codexPayload(phase: "pre" | "post", patch: string, opId: string, transcript: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    session_id: "019f9e28-8026",
    turn_id: "019f9e28-8106",
    transcript_path: transcript,
    cwd: "/tmp",
    hook_event_name: phase === "pre" ? "PreToolUse" : "PostToolUse",
    model: "gpt-5.6-sol",
    permission_mode: "bypassPermissions",
    tool_name: "apply_patch",
    tool_input: { command: patch },
    tool_use_id: opId,
  };
  if (phase === "post") base.tool_response = "Exit code: 0\nOutput:\nSuccess. Updated the following files:\n";
  return base;
}

let fx: Fixture | undefined;
afterEach(() => {
  if (fx) cleanup(fx);
  fx = undefined;
});

const LEGACY_PRE = `sh -c 'proven capture --phase pre 2>>.proven/logs/capture-errors.log || true'`;

describe("hookコマンドのcwd非依存(REQ-230/232)", () => {
  it("REQ-230: hookコマンドに相対パスのリダイレクトを含まない", () => {
    for (const phase of ["pre", "post"] as const) {
      expect(hookCommand(phase)).not.toContain(".proven/");
      expect(isLegacyHookCommand(hookCommand(phase))).toBe(false);
    }
    expect(isLegacyHookCommand(LEGACY_PRE)).toBe(true);
  });

  it("REQ-232: cwdがリポジトリ外でも登録済みhookコマンド経由で捕捉される", () => {
    fx = makeRepo({ "src/a.ts": "const a = 1;\n" });
    initProven(fx);
    const shimDir = provenShimDir();
    const outsideCwd = fs.mkdtempSync(path.join(os.tmpdir(), "proven-outside-"));
    const abs = path.join(fx.dir, "src/a.ts");
    const payload = JSON.stringify({
      session_id: "s1",
      transcript_path: "",
      cwd: outsideCwd, // ハーネスのセッションcwdがリポジトリ外
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: abs },
      tool_use_id: "tu_outside_1",
    });

    // 登録されている文字列そのものを実行する(改変しない)
    const r = spawnSync("sh", ["-c", hookCommand("pre")], {
      cwd: outsideCwd,
      input: payload,
      encoding: "utf8",
      env: { ...process.env, PATH: `${shimDir}:${process.env.PATH ?? ""}` },
      timeout: 60000,
    });
    expect(r.status).toBe(0);

    const events = readFileIn(fx, ".proven/events/edits.jsonl")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const pre = events.filter((e) => e.type === "edit_pre");
    expect(pre.length).toBe(1);
    expect(pre[0].payload.operation_id).toBe("tu_outside_1");
    expect(pre[0].payload.file).toBe("src/a.ts");

    fs.rmSync(shimDir, { recursive: true, force: true });
    fs.rmSync(outsideCwd, { recursive: true, force: true });
  });
});

describe("エージェント識別(REQ-205/206/207)", () => {
  it("REQ-205: --agent(自己申告)は環境変数より優先される(入れ子ハーネス対策)", () => {
    // Claude CodeのセッションからCodexを起動した状況: 両方のenvが同時に立つ
    const env = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s", CODEX_THREAD_ID: "t", CODEX_HOME: "/h" };
    const codexRaw = { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: "x" } };
    const declared = resolveAgent({ declared: "codex", raw: codexRaw, env });
    expect(declared.agent).toBe("codex");
    expect(declared.detection.method).toBe("declared");
    expect(declared.detection.confidence).toBe(1.0);

    // Claude Code形のpayloadでも、名乗りがcodexならcodexとして扱う(呼んだ側が正)
    const claudeRaw = { tool_name: "Edit", tool_input: { file_path: "/x/a.ts" }, tool_use_id: "tu1" };
    expect(resolveAgent({ declared: "codex", raw: claudeRaw, env }).agent).toBe("codex");
    expect(resolveAgent({ declared: "claude-code", raw: codexRaw, env }).agent).toBe("claude-code");
  });

  it("REQ-207: --agent無しは推定になり、confidenceは0.9以下", () => {
    const r = resolveAgent({
      declared: null,
      raw: { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: "*** Begin Patch" }, turn_id: "t" },
      env: {},
    });
    expect(r.agent).toBe("codex");
    expect(r.detection.method).toBe("inferred");
    expect(r.detection.confidence).not.toBeNull();
    expect(r.detection.confidence as number).toBeLessThanOrEqual(0.9);
    expect(r.detection.signals.length).toBeGreaterThan(0);
  });

  it("REQ-206: 判別材料が無ければunknownとして記録する(推測で埋めない)", () => {
    const r = resolveAgent({ declared: null, raw: { foo: "bar" }, env: {} });
    expect(r.agent).toBe("unknown");
    expect(r.detection.method).toBe("unknown");
    expect(r.detection.confidence).toBeNull();
  });

  it("REQ-201/206: claude-code経路の記録内容は不変で、検出結果が付与される", () => {
    fx = makeRepo({ "src/a.ts": "const a = 1;\n" });
    initProven(fx);
    const abs = path.join(fx.dir, "src/a.ts");
    const input = {
      session_id: "s1",
      transcript_path: "",
      cwd: fx.dir,
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { file_path: abs },
      tool_use_id: "tu_cc_1",
    };
    runCapture(fx.ws, "pre", input, { declaredAgent: "claude-code" });
    fs.writeFileSync(abs, "const a = 2;\n");
    runCapture(fx.ws, "post", { ...input, hook_event_name: "PostToolUse", tool_response: { success: true } }, { declaredAgent: "claude-code" });

    const evs = editEvents(fx);
    const pre = evs.find((e) => e.type === "edit_pre")!.payload as Record<string, unknown>;
    const post = evs.find((e) => e.type === "edit_post")!.payload as Record<string, unknown>;
    expect(pre.operation_id).toBe("tu_cc_1"); // 従来と同じ
    expect(pre.file).toBe("src/a.ts");
    expect(pre.agent).toBe("claude-code");
    expect(post.operation_id).toBe("tu_cc_1");
    expect(post.tool_status).toBe("success");
    expect((pre.agent_detection as { method: string }).method).toBe("declared");
  });
});

describe("codexアダプタ(REQ-215〜218/223/224)", () => {
  it("apply_patchのパッチ本文から対象ファイルを抽出する", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+export const x = 1;",
      "*** Update File: src/old.ts",
      "@@",
      "-const a = 1;",
      "+const a = 2;",
      "*** Delete File: src/gone.ts",
      "*** End Patch",
    ].join("\n");
    expect(filesFromPatch(patch)).toEqual(["src/new.ts", "src/old.ts", "src/gone.ts"]);
  });

  it("REQ-223: 1回のapply_patchで複数ファイルが記録され、ingestで各ファイルがcaptured/linkedになる", () => {
    fx = makeRepo({ "src/a.ts": "const a = 1;\n", "src/b.ts": "const b = 1;\n" });
    initProven(fx);
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      "-const a = 1;",
      "+const a = 2;",
      "*** Update File: src/b.ts",
      "@@",
      "-const b = 1;",
      "+const b = 2;",
      "*** End Patch",
    ].join("\n");
    const opId = "call_multi_1";

    runCapture(fx.ws, "pre", codexPayload("pre", patch, opId, ""), { declaredAgent: "codex" });
    fs.writeFileSync(path.join(fx.dir, "src/a.ts"), "const a = 2;\n");
    fs.writeFileSync(path.join(fx.dir, "src/b.ts"), "const b = 2;\n");
    runCapture(fx.ws, "post", codexPayload("post", patch, opId, ""), { declaredAgent: "codex" });

    const evs = editEvents(fx);
    const pres = evs.filter((e) => e.type === "edit_pre");
    const posts = evs.filter((e) => e.type === "edit_post");
    expect(pres.map((e) => e.payload.file).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(new Set(pres.map((e) => e.payload.operation_id))).toEqual(new Set([opId])); // 同一操作ID
    expect(posts.length).toBe(2);
    expect(pres.every((e) => e.payload.agent === "codex")).toBe(true);

    // ingestで各ファイルのhunkが捕捉済みとして紐付く
    runIngest(fx.ws, {});
    const db = openDb(fx.ws);
    const rows = db.prepare("SELECT file, edit_capture_status, lineage_status FROM hunks ORDER BY file").all() as {
      file: string;
      edit_capture_status: string;
      lineage_status: string | null;
    }[];
    db.close();
    expect(rows.map((r) => r.file)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(rows.every((r) => r.edit_capture_status === "captured")).toBe(true);
    expect(rows.every((r) => r.lineage_status === "linked")).toBe(true);
  });

  it("パッチ本文を含まないツール(Bash等)は捕捉対象外", () => {
    fx = makeRepo({ "src/a.ts": "const a = 1;\n" });
    initProven(fx);
    const r = runCapture(
      fx.ws,
      "pre",
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls -la" }, tool_use_id: "call_bash" },
      { declaredAgent: "codex" },
    );
    expect(r.recorded).toBe(false);
    expect(r.reason).toBe("non-target-tool");
  });

  it("tool_responseが文字列でも成否を判定できる(codexは文字列/Claude Codeはオブジェクト)", () => {
    fx = makeRepo({ "src/a.ts": "const a = 1;\n" });
    initProven(fx);
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-const a = 1;\n+const a = 2;\n*** End Patch";
    runCapture(fx.ws, "pre", codexPayload("pre", patch, "call_fail", ""), { declaredAgent: "codex" });
    const failed = codexPayload("post", patch, "call_fail", "");
    failed.tool_response = "Exit code: 1\nOutput:\nfailed to apply";
    runCapture(fx.ws, "post", failed, { declaredAgent: "codex" });
    const post = editEvents(fx).find((e) => e.type === "edit_post")!.payload;
    expect(post.tool_status).toBe("failure");
  });

  it("rolloutのuser発話を由来判定に使える", () => {
    fx = makeRepo({ "src/a.ts": "const a = 1;\n" });
    initProven(fx);
    const rollout = path.join(fx.transcriptDir, "rollout-test.jsonl");
    fs.writeFileSync(
      rollout,
      [
        JSON.stringify({ type: "session_meta", payload: { session_id: "s" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "src/a.ts の値を2にして" } }),
      ].join("\n") + "\n",
    );
    const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-const a = 1;\n+const a = 2;\n*** End Patch";
    runCapture(fx.ws, "pre", codexPayload("pre", patch, "call_rollout", rollout), { declaredAgent: "codex" });
    fs.writeFileSync(path.join(fx.dir, "src/a.ts"), "const a = 2;\n");
    runCapture(fx.ws, "post", codexPayload("post", patch, "call_rollout", rollout), { declaredAgent: "codex" });
    runIngest(fx.ws, {});

    const db = openDb(fx.ws);
    const claim = db
      .prepare("SELECT value, reason, evidence_json FROM claims WHERE kind='instructed'")
      .get() as { value: string; reason: string; evidence_json: string } | undefined;
    db.close();
    expect(claim).toBeDefined();
    // rolloutが読めていれば「transcriptが読めない」には落ちない
    expect(claim!.reason).not.toContain("transcriptが読めない");
  });
});

describe("opencodeアダプタ(REQ-219〜221)", () => {
  it("プラグイン形式のpayloadでpre/postが対で記録される", () => {
    fx = makeRepo({ "src/a.ts": "const a = 1;\n" });
    initProven(fx);
    const abs = path.join(fx.dir, "src/a.ts");
    // 実測形: beforeは引数がoutput.args側 → プラグインがargsへ均して渡す
    const pre = { agent: "opencode", tool: "write", sessionID: "ses_1", callID: "write_0", args: { filePath: abs, content: "x" } };
    runCapture(fx.ws, "pre", pre, { declaredAgent: "opencode" });
    fs.writeFileSync(abs, "const a = 9;\n");
    runCapture(
      fx.ws,
      "post",
      { ...pre, output: { title: "src/a.ts", metadata: { filepath: abs } } },
      { declaredAgent: "opencode" },
    );

    const evs = editEvents(fx);
    const preEv = evs.find((e) => e.type === "edit_pre")!.payload;
    const postEv = evs.find((e) => e.type === "edit_post")!.payload;
    expect(preEv.agent).toBe("opencode");
    expect(preEv.file).toBe("src/a.ts");
    // callIDはセッション内連番なのでセッションIDと組で一意化する(実測)
    expect(preEv.operation_id).toBe("ses_1:write_0");
    expect(postEv.operation_id).toBe("ses_1:write_0");
    expect(preEv.conversation_ref).toBeNull(); // transcriptはファイルでない(sdk)
  });
});

describe("generic契約(REQ-222)", () => {
  it("明示契約のpayloadで捕捉できる", () => {
    fx = makeRepo({ "src/a.ts": "const a = 1;\n" });
    initProven(fx);
    runCapture(
      fx.ws,
      "pre",
      { agent: "generic", operation_id: "op1", session_ref: "", tool: "my-agent-edit", files: ["src/a.ts"] },
      { declaredAgent: "generic" },
    );
    const pre = editEvents(fx).find((e) => e.type === "edit_pre")!.payload;
    expect(pre.agent).toBe("generic");
    expect(pre.operation_id).toBe("op1");
    expect(pre.file).toBe("src/a.ts");
  });
});

describe("ハーネス検出と登録(REQ-208/209/210/215/220)", () => {
  it("--agentで指定したハーネスのみ登録され、コマンドに--agentが埋まる", () => {
    fx = makeRepo();
    expect(cli(fx.dir, ["init", "--yes", "--agent", "codex,opencode"]).code).toBe(0);

    const codexHooks = JSON.parse(readFileIn(fx, ".codex/hooks.json"));
    const cmds: string[] = codexHooks.hooks.PreToolUse.flatMap((e: { hooks: { command: string }[] }) =>
      e.hooks.map((h) => h.command),
    );
    expect(cmds.some((c) => c.includes("--agent codex"))).toBe(true);
    expect(fs.existsSync(path.join(fx.dir, ".claude", "settings.json"))).toBe(false); // 指定外は登録しない

    const plugin = readFileIn(fx, ".opencode/plugin/proven.js");
    expect(plugin).toContain("tool.execute.before");
    expect(plugin).toContain('"--agent", "opencode"');
  });

  it("init再実行で重複登録されない", () => {
    fx = makeRepo();
    cli(fx.dir, ["init", "--yes", "--agent", "codex"]);
    cli(fx.dir, ["init", "--yes", "--agent", "codex"]);
    const doc = JSON.parse(readFileIn(fx, ".codex/hooks.json"));
    const cmds: string[] = doc.hooks.PreToolUse.flatMap((e: { hooks: { command: string }[] }) => e.hooks.map((h) => h.command));
    expect(cmds.filter((c) => c.includes("proven capture")).length).toBe(1);
  });
});

describe("旧形式hookの置換(REQ-231)", () => {
  it("旧形式は置換され、二重登録されない", () => {
    fx = makeRepo();
    const settingsPath = path.join(fx.dir, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] },
            { matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: LEGACY_PRE }] },
          ],
        },
      }),
    );
    expect(cli(fx.dir, ["init", "--yes"]).code).toBe(0);

    const settings = JSON.parse(readFileIn(fx, ".claude/settings.json"));
    const preCmds: string[] = settings.hooks.PreToolUse.flatMap((e: { hooks: { command: string }[] }) =>
      e.hooks.map((h) => h.command),
    );
    expect(preCmds).toContain("echo hi"); // 既存の他hookは保持
    expect(preCmds).not.toContain(LEGACY_PRE); // 旧形式は残らない
    expect(preCmds.filter((c) => c.includes("proven capture")).length).toBe(1); // 二重登録なし
    expect(preCmds).toContain(hookCommand("pre"));
  });
});

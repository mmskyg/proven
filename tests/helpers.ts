import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { workspace, type Workspace } from "../src/store/paths.js";
import { runInit } from "../src/cli/init.js";
import { runCapture, type HookInput } from "../src/capture/capture.js";

export interface Fixture {
  dir: string;
  ws: Workspace;
  transcriptDir: string;
}

export function sh(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd }).toString();
}

/** 決定的なfixtureリポジトリ生成 */
export function makeRepo(files: Record<string, string> = {}): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airev-test-"));
  sh(dir, "git", ["init", "-q"]);
  sh(dir, "git", ["config", "user.email", "test@example.com"]);
  sh(dir, "git", ["config", "user.name", "test"]);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  sh(dir, "git", ["add", "-A"]);
  sh(dir, "git", ["commit", "-qm", "init", "--allow-empty"]);
  const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "airev-tr-"));
  return { dir, ws: workspace(dir), transcriptDir };
}

export function initAirev(fx: Fixture): void {
  runInit(fx.ws, { yes: true, isTTY: false });
  // initによる.gitignore/.claude変更をbaseへ含める(テストの関心を編集に絞る)
  sh(fx.dir, "git", ["add", "-A"]);
  sh(fx.dir, "git", ["commit", "-qm", "airev-init", "--allow-empty"]);
}

export function writeTranscript(fx: Fixture, name: string, messages: { role: "user" | "assistant"; text: string }[]): string {
  const p = path.join(fx.transcriptDir, `${name}.jsonl`);
  const lines = messages.map((m) => JSON.stringify({ type: m.role, message: { role: m.role, content: m.text } }));
  fs.writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

let opSeq = 0;

/** hookリプレイでEdit相当の編集を捕捉つきで実施 */
export function capturedEdit(
  fx: Fixture,
  relFile: string,
  newContent: string,
  opts: { transcript?: string; toolUseId?: string; tool?: string; failPost?: boolean; skipPost?: boolean } = {},
): string {
  const toolUseId = opts.toolUseId ?? `tu_${String(++opSeq).padStart(4, "0")}`;
  const abs = path.join(fx.dir, relFile);
  const base: HookInput = {
    session_id: "s1",
    transcript_path: opts.transcript ?? "",
    cwd: fx.dir,
    tool_name: opts.tool ?? "Edit",
    tool_input: { file_path: abs },
    tool_use_id: opts.toolUseId === "" ? undefined : toolUseId,
  };
  runCapture(fx.ws, "pre", { ...base, hook_event_name: "PreToolUse" });
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, newContent);
  if (!opts.skipPost) {
    runCapture(fx.ws, "post", {
      ...base,
      hook_event_name: "PostToolUse",
      tool_response: opts.failPost ? { success: false, error: "x" } : { success: true },
    });
  }
  return toolUseId;
}

/** 手編集(hook外) */
export function manualEdit(fx: Fixture, relFile: string, newContent: string): void {
  const abs = path.join(fx.dir, relFile);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, newContent);
}

const TSX = path.join(process.cwd(), "node_modules", ".bin", "tsx");
const MAIN = path.join(process.cwd(), "src", "cli", "main.ts");

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** CLI起動(exit code契約テスト用) */
export function cli(cwd: string, args: string[], stdin?: string): CliResult {
  const r = spawnSync(TSX, [MAIN, ...args], { cwd, input: stdin, encoding: "utf8", timeout: 60000 });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function readFileIn(fx: Fixture, rel: string): string {
  return fs.readFileSync(path.join(fx.dir, rel), "utf8");
}

export function cleanup(fx: Fixture): void {
  fs.rmSync(fx.dir, { recursive: true, force: true });
  fs.rmSync(fx.transcriptDir, { recursive: true, force: true });
}

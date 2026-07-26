// Claude Codeアダプタ(REQ-214)。既存の捕捉挙動をそのまま切り出したもので、
// 記録内容が改修前と一致すること(REQ-201)がこのファイルの制約。
import fs from "node:fs";
import type { AgentAdapter, NormalizedCapture, Phase, RawPayload, Utterance } from "./types.js";

const TARGET_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** transcript(Claude Code形式JSONL)からbeforeLine以前の直近user発話を最大max件 */
export function readClaudeUtterances(sessionRef: string, beforeLine: number | null, max = 3): Utterance[] {
  if (!sessionRef || !fs.existsSync(sessionRef)) return [];
  const lines = fs.readFileSync(sessionRef, "utf8").split("\n");
  const out: Utterance[] = [];
  const limit = beforeLine === null ? lines.length : Math.min(beforeLine, lines.length);
  for (let i = limit - 1; i >= 0 && out.length < max; i--) {
    const line = lines[i];
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      const role = obj?.message?.role ?? obj?.role ?? obj?.type;
      if (role === "user") {
        const content = obj?.message?.content ?? obj?.content ?? "";
        const text =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content.map((c: { text?: string }) => c?.text ?? "").join(" ")
              : "";
        if (text.trim()) out.push({ text, line: i + 1, path: sessionRef });
      }
    } catch {
      continue;
    }
  }
  return out;
}

export const claudeCodeAdapter: AgentAdapter = {
  id: "claude-code",
  capabilities: { preState: "hook", operationId: "native", filesPerOperation: "one", transcript: "jsonl" },

  match(raw: RawPayload, env: NodeJS.ProcessEnv) {
    const signals: string[] = [];
    let score = 0;
    const tool = str(raw.tool_name);
    if (tool && TARGET_TOOLS.has(tool)) {
      score += 0.6;
      signals.push(`payload:tool_name=${tool}`);
    }
    const ti = raw.tool_input as Record<string, unknown> | undefined;
    if (ti && (typeof ti.file_path === "string" || typeof ti.notebook_path === "string")) {
      score += 0.2;
      signals.push("payload:tool_input.file_path");
    }
    if (env.CLAUDECODE || env.CLAUDE_CODE_SESSION_ID) {
      score += 0.1;
      signals.push("env:CLAUDECODE");
    }
    if (str(raw.transcript_path).includes("/.claude/")) {
      score += 0.1;
      signals.push("payload:transcript_path=.claude");
    }
    return { score: Math.min(1, score), signals };
  },

  normalize(raw: RawPayload, phase: Phase): NormalizedCapture | null {
    const tool = str(raw.tool_name);
    const ti = raw.tool_input as Record<string, unknown> | undefined;
    const file = str(ti?.file_path) || str(ti?.notebook_path);
    const resp = raw.tool_response;
    const ok = !(
      typeof resp === "object" &&
      resp !== null &&
      ("error" in (resp as object) || (resp as { success?: boolean }).success === false)
    );
    return {
      operationIdNative: typeof raw.tool_use_id === "string" && raw.tool_use_id ? raw.tool_use_id : null,
      sessionRef: str(raw.transcript_path),
      tool,
      files: file ? [file] : [],
      isTargetTool: TARGET_TOOLS.has(tool),
      toolStatus: phase === "post" ? (ok ? "success" : "failure") : null,
    };
  },

  readUtterances: readClaudeUtterances,
};

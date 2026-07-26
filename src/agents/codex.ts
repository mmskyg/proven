// Codexアダプタ(REQ-215〜218)。payloadは実機採取済み(docs/spec-multi-harness.md §11.1)。
//   tool_name: "apply_patch" / tool_input.command にパッチ本文 / tool_use_id あり
//   tool_response は文字列("Exit code: 0\n...") でClaude Codeのオブジェクトと異なる
//   Bashツールでも PreToolUse が発火するため編集系のみ通す
import fs from "node:fs";
import { filesFromPayload } from "./patch.js";
import type { AgentAdapter, NormalizedCapture, Phase, RawPayload, Utterance } from "./types.js";

/** 編集を伴うツール。apply_patch以外はパッチ本文を持つ場合のみ対象とする */
const PATCH_TOOLS = new Set(["apply_patch", "applypatch", "apply-patch"]);

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** rollout JSONL からuser発話を取得。行形式: {"type":"event_msg","payload":{"type":"user_message","message":"..."}} */
export function readCodexUtterances(sessionRef: string, beforeLine: number | null, max = 3): Utterance[] {
  if (!sessionRef || !fs.existsSync(sessionRef)) return [];
  const lines = fs.readFileSync(sessionRef, "utf8").split("\n");
  const out: Utterance[] = [];
  const limit = beforeLine === null ? lines.length : Math.min(beforeLine, lines.length);
  for (let i = limit - 1; i >= 0 && out.length < max; i--) {
    const line = lines[i];
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      const p = obj?.payload;
      let text = "";
      if (obj?.type === "event_msg" && p?.type === "user_message") {
        text = typeof p.message === "string" ? p.message : "";
      } else if (obj?.type === "response_item" && p?.role === "user" && Array.isArray(p.content)) {
        text = p.content.map((c: { text?: string }) => c?.text ?? "").join(" ");
      }
      if (text.trim()) out.push({ text, line: i + 1, path: sessionRef });
    } catch {
      continue;
    }
  }
  return out;
}

/** tool_responseは文字列。"Exit code: 0" 以外や error 文字列を失敗とみなす */
function statusFromResponse(resp: unknown): "success" | "failure" {
  if (typeof resp === "string") {
    const m = /Exit code:\s*(-?\d+)/.exec(resp);
    if (m) return m[1] === "0" ? "success" : "failure";
    return /\berror\b/i.test(resp) ? "failure" : "success";
  }
  if (typeof resp === "object" && resp !== null) {
    if ("error" in (resp as object) || (resp as { success?: boolean }).success === false) return "failure";
  }
  return "success";
}

export const codexAdapter: AgentAdapter = {
  id: "codex",
  capabilities: { preState: "hook", operationId: "native", filesPerOperation: "many", transcript: "rollout" },

  match(raw: RawPayload, env: NodeJS.ProcessEnv) {
    const signals: string[] = [];
    let score = 0;
    const tool = str(raw.tool_name);
    if (PATCH_TOOLS.has(tool)) {
      score += 0.6;
      signals.push(`payload:tool_name=${tool}`);
    }
    if (typeof raw.turn_id === "string") {
      score += 0.15;
      signals.push("payload:turn_id");
    }
    if (str(raw.transcript_path).includes("rollout-")) {
      score += 0.15;
      signals.push("payload:transcript_path=rollout");
    }
    if (env.CODEX_THREAD_ID || env.CODEX_HOME) {
      score += 0.1;
      signals.push("env:CODEX_*");
    }
    return { score: Math.min(1, score), signals };
  },

  normalize(raw: RawPayload, phase: Phase): NormalizedCapture | null {
    const tool = str(raw.tool_name);
    const files = filesFromPayload(raw.tool_input);
    // 編集対象はパッチ本文からのみ導く。Bash等でパッチを含まないものは捕捉対象外(REQ-218)
    const isTargetTool = files.length > 0;
    return {
      operationIdNative: typeof raw.tool_use_id === "string" && raw.tool_use_id ? raw.tool_use_id : null,
      sessionRef: str(raw.transcript_path),
      tool,
      files,
      isTargetTool,
      toolStatus: phase === "post" ? statusFromResponse(raw.tool_response) : null,
    };
  },

  readUtterances: readCodexUtterances,
};

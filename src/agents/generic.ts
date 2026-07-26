// genericアダプタ(REQ-222)。未対応ハーネス向けの明示的な入力契約。
//   { "operation_id": "...", "session_ref": "...", "tool": "...", "files": ["src/a.ts"], "status": "success" }
import type { AgentAdapter, NormalizedCapture, Phase, RawPayload } from "./types.js";

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export const genericAdapter: AgentAdapter = {
  id: "generic",
  // 呼び出し側が自分で pre/post を送る契約。編集前状態はその呼び出しに依存する
  capabilities: { preState: "hook", operationId: "native", filesPerOperation: "many", transcript: "none" },

  match(raw: RawPayload, _env: NodeJS.ProcessEnv) {
    const signals: string[] = [];
    let score = 0;
    if (raw.agent === "generic") {
      score += 0.6;
      signals.push("payload:agent=generic");
    }
    if (Array.isArray(raw.files)) {
      score += 0.3;
      signals.push("payload:files[]");
    }
    if (typeof raw.operation_id === "string") {
      score += 0.1;
      signals.push("payload:operation_id");
    }
    return { score: Math.min(1, score), signals };
  },

  normalize(raw: RawPayload, phase: Phase): NormalizedCapture | null {
    const files = Array.isArray(raw.files) ? raw.files.filter((f): f is string => typeof f === "string" && !!f) : [];
    const status = str(raw.status);
    return {
      operationIdNative: typeof raw.operation_id === "string" && raw.operation_id ? raw.operation_id : null,
      sessionRef: str(raw.session_ref),
      tool: str(raw.tool) || "generic",
      files,
      isTargetTool: files.length > 0,
      toolStatus: phase === "post" ? (status === "failure" ? "failure" : "success") : null,
    };
  },
};

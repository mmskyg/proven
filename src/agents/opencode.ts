// OpenCodeアダプタ(REQ-219〜221)。実機採取済み(2026-07-26 / opencode 1.17.9)。
// OpenCodeのhookはin-processのTSプラグインなので、Proven同梱のプラグインが
// tool.execute.before / after の入力を次の形に均してJSONで渡す。
//   { agent:"opencode", tool, sessionID, callID, args, output? }
// 実測での注意点:
//   - before では引数は input ではなく output.args 側に入る(プラグインが吸収する)
//   - callID はセッション内の連番("write_0")なのでセッションIDと組で一意化する
import { filesFromPayload } from "./patch.js";
import type { AgentAdapter, NormalizedCapture, Phase, RawPayload } from "./types.js";

/** 編集系ツール名(OpenCode) */
const EDIT_TOOLS = new Set(["write", "edit", "patch", "multiedit"]);

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** args から対象ファイルを抽出。キー名はハーネス側の揺れを許容する(REQ-221) */
function filesFromArgs(args: unknown): string[] {
  const out: string[] = [];
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    for (const key of ["filePath", "file_path", "path", "file"]) {
      const v = a[key];
      if (typeof v === "string" && v) {
        out.push(v);
        break;
      }
    }
  }
  // patch系はパッチ本文から抽出(解析器はcodexと共用)
  for (const f of filesFromPayload(args)) if (!out.includes(f)) out.push(f);
  return out;
}

export const opencodeAdapter: AgentAdapter = {
  id: "opencode",
  capabilities: { preState: "plugin", operationId: "native", filesPerOperation: "many", transcript: "sdk" },

  match(raw: RawPayload, _env: NodeJS.ProcessEnv) {
    const signals: string[] = [];
    let score = 0;
    if (typeof raw.callID === "string") {
      score += 0.5;
      signals.push("payload:callID");
    }
    if (typeof raw.sessionID === "string") {
      score += 0.3;
      signals.push("payload:sessionID");
    }
    const tool = str(raw.tool);
    if (tool && EDIT_TOOLS.has(tool)) {
      score += 0.2;
      signals.push(`payload:tool=${tool}`);
    }
    return { score: Math.min(1, score), signals };
  },

  normalize(raw: RawPayload, phase: Phase): NormalizedCapture | null {
    const tool = str(raw.tool);
    const files = filesFromArgs(raw.args);
    const isTargetTool = EDIT_TOOLS.has(tool) && files.length > 0;
    // afterフックはoutputを持つ。エラー文字列があれば失敗扱い
    const out = raw.output;
    let status: "success" | "failure" | null = null;
    if (phase === "post") {
      const failed =
        (typeof out === "object" && out !== null && "error" in (out as object)) ||
        (typeof out === "string" && /\berror\b/i.test(out));
      status = failed ? "failure" : "success";
    }
    // callIDはセッション内連番なので、セッションIDと組にして一意にする(実測)
    const callId = str(raw.callID);
    const sessionId = str(raw.sessionID);
    return {
      operationIdNative: callId ? (sessionId ? `${sessionId}:${callId}` : callId) : null,
      tool,
      files,
      isTargetTool,
      toolStatus: status,
      // OpenCodeのtranscriptはファイルでないため、セッションIDを参照値として持つ(transcript: sdk)
      sessionRef: sessionId,
    };
  },
};

// Claude Codeアダプタ(REQ-214)。既存の捕捉挙動をそのまま切り出したもので、
// 記録内容が改修前と一致すること(REQ-201)がこのファイルの制約。
import fs from "node:fs";
import type { AgentAdapter, NormalizedCapture, Phase, RawPayload, Utterance } from "./types.js";

const TARGET_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * roleがuserでも「人が言ったこと」ではない行を除く(REQ-827)。
 *
 * Claude Codeのtranscriptは、コンパクション要約やCLIコマンドの実行結果も
 * role=user として書き込む。要約は会話全体の技術用語(ファイル名・識別子・SQL断片)を
 * 大量に含むため、これを発話として扱うと**ほぼ何にでも一致し**、
 * 指示が無い変更まで instructed=あり になる。実測でこの誤検出が出た。
 *
 * isMeta では弾かない。Discord等のチャネル経由で届いた**本物のユーザー発話にも
 * isMeta が付く**ため、弾くと指示が丸ごと見えなくなる。
 */
function isNonSpeech(obj: Record<string, unknown>, text: string): boolean {
  if (obj.isCompactSummary === true) return true;
  // スラッシュコマンドの起動と、その標準出力。人の指示ではない
  if (/<command-name>|<local-command-stdout>|<local-command-stderr>/.test(text)) return true;
  // REQ-834: サブエージェント/チームメイトの発言も role=user で届く。
  // これらは機械が書いたレビュー文で、ファイル名と識別子が密に並ぶため、
  // コンパクション要約と同じく「ほぼ何にでも一致する」誤検出源になる。
  // 実測: fable のレビュー文1本が buffer/statsync/isfile 等で複数のhunkに
  // instructed=あり を付けていた
  if (/<teammate-message\b|Another Claude session sent a message:/.test(text)) return true;
  // サブエージェントのプロンプト(sidechain)は親エージェントが書いたもので人の発話ではない
  if (obj.isSidechain === true) return true;
  // REQ-834: ツール実行の結果として注入された内容(skillの本文・システムプロンプト等)。
  // sourceToolUseID を持つ行はツール由来で、人が打った発話ではない。
  // 実測: skillの説明文がuser発話として読まれ、claude/session で instructed=あり になっていた。
  // 対象セッションで本物のチャネル発話44件のうち、この条件に当たるものは0件
  if (typeof obj.sourceToolUseID === "string" && obj.sourceToolUseID) return true;
  return false;
}

/**
 * 発話に混ざる伝送メタデータを落とす(REQ-827)。
 *
 * チャネル経由の発話は `<channel source="plugin:discord:discord" chat_id="..." ...>` に
 * 包まれて届く。この属性は**全ての発話に必ず入る固定語**なので、残すと
 * `discord` `plugin` `source` のような語が毎回タダで一致し、指示の証拠にならない。
 * 中の本文だけを残す。
 */
function stripTransportMarkup(text: string): string {
  return text
    .replace(/<channel\b[^>]*>/g, " ")
    .replace(/<\/channel>/g, " ")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ")
    .trim();
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
        if (!text.trim() || isNonSpeech(obj, text)) continue;
        const speech = stripTransportMarkup(text);
        if (speech) out.push({ text: speech, line: i + 1, path: sessionRef });
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

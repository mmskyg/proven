// アダプタレジストリと検出(REQ-205〜207)。
// 検出は「自己申告(declared) > 推定(inferred) > 不明(unknown)」の優先順とし、
// 環境変数による推測を第一手段にしない(ハーネスは入れ子で起動されうるため)。
import { claudeCodeAdapter } from "./claudeCode.js";
import { codexAdapter } from "./codex.js";
import { genericAdapter } from "./generic.js";
import { opencodeAdapter } from "./opencode.js";
import {
  INFERRED_CONF_MAX,
  type AgentAdapter,
  type AgentDetection,
  type AgentId,
  type RawPayload,
} from "./types.js";

export * from "./types.js";
export { filesFromPatch, filesFromPayload, findPatchText } from "./patch.js";
export { claudeCodeAdapter, codexAdapter, genericAdapter, opencodeAdapter };

/** 登録済みアダプタ。推定時はこの順で評価する */
export const ADAPTERS: AgentAdapter[] = [claudeCodeAdapter, codexAdapter, opencodeAdapter, genericAdapter];

export function adapterById(id: string): AgentAdapter | null {
  return ADAPTERS.find((a) => a.id === id) ?? null;
}

export interface ResolvedAgent {
  adapter: AgentAdapter;
  agent: AgentId;
  detection: AgentDetection;
}

/**
 * 使用するアダプタを決定する(REQ-205)。
 * declared: --agent の値をそのまま採用(confidence 1.0)
 * inferred: match()のスコア最大。confidenceは INFERRED_CONF_MAX で頭打ち(REQ-207)
 * unknown : どれも一致しない。最有力アダプタで正規化は試みるが、agentはunknownとして記録する
 */
export function resolveAgent(opts: {
  declared?: string | null;
  raw: RawPayload;
  env?: NodeJS.ProcessEnv;
}): ResolvedAgent {
  const env = opts.env ?? process.env;
  const declared = (opts.declared ?? "").trim();
  if (declared) {
    const adapter = adapterById(declared);
    if (adapter) {
      return {
        adapter,
        agent: adapter.id,
        detection: { method: "declared", signals: [`flag:--agent=${declared}`], confidence: 1.0 },
      };
    }
    // 未知のidを名乗られた場合は推定へ落とすが、名乗り自体は根拠として残す
  }

  const scored = ADAPTERS.map((a) => ({ adapter: a, ...a.match(opts.raw, env) })).sort((x, y) => y.score - x.score);
  const best = scored[0];
  const signals = best ? best.signals : [];
  if (declared) signals.unshift(`flag:--agent=${declared}(未知のid)`);

  if (best && best.score > 0) {
    return {
      adapter: best.adapter,
      agent: best.adapter.id,
      detection: {
        method: "inferred",
        signals,
        confidence: Math.min(INFERRED_CONF_MAX, Number(best.score.toFixed(2))),
      },
    };
  }
  // 判別不能。最も一般的な形(claude-code)で正規化を試みるが、事実としてはunknownと記録する
  return {
    adapter: claudeCodeAdapter,
    agent: "unknown",
    detection: { method: "unknown", signals, confidence: null },
  };
}

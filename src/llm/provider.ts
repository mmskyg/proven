// LLMプロバイダ抽象(REQ-814)。既定実装はAnthropic Messages API。
// テストではモックを注入し、ネットワークを一切使わない。

export interface LlmRequest {
  system: string;
  user: string;
  /** 期待する出力のJSON Schema(構造化出力) */
  schema: Record<string, unknown>;
  model: string;
}

export interface LlmResponse {
  /** schemaに沿ってパース済みの出力。パース不能はnull */
  parsed: Record<string, unknown> | null;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  /** プロバイダが実費を返す場合(claude-cli)。あれば見積もりより優先する */
  costUsdOverride?: number;
}

export interface LlmProvider {
  name: string;
  /** 失敗時は例外ではなくnullを返す(呼び出し側は判定不能として続行する・REQ-816) */
  complete(req: LlmRequest): Promise<LlmResponse | null>;
}

/** 1Mトークンあたりのドル単価(概算・費用上限の判定用) */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

const PRICING: Record<string, ModelPricing> = {
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
};

/** 概算費用(USD)。未知モデルは最も高い既知単価で見積もる(過小評価しない) */
export function estimateCostUsd(model: string, usage: { inputTokens: number; outputTokens: number }): number {
  const p =
    PRICING[model] ??
    Object.values(PRICING).reduce((a, b) => (a.outputPerMTok >= b.outputPerMTok ? a : b));
  return (usage.inputTokens / 1_000_000) * p.inputPerMTok + (usage.outputTokens / 1_000_000) * p.outputPerMTok;
}

/**
 * Anthropic Messages API プロバイダ。
 * 認証は環境変数(ANTHROPIC_API_KEY等)から。設定ファイルには保存しない(REQ-815)。
 * SDKは動的importし、未インストールでも他の機能を壊さない。
 */
export function anthropicProvider(): LlmProvider {
  return {
    name: "anthropic",
    async complete(req: LlmRequest): Promise<LlmResponse | null> {
      try {
        const mod = (await import("@anthropic-ai/sdk")) as unknown as {
          default: new () => {
            messages: {
              create(args: Record<string, unknown>): Promise<{
                content: { type: string; text?: string }[];
                usage?: { input_tokens?: number; output_tokens?: number };
                model?: string;
                stop_reason?: string;
              }>;
            };
          };
        };
        const client = new mod.default();
        const res = await client.messages.create({
          model: req.model,
          max_tokens: 2000,
          // 判定は短い構造化出力なので、思考は浅くてよい(費用と再現性のため)
          output_config: { effort: "low", format: { type: "json_schema", schema: req.schema } },
          system: req.system,
          messages: [{ role: "user", content: req.user }],
        });
        const text = res.content.find((b) => b.type === "text")?.text ?? "";
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(text) as Record<string, unknown>;
        } catch {
          parsed = null;
        }
        return {
          parsed,
          usage: {
            inputTokens: res.usage?.input_tokens ?? 0,
            outputTokens: res.usage?.output_tokens ?? 0,
          },
          model: res.model ?? req.model,
        };
      } catch {
        // レート制限・ネットワーク断・SDK未導入などは判定不能として続行する(REQ-816)
        return null;
      }
    },
  };
}

/**
 * ローカルの `claude` CLI をプロバイダとして使う(REQ-814/817)。
 * APIキーを持たない利用者でも、既に認証済みのエージェントCLIでLLM層を動かせる。
 * 費用はCLIが返す total_cost_usd をそのまま使う(見積もりより正確)。
 */
export function claudeCliProvider(): LlmProvider {
  return {
    name: "claude-cli",
    async complete(req: LlmRequest): Promise<LlmResponse | null> {
      try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const run = promisify(execFile);
        const instruction = `${req.user}\n\n出力はJSONのみ。スキーマ: ${JSON.stringify(req.schema)}`;
        const { stdout } = await run(
          "claude",
          ["-p", instruction, "--output-format", "json", "--model", req.model, "--append-system-prompt", req.system],
          { maxBuffer: 10 * 1024 * 1024, timeout: 180_000 },
        );
        const env = JSON.parse(stdout) as { result?: string; total_cost_usd?: number; is_error?: boolean };
        if (env.is_error) return null;
        const text = env.result ?? "";
        // ```json フェンスが付くことがあるので剥がす
        const body = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1] ?? text;
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(body.trim()) as Record<string, unknown>;
        } catch {
          parsed = null;
        }
        return {
          parsed,
          // 費用はCLI側の実測値を使うため、トークン数ではなくcostUsdOverrideで渡す
          usage: { inputTokens: 0, outputTokens: 0 },
          costUsdOverride: env.total_cost_usd,
          model: req.model,
        };
      } catch {
        return null;
      }
    },
  };
}

/** 認証情報が使えるか(REQ-815)。無ければLLM層を無効として扱う */
export function hasCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
}

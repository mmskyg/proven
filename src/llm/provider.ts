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
  /** プロバイダが実費を返す場合。あれば見積もりより優先する */
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

/** ```json フェンス付きで返ることがあるので剥がしてからパースする */
export function parseJsonLoose(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const body = (fenced ?? text).trim();
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    // 前後に説明文が付く場合に備え、最初の { から最後の } までを試す
    const s = body.indexOf("{");
    const e = body.lastIndexOf("}");
    if (s >= 0 && e > s) {
      try {
        return JSON.parse(body.slice(s, e + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** CLI起動のタイムアウト(ms)。ハングしても1件で止まるようにする */
const CLI_TIMEOUT_MS = 600_000;

/** stdout取り込みの上限(byte)。イベント列が想定外に長くても止まらないようにする */
const CLI_MAX_STDOUT = 10 * 1024 * 1024;

/**
 * 子プロセスをstdinを与えずに起動し、stdoutを返す。
 * `codex exec` はstdinがパイプだと入力を`<stdin>`ブロックとして読むためEOFまでブロックする。
 * execFileはstdioを常にパイプにするので、spawnで明示的に stdin を閉じる必要がある。
 */
async function spawnNoStdin(command: string, args: string[], timeoutMs: number): Promise<string> {
  const { spawn } = await import("node:child_process");
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < CLI_MAX_STDOUT) stdout += chunk;
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with ${String(code)}`));
    });
  });
}

/**
 * `codex exec --json` のイベント列(JSONL)から使用トークン数を取り出す。
 * 取れなかった場合は0を返す(判定自体は続行する)。
 * reasoning_output_tokensは出力側に合算する(課金上も出力として扱われるため)。
 */
export function parseCodexUsage(stdoutJsonl: string): { inputTokens: number; outputTokens: number } {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const line of stdoutJsonl.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{") || !t.includes('"usage"')) continue;
    let ev: { usage?: Record<string, unknown> };
    try {
      ev = JSON.parse(t) as { usage?: Record<string, unknown> };
    } catch {
      continue;
    }
    const u = ev.usage;
    if (!u) continue;
    const num = (k: string): number => (typeof u[k] === "number" ? (u[k] as number) : 0);
    // turn.completed は累積ではなくターンごとなので、複数ターンなら足し合わせる
    inputTokens += num("input_tokens");
    outputTokens += num("output_tokens") + num("reasoning_output_tokens");
  }
  return { inputTokens, outputTokens };
}

/**
 * ローカルの `codex` CLI をプロバイダとして使う(REQ-818)。
 * 認証はCodex CLI側の設定に従う。サンドボックスは read-only で起動し、
 * 判定のためにファイルを書き換えさせない。
 */
export function codexCliProvider(): LlmProvider {
  return {
    name: "codex-cli",
    async complete(req: LlmRequest): Promise<LlmResponse | null> {
      try {
        const os = await import("node:os");
        const fs = await import("node:fs");
        const path = await import("node:path");
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proven-codex-"));
        const out = path.join(dir, "last.txt");
        const prompt = `${req.system}\n\n${req.user}\n\n出力はJSONのみ。スキーマ: ${JSON.stringify(req.schema)}`;
        try {
          const stdout = await spawnNoStdin(
            "codex",
            [
              "exec",
              // 使用トークン数を取るためイベントをJSONLで受ける(最終メッセージは -o から読む)
              "--json",
              "--sandbox",
              "read-only",
              "--skip-git-repo-check",
              "-C",
              dir,
              "-m",
              req.model,
              // 短い構造化判定なので推論は浅くてよい(既定のままだと数分かかる)
              "-c",
              "model_reasoning_effort=low",
              "-o",
              out,
              prompt,
            ],
            CLI_TIMEOUT_MS,
          );
          const text = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
          return {
            parsed: parseJsonLoose(text),
            usage: parseCodexUsage(stdout),
            model: req.model,
            // 費用はCLI側の契約(サブスクリプション等)に依存し、単価が分からない。
            // Anthropicの単価表で概算すると誤った金額になるため0とする(費用上限は効かない)
            costUsdOverride: 0,
          };
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
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

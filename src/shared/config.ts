import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { AirevError } from "./errors.js";

const ConfigSchema = z.object({
  version: z.number().default(1),
  reviewer_id: z.string().default(""),
  spec_sources: z
    .array(z.object({ type: z.literal("markdown"), glob: z.string() }))
    .default([{ type: "markdown", glob: "docs/**/*.md" }]),
  agents: z
    .array(
      z.object({
        type: z.literal("claude-code"),
        transcripts: z.string().default(""),
        hooks_autocapture: z.boolean().default(true),
      }),
    )
    .default([]),
  capture: z.object({ exclude: z.array(z.string()).default([]) }).default({ exclude: [] }),
  llm: z
    .object({
      enabled: z.boolean().default(false),
      provider: z.string().default("anthropic"),
      model_light: z.string().default(""),
      model_heavy: z.string().default(""),
      max_calls_per_run: z.number().default(60),
      budget_usd_per_run: z.number().default(0.5),
      exclude: z.array(z.string()).default([]),
      secret_masking: z.boolean().default(true),
    })
    .prefault({}),
  policy: z
    .object({
      path: z.string().default(".airev/policy.yaml"),
      precheck_on_stop: z.boolean().default(false),
    })
    .prefault({}),
  review: z
    .object({
      understood_check_paths: z.array(z.string()).default([]),
      blind_ratio: z.number().default(0),
    })
    .prefault({}),
  triage: z.object({ boundary_paths: z.array(z.string()).default([]) }).default({ boundary_paths: [] }),
  retention: z.object({ snapshot_days: z.number().default(90) }).default({ snapshot_days: 90 }),
  lineage: z.object({ time_budget_ms: z.number().default(60000) }).default({ time_budget_ms: 60000 }),
});

export type AirevConfig = z.infer<typeof ConfigSchema>;

export function defaultConfig(): AirevConfig {
  return ConfigSchema.parse({});
}

export function loadConfig(airevDir: string): AirevConfig {
  const p = path.join(airevDir, "config.yaml");
  if (!fs.existsSync(p)) return defaultConfig();
  let raw: unknown;
  try {
    raw = YAML.parse(fs.readFileSync(p, "utf8")) ?? {};
  } catch (e) {
    throw new AirevError("input", `config.yamlのYAMLパースに失敗: ${String(e)}`);
  }
  const r = ConfigSchema.safeParse(raw);
  if (!r.success) throw new AirevError("input", `config.yamlが不正です: ${r.error.message}`);
  return r.data;
}

export function saveConfig(airevDir: string, cfg: AirevConfig): void {
  fs.writeFileSync(path.join(airevDir, "config.yaml"), YAML.stringify(cfg), { mode: 0o600 });
}

// glob → RegExp (** / * のみ対応の簡易実装。boundary_paths/exclude用)
export function globToRegExp(glob: string): RegExp {
  const DSTAR_SLASH = "\u0000"; // **/ = 0階層以上
  const DSTAR = "\u0001"; // ** = 任意
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, DSTAR_SLASH)
    .replace(/\*\*/g, DSTAR)
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".")
    .replace(new RegExp(DSTAR_SLASH, "g"), "(?:.*/)?")
    .replace(new RegExp(DSTAR, "g"), ".*");
  return new RegExp(`^${esc}$`);
}

export function validateGlob(glob: string): void {
  // 全メタ文字をエスケープするためRegExpエラーにはならない。不正=空・制御文字含み
  if (glob.trim() === "" || /[\x00-\x1f]/.test(glob)) {
    throw new AirevError("input", `不正なglobパターンです: ${JSON.stringify(glob)}`);
  }
}

export function matchAnyGlob(relPath: string, globs: string[]): boolean {
  for (const g of globs) {
    validateGlob(g);
    if (globToRegExp(g).test(relPath)) return true;
  }
  return false;
}

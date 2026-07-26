import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { AirevError } from "../shared/errors.js";
import { loadConfig } from "../shared/config.js";
import { sha256 } from "../shared/hash.js";
import type { Workspace } from "../store/paths.js";

const AntiPatternSchema = z.object({
  id: z.string(),
  title: z.string(),
  reason: z.string(),
  detect: z.object({ type: z.enum(["regex", "ast", "llm"]), pattern: z.string().optional().default("") }),
  severity: z.enum(["block", "warn"]).default("warn"),
  scope: z.array(z.string()).optional(),
});

const ExpectationSchema = z.union([
  z.object({ type: z.literal("new_dependency_reason") }),
  z.object({ type: z.literal("hunk_note_required"), when: z.string().optional() }),
  z.object({ type: z.literal("manual"), text: z.string() }),
]);

const PolicySchema = z.object({
  charter: z.array(z.object({ lens: z.string(), description: z.string(), paths: z.array(z.string()).optional() })).default([]),
  requirements: z.string().default("REQ-\\d+"),
  anti_patterns: z.array(AntiPatternSchema).default([]),
  expectations: z.array(ExpectationSchema).default([]),
});

export type Policy = z.infer<typeof PolicySchema>;
export type Expectation = z.infer<typeof ExpectationSchema>;

/** ルールストア共通型(詳細設計書3.7) */
export interface Rule {
  rule_id: string;
  source: "policy" | "learn";
  source_finding_ref: string | null;
  languages: string[] | null;
  scope: string[] | null;
  pattern: { type: "regex" | "ast" | "llm"; expr: string };
  severity: "block" | "warn";
  description: string;
  test_examples: { positive: string[]; negative: string[] } | null;
  owner: string | null;
  expiry: string | null;
  stats: { applied: number; hit: number; false_positive: number };
}

export interface PolicyLoadResult {
  policy: Policy;
  rules: Rule[];
  policyDigest: string;
  lintErrors: string[]; // 全違反列挙(E-40)
}

export function policyPath(ws: Workspace): string {
  const cfg = loadConfig(ws.airevDir);
  return path.isAbsolute(cfg.policy.path) ? cfg.policy.path : path.join(ws.repoRoot, cfg.policy.path);
}

/** policy.yamlロード+Rule変換。lintErrors非空=不正policy(precheckは安全側中止=v0.3) */
export function loadPolicy(ws: Workspace): PolicyLoadResult | null {
  const p = policyPath(ws);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, "utf8");
  const digest = sha256(raw);
  const lintErrors: string[] = [];
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw) ?? {};
  } catch (e) {
    return { policy: PolicySchema.parse({}), rules: [], policyDigest: digest, lintErrors: [`YAMLパースエラー: ${String(e)}`] };
  }
  const res = PolicySchema.safeParse(parsed);
  if (!res.success) {
    for (const issue of res.error.issues) lintErrors.push(`${issue.path.join(".")}: ${issue.message}`);
    return { policy: PolicySchema.parse({}), rules: [], policyDigest: digest, lintErrors };
  }
  const policy = res.data;
  const rules: Rule[] = [];
  for (const ap of policy.anti_patterns) {
    if (ap.detect.type === "regex") {
      try {
        new RegExp(ap.detect.pattern);
      } catch (e) {
        lintErrors.push(`anti_patterns[${ap.id}]: コンパイル不能なregex: ${String(e)}`);
        continue;
      }
    }
    rules.push({
      rule_id: ap.id,
      source: "policy",
      source_finding_ref: null,
      languages: ap.detect.type === "ast" ? ["ts", "js"] : null,
      scope: ap.scope ?? null,
      pattern: { type: ap.detect.type, expr: ap.detect.pattern },
      severity: ap.severity,
      description: `${ap.title}: ${ap.reason}`,
      test_examples: null,
      owner: null,
      expiry: null,
      stats: { applied: 0, hit: 0, false_positive: 0 },
    });
  }
  // learnルール(rules/*.yaml)との重複はpolicy優先+警告(E-43)
  const learnDir = path.join(ws.airevDir, "rules");
  if (fs.existsSync(learnDir)) {
    for (const f of fs.readdirSync(learnDir).filter((f) => f.endsWith(".yaml"))) {
      try {
        const lr = YAML.parse(fs.readFileSync(path.join(learnDir, f), "utf8")) as Rule;
        if (rules.some((r) => r.rule_id === lr.rule_id)) {
          lintErrors.push(`警告: rule_id重複(${lr.rule_id})はpolicy優先で無視します`);
          continue;
        }
        rules.push(lr);
      } catch {
        lintErrors.push(`警告: learnルール ${f} を読めません`);
      }
    }
  }
  return { policy, rules, policyDigest: digest, lintErrors };
}

export function policyInitTemplate(): string {
  return `charter:
  - lens: security
    description: 認証・認可・外部入力の扱いを必ず見る
    paths: ["src/auth/**"]
requirements: "REQ-\\\\d+"
anti_patterns: []
#  - id: AP-001
#    title: ORM層を迂回した生SQL
#    reason: 監査ログが乗らないため
#    detect: {type: regex, pattern: "SELECT .* FROM"}
#    severity: block
expectations:
  - {type: new_dependency_reason}
  - {type: hunk_note_required, when: unsolicited}
`;
}

const GUARD_START = "<!-- airev:guard start -->";
const GUARD_END = "<!-- airev:guard end -->";

export function generateGuardPrompt(policy: Policy): string {
  const L: string[] = [GUARD_START, "## airevレビューポリシー(自動生成・手動採用済み)", ""];
  if (policy.anti_patterns.length) {
    L.push("### してほしくない設計");
    for (const ap of policy.anti_patterns) L.push(`- ${ap.title}(${ap.id}): ${ap.reason}`);
    L.push("");
  }
  const manual = policy.expectations.filter((e): e is Extract<Expectation, { type: "manual" }> => e.type === "manual");
  const typed = policy.expectations.filter((e) => e.type !== "manual");
  if (typed.length || manual.length) {
    L.push("### 申し送りの要求");
    for (const e of typed) {
      if (e.type === "new_dependency_reason") L.push("- 新規依存を追加した場合は理由をPR説明に書く");
      if (e.type === "hunk_note_required") L.push("- 仕様外実装(unsolicited)が残る場合は該当hunkに理由を付す");
    }
    for (const e of manual) L.push(`- ${e.text}`);
    L.push("");
  }
  L.push(GUARD_END);
  return L.join("\n");
}

/** CLAUDE.mdのマーカー区間のみ置換(区間外不変=N-47) */
export function applyGuard(ws: Workspace, guard: string): { applied: boolean; target: string } {
  const target = path.join(ws.repoRoot, "CLAUDE.md");
  let content = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  const si = content.indexOf(GUARD_START);
  const ei = content.indexOf(GUARD_END);
  if (si !== -1 && ei !== -1 && ei > si) {
    content = content.slice(0, si) + guard + content.slice(ei + GUARD_END.length);
  } else {
    content = content + (content.endsWith("\n") || content === "" ? "" : "\n") + "\n" + guard + "\n";
  }
  fs.writeFileSync(target, content);
  return { applied: true, target };
}

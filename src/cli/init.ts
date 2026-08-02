import fs from "node:fs";
import path from "node:path";
import { ProvenError } from "../shared/errors.js";
import { defaultConfig, saveConfig } from "../shared/config.js";
import { formatPendingDecision, pendingDecisions } from "../shared/decisions.js";
import { buildSpecIndex } from "../spec/index.js";
import { openDb } from "../store/projections.js";
import { eventsDir, exportsDir, logsDir, objectsDir, type Workspace } from "../store/paths.js";
import type { AgentId } from "../agents/index.js";

const GITIGNORE_ENTRIES = [
  ".proven/events/",
  ".proven/objects/",
  ".proven/projections.db",
  ".proven/logs/",
  ".proven/exports/",
];

/**
 * hookコマンド(REQ-230)。相対パスのリダイレクトを含めない。
 * ハーネスのセッションcwdがリポジトリ外だと相対パスの解決に失敗し、
 * sh がリダイレクトを開けずcaptureが一度も起動しないため(しかも `|| true` で無言成功になる)。
 * captureは起動後に対象ファイルから解決したワークスペースへ自前でエラーを記録する。
 *
 * agentは必ずコマンドに埋め込む(REQ-209)。ハーネスは入れ子で起動されうるため、
 * 実行時に環境から推測させず「呼んだ側が名乗る」形にする。
 */
export function hookCommand(phase: "pre" | "post", agent: AgentId = "claude-code"): string {
  return `sh -c 'proven capture --phase ${phase} --agent ${agent} >/dev/null 2>&1 || true'`;
}

/** 旧形式のproven hook(相対パスリダイレクト付き / --agent無し)か。置換対象の判定に使う(REQ-231) */
export function isLegacyHookCommand(cmd: string, agent: AgentId = "claude-code"): boolean {
  return /proven\s+capture\b/.test(cmd) && cmd !== hookCommand("pre", agent) && cmd !== hookCommand("post", agent);
}

/** PATH上に実行可能ファイルがあるか(プロセス起動なしで判定) */
function onPath(bin: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    try {
      const p = path.join(dir, bin);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return true;
    } catch {
      continue;
    }
  }
  return false;
}

export interface DetectedHarness {
  id: AgentId;
  signals: string[];
}

/**
 * 環境に存在するハーネスを検出する(REQ-208)。
 * 誤検出しても未使用なら発火しないため無害。「実行時に一発で当てる」のではなく
 * 「間違えても壊れない登録時」に判定を寄せるのがこの関数の狙い。
 */
export function detectHarnesses(ws: Workspace): DetectedHarness[] {
  const out: DetectedHarness[] = [];
  const add = (id: AgentId, signal: string | null): void => {
    if (!signal) return;
    const hit = out.find((h) => h.id === id);
    if (hit) hit.signals.push(signal);
    else out.push({ id, signals: [signal] });
  };

  if (fs.existsSync(path.join(ws.repoRoot, ".claude", "settings.json"))) add("claude-code", "file:.claude/settings.json");
  if (onPath("claude")) add("claude-code", "path:claude");

  const codexHome = process.env.CODEX_HOME ?? path.join(process.env.HOME ?? "", ".codex");
  if (onPath("codex")) add("codex", "path:codex");
  if (codexHome && fs.existsSync(codexHome)) add("codex", `dir:${codexHome}`);

  if (fs.existsSync(path.join(ws.repoRoot, "opencode.json"))) add("opencode", "file:opencode.json");
  if (fs.existsSync(path.join(ws.repoRoot, ".opencode"))) add("opencode", "dir:.opencode");
  if (onPath("opencode")) add("opencode", "path:opencode");

  return out;
}

export interface InitResult {
  created: boolean;
  gitignoreUpdated: boolean;
  hooksUpdated: boolean;
  reqIdsFound: number;
  messages: string[];
}

export function runInit(
  ws: Workspace,
  opts: { yes: boolean; isTTY: boolean; agents?: string[]; global?: boolean },
): InitResult {
  const messages: string[] = [];
  if (!opts.yes && !opts.isTTY) {
    throw new ProvenError("input", "非対話環境です。--yes を指定してください");
  }
  const firstTime = !fs.existsSync(ws.provenDir);
  fs.mkdirSync(ws.provenDir, { recursive: true, mode: 0o700 });
  for (const d of [eventsDir(ws), objectsDir(ws), logsDir(ws), exportsDir(ws), path.join(ws.provenDir, "rules")]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }
  const cfgPath = path.join(ws.provenDir, "config.yaml");
  if (!fs.existsSync(cfgPath)) saveConfig(ws.provenDir, defaultConfig());
  openDb(ws).close(); // DDL適用

  // .gitignore(重複追記しない)
  const giPath = path.join(ws.repoRoot, ".gitignore");
  const existing = fs.existsSync(giPath) ? fs.readFileSync(giPath, "utf8") : "";
  const lines = new Set(existing.split("\n").map((l) => l.trim()));
  const toAdd = GITIGNORE_ENTRIES.filter((e) => !lines.has(e));
  let gitignoreUpdated = false;
  if (toAdd.length > 0) {
    const add = (existing.endsWith("\n") || existing === "" ? "" : "\n") + toAdd.join("\n") + "\n";
    fs.appendFileSync(giPath, add);
    gitignoreUpdated = true;
  }

  // hook登録(REQ-208〜210)。既定はclaude-code + 検出できたハーネス全て。
  // 「使っていないハーネスに登録しても発火しなければ無害」なので、判定は登録時に寄せる。
  const targets: AgentId[] =
    opts.agents && opts.agents.length > 0
      ? (opts.agents as AgentId[])
      : ([...new Set<AgentId>(["claude-code", ...detectHarnesses(ws).map((h) => h.id)])] as AgentId[]);

  let hooksUpdated = false;
  for (const agent of targets) {
    switch (agent) {
      case "claude-code":
        hooksUpdated = registerClaudeCode(ws, messages, opts.global === true) || hooksUpdated;
        break;
      case "codex":
        hooksUpdated = registerCodex(ws, messages) || hooksUpdated;
        break;
      case "opencode":
        hooksUpdated = registerOpenCode(ws, messages) || hooksUpdated;
        break;
      default:
        messages.push(`未対応のハーネス指定のため登録をスキップしました: ${agent}`);
    }
  }

  // 仕様書スキャン。
  // 「1件も当たらない」と「当たったがREQ-IDが無い」は原因も対処も違うので分けて出す(REQ-821)。
  // 前者を黙って通すと全hunkが spec=判定不能 になり、それが unsolicited候補 のスコアに
  // 効くため、設定ミスがそのまま偽陽性の増加として現れる。
  const spec = buildSpecIndex(ws);
  if (spec.files > 0 && spec.reqIds === 0) {
    messages.push(
      "仕様書にREQ-xxx形式のIDが見つかりません。要求にIDを振る運用を推奨します(無IDでも動きますが判定精度が下がります)",
    );
  }
  messages.push("LLM送信は現在OFF。有効化は `proven config llm.enabled true`(初回に送信対象プレビューを表示)");

  // 未決の設定は最後にまとめて出す。既定値で動いてしまう分、
  // 決めたのか決めていないのかが後から見分けられなくなるため(REQ-823)
  const pending = pendingDecisions(ws);
  for (const d of pending) messages.push(formatPendingDecision(d));
  if (pending.length > 0) {
    messages.push(`未決が${pending.length}件あります。precheck のたびに再掲します`);
  }
  return { created: firstTime, gitignoreUpdated, hooksUpdated, reqIdsFound: spec.reqIds, messages };
}

type HookEntry = { matcher?: string; hooks?: { type: string; command: string; timeout?: number }[] };

/** claude-code のユーザー全体設定(REQ-820)。リポジトリを問わず読まれる */
export function globalClaudeSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.CLAUDE_CONFIG_DIR ?? path.join(env.HOME ?? "", ".claude"), "settings.json");
}

/**
 * claude-code: PreToolUse/PostToolUse に登録。
 *
 * 既定はリポジトリの `.claude/settings.json` だが、**Claude Code はセッション開始時の
 * cwd の設定しか読まない**。リポジトリ外(例: ホームディレクトリ)で起動したセッションから
 * このリポジトリを編集した場合、hookは一度も発火せず、それでいてエラーも出ない。
 * 「捕捉0件」と「変更が無い」が見分けられないのが最も危険なので、
 * 登録時に必ずその条件を伝え、--global でユーザー全体設定に置く道を用意する(REQ-820)。
 */
function registerClaudeCode(ws: Workspace, messages: string[], global: boolean): boolean {
  const settingsPath = global ? globalClaudeSettingsPath() : path.join(ws.repoRoot, ".claude", "settings.json");
  const label = global ? settingsPath : ".claude/settings.json";
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    } catch {
      throw new ProvenError("input", `${label} が不正なJSONです(上書きせず中断します): ${settingsPath}`);
    }
  }
  const changed = mergeHooks(settings);
  if (changed) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    messages.push(`hooks(PreToolUse/PostToolUse)を登録しました: ${label}`);
  }
  if (global) {
    messages.push("ユーザー全体に登録したので、どのディレクトリで起動したセッションからでも捕捉されます");
  } else {
    messages.push(
      "注意: この登録が効くのは、このリポジトリをcwdにして起動したセッションだけです。" +
        "別のディレクトリ(ホーム等)で起動したセッションから編集すると、hookは無言で一度も発火しません。" +
        "そのような使い方をするなら `proven init --global` を実行してください",
    );
  }
  return changed;
}

/**
 * codex: <repo>/.codex/hooks.json に登録(REQ-215)。
 * イベント名はCamelCase(実測)。matcherは付けない — Bash等でも発火するが、
 * 編集対象はパッチ本文から導くため対象外payloadはアダプタ側で落とせる。
 */
function registerCodex(ws: Workspace, messages: string[]): boolean {
  const hooksPath = path.join(ws.repoRoot, ".codex", "hooks.json");
  let doc: Record<string, unknown> = {};
  if (fs.existsSync(hooksPath)) {
    try {
      doc = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
    } catch {
      throw new ProvenError("input", `.codex/hooks.json が不正なJSONです(上書きせず中断します): ${hooksPath}`);
    }
  }
  const hooks = (doc.hooks ?? {}) as Record<string, HookEntry[]>;
  doc.hooks = hooks;
  let changed = false;
  for (const phase of ["pre", "post"] as const) {
    const key = phase === "pre" ? "PreToolUse" : "PostToolUse";
    const arr: HookEntry[] = Array.isArray(hooks[key]) ? hooks[key] : [];
    hooks[key] = arr;
    const cmd = hookCommand(phase, "codex");
    for (const entry of arr) {
      for (const h of entry.hooks ?? []) {
        if (isLegacyHookCommand(h.command, "codex")) {
          h.command = cmd;
          changed = true;
        }
      }
    }
    if (!arr.some((e) => e.hooks?.some((h) => h.command === cmd))) {
      arr.push({ hooks: [{ type: "command", command: cmd, timeout: 30 }] });
      changed = true;
    }
  }
  if (changed) {
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    fs.writeFileSync(hooksPath, JSON.stringify(doc, null, 2) + "\n");
    messages.push(
      "codex: .codex/hooks.json に登録しました。Codex CLI の `/hooks` で信頼(trust)を付与するまで実行されません(REQ-233)",
    );
  }
  return changed;
}

/**
 * opencode: <repo>/.opencode/plugin/proven.js を配置(REQ-220)。
 * プラグインはin-processで動くため、captureは子プロセスとして起動し、
 * その失敗がOpenCodeの動作を妨げないようにする(失敗は握りつぶす)。
 */
function registerOpenCode(ws: Workspace, messages: string[]): boolean {
  const pluginPath = path.join(ws.repoRoot, ".opencode", "plugin", "proven.js");
  const content = openCodePluginSource();
  const current = fs.existsSync(pluginPath) ? fs.readFileSync(pluginPath, "utf8") : null;
  if (current === content) return false;
  fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
  fs.writeFileSync(pluginPath, content);
  messages.push("opencode: .opencode/plugin/proven.js を配置しました(次回のopencode起動から有効)");
  return true;
}

/**
 * 同梱するOpenCodeプラグイン本体。
 * 実測(opencode 1.17.9): before では引数が output.args 側に入り、
 * after では input.args に入る。callIDはセッション内連番。
 */
export function openCodePluginSource(): string {
  return `// Proven capture plugin (generated by \`proven init\`)
// tool.execute.before / after を捕捉して proven capture へ渡す。
// 失敗してもOpenCodeの動作を止めない(すべて握りつぶす)。
import { spawn } from "node:child_process"

function send(phase, payload) {
  return new Promise((resolve) => {
    try {
      const p = spawn("proven", ["capture", "--phase", phase, "--agent", "opencode"], {
        stdio: ["pipe", "ignore", "ignore"],
      })
      p.on("error", () => resolve())
      p.on("close", () => resolve())
      p.stdin.on("error", () => resolve())
      p.stdin.end(JSON.stringify(payload))
    } catch {
      resolve()
    }
  })
}

export const ProvenPlugin = async ({ directory }) => ({
  "tool.execute.before": async (input, output) => {
    await send("pre", {
      agent: "opencode",
      tool: input?.tool,
      sessionID: input?.sessionID,
      callID: input?.callID,
      args: output?.args,
      cwd: directory,
    })
  },
  "tool.execute.after": async (input, output) => {
    await send("post", {
      agent: "opencode",
      tool: input?.tool,
      sessionID: input?.sessionID,
      callID: input?.callID,
      args: input?.args,
      output: { title: output?.title, metadata: output?.metadata },
      cwd: directory,
    })
  },
})
`;
}

function mergeHooks(settings: Record<string, unknown>): boolean {
  const hooks = (settings.hooks ?? {}) as Record<string, HookEntry[]>;
  settings.hooks = hooks;
  let changed = false;
  for (const phase of ["pre", "post"] as const) {
    const key = phase === "pre" ? "PreToolUse" : "PostToolUse";
    const arr: HookEntry[] = Array.isArray(hooks[key]) ? hooks[key] : [];
    hooks[key] = arr;
    const cmd = hookCommand(phase);
    // 旧形式は置換する(REQ-231)。追記すると同一編集が二重記録されるため
    for (const entry of arr) {
      for (const h of entry.hooks ?? []) {
        if (isLegacyHookCommand(h.command)) {
          h.command = cmd;
          changed = true;
        }
      }
    }
    // 置換後に空になったエントリ(hooksが空配列)は残さない
    const emptied = arr.filter((e) => (e.hooks ?? []).length === 0);
    for (const e of emptied) arr.splice(arr.indexOf(e), 1);
    const already = arr.some((e) => e.hooks?.some((h) => h.command === cmd));
    if (!already) {
      arr.push({ matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: cmd }] });
      changed = true;
    }
  }
  return changed;
}

import fs from "node:fs";
import path from "node:path";
import { AirevError } from "../shared/errors.js";
import { defaultConfig, saveConfig } from "../shared/config.js";
import { buildSpecIndex } from "../spec/index.js";
import { openDb } from "../store/projections.js";
import { eventsDir, exportsDir, logsDir, objectsDir, type Workspace } from "../store/paths.js";

const GITIGNORE_ENTRIES = [
  ".airev/events/",
  ".airev/objects/",
  ".airev/projections.db",
  ".airev/logs/",
  ".airev/exports/",
];

export function hookCommand(phase: "pre" | "post"): string {
  return `sh -c 'airev capture --phase ${phase} 2>>.airev/logs/capture-errors.log || true'`;
}

export interface InitResult {
  created: boolean;
  gitignoreUpdated: boolean;
  hooksUpdated: boolean;
  reqIdsFound: number;
  messages: string[];
}

export function runInit(ws: Workspace, opts: { yes: boolean; isTTY: boolean }): InitResult {
  const messages: string[] = [];
  if (!opts.yes && !opts.isTTY) {
    throw new AirevError("input", "非対話環境です。--yes を指定してください");
  }
  const firstTime = !fs.existsSync(ws.airevDir);
  fs.mkdirSync(ws.airevDir, { recursive: true, mode: 0o700 });
  for (const d of [eventsDir(ws), objectsDir(ws), logsDir(ws), exportsDir(ws), path.join(ws.airevDir, "rules")]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }
  const cfgPath = path.join(ws.airevDir, "config.yaml");
  if (!fs.existsSync(cfgPath)) saveConfig(ws.airevDir, defaultConfig());
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

  // hooks登録(.claude/settings.json)。不正JSONは非破壊でexit 2(S-10b)
  const settingsPath = path.join(ws.repoRoot, ".claude", "settings.json");
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    } catch {
      throw new AirevError("input", `.claude/settings.json が不正なJSONです(上書きせず中断します): ${settingsPath}`);
    }
  }
  const hooksUpdated = mergeHooks(settings);
  if (hooksUpdated) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    messages.push("hooks(PreToolUse/PostToolUse)を登録しました");
  }

  // 仕様書スキャン
  const spec = buildSpecIndex(ws);
  if (spec.reqIds === 0) {
    messages.push(
      "仕様書にREQ-xxx形式のIDが見つかりません。要求にIDを振る運用を推奨します(無IDでも動きますが判定精度が下がります)",
    );
  }
  messages.push("LLM送信は現在OFF。有効化は `airev config llm.enabled true`(初回に送信対象プレビューを表示)");
  messages.push("レビュー観点の事前定義は `airev policy init`(任意)");
  return { created: firstTime, gitignoreUpdated, hooksUpdated, reqIdsFound: spec.reqIds, messages };
}

type HookEntry = { matcher?: string; hooks?: { type: string; command: string }[] };

function mergeHooks(settings: Record<string, unknown>): boolean {
  const hooks = (settings.hooks ?? {}) as Record<string, HookEntry[]>;
  settings.hooks = hooks;
  let changed = false;
  for (const phase of ["pre", "post"] as const) {
    const key = phase === "pre" ? "PreToolUse" : "PostToolUse";
    const arr: HookEntry[] = Array.isArray(hooks[key]) ? hooks[key] : [];
    hooks[key] = arr;
    const cmd = hookCommand(phase);
    const already = arr.some((e) => e.hooks?.some((h) => h.command === cmd));
    if (!already) {
      arr.push({ matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: cmd }] });
      changed = true;
    }
  }
  return changed;
}

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { AirevError } from "../shared/errors.js";

export interface Workspace {
  repoRoot: string;
  airevDir: string;
}

export function git(repoRoot: string, args: string[], input?: Buffer): Buffer {
  try {
    return execFileSync("git", args, { cwd: repoRoot, input, maxBuffer: 64 * 1024 * 1024 });
  } catch (e: any) {
    if (e?.code === "ENOENT") throw new AirevError("external", "gitコマンドが見つかりません");
    throw e;
  }
}

export function findRepoRoot(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd }).toString().trim();
  } catch (e: any) {
    if (e?.code === "ENOENT") throw new AirevError("external", "gitコマンドが見つかりません");
    throw new AirevError("input", "gitリポジトリの外です(git管理下で実行してください)");
  }
}

export function workspace(cwd: string): Workspace {
  const repoRoot = findRepoRoot(cwd);
  return { repoRoot, airevDir: path.join(repoRoot, ".airev") };
}

export function requireInitialized(ws: Workspace): void {
  if (!fs.existsSync(ws.airevDir)) {
    throw new AirevError("input", ".airev/ がありません。`airev init` を先に実行してください");
  }
}

export function eventsDir(ws: Workspace): string {
  return path.join(ws.airevDir, "events");
}
export function objectsDir(ws: Workspace): string {
  return path.join(ws.airevDir, "objects");
}
export function logsDir(ws: Workspace): string {
  return path.join(ws.airevDir, "logs");
}
export function exportsDir(ws: Workspace): string {
  return path.join(ws.airevDir, "exports");
}
export function dbPath(ws: Workspace): string {
  return path.join(ws.airevDir, "projections.db");
}

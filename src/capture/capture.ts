import fs from "node:fs";
import path from "node:path";
import { loadConfig, matchAnyGlob } from "../shared/config.js";
import { sha256 } from "../shared/hash.js";
import type { EditPost, EditPre, EditTool } from "../shared/types.js";
import { appendEvent, readEvents } from "../store/events.js";
import { putObject } from "../store/objects.js";
import { logsDir, type Workspace } from "../store/paths.js";

const TARGET_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; notebook_path?: string; [k: string]: unknown };
  tool_use_id?: string;
  tool_response?: unknown;
}

function logCaptureError(ws: Workspace, msg: string): void {
  try {
    fs.mkdirSync(logsDir(ws), { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(logsDir(ws), "capture-errors.log"), `${new Date().toISOString()} ${msg}\n`, {
      mode: 0o600,
    });
  } catch {
    /* 開発を止めない: ログ失敗も握りつぶす */
  }
}

/**
 * 対象パス解決(詳細設計書4.1)。既存=自身をrealpath、新規=最も近い既存親をrealpath。
 * リポジトリ外/exclude一致はnull(捕捉対象外)。
 */
export function resolveCapturePath(
  ws: Workspace,
  filePathInput: string,
  captureExclude: string[],
): { abs: string; rel: string } | null {
  let abs = path.isAbsolute(filePathInput) ? filePathInput : path.join(ws.repoRoot, filePathInput);
  if (fs.existsSync(abs)) {
    abs = fs.realpathSync(abs);
  } else {
    // 新規ファイル: 最も近い既存親をrealpathして作成予定パスを正規化
    let dir = path.dirname(abs);
    const tail: string[] = [path.basename(abs)];
    while (!fs.existsSync(dir)) {
      tail.unshift(path.basename(dir));
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
    abs = path.join(fs.realpathSync(dir), ...tail);
  }
  const realRoot = fs.realpathSync(ws.repoRoot);
  if (!(abs === realRoot || abs.startsWith(realRoot + path.sep))) return null; // リポジトリ外
  const rel = path.relative(realRoot, abs);
  if (rel.startsWith(".airev/") || rel === ".airev") return null; // 自己データ除外
  if (matchAnyGlob(rel, captureExclude)) return null;
  return { abs, rel };
}

function transcriptTailLine(transcriptPath: string | undefined): number | null {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
  const text = fs.readFileSync(transcriptPath, "utf8");
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") n++;
  return n;
}

function operationId(input: HookInput, preBlobHash: string | null): string {
  if (input.tool_use_id) return input.tool_use_id;
  // フォールバック合成キー(詳細設計書4.1と同一方式)
  const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? "";
  return `synth:${input.session_id ?? "nosession"}:${file}:${(preBlobHash ?? "null").slice(0, 8)}`;
}

/**
 * capture本体。絶対原則: いかなる場合もthrowしない(exit 0 = 開発を止めない)。
 * 戻り値はテスト用の観測情報。
 */
export function runCapture(ws: Workspace, phase: "pre" | "post", input: HookInput): { recorded: boolean; reason?: string } {
  try {
    const toolName = input.tool_name ?? "";
    if (!TARGET_TOOLS.has(toolName)) return { recorded: false, reason: "non-target-tool" };
    const cfg = loadConfig(ws.airevDir);
    const rawPath = (input.tool_input?.file_path ?? input.tool_input?.notebook_path) as string | undefined;
    if (!rawPath) return { recorded: false, reason: "no-file-path" };
    const resolved = resolveCapturePath(ws, rawPath, cfg.capture.exclude);
    if (!resolved) return { recorded: false, reason: "excluded-or-outside" };

    const exists = fs.existsSync(resolved.abs) && fs.statSync(resolved.abs).isFile();
    const content = exists ? fs.readFileSync(resolved.abs) : null;
    let blobHash: string | null = null;
    if (content !== null) {
      const put = putObject(ws, content);
      blobHash = put.hash;
    }

    if (phase === "pre") {
      const payload: EditPre = {
        operation_id: operationId(input, blobHash),
        agent: "claude-code",
        session_ref: input.transcript_path ?? "",
        file: resolved.rel,
        pre_blob_hash: blobHash,
        tool: toolName as EditTool,
        conversation_ref: (() => {
          const line = transcriptTailLine(input.transcript_path);
          return line === null ? null : { transcript_line: line };
        })(),
      };
      appendEvent(ws, "edits", "edit_pre", payload);
    } else {
      const respOk = !(
        typeof input.tool_response === "object" &&
        input.tool_response !== null &&
        ("error" in (input.tool_response as object) || (input.tool_response as { success?: boolean }).success === false)
      );
      // tool_use_id欠落時: 同一session+fileの最新未マッチsynth preのキーへ対応付け(4.1)
      let opId = input.tool_use_id ?? null;
      if (!opId) {
        const evs = readEvents(ws, "edits").events;
        const posts = new Set(
          evs.filter((e) => e.type === "edit_post").map((e) => (e.payload as EditPost).operation_id),
        );
        for (let i = evs.length - 1; i >= 0; i--) {
          const e = evs[i];
          if (e.type !== "edit_pre") continue;
          const p = e.payload as EditPre;
          if (!p.operation_id.startsWith("synth:")) continue;
          if (p.session_ref === (input.transcript_path ?? "") || p.operation_id.includes(`:${resolved.rel}:`)) {
            if (!posts.has(p.operation_id)) {
              opId = p.operation_id;
              break;
            }
          }
        }
        if (!opId) opId = operationId(input, blobHash);
      }
      const payload: EditPost = {
        operation_id: opId,
        result_blob_hash: content !== null ? blobHash : null,
        tool_status: respOk ? "success" : "failure",
      };
      appendEvent(ws, "edits", "edit_post", payload);
    }
    return { recorded: true };
  } catch (e) {
    logCaptureError(ws, `capture ${phase} failed: ${String(e)}`);
    return { recorded: false, reason: `error: ${String(e)}` };
  }
}

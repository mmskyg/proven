import fs from "node:fs";
import path from "node:path";
import { loadConfig, matchAnyGlob } from "../shared/config.js";
import type { AgentDetectionRecord, EditPost, EditPre } from "../shared/types.js";
import { appendEvent, readEvents } from "../store/events.js";
import { putObject } from "../store/objects.js";
import { logsDir, type Workspace } from "../store/paths.js";
import { resolveAgent, type NormalizedCapture } from "../agents/index.js";

export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; notebook_path?: string; [k: string]: unknown };
  tool_use_id?: string;
  tool_response?: unknown;
  [k: string]: unknown;
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
  if (rel.startsWith(".proven/") || rel === ".proven") return null; // 自己データ除外
  if (matchAnyGlob(rel, captureExclude)) return null;
  return { abs, rel };
}

/** transcriptがファイルとして読める場合のみ行数を返す(sdk/none形式はnull) */
function transcriptTailLine(sessionRef: string): number | null {
  if (!sessionRef || !fs.existsSync(sessionRef)) return null;
  const text = fs.readFileSync(sessionRef, "utf8");
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") n++;
  return n;
}

function sessionIdOf(input: HookInput): string {
  const sid = input.session_id ?? (input as { sessionID?: string }).sessionID;
  return typeof sid === "string" && sid ? sid : "nosession";
}

/** ネイティブIDが無いときの合成キー(詳細設計書4.1と同一方式) */
function synthOperationId(input: HookInput, rawFile: string, preBlobHash: string | null): string {
  return `synth:${sessionIdOf(input)}:${rawFile}:${(preBlobHash ?? "null").slice(0, 8)}`;
}

/** post時にファイルが判らない場合、同一operation_idのpreイベントからファイルを補う */
function filesFromPriorPre(ws: Workspace, operationId: string): string[] {
  const evs = readEvents(ws, "edits").events;
  const files: string[] = [];
  for (const e of evs) {
    if (e.type !== "edit_pre") continue;
    const p = e.payload as EditPre;
    if (p.operation_id === operationId && !files.includes(p.file)) files.push(p.file);
  }
  return files;
}

export interface CaptureOptions {
  /** --agent による自己申告(REQ-205)。環境変数による推測より常に優先する */
  declaredAgent?: string | null;
}

/**
 * capture本体。絶対原則: いかなる場合もthrowしない(exit 0 = 開発を止めない)。
 * 戻り値はテスト用の観測情報。
 */
export function runCapture(
  ws: Workspace,
  phase: "pre" | "post",
  input: HookInput,
  opts: CaptureOptions = {},
): { recorded: boolean; reason?: string; agent?: string; files?: string[] } {
  try {
    const cfg = loadConfig(ws.provenDir);
    const resolved = resolveAgent({ declared: opts.declaredAgent ?? null, raw: input as Record<string, unknown> });
    const detection: AgentDetectionRecord = resolved.detection;
    const norm: NormalizedCapture | null = resolved.adapter.normalize(input as Record<string, unknown>, phase);
    if (!norm || !norm.isTargetTool) return { recorded: false, reason: "non-target-tool", agent: resolved.agent };

    let rawFiles = norm.files;
    // post時にファイルが判らないハーネスは、preイベントから補完する(1操作N ファイル対応)
    if (phase === "post" && rawFiles.length === 0 && norm.operationIdNative) {
      rawFiles = filesFromPriorPre(ws, norm.operationIdNative);
    }
    if (rawFiles.length === 0) return { recorded: false, reason: "no-file-path", agent: resolved.agent };

    const transcriptLine =
      resolved.adapter.capabilities.transcript === "sdk" || resolved.adapter.capabilities.transcript === "none"
        ? null
        : transcriptTailLine(norm.sessionRef);

    const recordedFiles: string[] = [];
    for (const rawFile of rawFiles) {
      const target = resolveCapturePath(ws, rawFile, cfg.capture.exclude);
      if (!target) continue; // リポジトリ外/除外

      const exists = fs.existsSync(target.abs) && fs.statSync(target.abs).isFile();
      const content = exists ? fs.readFileSync(target.abs) : null;
      const blobHash = content !== null ? putObject(ws, content).hash : null;

      if (phase === "pre") {
        const payload: EditPre = {
          operation_id: norm.operationIdNative ?? synthOperationId(input, rawFile, blobHash),
          agent: resolved.agent,
          session_ref: norm.sessionRef,
          file: target.rel,
          pre_blob_hash: blobHash,
          tool: norm.tool,
          conversation_ref: transcriptLine === null ? null : { transcript_line: transcriptLine },
          agent_detection: detection,
        };
        appendEvent(ws, "edits", "edit_pre", payload);
      } else {
        const opId = norm.operationIdNative ?? resolvePostOperationId(ws, input, norm, target.rel, blobHash);
        const payload: EditPost = {
          operation_id: opId,
          result_blob_hash: blobHash,
          tool_status: norm.toolStatus === "failure" ? "failure" : "success",
          file: target.rel,
        };
        appendEvent(ws, "edits", "edit_post", payload);
      }
      recordedFiles.push(target.rel);
    }

    if (recordedFiles.length === 0) return { recorded: false, reason: "excluded-or-outside", agent: resolved.agent };
    return { recorded: true, agent: resolved.agent, files: recordedFiles };
  } catch (e) {
    logCaptureError(ws, `capture ${phase} failed: ${String(e)}`);
    return { recorded: false, reason: `error: ${String(e)}` };
  }
}

/**
 * ネイティブID欠落時のpost対応付け(詳細設計書4.1)。
 * 同一session+fileの最新未マッチsynth preのキーへ寄せ、無ければ同じ合成規則で作る。
 */
function resolvePostOperationId(
  ws: Workspace,
  input: HookInput,
  norm: NormalizedCapture,
  rel: string,
  blobHash: string | null,
): string {
  const evs = readEvents(ws, "edits").events;
  const posts = new Set(evs.filter((e) => e.type === "edit_post").map((e) => (e.payload as EditPost).operation_id));
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e.type !== "edit_pre") continue;
    const p = e.payload as EditPre;
    if (!p.operation_id.startsWith("synth:")) continue;
    if (p.session_ref === norm.sessionRef || p.operation_id.includes(`:${rel}:`)) {
      if (!posts.has(p.operation_id)) return p.operation_id;
    }
  }
  const rawFile = norm.files[0] ?? rel;
  return synthOperationId(input, rawFile, blobHash);
}

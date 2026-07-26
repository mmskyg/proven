import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import lockfile from "proper-lockfile";
import { ulid } from "ulid";
import { sha256 } from "../shared/hash.js";
import { SCHEMA_VERSION, type EventEnvelope } from "../shared/types.js";
import type { Workspace } from "./paths.js";
import { eventsDir } from "./paths.js";

export type EventFile = "edits" | "analysis" | "decisions";

function lockWithRetry(target: string): () => void {
  // proper-lockfileのsync APIはretries非対応のため自前リトライ(単一writer直列化)
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      return lockfile.lockSync(target, { stale: 10000 });
    } catch (e) {
      if (Date.now() > deadline) throw e;
      const buf = new SharedArrayBuffer(4);
      Atomics.wait(new Int32Array(buf), 0, 0, 5); // 5ms sleep(同期)
    }
  }
}

function filePath(ws: Workspace, file: EventFile): string {
  return path.join(eventsDir(ws), `${file}.jsonl`);
}

function archiveDir(ws: Workspace): string {
  return path.join(eventsDir(ws), "archive");
}

function ensure(ws: Workspace): void {
  fs.mkdirSync(eventsDir(ws), { recursive: true, mode: 0o700 });
}

function lastLine(p: string): string | null {
  if (!fs.existsSync(p)) return null;
  const content = fs.readFileSync(p, "utf8");
  const lines = content.split("\n").filter((l) => l.length > 0);
  return lines.length ? lines[lines.length - 1] : null;
}

/** flock下のappend+fsync(基本設計9.3)。decisionsは全行prev_record_hash連鎖 */
export function appendEvent<T extends string, P>(
  ws: Workspace,
  file: EventFile,
  type: T,
  payload: P,
): EventEnvelope<T, P> {
  ensure(ws);
  const p = filePath(ws, file);
  if (!fs.existsSync(p)) fs.writeFileSync(p, "", { mode: 0o600 });
  const release = lockWithRetry(p);
  try {
    const env: EventEnvelope<T, P> = {
      schema_version: SCHEMA_VERSION,
      event_id: ulid(),
      type,
      ts: new Date().toISOString(),
      payload,
    };
    if (file === "decisions") {
      const prev = lastLine(p);
      env.prev_record_hash = prev ? sha256(prev) : "genesis";
    }
    const fd = fs.openSync(p, "a");
    try {
      fs.writeSync(fd, JSON.stringify(env) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return env;
  } finally {
    release();
  }
}

export interface ReadResult {
  events: EventEnvelope[];
  corruptLines: number;
  generations: number;
}

/** archive世代(古い順)→現行ファイルの順で読む。破損行はskipしてカウント(E-01) */
export function readEvents(ws: Workspace, file: EventFile): ReadResult {
  const events: EventEnvelope[] = [];
  let corruptLines = 0;
  let generations = 0;
  const sources: string[] = [];
  const adir = archiveDir(ws);
  if (fs.existsSync(adir)) {
    const archives = fs
      .readdirSync(adir)
      .filter((f) => f.startsWith(`${file}-`) && f.endsWith(".jsonl.gz"))
      .sort();
    for (const a of archives) {
      sources.push(path.join(adir, a));
      generations++;
    }
  }
  const cur = filePath(ws, file);
  if (fs.existsSync(cur)) sources.push(cur);
  for (const src of sources) {
    let text: string;
    if (src.endsWith(".gz")) {
      try {
        text = zlib.gunzipSync(fs.readFileSync(src)).toString("utf8");
      } catch {
        corruptLines++; // アーカイブ自体が読めない
        continue;
      }
    } else {
      text = fs.readFileSync(src, "utf8");
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const env = JSON.parse(line) as EventEnvelope;
        if (typeof env.type !== "string" || typeof env.event_id !== "string") throw new Error("bad");
        events.push(env);
      } catch {
        corruptLines++;
      }
    }
  }
  return { events, corruptLines, generations };
}

export interface ChainVerifyResult {
  ok: boolean;
  checkedRows: number;
  brokenAt: string | null; // 説明文
  note: string;
}

/**
 * decisionsチェーン検証(世代跨ぎ)。
 * 保証外: 後続ハッシュ・次世代アンカーの双方が無い最終世代の末尾行(E-47/U-08の限定)。
 */
export function verifyDecisionsChain(ws: Workspace): ChainVerifyResult {
  const segments: { name: string; lines: string[] }[] = [];
  const adir = archiveDir(ws);
  if (fs.existsSync(adir)) {
    for (const a of fs
      .readdirSync(adir)
      .filter((f) => f.startsWith("decisions-") && f.endsWith(".jsonl.gz"))
      .sort()) {
      const text = zlib.gunzipSync(fs.readFileSync(path.join(adir, a))).toString("utf8");
      segments.push({ name: a, lines: text.split("\n").filter((l) => l.length > 0) });
    }
  }
  const cur = filePath(ws, "decisions");
  if (fs.existsSync(cur)) {
    segments.push({
      name: "decisions.jsonl",
      lines: fs.readFileSync(cur, "utf8").split("\n").filter((l) => l.length > 0),
    });
  }
  let checkedRows = 0;
  let prevSegmentLastHash: string | null = null; // 直前セグメント末尾行のhash
  for (const seg of segments) {
    let prevLine: string | null = null;
    for (let i = 0; i < seg.lines.length; i++) {
      const line = seg.lines[i];
      let env: EventEnvelope;
      try {
        env = JSON.parse(line) as EventEnvelope;
      } catch {
        return { ok: false, checkedRows, brokenAt: `${seg.name}:${i + 1} (パース不能)`, note: chainNote() };
      }
      // 期待されるprev_record_hash
      let expected: string;
      if (prevLine !== null) {
        expected = sha256(prevLine);
      } else if (prevSegmentLastHash !== null) {
        expected = prevSegmentLastHash; // 世代先頭はアンカー(=前世代末尾hash)を指す
      } else {
        expected = "genesis";
      }
      if (env.prev_record_hash !== expected) {
        return { ok: false, checkedRows, brokenAt: `${seg.name}:${i + 1} (チェーン不整合)`, note: chainNote() };
      }
      if (env.type === "generation_started") {
        const p = env.payload as { last_record_hash: string };
        if (prevSegmentLastHash !== null && p.last_record_hash !== prevSegmentLastHash) {
          return { ok: false, checkedRows, brokenAt: `${seg.name}:${i + 1} (世代アンカー不一致)`, note: chainNote() };
        }
      }
      checkedRows++;
      prevLine = line;
    }
    if (prevLine !== null) prevSegmentLastHash = sha256(prevLine);
  }
  return { ok: true, checkedRows, brokenAt: null, note: chainNote() };
}

function chainNote(): string {
  return "検出保証外: 後続ハッシュ・次世代アンカーの双方が無い最終世代の末尾行のみ(改ざん耐性は非保証=基本設計9.4)";
}

/** 世代切替(F-11 rotate)。旧世代→archive/<name>-<gen>.jsonl.gz、新ファイル先頭にgeneration_started */
export function rotate(ws: Workspace, file: EventFile): { archived: string; generation: number } {
  ensure(ws);
  const p = filePath(ws, file);
  if (!fs.existsSync(p)) fs.writeFileSync(p, "", { mode: 0o600 });
  const release = lockWithRetry(p);
  try {
    const adir = archiveDir(ws);
    fs.mkdirSync(adir, { recursive: true, mode: 0o700 });
    const gen =
      fs.readdirSync(adir).filter((f) => f.startsWith(`${file}-`) && f.endsWith(".jsonl.gz")).length + 1;
    const name = `${file}-${String(gen).padStart(4, "0")}.jsonl.gz`;
    const content = fs.readFileSync(p, "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    const lastHash = lines.length ? sha256(lines[lines.length - 1]) : "genesis";
    fs.writeFileSync(path.join(adir, name), zlib.gzipSync(content), { mode: 0o600 });
    fs.writeFileSync(p, "", { mode: 0o600 });
    // 新世代先頭イベント
    const env: EventEnvelope<"generation_started", { previous_generation: string; last_record_hash: string }> = {
      schema_version: SCHEMA_VERSION,
      event_id: ulid(),
      type: "generation_started",
      ts: new Date().toISOString(),
      payload: { previous_generation: name, last_record_hash: lastHash },
    };
    if (file === "decisions") env.prev_record_hash = lastHash;
    const fd = fs.openSync(p, "a");
    try {
      fs.writeSync(fd, JSON.stringify(env) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return { archived: name, generation: gen };
  } finally {
    release();
  }
}

export function eventFileSize(ws: Workspace, file: EventFile): number {
  const p = filePath(ws, file);
  return fs.existsSync(p) ? fs.statSync(p).size : 0;
}

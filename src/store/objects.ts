import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { sha256 } from "../shared/hash.js";
import { OVERSIZE_BYTES } from "../shared/types.js";
import type { Workspace } from "./paths.js";
import { objectsDir } from "./paths.js";

export function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}
export function isOversize(buf: Buffer): boolean {
  return buf.length > OVERSIZE_BYTES;
}
export function isStorable(buf: Buffer): boolean {
  return !isBinary(buf) && !isOversize(buf);
}

function objPath(ws: Workspace, hash: string): string {
  return path.join(objectsDir(ws), hash.slice(0, 2), `${hash.slice(2)}.gz`);
}

/** content-addressed put。storable(テキスト≤5MB)のみ本文保存。戻り値は常にcontent_sha256 */
export function putObject(ws: Workspace, buf: Buffer): { hash: string; stored: boolean } {
  const hash = sha256(buf);
  if (!isStorable(buf)) return { hash, stored: false };
  const p = objPath(ws, hash);
  if (fs.existsSync(p)) return { hash, stored: true };
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, zlib.gzipSync(buf), { mode: 0o600 });
  fs.renameSync(tmp, p);
  return { hash, stored: true };
}

export function hasObject(ws: Workspace, hash: string): boolean {
  return fs.existsSync(objPath(ws, hash));
}

export function getObject(ws: Workspace, hash: string): Buffer | null {
  const p = objPath(ws, hash);
  if (!fs.existsSync(p)) return null;
  return zlib.gunzipSync(fs.readFileSync(p));
}

export function deleteObject(ws: Workspace, hash: string): boolean {
  const p = objPath(ws, hash);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

export function listObjects(ws: Workspace): string[] {
  const dir = objectsDir(ws);
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const pre of fs.readdirSync(dir)) {
    const sub = path.join(dir, pre);
    if (!fs.statSync(sub).isDirectory()) continue;
    for (const f of fs.readdirSync(sub)) {
      if (f.endsWith(".gz")) out.push(pre + f.slice(0, -3));
    }
  }
  return out;
}

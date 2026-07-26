import fs from "node:fs";
import path from "node:path";
import { loadConfig, matchAnyGlob } from "../shared/config.js";
import { ProvenError } from "../shared/errors.js";
import { sha256 } from "../shared/hash.js";
import { getObject, isBinary, isOversize, putObject } from "../store/objects.js";
import { git, type Workspace } from "../store/paths.js";

export interface ManifestEntry {
  path: string;
  mode: string;
  content_sha256: string;
  size: number;
  binary: boolean; // binary or oversize(=object非保存)
}

export interface Manifest {
  files: ManifestEntry[];
}

export interface Revision {
  ref: string; // commit:<oid> | worktree:<manifest_sha256>
  manifest: Manifest;
}

function excludedByCapture(ws: Workspace, rel: string): boolean {
  const cfg = loadConfig(ws.provenDir);
  if (rel === ".proven" || rel.startsWith(".proven/")) return true;
  return matchAnyGlob(rel, cfg.capture.exclude);
}

/** worktree revision: git ls-files集合からcapture.exclude/.provenを強制除外(3.5) */
export function buildWorktreeRevision(ws: Workspace): { rev: Revision; excludedCount: number } {
  const out = git(ws.repoRoot, ["ls-files", "--cached", "--others", "--exclude-standard"]).toString();
  const all = out.split("\n").filter((l) => l.length > 0);
  const entries: ManifestEntry[] = [];
  let excludedCount = 0;
  for (const rel of all.sort()) {
    if (excludedByCapture(ws, rel)) {
      excludedCount++;
      continue;
    }
    const abs = path.join(ws.repoRoot, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    const buf = fs.readFileSync(abs);
    const bin = isBinary(buf) || isOversize(buf);
    const { hash } = putObject(ws, buf); // storableのみ本文保存
    const mode = (fs.statSync(abs).mode & 0o111) !== 0 ? "100755" : "100644";
    entries.push({ path: rel, mode, content_sha256: hash, size: buf.length, binary: bin });
  }
  const manifest: Manifest = { files: entries };
  const canonical = JSON.stringify(manifest);
  const { hash } = putObject(ws, Buffer.from(canonical));
  return { rev: { ref: `worktree:${hash}`, manifest }, excludedCount };
}

/** commit revision: ls-tree全blobをcontent_sha256化(objects保存)しmanifest構築 */
export function buildCommitRevision(ws: Workspace, refspec: string): Revision {
  let oid: string;
  try {
    oid = git(ws.repoRoot, ["rev-parse", "--verify", `${refspec}^{commit}`]).toString().trim();
  } catch {
    throw new ProvenError("input", `不正なref: ${refspec}`);
  }
  const out = git(ws.repoRoot, ["ls-tree", "-r", oid]).toString();
  const entries: ManifestEntry[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const m = line.match(/^(\d+) blob ([0-9a-f]+)\t(.+)$/);
    if (!m) continue;
    const [, mode, , rel] = m;
    if (excludedByCapture(ws, rel)) continue;
    const buf = git(ws.repoRoot, ["cat-file", "blob", `${oid}:${rel}` as string]);
    const bin = isBinary(buf) || isOversize(buf);
    const { hash } = putObject(ws, buf);
    entries.push({ path: rel, mode, content_sha256: hash, size: buf.length, binary: bin });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { ref: `commit:${oid}`, manifest: { files: entries } };
}

/** refからmanifest復元。worktreeはobjects、commitは再構築 */
export function resolveRevision(ws: Workspace, ref: string): Revision {
  if (ref.startsWith("worktree:")) {
    const hash = ref.slice("worktree:".length);
    const buf = getObject(ws, hash);
    if (!buf) throw new ProvenError("corrupt", `worktreeマニフェストが見つかりません(purge済み?): ${ref}`);
    return { ref, manifest: JSON.parse(buf.toString()) as Manifest };
  }
  if (ref.startsWith("commit:")) {
    return buildCommitRevision(ws, ref.slice("commit:".length));
  }
  throw new ProvenError("input", `不正なrevision_ref: ${ref}`);
}

/** manifest entryの内容取得(テキスト≤5MBのみ保証=3.5)。無ければnull */
export function fileContent(ws: Workspace, entry: ManifestEntry | undefined): string | null {
  if (!entry || entry.binary) return null;
  const buf = getObject(ws, entry.content_sha256);
  return buf ? buf.toString("utf8") : null;
}

export function manifestMap(m: Manifest): Map<string, ManifestEntry> {
  return new Map(m.files.map((e) => [e.path, e]));
}

export function repoId(ws: Workspace): string {
  try {
    const roots = git(ws.repoRoot, ["rev-list", "--max-parents=0", "HEAD"]).toString().trim().split("\n");
    return roots[roots.length - 1] || sha256(ws.repoRoot);
  } catch {
    return sha256(ws.repoRoot); // コミットゼロのリポジトリ
  }
}

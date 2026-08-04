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
  /** 読めなかったパス(REQ-829)。commit revision のみ設定される */
  unreadable?: string[];
}

/** proven自身の管理ファイルか(REQ-822)。追跡対象外だが「除外した」とは数えない */
function isProvenInternal(rel: string): boolean {
  return rel === ".proven" || rel.startsWith(".proven/");
}

function excludedByCapture(ws: Workspace, rel: string): boolean {
  const cfg = loadConfig(ws.provenDir);
  if (isProvenInternal(rel)) return true;
  return matchAnyGlob(rel, cfg.capture.exclude);
}

/**
 * gitのパス出力を生のUTF-8で受け取るための引数(REQ-829)。
 *
 * 既定(`core.quotepath=true`)では non-ASCII が octal-quote されて
 * `"\346\227\245..."` の形で返る。これをそのままパスとして扱うと
 * `fs.existsSync` が false になり、**日本語名のファイルが黙ってmanifestから消える**。
 * 警告も出ないので「捕捉0件」と「変更なし」が区別できなくなる。
 *
 * `-z`(NUL区切り)ではなくこちらを選ぶ理由は、出力パーサ(split("\n")と
 * ls-treeの正規表現)を書き換えずに済むため。
 * **その代わり改行を含むファイル名は依然として扱えない。**
 */
const QUOTEPATH_OFF = ["-c", "core.quotepath=off"];

/** worktree revision: git ls-files集合からcapture.exclude/.provenを強制除外(3.5) */
export function buildWorktreeRevision(ws: Workspace): {
  rev: Revision;
  excludedCount: number;
  /** git的には存在するが読めなかったパス(REQ-829)。黙って捨てず呼び出し側で警告する */
  unreadable: string[];
} {
  const out = git(ws.repoRoot, [
    ...QUOTEPATH_OFF,
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
  ]).toString();
  const all = out.split("\n").filter((l) => l.length > 0);
  const entries: ManifestEntry[] = [];
  const unreadable: string[] = [];
  let excludedCount = 0;
  for (const rel of all.sort()) {
    if (excludedByCapture(ws, rel)) {
      // .proven/config.yaml はgit管理下に置く運用なので、数えると全リポジトリで
      // 「exclude対象1件」が永久に出続け、対処のしようがない警告になる(REQ-822)。
      // 利用者が capture.exclude で意図的に外したものだけを数える。
      if (!isProvenInternal(rel)) excludedCount++;
      continue;
    }
    const abs = path.join(ws.repoRoot, rel);
    let buf: Buffer;
    let mode: string;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) continue; // ディレクトリ・symlink等は元から対象外
      buf = fs.readFileSync(abs);
      mode = (st.mode & 0o111) !== 0 ? "100755" : "100644";
    } catch (e) {
      // REQ-829: 以前はここで無言の continue だった。パス破損・権限のいずれでも
      // 同じく無音になるため、必ず呼び出し側へ知らせる。
      //
      // ただし「indexにあるがworktreeに無い」= コミット前の削除は正常な状態で、
      // head manifest から消えることで削除hunkとして**きちんとレビューされる**。
      // ここで警告すると、rm してからコミットするまでの間ずっと嘘の警告が出続ける
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") unreadable.push(rel);
      continue;
    }
    const bin = isBinary(buf) || isOversize(buf);
    const { hash } = putObject(ws, buf); // storableのみ本文保存
    entries.push({ path: rel, mode, content_sha256: hash, size: buf.length, binary: bin });
  }
  const manifest: Manifest = { files: entries };
  const canonical = JSON.stringify(manifest);
  const { hash } = putObject(ws, Buffer.from(canonical));
  return { rev: { ref: `worktree:${hash}`, manifest }, excludedCount, unreadable };
}

/** commit revision: ls-tree全blobをcontent_sha256化(objects保存)しmanifest構築 */
export function buildCommitRevision(ws: Workspace, refspec: string): Revision {
  let oid: string;
  try {
    oid = git(ws.repoRoot, ["rev-parse", "--verify", `${refspec}^{commit}`]).toString().trim();
  } catch {
    throw new ProvenError("input", `不正なref: ${refspec}`);
  }
  const out = git(ws.repoRoot, [...QUOTEPATH_OFF, "ls-tree", "-r", oid]).toString();
  const entries: ManifestEntry[] = [];
  const unreadable: string[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const m = line.match(/^(\d+) blob ([0-9a-f]+)\t(.+)$/);
    if (!m) continue;
    const [, mode, , rel] = m;
    if (excludedByCapture(ws, rel)) continue;
    let buf: Buffer;
    try {
      buf = git(ws.repoRoot, ["cat-file", "blob", `${oid}:${rel}` as string]);
    } catch {
      // REQ-829: 1ファイルのcat-file失敗で ingest 全体を落とさない。
      // 以前は raw な git fatal がそのまま外へ出ていた
      unreadable.push(rel);
      continue;
    }
    const bin = isBinary(buf) || isOversize(buf);
    const { hash } = putObject(ws, buf);
    entries.push({ path: rel, mode, content_sha256: hash, size: buf.length, binary: bin });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { ref: `commit:${oid}`, manifest: { files: entries }, unreadable };
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

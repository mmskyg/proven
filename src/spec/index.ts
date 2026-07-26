import fs from "node:fs";
import path from "node:path";
import { loadConfig, globToRegExp } from "../shared/config.js";
import { sha256 } from "../shared/hash.js";
import { openDb } from "../store/projections.js";
import type { Workspace } from "../store/paths.js";

const REQ_RE = /REQ-\d+/g;

function walkFiles(root: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === ".proven" || entry.name === "node_modules") continue;
    const p = path.join(root, entry.name);
    if (entry.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

export function specFiles(ws: Workspace): string[] {
  const cfg = loadConfig(ws.provenDir);
  const regs = cfg.spec_sources.map((s) => globToRegExp(s.glob));
  return walkFiles(ws.repoRoot)
    .map((p) => path.relative(ws.repoRoot, p))
    .filter((rel) => regs.some((r) => r.test(rel)))
    .sort();
}

/** 全対象ファイルdigestの結合SHA-256(findingのstale判定用) */
export function specDigest(ws: Workspace): string | null {
  const files = specFiles(ws);
  if (files.length === 0) return null;
  const parts = files.map((f) => `${f}:${sha256(fs.readFileSync(path.join(ws.repoRoot, f)))}`);
  return sha256(parts.join("\n"));
}

export interface SpecIndexResult {
  files: number;
  paragraphs: number;
  reqIds: number;
}

/** 仕様書md走査→spec_index/spec_fts構築(4.2) */
export function buildSpecIndex(ws: Workspace): SpecIndexResult {
  const db = openDb(ws);
  db.prepare("DELETE FROM spec_index").run();
  db.prepare("DELETE FROM spec_fts").run();
  const files = specFiles(ws);
  let paragraphs = 0;
  const reqSet = new Set<string>();
  const ins = db.prepare("INSERT INTO spec_index(req_id, file, section, heading, body_digest, tokens) VALUES (?,?,?,?,?,?)");
  const insFts = db.prepare("INSERT INTO spec_fts(req_id, heading, body, file, section) VALUES (?,?,?,?,?)");
  for (const rel of files) {
    const text = fs.readFileSync(path.join(ws.repoRoot, rel), "utf8");
    let heading = "";
    let sectionNo = 0;
    for (const para of text.split(/\n\s*\n/)) {
      const trimmed = para.trim();
      if (!trimmed) continue;
      sectionNo++;
      const hm = trimmed.match(/^#+\s+(.+)$/m);
      if (hm) heading = hm[1];
      const reqs = trimmed.match(REQ_RE) ?? [];
      const reqId = reqs.length ? reqs[0] : null;
      for (const r of reqs) reqSet.add(r);
      paragraphs++;
      const section = `${rel}#p${sectionNo}`;
      const tokens = tokenize(trimmed).join(" ");
      ins.run(reqId, rel, section, heading, sha256(trimmed), tokens);
      // FTS本文は自前トークン列(unicode61は日本語境界で分割できないため)
      insFts.run(reqId ?? "", heading, tokens, rel, section);
    }
  }
  db.close();
  return { files: files.length, paragraphs, reqIds: reqSet.size };
}

/**
 * section識別子(`<file>#p<N>`)から仕様書の該当段落本文を復元する(REQ-601)。
 * spec_indexはトークン列とハッシュしか持たないため、証拠提示にはファイルを読み直す。
 */
export function specParagraph(ws: Workspace, section: string): string | null {
  const m = /^(.*)#p(\d+)$/.exec(section);
  if (!m) return null;
  const abs = path.join(ws.repoRoot, m[1]);
  if (!fs.existsSync(abs)) return null;
  const want = Number(m[2]);
  let n = 0;
  for (const para of fs.readFileSync(abs, "utf8").split(/\n\s*\n/)) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    n++;
    if (n === want) return trimmed;
  }
  return null;
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.match(/[A-Za-z_][A-Za-z0-9_]{2,}|[ぁ-んァ-ヶ一-龠]{2,}/g) ?? []) {
    if (/^[A-Za-z_]/.test(m)) {
      out.push(m.toLowerCase());
      continue;
    }
    // 日本語は貪欲マッチで長大な塊になり一致が取れないため2-gramへ分解する。
    // 助詞・活用語尾の誤ヒットを避けるため漢字・カタカナを含むgramのみ採る。
    for (let i = 0; i + 2 <= m.length; i++) {
      const g = m.slice(i, i + 2);
      if (/[ァ-ヶ一-龠]/.test(g)) out.push(g);
    }
  }
  return out;
}

export interface SpecHit {
  req_id: string | null;
  file: string;
  section: string;
  heading: string;
  snippet: string;
  score: number;
}

/** FTS検索(claims spec_support用)。ヒットなしはnull */
export function searchSpec(ws: Workspace, queryTokens: string[]): SpecHit | null {
  if (queryTokens.length === 0) return null;
  const db = openDb(ws);
  try {
    const q = queryTokens
      .slice(0, 12)
      .map((t) => `"${t.replace(/"/g, "")}"`)
      .join(" OR ");
    const row = db
      .prepare(
        `SELECT req_id, file, section, heading, snippet(spec_fts, 2, '', '', '…', 24) AS snippet, rank
         FROM spec_fts WHERE spec_fts MATCH ? ORDER BY rank LIMIT 1`,
      )
      .get(q) as { req_id: string; file: string; section: string; heading: string; snippet: string; rank: number } | undefined;
    if (!row) return null;
    return {
      req_id: row.req_id || null,
      file: row.file,
      section: row.section,
      heading: row.heading,
      snippet: row.snippet,
      score: -row.rank, // fts5 rankは小さいほど良い
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

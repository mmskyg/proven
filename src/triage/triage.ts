import fs from "node:fs";
import path from "node:path";
import { loadConfig, matchAnyGlob } from "../shared/config.js";
import { ProvenError } from "../shared/errors.js";
import { INDETERMINATE } from "../shared/types.js";
import { openDbChecked } from "../store/projections.js";
import type { Workspace } from "../store/paths.js";

export interface TriageFactor {
  factor: string;
  points: number;
}

export interface TriageRow {
  hunk_instance_id: string;
  file: string;
  new_start: number;
  new_lines: number;
  edit_capture_status: string | null;
  lineage_status: string | null;
  oversize: boolean;
  score: number;
  factors: TriageFactor[];
  group: "focus" | "light";
  necessity: string | null;
  necessityReason: string | null;
  instructed: string | null;
  specSupport: string | null;
}

export interface TriageResult {
  rows: TriageRow[];
  counts: { total: number; focus: number; light: number; uncaptured: number; broken: number; unsolicited: number };
  warnings: string[];
}

/** 加点表(機能設計書F-03)。内訳は常に保持 */
export function runTriage(ws: Workspace): TriageResult {
  const cfg = loadConfig(ws.provenDir);
  // 不正glob検出(E-35)
  for (const g of cfg.triage.boundary_paths) {
    try {
      matchAnyGlob("x", [g]);
    } catch {
      throw new ProvenError("input", `triage.boundary_paths に不正なglobがあります: ${g}`);
    }
  }
  const db = openDbChecked(ws);
  try {
    const latest = db
      .prepare("SELECT job_id FROM ingest_runs ORDER BY ts DESC, job_id DESC LIMIT 1")
      .get() as { job_id: string } | undefined;
    if (!latest) throw new ProvenError("empty", "ingestが未実行です。`proven ingest` を実行してください");
    const hunks = db
      .prepare(
        `SELECT hunk_instance_id, file, new_start, new_lines, edit_capture_status, lineage_status, oversize
         FROM hunks WHERE ingest_job_id=?`,
      )
      .all(latest.job_id) as {
      hunk_instance_id: string;
      file: string;
      new_start: number;
      new_lines: number;
      edit_capture_status: string | null;
      lineage_status: string | null;
      oversize: number;
    }[];
    if (hunks.length === 0) throw new ProvenError("empty", "最新ingestに対象hunkがありません");

    const claimStmt = db.prepare("SELECT kind, value, reason FROM claims WHERE hunk_ref=?");
    const ocStmt = db.prepare("SELECT attribute, confirmed_value FROM origin_confirmed WHERE hunk_ref=?");
    const rows: TriageRow[] = [];
    const warnings: string[] = [];
    let unsolicitedCount = 0;

    for (const h of hunks) {
      const claims = claimStmt.all(h.hunk_instance_id) as { kind: string; value: string; reason: string }[];
      const oc = ocStmt.all(h.hunk_instance_id) as { attribute: string; confirmed_value: string }[];
      const get = (k: string) => claims.filter((c) => c.kind === k).map((c) => c.value)[0] ?? null;
      const confirmed = (a: string) => oc.find((o) => o.attribute === a)?.confirmed_value ?? null;
      const necessity = confirmed("necessity") ?? get("necessity");
      const necessityReason = claims.find((c) => c.kind === "necessity")?.reason ?? null;
      const instructed = confirmed("instructed") ?? get("instructed");
      const specSupport = confirmed("spec_support") ?? get("spec_support");

      const factors: TriageFactor[] = [];
      if (matchAnyGlob(h.file, cfg.triage.boundary_paths)) factors.push({ factor: "boundary-path", points: 40 });
      const isUnsolicited = necessity === "unsolicited候補" || necessity === "unsolicited";
      if (isUnsolicited) {
        factors.push({ factor: "unsolicited-candidate", points: 30 });
        unsolicitedCount++;
      }
      // candidateは帰属未確定なので精読対象。表示はuncapturedと区別する(REQ-411)
      const noLineage =
        h.edit_capture_status === "uncaptured" ||
        h.lineage_status === "broken" ||
        h.lineage_status === "candidate";
      if (noLineage) factors.push({ factor: "no-lineage", points: 25 });
      if (hasNewExternal(h, db)) factors.push({ factor: "new-external-dep", points: 20 });
      const refApprox = referencedApprox(ws, db, h.hunk_instance_id);
      if (refApprox) factors.push({ factor: "referenced-approx", points: 15 });
      const ruleHits = 0; // ルールストア過去指摘一致はlearn(Phase 3)導入後
      if (ruleHits > 0) factors.push({ factor: "rule-hits", points: 10 * ruleHits });
      if (necessity === "incidental") factors.push({ factor: "incidental", points: -30 });
      if (h.oversize) warnings.push(`${h.file}:${h.new_start} は300行超のoversize hunkです(Phase 2で分割対応)`);

      const score = factors.reduce((a, f) => a + f.points, 0);
      rows.push({
        hunk_instance_id: h.hunk_instance_id,
        file: h.file,
        new_start: h.new_start,
        new_lines: h.new_lines,
        edit_capture_status: h.edit_capture_status,
        lineage_status: h.lineage_status,
        oversize: h.oversize === 1,
        score,
        factors,
        group: necessity === "incidental" ? "light" : "focus",
        necessity,
        necessityReason,
        instructed,
        specSupport,
      });
    }
    rows.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.new_start - b.new_start);
    const uncaptured = rows.filter((r) => r.edit_capture_status === "uncaptured").length;
    const broken = rows.filter((r) => r.lineage_status === "broken").length;
    return {
      rows,
      counts: {
        total: rows.length,
        focus: rows.filter((r) => r.group === "focus").length,
        light: rows.filter((r) => r.group === "light").length,
        uncaptured,
        broken,
        unsolicited: unsolicitedCount,
      },
      warnings,
    };
  } finally {
    db.close();
  }
}

function hasNewExternal(h: { file: string }, _db: unknown): boolean {
  // MVP近似: lockfile/依存定義ファイルの変更を新規外部依存とみなす
  return /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt|go\.sum|Cargo\.lock)$/.test(h.file);
}

function referencedApprox(_ws: Workspace, _db: unknown, _hunkId: string): boolean {
  return false; // MVP: 被参照数近似は未実装(factor名で近似であることを明示する設計のみ先行)
}

export function renderTriageText(r: TriageResult): string {
  const lines: string[] = [];
  lines.push("◆ 精読推奨順");
  let i = 0;
  for (const row of r.rows.filter((x) => x.group === "focus")) {
    i++;
    const tags = row.factors.map((f) => `${f.factor}${f.points >= 0 ? "+" : ""}${f.points}`).join(", ");
    lines.push(`  ${i}. ${row.file}:${row.new_start} [${tags}] 計${row.score}`);
    const origin = `instructed=${row.instructed ?? "-"} / spec=${row.specSupport ?? "-"} / necessity=${row.necessity ?? "-"}`;
    lines.push(`     来歴: ${row.edit_capture_status ?? "-"}${row.lineage_status ? "/" + row.lineage_status : ""}  ${origin}`);
    if (row.necessityReason) lines.push(`     経緯: ${row.necessityReason}`);
  }
  const light = r.rows.filter((x) => x.group === "light");
  lines.push(`◆ 軽確認(incidental) ${light.length} hunks`);
  for (const row of light) lines.push(`  - ${row.file}:${row.new_start} 計${row.score}`);
  lines.push(
    `合計${r.counts.total} hunks / 来歴不明 ${r.counts.uncaptured + r.counts.broken} (uncaptured ${r.counts.uncaptured} / broken ${r.counts.broken}) / unsolicited候補 ${r.counts.unsolicited}`,
  );
  for (const w of r.warnings) lines.push(`⚠ ${w}`);
  return lines.join("\n");
}

export function renderTriageMd(r: TriageResult): string {
  const L: string[] = [];
  L.push("# proven triageレポート", "");
  L.push(`- 対象hunk: ${r.counts.total} / 精読 ${r.counts.focus} / 軽確認 ${r.counts.light}`);
  L.push(
    `- 来歴内訳: uncaptured ${r.counts.uncaptured} / broken ${r.counts.broken} / unsolicited候補 ${r.counts.unsolicited}`,
    "",
  );
  L.push("## 精読リスト", "");
  L.push("| # | 位置 | score | 加点内訳 | 来歴 | necessity |");
  L.push("|---|---|---|---|---|---|");
  let i = 0;
  for (const row of r.rows.filter((x) => x.group === "focus")) {
    i++;
    const tags = row.factors.map((f) => `${f.factor}(${f.points})`).join("<br>") || "-";
    L.push(
      `| ${i} | ${row.file}:${row.new_start} | ${row.score} | ${tags} | ${row.edit_capture_status ?? "-"}${row.lineage_status ? "/" + row.lineage_status : ""} | ${row.necessity ?? INDETERMINATE} |`,
    );
  }
  L.push("", "## unsolicited一覧", "");
  const uns = r.rows.filter((x) => x.necessity?.startsWith("unsolicited"));
  if (uns.length === 0) L.push("なし");
  for (const row of uns) L.push(`- ${row.file}:${row.new_start} — ${row.necessityReason ?? ""}`);
  L.push("");
  return L.join("\n");
}

export function writeTriageMd(ws: Workspace, outPath: string, r: TriageResult): void {
  const abs = path.isAbsolute(outPath) ? outPath : path.join(process.cwd(), outPath);
  const tmp = `${abs}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, renderTriageMd(r));
  fs.renameSync(tmp, abs); // atomic rename
}

import fs from "node:fs";
import path from "node:path";
import { ulid } from "ulid";
import { ProvenError } from "../shared/errors.js";
import { loadConfig, matchAnyGlob } from "../shared/config.js";
import { formatPendingDecision, pendingDecisions } from "../shared/decisions.js";
import type { Finding } from "../shared/types.js";
import { appendEvent } from "../store/events.js";
import { applyEvent, openDbChecked } from "../store/projections.js";
import { exportsDir, type Workspace } from "../store/paths.js";
import { specDigest } from "../spec/index.js";
import { fileContent, manifestMap, resolveRevision } from "../ingest/revision.js";
import { splitLines } from "../ingest/diff.js";
import { loadPolicy, type Rule } from "./policy.js";
import { runIngest, type IngestSummary } from "../ingest/ingest.js";

export interface PrecheckResult {
  findings: Finding[];
  unsolicited: { hunkId: string; file: string; line: number; reason: string; noted: boolean }[];
  expectations: { type: string; satisfied: boolean | null; detail: string }[];
  prDraftPath: string;
  gate: boolean; // true=exit 10
  warnings: string[];
  ingest: IngestSummary | null;
}

interface RuleViolation {
  rule: Rule;
  file: string;
  line: number;
  text: string;
}

function scanRegexViolations(rules: Rule[], filePath: string, content: string): RuleViolation[] {
  const out: RuleViolation[] = [];
  const lines = splitLines(content);
  for (const rule of rules) {
    if (rule.pattern.type !== "regex") continue;
    if (rule.scope && !matchAnyGlob(filePath, rule.scope)) continue;
    const re = new RegExp(rule.pattern.expr);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) out.push({ rule, file: filePath, line: i + 1, text: lines[i] });
    }
  }
  return out;
}

/** precheck(F-12b)。anti_patternsはbase/head両検査で新規・悪化のみblock */
export function runPrecheck(ws: Workspace, opts: { skipIngest?: boolean } = {}): PrecheckResult {
  const warnings: string[] = [];
  const loaded = loadPolicy(ws);
  // 不正policy: 安全側で実行中止(v0.3)。警告のみ(rule_id重複等)は続行
  if (loaded && loaded.lintErrors.some((e) => !e.startsWith("警告:"))) {
    throw new ProvenError(
      "input",
      `policy.yamlが不正なためprecheckを中止します(壊れたpolicyの一部だけで「通過」を出しません):\n  ` +
        loaded.lintErrors.join("\n  "),
    );
  }
  if (loaded) warnings.push(...loaded.lintErrors.filter((e) => e.startsWith("警告:")));

  // ingest内部実行(未実行または最新化)
  let ingestSummary: IngestSummary | null = null;
  if (!opts.skipIngest) {
    try {
      ingestSummary = runIngest(ws);
    } catch (e) {
      if (e instanceof ProvenError && e.category === "empty") {
        // 差分なし or 冪等no-op → 既存の最新ingestで続行
      } else throw e;
    }
  }

  const db = openDbChecked(ws);
  try {
    const latest = db
      .prepare("SELECT job_id, base_revision_ref, head_revision_ref FROM ingest_runs ORDER BY ts DESC, job_id DESC LIMIT 1")
      .get() as { job_id: string; base_revision_ref: string; head_revision_ref: string } | undefined;
    if (!latest) throw new ProvenError("empty", "ingest対象がありません(差分なし)");

    const base = resolveRevision(ws, latest.base_revision_ref);
    const head = resolveRevision(ws, latest.head_revision_ref);
    const baseMap = manifestMap(base.manifest);
    const headMap = manifestMap(head.manifest);
    const findings: Finding[] = [];
    const runId = ulid();
    const sd = specDigest(ws);
    const pd = loaded?.policyDigest ?? null;

    // 1. anti_patterns(regex): head違反のうちbaseに無い行のみblock対象
    const regexRules = (loaded?.rules ?? []).filter((r) => r.pattern.type === "regex");
    const skippedTypes = new Set((loaded?.rules ?? []).filter((r) => r.pattern.type !== "regex").map((r) => r.pattern.type));
    for (const t of skippedTypes) warnings.push(`detect.type=${t} のルールはMVPではskippedです(Phase 2)`);

    if (regexRules.length) {
      const targetFiles = new Set<string>([...headMap.keys()]);
      for (const file of targetFiles) {
        const hEntry = headMap.get(file);
        if (!hEntry || hEntry.binary) continue;
        const headContent = fileContent(ws, hEntry);
        if (headContent === null) continue;
        const headViolations = scanRegexViolations(regexRules, file, headContent);
        if (headViolations.length === 0) continue;
        const bEntry = baseMap.get(file);
        const baseContent = bEntry && !bEntry.binary ? fileContent(ws, bEntry) : null;
        const baseViolLines = new Set(
          (baseContent !== null ? scanRegexViolations(regexRules, file, baseContent) : []).map(
            (v) => `${v.rule.rule_id}:${v.text.trim()}`,
          ),
        );
        for (const v of headViolations) {
          const isNew = !baseViolLines.has(`${v.rule.rule_id}:${v.text.trim()}`);
          const f: Finding = {
            finding_id: ulid(),
            run_id: runId,
            hunk_ref: null,
            lens: "anti_pattern",
            severity: isNew ? v.rule.severity : "warn", // 既存違反はwarn格下げ
            outcome: "fail",
            verification_level: "tool-confirmed",
            disposition: "open",
            location: { file: v.file, line: v.line },
            rule_ref: v.rule.rule_id,
            reason: `${v.rule.description}${isNew ? "" : "(既存違反: 参考表示)"}`,
            fix_hint: `該当行を修正してください: ${v.text.trim().slice(0, 80)}`,
            target_revision_ref: latest.head_revision_ref,
            spec_digest: sd,
            policy_digest: pd,
            evidence_refs: [],
          };
          findings.push(f);
          const env = appendEvent(ws, "analysis", "finding", f);
          applyEvent(db, env);
        }
      }
    }

    // 2. unsolicited一覧(claims+origin_confirmed統合)
    const unsRows = db
      .prepare(
        `SELECT h.hunk_instance_id, h.file, h.new_start, c.reason,
                (SELECT confirmed_value FROM origin_confirmed o WHERE o.hunk_ref=h.hunk_instance_id AND o.attribute='necessity') AS confirmed
         FROM hunks h JOIN claims c ON c.hunk_ref=h.hunk_instance_id AND c.kind='necessity'
         WHERE h.ingest_job_id=? AND (c.value LIKE 'unsolicited%' OR confirmed='unsolicited')`,
      )
      .all(latest.job_id) as { hunk_instance_id: string; file: string; new_start: number; reason: string; confirmed: string | null }[];

    // 3. req_coverage(unverified・gate対象外) — MVPは対応表提示のみ
    const reqFinding: Finding = {
      finding_id: ulid(),
      run_id: runId,
      hunk_ref: null,
      lens: "req_coverage",
      severity: "warn",
      outcome: "indeterminate",
      verification_level: "unverified",
      disposition: "open",
      location: null,
      rule_ref: null,
      reason: "REQ対応の推定はspec claim由来のためunverified(gate対象外)",
      fix_hint: null,
      target_revision_ref: latest.head_revision_ref,
      spec_digest: sd,
      policy_digest: pd,
      evidence_refs: [],
    };
    findings.push(reqFinding);
    applyEvent(db, appendEvent(ws, "analysis", "finding", reqFinding));

    // 4. expectations(型付きのみ機械判定)
    const expectations: PrecheckResult["expectations"] = [];
    const lockfileChanged = [...headMap.keys()].some(
      (p) =>
        /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt|go\.sum|Cargo\.lock)$/.test(p) &&
        baseMap.get(p)?.content_sha256 !== headMap.get(p)?.content_sha256,
    );
    const notes = loadHunkNotes(ws);
    for (const e of loaded?.policy.expectations ?? []) {
      if (e.type === "new_dependency_reason") {
        expectations.push({
          type: e.type,
          satisfied: lockfileChanged ? notes.dependencyReason !== null : true,
          detail: lockfileChanged
            ? notes.dependencyReason
              ? "新規依存あり: 理由記載を確認"
              : "新規依存がありますがPR説明の理由が未記入です(pr-draft.mdに記入してください)"
            : "新規依存なし",
        });
      } else if (e.type === "hunk_note_required") {
        const unnoted = unsRows.filter((u) => !notes.hunkNotes.has(u.hunk_instance_id));
        expectations.push({
          type: e.type,
          satisfied: unnoted.length === 0,
          detail: unnoted.length === 0 ? "unsolicited hunkへの注記あり(または該当なし)" : `unsolicited ${unnoted.length}件に注記がありません`,
        });
      } else {
        expectations.push({ type: "manual", satisfied: null, detail: e.text }); // 表示のみ
      }
    }

    // 5. PR説明下書き生成
    const prDraftPath = writePrDraft(ws, latest, unsRows, expectations, ingestSummary);

    // 決めていない設定のまま「レビューしてください」に進むのを止めない代わりに、必ず読み上げる(REQ-823)。
    // 未決の影響は失敗ではなく判定精度の低下として出るので、黙っていると気づけない。
    for (const d of pendingDecisions(ws)) warnings.push(formatPendingDecision(d));

    // 6. gate判定: fresh∧open∧fail∧tool-confirmed∧block(新規・悪化のanti_patternsのみ)
    const gate = findings.some(
      (f) =>
        f.lens === "anti_pattern" &&
        f.severity === "block" &&
        f.outcome === "fail" &&
        f.verification_level === "tool-confirmed" &&
        f.disposition === "open" &&
        f.policy_digest === pd, // fresh(policy変更前の旧findingは対象外)
    );

    return {
      findings,
      unsolicited: unsRows.map((u) => ({
        hunkId: u.hunk_instance_id,
        file: u.file,
        line: u.new_start,
        reason: u.reason,
        noted: notes.hunkNotes.has(u.hunk_instance_id),
      })),
      expectations,
      prDraftPath,
      gate,
      warnings,
      ingest: ingestSummary,
    };
  } finally {
    db.close();
  }
}

interface HunkNotes {
  dependencyReason: string | null;
  hunkNotes: Map<string, string>;
}

/** pr-draft.mdの記入内容を読み取る(申し送りの充足判定) */
function loadHunkNotes(ws: Workspace): HunkNotes {
  const p = path.join(exportsDir(ws), "pr-draft.md");
  const notes: HunkNotes = { dependencyReason: null, hunkNotes: new Map() };
  if (!fs.existsSync(p)) return notes;
  const text = fs.readFileSync(p, "utf8");
  const dep = text.match(/## 新規依存の理由\n+([^\n<][^\n]*)/);
  if (dep && !dep[1].includes("(ここに記入)")) notes.dependencyReason = dep[1];
  for (const m of text.matchAll(/<!-- hunk:([0-9a-f]+) -->\n+([^\n<][^\n]*)/g)) {
    if (!m[2].includes("(ここに記入)")) notes.hunkNotes.set(m[1], m[2]);
  }
  return notes;
}

function writePrDraft(
  ws: Workspace,
  latest: { base_revision_ref: string; head_revision_ref: string },
  uns: { hunk_instance_id: string; file: string; new_start: number; reason: string }[],
  expectations: PrecheckResult["expectations"],
  ingest: IngestSummary | null,
): string {
  const p = path.join(exportsDir(ws), "pr-draft.md");
  const existing = loadHunkNotes(ws);
  const L: string[] = ["# PR説明下書き(proven precheck生成)", ""];
  L.push("## 来歴サマリ");
  if (ingest) {
    L.push(
      `- hunk ${ingest.hunks} / linked ${ingest.linked} / uncaptured ${ingest.uncaptured} / broken ${ingest.broken}`,
    );
  } else {
    L.push("- (既存ingest結果を使用)");
  }
  L.push(`- base: ${latest.base_revision_ref.slice(0, 24)}… / head: ${latest.head_revision_ref.slice(0, 24)}…`, "");
  L.push("## 新規依存の理由", "", existing.dependencyReason ?? "(ここに記入)", "");
  L.push("## unsolicited変更の理由", "");
  if (uns.length === 0) L.push("該当なし", "");
  for (const u of uns) {
    L.push(`### ${u.file}:${u.new_start}`, `<!-- hunk:${u.hunk_instance_id} -->`, "", existing.hunkNotes.get(u.hunk_instance_id) ?? "(ここに記入)", "");
  }
  L.push("## 要件対応表", "", "| REQ | 対応hunk | テスト |", "|---|---|---|", "| (spec claim参照) | - | - |", "");
  L.push("## 申し送りチェック", "");
  for (const e of expectations) {
    const mark = e.satisfied === null ? "·" : e.satisfied ? "✓" : "✗";
    L.push(`- [${mark}] ${e.type}: ${e.detail}`);
  }
  L.push("");
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, L.join("\n"));
  fs.renameSync(tmp, p);
  return p;
}

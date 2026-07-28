// LLM第二段判定の実行(REQ-801/809〜813)。
// ingestとは分離した独立コマンドにしている: ingestを同期・決定的に保ち、
// 外部送信が起きる箇所を利用者から見て明示的にするため。
import { ulid } from "ulid";
import { loadConfig, matchAnyGlob } from "../shared/config.js";
import { INDETERMINATE, type ClaimEmitted, type EvidenceRef } from "../shared/types.js";
import { appendEvent } from "../store/events.js";
import { applyEvent, openDbChecked } from "../store/projections.js";
import type { Workspace } from "../store/paths.js";
import { fileContent, manifestMap, resolveRevision } from "../ingest/revision.js";
import { gitNoIndexHunks } from "../ingest/diff.js";
import { searchSpec, specParagraph } from "../spec/index.js";
import { recentUserUtterances } from "../claims/heuristics.js";
import { anthropicProvider, codexCliProvider, hasCredentials, type LlmProvider } from "./provider.js";
import { budgetExhausted, judge, newBudget, type JudgeInput } from "./judge.js";

export interface LlmRunSummary {
  enabled: boolean;
  targets: number;
  judged: number;
  determinate: number;
  discarded: number;
  skippedByBudget: number;
  calls: number;
  spentUsd: number;
  /** 実際に使ったトークン数(プロバイダが返さない場合は0) */
  inputTokens: number;
  outputTokens: number;
  warnings: string[];
}

interface TargetRow {
  claim_id: string;
  hunk_ref: string;
  kind: string;
  reason: string;
  file: string;
  new_start: number;
  new_lines: number;
  base_revision_ref: string;
  head_revision_ref: string;
}

/** 対象hunkのdiffを復元 */
function hunkDiff(ws: Workspace, r: TargetRow): string {
  try {
    const base = resolveRevision(ws, r.base_revision_ref);
    const head = resolveRevision(ws, r.head_revision_ref);
    const b = manifestMap(base.manifest).get(r.file);
    const h = manifestMap(head.manifest).get(r.file);
    const hunks = gitNoIndexHunks(b ? fileContent(ws, b) : null, h ? fileContent(ws, h) : null);
    const t = hunks.find((x) => x.newStart === r.new_start && x.newLines === r.new_lines) ?? hunks[0];
    if (!t) return "";
    return [...t.removedLines.map((l) => `-${l}`), ...t.addedLines.map((l) => `+${l}`)].join("\n");
  } catch {
    return "";
  }
}

/**
 * 判定不能のclaimだけを対象に第二段判定を行う(REQ-801)。
 * LLM OFF・認証なし・候補なしのときは何も送らない。
 */
export async function runLlmJudge(
  ws: Workspace,
  opts: { limit?: number; provider?: LlmProvider; env?: NodeJS.ProcessEnv } = {},
): Promise<LlmRunSummary> {
  const cfg = loadConfig(ws.provenDir);
  const warnings: string[] = [];
  const empty: LlmRunSummary = {
    enabled: false,
    targets: 0,
    judged: 0,
    determinate: 0,
    discarded: 0,
    skippedByBudget: 0,
    calls: 0,
    spentUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    warnings,
  };
  if (!cfg.llm.enabled) {
    warnings.push("LLM送信はOFFです(`proven config llm.enabled true` で有効化)");
    return empty;
  }
  const useCli = cfg.llm.provider === "codex-cli";
  const provider = opts.provider ?? (useCli ? codexCliProvider() : anthropicProvider());
  // 認証が無い場合はエラーにせず無効として続行する(REQ-815)。
  // codex-cli はCLI側が認証を持つため、APIキーの有無は問わない
  if (!opts.provider && !useCli && !hasCredentials(opts.env)) {
    warnings.push(
      "認証情報が見つからないためLLM層を無効にしました(ANTHROPIC_API_KEY を設定するか、" +
        "`proven config llm.provider codex-cli` などローカルCLIを使ってください)",
    );
    return empty;
  }
  if (useCli) {
    // CLI方式は単価が分からず金額換算できない。効くのは回数上限だけであることを明示する
    warnings.push(
      `CLI方式(${cfg.llm.provider})では費用上限(budget_usd_per_run)は効きません。` +
        `回数上限(max_calls_per_run=${cfg.llm.max_calls_per_run})で制御します`,
    );
  }
  const model = cfg.llm.model_light || "claude-opus-5";

  const db = openDbChecked(ws);
  try {
    const rows = db
      .prepare(
        `SELECT c.claim_id, c.hunk_ref, c.kind, c.reason, h.file, h.new_start, h.new_lines,
                h.base_revision_ref, h.head_revision_ref
         FROM claims c JOIN hunks h ON h.hunk_instance_id = c.hunk_ref
         WHERE c.kind IN ('instructed','spec_support') AND c.value = ?
           AND (c.method IS NULL OR c.method <> 'llm')
         ORDER BY c.claim_id`,
      )
      .all(INDETERMINATE) as TargetRow[];

    const budget = newBudget(cfg.llm.max_calls_per_run, cfg.llm.budget_usd_per_run);
    // limitは「判定した件数」の上限。候補が無い行は判定できないので数えない
    const limit = opts.limit ?? Number.MAX_SAFE_INTEGER;
    let judged = 0;
    let determinate = 0;
    let discarded = 0;

    for (const r of rows) {
      if (judged >= limit) break;
      // REQ-809: 除外globに一致するファイルは送らない
      if (matchAnyGlob(r.file, cfg.llm.exclude)) continue;
      if (budgetExhausted(budget)) {
        budget.skipped++;
        continue;
      }

      const diff = hunkDiff(ws, r);
      if (!diff) continue;

      // 候補を第一段から用意する(LLMは候補の妥当性だけを見る・REQ-802)
      const candidates: { label: string; text: string }[] = [];
      const evidence: EvidenceRef[] = [];
      if (r.kind === "instructed") {
        const ev = db
          .prepare(
            `SELECT e.session_ref, e.transcript_line, e.agent FROM lineage_links l
             JOIN edit_events e ON e.operation_id=l.operation_id
             WHERE l.hunk_instance_id=? AND e.file=? LIMIT 1`,
          )
          .get(r.hunk_ref, r.file) as { session_ref: string; transcript_line: number | null; agent: string } | undefined;
        if (!ev) continue;
        for (const u of recentUserUtterances(ev.session_ref, ev.transcript_line, 5, ev.agent)) {
          candidates.push({ label: `user発話 L${u.line}`, text: u.text });
          evidence.push({ type: "transcript", path: u.path, line: u.line, quote_digest: "" });
        }
      } else {
        const hit = searchSpec(ws, [r.file.split("/").pop() ?? r.file]);
        if (!hit || !hit.req_id) continue;
        const body = specParagraph(ws, hit.section);
        if (!body) continue;
        candidates.push({ label: `${hit.req_id} (${hit.heading})`, text: body });
        evidence.push({ type: "spec", file: hit.file, req_id: hit.req_id, section: hit.section });
      }
      if (candidates.length === 0) continue;

      const input: JudgeInput = {
        kind: r.kind as JudgeInput["kind"],
        file: r.file,
        location: `${r.file}:${r.new_start}`,
        hunkDiff: diff,
        candidates,
        heuristicReason: r.reason,
      };
      const verdict = await judge(provider, model, input, budget);
      if (!verdict) continue;
      judged++;
      if (verdict.discarded) discarded++;
      if (verdict.value !== INDETERMINATE) determinate++;

      const payload: ClaimEmitted = {
        claim_id: ulid(),
        run_id: `llm-${ulid()}`,
        hunk_ref: r.hunk_ref,
        kind: r.kind as ClaimEmitted["kind"],
        value: verdict.value,
        confidence: verdict.value === INDETERMINATE ? 0 : verdict.confidence,
        reason:
          verdict.value === INDETERMINATE
            ? verdict.discarded
              ? `LLM判定を破棄: ${verdict.discarded}`
              : `LLM判定: ${verdict.indeterminateReason || "判断材料が不足"}`
            : `LLM判定: ${verdict.why}${verdict.counterEvidence ? ` / 反証候補: ${verdict.counterEvidence}` : ""}`,
        evidence_refs: verdict.value === INDETERMINATE ? [] : evidence,
        method: "llm",
        model: verdict.model,
        prompt_digest: verdict.promptDigest,
        input_scope: verdict.inputScope,
      };
      const env = appendEvent(ws, "analysis", "claim_emitted", payload);
      applyEvent(db, env);
    }

    if (budget.skipped > 0) {
      warnings.push(`上限に達したため${budget.skipped}件をLLM判定せず判定不能のままにしました(REQ-811/812)`);
    }
    return {
      enabled: true,
      targets: rows.length,
      judged,
      determinate,
      discarded,
      skippedByBudget: budget.skipped,
      calls: budget.calls,
      spentUsd: Number(budget.spentUsd.toFixed(4)),
      inputTokens: budget.inputTokens,
      outputTokens: budget.outputTokens,
      warnings,
    };
  } finally {
    db.close();
  }
}

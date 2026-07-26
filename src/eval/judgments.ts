import fs from "node:fs";
import { ulid } from "ulid";
import { z } from "zod";
import { ProvenError } from "../shared/errors.js";
import { appendEvent } from "../store/events.js";
import { applyEvent, openDbChecked } from "../store/projections.js";
import type { Workspace } from "../store/paths.js";
import { pct } from "../store/maintenance.js";
import type { EvalKind } from "./cases.js";

/**
 * 受入計測の判定取り込み・集計。
 * 設計原則2(検証の格付け)に従い、AI判定は unverified、人間判定は human-confirmed として
 * **必ず区別**する。受入基準(lineage 90% / claim 80%)の合否判定は人間確認済みのみで行う。
 */

export type Verdict = "correct" | "incorrect" | "unsure";
export type Judge = "ai" | "human";

/**
 * 受入PASSを出すのに必要な人間確認済み判定の最低件数(REQ-305)。
 * n=1で「PASS」と出すと、測れていないものを測れたように見せてしまうため。
 */
export const MIN_HUMAN_SAMPLE = 20;

const JudgmentsSchema = z.object({
  judgments: z
    .array(
      z.object({
        case_id: z.string(),
        verdict: z.enum(["correct", "incorrect", "unsure"]),
        reason: z.string().default(""),
      }),
    )
    .min(1),
});

export interface EvalJudgment {
  judgment_id: string;
  kind: EvalKind;
  case_id: string;
  verdict: Verdict;
  reason: string;
  judge: Judge;
  actor_id: string;
  model: string | null; // judge=ai のとき、判定したモデル(自己申告)
  verification_level: "unverified" | "human-confirmed";
}

export interface SubmitResult {
  accepted: number;
  unknownCases: string[];
  judge: Judge;
  verificationLevel: string;
}

/** 判定JSONを取り込みイベント化。AI判定はunverifiedとして記録される */
export function submitJudgments(
  ws: Workspace,
  kind: EvalKind,
  filePath: string,
  opts: { judge: Judge; actorId: string; model?: string },
): SubmitResult {
  if (!fs.existsSync(filePath)) throw new ProvenError("input", `判定ファイルがありません: ${filePath}`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    throw new ProvenError("input", `判定ファイルのJSONパースに失敗: ${String(e)}`);
  }
  const parsed = JudgmentsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProvenError("input", `判定ファイルの形式が不正です(judgments配列が必要): ${parsed.error.message}`);
  }
  const db = openDbChecked(ws);
  try {
    const validIds = new Set(
      kind === "lineage"
        ? (db.prepare("SELECT hunk_instance_id AS id FROM hunks").all() as { id: string }[]).map((r) => r.id)
        : (db.prepare("SELECT claim_id AS id FROM claims").all() as { id: string }[]).map((r) => r.id),
    );
    const unknownCases: string[] = [];
    let accepted = 0;
    for (const j of parsed.data.judgments) {
      if (!validIds.has(j.case_id)) {
        unknownCases.push(j.case_id);
        continue;
      }
      const payload: EvalJudgment = {
        judgment_id: ulid(),
        kind,
        case_id: j.case_id,
        verdict: j.verdict,
        reason: j.reason,
        judge: opts.judge,
        actor_id: opts.actorId,
        model: opts.judge === "ai" ? (opts.model ?? "unspecified") : null,
        verification_level: opts.judge === "ai" ? "unverified" : "human-confirmed",
      };
      const env = appendEvent(ws, "decisions", "eval_judgment", payload);
      applyEvent(db, env);
      accepted++;
    }
    return {
      accepted,
      unknownCases,
      judge: opts.judge,
      verificationLevel: opts.judge === "ai" ? "unverified(AI仮説)" : "human-confirmed",
    };
  } finally {
    db.close();
  }
}

export interface EvalReport {
  kind: EvalKind;
  population: number;
  ai: { judged: number; correct: number; incorrect: number; unsure: number; rate: string };
  human: { judged: number; correct: number; incorrect: number; unsure: number; rate: string };
  disagreements: { case_id: string; ai: Verdict; human: Verdict }[];
  needsHumanReview: string[]; // AIがunsure/incorrectとしたもの=人間が優先確認すべき
  threshold: number;
  acceptancePassed: boolean | null; // 人間確認済みのみで判定。判定不能はnull
  lines: string[];
}

/** 集計。AI判定と人間確認を混ぜず、受入合否は人間確認済みのみで判定する */
export function reportEval(ws: Workspace, kind: EvalKind): EvalReport {
  const db = openDbChecked(ws);
  try {
    const population = (
      db
        .prepare(
          kind === "lineage"
            ? "SELECT COUNT(*) AS c FROM hunks"
            : "SELECT COUNT(*) AS c FROM claims WHERE kind IN ('instructed','spec_support')",
        )
        .get() as { c: number }
    ).c;
    const rows = db
      .prepare(
        `SELECT case_id, verdict, judge, ts FROM eval_judgments WHERE kind=? ORDER BY ts`,
      )
      .all(kind) as { case_id: string; verdict: Verdict; judge: Judge; ts: string }[];

    // 同一case_id・同一judgeは最新を採用
    const latest = new Map<string, { verdict: Verdict; judge: Judge }>();
    for (const r of rows) latest.set(`${r.judge}:${r.case_id}`, { verdict: r.verdict, judge: r.judge });

    const tally = (judge: Judge) => {
      const vs = [...latest.entries()].filter(([k]) => k.startsWith(`${judge}:`)).map(([, v]) => v.verdict);
      const correct = vs.filter((v) => v === "correct").length;
      const incorrect = vs.filter((v) => v === "incorrect").length;
      const unsure = vs.filter((v) => v === "unsure").length;
      const decided = correct + incorrect; // unsureは母数から除く
      return { judged: vs.length, correct, incorrect, unsure, rate: pct(correct, decided) };
    };
    const ai = tally("ai");
    const human = tally("human");

    const disagreements: EvalReport["disagreements"] = [];
    for (const [k, v] of latest) {
      if (!k.startsWith("ai:")) continue;
      const caseId = k.slice(3);
      const h = latest.get(`human:${caseId}`);
      if (h && h.verdict !== v.verdict) disagreements.push({ case_id: caseId, ai: v.verdict, human: h.verdict });
    }
    const needsHumanReview = [...latest.entries()]
      .filter(([k, v]) => k.startsWith("ai:") && (v.verdict === "unsure" || v.verdict === "incorrect"))
      .map(([k]) => k.slice(3))
      .filter((id) => !latest.has(`human:${id}`));

    const threshold = kind === "lineage" ? 0.9 : 0.8;
    const humanDecided = human.correct + human.incorrect;
    const meetsThreshold = humanDecided === 0 ? null : human.correct / humanDecided >= threshold;
    // REQ-305: サンプルが少ないうちはPASSを出さない。基準割れ(FAIL)は少数でも事実として出す
    const acceptancePassed =
      meetsThreshold === null ? null : meetsThreshold && humanDecided < MIN_HUMAN_SAMPLE ? null : meetsThreshold;

    const verdictText =
      acceptancePassed === null
        ? humanDecided === 0
          ? "判定不能(人間確認済みの判定がありません)"
          : `判定不能(サンプル不足 ${humanDecided}/${MIN_HUMAN_SAMPLE}件。基準は満たしているが件数が足りません)`
        : acceptancePassed
          ? "PASS"
          : "FAIL";

    const lines = [
      `対象母集団: ${population}件`,
      `AI判定(unverified): ${ai.judged}件 — 正解率 ${ai.rate} (unsure ${ai.unsure}件は母数外)`,
      `人間確認済み(human-confirmed): ${human.judged}件 — 正解率 ${human.rate} (unsure ${human.unsure}件は母数外)`,
      `受入基準(${kind === "lineage" ? "lineage 90%" : "claim 80%"}): ${verdictText}`,
      `※AI判定は検証済みではありません(設計原則2)。受入合否は人間確認済みのみで判定しています。`,
    ];
    if (disagreements.length) lines.push(`AIと人間の不一致: ${disagreements.length}件 → ${disagreements.map((d) => d.case_id.slice(0, 8)).join(", ")}`);
    if (needsHumanReview.length)
      lines.push(`人間が優先確認すべきケース(AIがunsure/incorrectとした未確認分): ${needsHumanReview.length}件`);

    return { kind, population, ai, human, disagreements, needsHumanReview, threshold, acceptancePassed, lines };
  } finally {
    db.close();
  }
}

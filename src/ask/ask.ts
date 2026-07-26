import fs from "node:fs";
import { ulid } from "ulid";
import { ProvenError } from "../shared/errors.js";
import { INDETERMINATE, type Finding, type OriginConfirmed } from "../shared/types.js";
import { appendEvent } from "../store/events.js";
import { applyEvent, openDbChecked } from "../store/projections.js";
import type { Workspace } from "../store/paths.js";
import { loadConfig } from "../shared/config.js";

export interface AskAnswer {
  hunkId: string;
  file: string;
  sections: {
    observed: string[]; // 観測事実(LLM不使用・機械生成)
    aiExplanation: string[]; // 当時のAI説明(引用)
    specRelation: string[]; // 仕様との関係
    speculation: string[] | null; // 現在コードからの推測(LLM ONのみ。OFFはnull)
  };
  noLineage: boolean;
  footer: string;
}

interface HunkRow {
  hunk_instance_id: string;
  file: string;
  new_start: number;
  new_lines: number;
  edit_capture_status: string | null;
  lineage_status: string | null;
}

function resolveTarget(db: ReturnType<typeof openDbChecked>, target: string): HunkRow {
  const direct = db
    .prepare(
      "SELECT hunk_instance_id, file, new_start, new_lines, edit_capture_status, lineage_status FROM hunks WHERE hunk_instance_id=?",
    )
    .get(target) as HunkRow | undefined;
  if (direct) return direct;
  const m = target.match(/^(.+):(\d+)$/);
  if (m) {
    const [, file, lineStr] = m;
    const line = Number(lineStr);
    const latest = db
      .prepare("SELECT job_id FROM ingest_runs ORDER BY ts DESC, job_id DESC LIMIT 1")
      .get() as { job_id: string } | undefined;
    if (latest) {
      const rows = db
        .prepare(
          `SELECT hunk_instance_id, file, new_start, new_lines, edit_capture_status, lineage_status
           FROM hunks WHERE ingest_job_id=? AND file=?`,
        )
        .all(latest.job_id, file) as HunkRow[];
      for (const r of rows) {
        const lo = r.new_lines === 0 ? r.new_start : r.new_start;
        const hi = r.new_lines === 0 ? r.new_start : r.new_start + r.new_lines - 1;
        if (line >= lo && line <= hi) return r;
      }
    }
  }
  throw new ProvenError("empty", `対象hunkが見つかりません: ${target}`);
}

/** ask(F-04)。LLM OFF: 観測事実・引用のみ。4区分構造 */
export function runAsk(ws: Workspace, target: string, _question: string): AskAnswer {
  const cfg = loadConfig(ws.provenDir);
  const db = openDbChecked(ws);
  try {
    const hunk = resolveTarget(db, target);
    const noLineage = hunk.edit_capture_status === "uncaptured" || hunk.lineage_status === "broken";
    const observed: string[] = [];
    const aiExplanation: string[] = [];
    const specRelation: string[] = [];

    const links = db
      .prepare(
        `SELECT e.operation_id, e.agent, e.ts_pre, e.session_ref, e.transcript_line
         FROM lineage_links l JOIN edit_events e ON e.operation_id=l.operation_id
         WHERE l.hunk_instance_id=? ORDER BY e.ts_pre ASC`,
      )
      .all(hunk.hunk_instance_id) as {
      operation_id: string;
      agent: string;
      ts_pre: string;
      session_ref: string;
      transcript_line: number | null;
    }[];

    if (hunk.edit_capture_status === "uncaptured") {
      observed.push("経緯情報なし: この変更はhook捕捉外(手編集・formatter等)で発生しました(uncaptured)");
    } else {
      for (const l of links) {
        observed.push(
          `${l.ts_pre} のedit_event ${l.operation_id.slice(0, 12)}… で ${l.agent} が編集` +
            (hunk.lineage_status === "broken" ? "(broken: 近傍参考情報)" : ""),
        );
      }
      if (links.length === 0) observed.push("帰属イベントの詳細を取得できませんでした");
    }

    // 当時のAI説明 = transcript引用(発話の存在という事実)
    for (const l of links.slice(0, 3)) {
      if (!l.session_ref || !fs.existsSync(l.session_ref) || l.transcript_line === null) continue;
      const lines = fs.readFileSync(l.session_ref, "utf8").split("\n");
      for (let i = Math.min(l.transcript_line, lines.length) - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(lines[i]);
          const role = obj?.message?.role ?? obj?.role;
          if (role === "assistant") {
            const content = obj?.message?.content ?? obj?.content ?? "";
            const text =
              typeof content === "string"
                ? content
                : Array.isArray(content)
                  ? content.map((c: { text?: string }) => c?.text ?? "").join(" ")
                  : "";
            if (text.trim()) {
              aiExplanation.push(
                `transcript#L${i + 1}「${text.slice(0, 120)}${text.length > 120 ? "…" : ""}」 ※当時の説明の引用であり、真の理由の保証ではありません`,
              );
              break;
            }
          }
        } catch {
          continue;
        }
      }
    }
    if (aiExplanation.length === 0) aiExplanation.push("該当するAI発話の引用はありません");

    const claims = db
      .prepare("SELECT kind, value, confidence, reason, evidence_json FROM claims WHERE hunk_ref=?")
      .all(hunk.hunk_instance_id) as { kind: string; value: string; confidence: number; reason: string; evidence_json: string }[];
    const spec = claims.find((c) => c.kind === "spec_support");
    if (spec) {
      specRelation.push(
        spec.value === INDETERMINATE
          ? `${INDETERMINATE}(${spec.reason})`
          : `${spec.value} (confidence ${spec.confidence.toFixed(2)}): ${spec.reason}`,
      );
    } else {
      specRelation.push("仕様claimなし");
    }
    const oc = db
      .prepare("SELECT attribute, confirmed_value, actor_id FROM origin_confirmed WHERE hunk_ref=?")
      .all(hunk.hunk_instance_id) as { attribute: string; confirmed_value: string; actor_id: string }[];
    for (const o of oc) specRelation.push(`人間確定値: ${o.attribute}=${o.confirmed_value} (by ${o.actor_id})`);

    const speculation = cfg.llm.enabled ? ["(LLM推測はPhase 1では簡易実装のため省略)"] : null;
    return {
      hunkId: hunk.hunk_instance_id,
      file: hunk.file,
      sections: { observed, aiExplanation, specRelation, speculation },
      noLineage,
      footer: "[o]根拠を開く [f]指摘として記録 [c]由来を確定",
    };
  } finally {
    db.close();
  }
}

export function renderAsk(a: AskAnswer): string {
  const L: string[] = [];
  if (a.noLineage) L.push("⚠ 経緯情報なし(来歴不明のhunkです)");
  L.push("【観測事実】");
  for (const s of a.sections.observed) L.push(`  ${s}`);
  if (a.sections.aiExplanation.length && !a.noLineage) {
    L.push("【当時のAI説明】");
    for (const s of a.sections.aiExplanation) L.push(`  ${s}`);
  }
  L.push("【仕様との関係】");
  for (const s of a.sections.specRelation) L.push(`  ${s}`);
  if (a.sections.speculation) {
    L.push("【現在コードからの推測】");
    for (const s of a.sections.speculation) L.push(`  ${s}`);
  }
  L.push(`→ ${a.footer}`);
  return L.join("\n");
}

/** [c] 由来の人間確定(--confirm 属性=値) */
export function confirmOrigin(
  ws: Workspace,
  hunkId: string,
  attribute: "instructed" | "spec_support" | "necessity",
  value: string,
  actorId: string,
): void {
  const allowed: Record<string, string[]> = {
    instructed: ["yes", "no", "unknown"],
    spec_support: ["supported", "not_found", "conflict", "unknown"],
    necessity: ["essential", "incidental", "unsolicited"],
  };
  if (!allowed[attribute]?.includes(value)) {
    throw new ProvenError("input", `--confirm ${attribute} の値は ${allowed[attribute].join("|")} のいずれかです`);
  }
  const db = openDbChecked(ws);
  try {
    const exists = db.prepare("SELECT 1 FROM hunks WHERE hunk_instance_id=?").get(hunkId);
    if (!exists) throw new ProvenError("empty", `対象hunkが見つかりません: ${hunkId}`);
    const payload: OriginConfirmed = { hunk_ref: hunkId, attribute, confirmed_value: value, actor_id: actorId };
    const env = appendEvent(ws, "decisions", "origin_confirmed", payload);
    applyEvent(db, env);
  } finally {
    db.close();
  }
}

/** [f] finding(unverified/open)として記録 */
export function recordFinding(ws: Workspace, hunkId: string, note: string, targetRevisionRef: string): string {
  const db = openDbChecked(ws);
  try {
    const payload: Finding = {
      finding_id: ulid(),
      run_id: ulid(),
      hunk_ref: hunkId,
      lens: "ask",
      severity: "warn",
      outcome: "indeterminate",
      verification_level: "unverified",
      disposition: "open",
      location: null,
      rule_ref: null,
      reason: note,
      fix_hint: null,
      target_revision_ref: targetRevisionRef,
      spec_digest: null,
      policy_digest: null,
      evidence_refs: [],
    };
    const env = appendEvent(ws, "analysis", "finding", payload);
    applyEvent(db, env);
    return payload.finding_id;
  } finally {
    db.close();
  }
}

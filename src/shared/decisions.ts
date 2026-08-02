import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { specFiles } from "../spec/index.js";
import type { Workspace } from "../store/paths.js";

/**
 * 決めないまま進むと結果が静かに劣化する設定(REQ-823)。
 *
 * 既定値が入っているので動きはするが、「動く」と「決めた」は違う。
 * 未決のまま進むと、その影響は失敗ではなく**判定精度の低下**として現れるため
 * 気づけない。だからレビューを頼む直前(precheck)に必ず読み上げる。
 */
export interface PendingDecision {
  key: string;
  /** 何が決まっていないか */
  question: string;
  /** 決めないまま進むと何が起きるか(既定値で動いてしまうので気づきにくい) */
  risk: string;
  /** どう決めるか */
  howTo: string;
}

export function pendingDecisions(ws: Workspace): PendingDecision[] {
  const cfg = loadConfig(ws.provenDir);
  const out: PendingDecision[] = [];

  if (cfg.reviewer_id.trim() === "") {
    out.push({
      key: "reviewer_id",
      question: "誰がレビューするか(reviewer_id)が未設定です",
      risk: "finding・attestに記録される確認者が空のままになり、後から「誰が見たのか」を辿れません",
      howTo: "proven config reviewer_id <あなたの識別子>",
    });
  }

  if (specFiles(ws).length === 0) {
    const globs = cfg.spec_sources.map((s) => s.glob).join(", ");
    out.push({
      key: "spec_sources",
      question: `仕様書の置き場(spec_sources)が実態と合っていません。検索パターン ${globs} に1件も当たりません`,
      risk: "全ての変更が spec=判定不能 になり、それが unsolicited候補 のスコアに効くので、頼んでいない変更の判定が甘くなります",
      howTo: ".proven/config.yaml の spec_sources を実際の仕様書の場所に直す",
    });
  }

  const policyPath = path.isAbsolute(cfg.policy.path)
    ? cfg.policy.path
    : path.join(ws.repoRoot, cfg.policy.path);
  if (!fs.existsSync(policyPath)) {
    out.push({
      key: "policy",
      question: "レビュー観点(policy)が未定義です",
      risk: "precheckが既定の検査しか行わないため、このプロジェクト固有の禁止設計は素通りします",
      howTo: "proven policy init",
    });
  }

  if (cfg.triage.boundary_paths.length === 0) {
    out.push({
      key: "triage.boundary_paths",
      question: "重点的に見るパス(triage.boundary_paths)が未定義です",
      risk: "認証・課金・マイグレーション等の重要な変更が、些末な変更と同じ優先度で並びます",
      howTo: ".proven/config.yaml の triage.boundary_paths にglobを列挙する",
    });
  }

  return out;
}

/** 表示用。1件1行に畳む */
export function formatPendingDecision(d: PendingDecision): string {
  return `未決: ${d.question} — このまま進むと${d.risk}。決め方: ${d.howTo}`;
}

// エージェントアダプタの共通型(docs/spec-multi-harness.md REQ-211〜213)
// ハーネス依存の処理はここに実装するアダプタへ閉じ込め、下流はcapabilityだけを見る(REQ-212)。

/** 捕捉対象のハーネス識別子。unknownは「判別できなかった」ことを事実として記録するための値 */
export type AgentId = "claude-code" | "codex" | "opencode" | "generic" | "unknown";

export const AGENT_IDS: AgentId[] = ["claude-code", "codex", "opencode", "generic"];

/**
 * アダプタが申告する捕捉能力(REQ-212)。
 * 呼び出し側はハーネス名で分岐せず、この能力で分岐する。
 */
export interface AgentCapabilities {
  /** 編集前状態を取得できる手段 */
  preState: "hook" | "plugin" | "watch" | "none";
  /** tool_use_id / callID 相当を持つか。synthesizedなら合成キーを作る */
  operationId: "native" | "synthesized";
  /** 1操作が複数ファイルに及びうるか(codexのapply_patchはmany) */
  filesPerOperation: "one" | "many";
  /** 発話履歴の取得方式 */
  transcript: "jsonl" | "rollout" | "sdk" | "none";
}

/** ハーネス固有payloadを正規化した共通形(REQ-213) */
export interface NormalizedCapture {
  /** ネイティブの操作ID(tool_use_id / callID)。無ければnull→合成キーへ */
  operationIdNative: string | null;
  /** transcriptのパス、またはセッション識別子 */
  sessionRef: string;
  /** 原文のツール名(記録用) */
  tool: string;
  /** 対象ファイル(raw path)。解決・除外判定は共通処理が行う */
  files: string[];
  /** 編集系ツールか */
  isTargetTool: boolean;
  /** post時のみ。判定不能はnull */
  toolStatus: "success" | "failure" | null;
}

/** hook/プラグインから渡される生payload(形はハーネスごとに異なる) */
export type RawPayload = Record<string, unknown>;

export type Phase = "pre" | "post";

/** match()の結果。scoreが最大のアダプタを推定に用いる */
export interface MatchResult {
  score: number;
  signals: string[];
}

export interface AgentAdapter {
  id: AgentId;
  capabilities: AgentCapabilities;
  /** 自分のpayloadらしいかの判定(推定時のみ使用。自己申告があればそちらが優先) */
  match(raw: RawPayload, env: NodeJS.ProcessEnv): MatchResult;
  /** ハーネス固有payload → 共通形。捕捉対象外はnull */
  normalize(raw: RawPayload, phase: Phase): NormalizedCapture | null;
  /** transcriptから直近のuser発話を取得(由来判定用)。未対応ハーネスは省略可 */
  readUtterances?(sessionRef: string, beforeLine: number | null, max: number): Utterance[];
}

export interface Utterance {
  text: string;
  line: number;
  path: string;
}

/** 検出方法の記録(REQ-206)。推定を確定事実として扱わないための情報 */
export interface AgentDetection {
  method: "declared" | "inferred" | "unknown";
  signals: string[];
  confidence: number | null;
}

/** 推定時のconfidence上限(REQ-207) */
export const INFERRED_CONF_MAX = 0.9;

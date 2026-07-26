// proven shared types — mirrors 詳細設計書 v0.3 §3
export const SCHEMA_VERSION = 1;

export interface EventEnvelope<T extends string = string, P = unknown> {
  schema_version: number;
  event_id: string; // ULID
  type: T;
  ts: string; // ISO-8601 UTC
  payload: P;
  prev_record_hash?: string; // decisions.jsonl only (all rows)
}

export type EditTool = "Edit" | "Write" | "MultiEdit" | "NotebookEdit";

/** 検出方法(REQ-206)。旧イベントには存在しないためoptional */
export interface AgentDetectionRecord {
  method: "declared" | "inferred" | "unknown";
  signals: string[];
  confidence: number | null;
}

export interface EditPre {
  operation_id: string;
  /** ハーネス識別子(REQ-227でenum化)。旧イベントは "claude-code" 固定 */
  agent: string;
  session_ref: string;
  file: string; // repo-relative
  pre_blob_hash: string | null;
  tool: EditTool | string;
  conversation_ref: { transcript_line: number } | null;
  agent_detection?: AgentDetectionRecord;
}

export interface EditPost {
  operation_id: string;
  result_blob_hash: string | null;
  tool_status: "success" | "failure";
  /** 1操作N ファイル(REQ-224)。旧イベントは未設定=その操作の全ファイル行を更新 */
  file?: string;
}

export interface GenerationStarted {
  previous_generation: string;
  last_record_hash: string;
}

export interface IngestRun {
  job_id: string;
  base_revision_ref: string;
  head_revision_ref: string;
  diff_algorithm: "myers";
  tool_version: string;
  input_digest: string;
}

export interface AnalysisRun {
  run_id: string;
  kind: "claims" | "triage" | "ask" | "precheck" | "verify";
  model: string | null;
  model_version: string | null;
  prompt_digest: string | null;
  config_digest: string;
  input_digest: string;
  status: "completed" | "partial" | "failed";
}

export interface HunkCreated {
  hunk_instance_id: string;
  ingest_job_id: string;
  file: string;
  base_revision_ref: string;
  head_revision_ref: string;
  old_blob_hash: string | null;
  new_blob_hash: string | null;
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  hunk_ordinal: number;
  oversize: boolean;
}

export type LineageLinked =
  | {
      hunk_instance_id: string;
      edit_capture_status: "captured";
      lineage_status: "linked" | "broken";
      context_status: "ok" | "transcript_broken";
      edit_event_refs: string[];
      method: "blob-chain";
      confidence: number;
    }
  | {
      hunk_instance_id: string;
      edit_capture_status: "uncaptured";
      edit_event_refs: [];
      method: "none";
      confidence: null;
    };

export interface HunkLineageLinked {
  predecessor_id: string;
  successor_id: string;
  similarity: number;
}

export type ClaimKind = "instructed" | "spec_support" | "necessity" | "nolineage_cause";

export type EvidenceRef =
  | { type: "transcript"; path: string; line: number; quote_digest: string }
  | { type: "spec"; file: string; req_id: string | null; section: string }
  | { type: "edit_event"; operation_id: string };

export interface ClaimEmitted {
  claim_id: string;
  run_id: string;
  hunk_ref: string;
  kind: ClaimKind;
  value: string;
  confidence: number;
  reason: string;
  evidence_refs: EvidenceRef[];
}

export interface Finding {
  finding_id: string;
  run_id: string;
  hunk_ref: string | null;
  lens: string; // Phase1: anti_pattern | req_coverage | expectations
  severity: "block" | "warn";
  outcome: "pass" | "fail" | "indeterminate";
  verification_level: "unverified" | "tool-confirmed" | "human-confirmed";
  disposition: "open" | "resolved" | "dismissed";
  location: { file: string; line: number } | null;
  rule_ref: string | null;
  reason: string;
  fix_hint: string | null;
  target_revision_ref: string;
  spec_digest: string | null;
  policy_digest: string | null;
  evidence_refs: EvidenceRef[];
}

export interface OriginConfirmed {
  hunk_ref: string;
  attribute: "instructed" | "spec_support" | "necessity";
  confirmed_value: string;
  actor_id: string;
}

// ---- constants (境界値はS-04の対象) ----
export const ABORT_AFTER_MS = 24 * 60 * 60 * 1000; // 24h
export const OVERSIZE_BYTES = 5 * 1024 * 1024; // 5MB
export const OVERSIZE_HUNK_LINES = 300;
export const ROTATE_SUGGEST_BYTES = 50 * 1024 * 1024; // 50MB
export const LINEAGE_TIME_BUDGET_MS = 60_000;
export const JACCARD_THRESHOLD = 0.6;
export const HEURISTIC_CONF_MAX = 0.5;

export const INDETERMINATE = "判定不能";

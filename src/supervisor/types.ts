import type { SupervisorActionKind } from "../graph/schema.js";

export type FailureClass =
  | "environment"
  | "workspace"
  | "context"
  | "artifact"
  | "harness"
  | "timeout"
  | "deterministic_evaluation"
  | "semantic_evaluation"
  | "outcome_verification"
  | "scope_drift"
  | "policy_breach"
  | "operator"
  | "unknown";

export type SupervisorDecisionKind =
  | "continue_graph"
  | "run_intervention"
  | "retry_with_guidance"
  | "pause_for_human"
  | "fail_run";

export type SupervisorHealthState =
  | "healthy"
  | "watching"
  | "stalled"
  | "looping"
  | "drifting"
  | "context_degraded"
  | "tool_hung"
  | "artifact_at_risk"
  | "policy_risk"
  | "unhealthy";

export interface SupervisorDecision {
  decision_id: string;
  kind: SupervisorDecisionKind;
  classification: FailureClass;
  health_state?: SupervisorHealthState;
  confidence?: "low" | "medium" | "high";
  target_compiled_id?: string;
  target_execution_id?: string;
  action?: SupervisorActionKind;
  reason: string;
  budget_cost: Partial<Record<SupervisorActionKind | "total", number>>;
  created_at: string;
  requires_human?: boolean;
  evidence?: Record<string, unknown>;
}

export interface SupervisorInterventionRecord {
  intervention_id: string;
  decision_id: string;
  action: SupervisorActionKind;
  status: "running" | "passed" | "failed" | "canceled";
  target_compiled_id?: string;
  target_execution_id?: string;
  started_at: string;
  ended_at?: string;
  reason: string;
  evidence: Record<string, unknown>;
  artifact_paths: Record<string, string>;
}

export interface SupervisorPromptRevision {
  revised_goal: string;
  must_do: string[];
  must_not_do: string[];
  artifact_requirements: string[];
  resolved_conflicts: string[];
  evidence_to_read: string[];
  intent_preservation: string;
  justification: string;
}

export interface SupervisorRetryGuidanceRecord {
  compiled_id: string;
  authored_id: string;
  prior_execution_id: string;
  action: SupervisorActionKind;
  classification: FailureClass;
  summary: string;
  failure_fingerprint: string;
  repeated_fingerprint_count: number;
  guidance_brief_path: string;
  prompt_revision_path: string;
  prompt_revision: SupervisorPromptRevision;
  created_at: string;
}

export interface SupervisorFailureFingerprintState {
  fingerprint: string;
  count: number;
  last_execution_id: string;
  last_seen_at: string;
}

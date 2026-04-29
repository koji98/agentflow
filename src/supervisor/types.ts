import type { SupervisorActionKind } from "../graph/schema.js";

export type FailureClass =
  | "missing_context"
  | "missing_dependency_docs"
  | "wrong_local_pattern"
  | "diagnostic_needed"
  | "artifact_contract_failure"
  | "semantic_misalignment"
  | "policy_or_scope_risk"
  | "harness_unavailable"
  | "operator_pause"
  | "repeated_failure"
  | "unknown"
  | "non_recoverable";

export type SupervisorEvidenceGatherKind =
  | "local_context"
  | "pattern_mining"
  | "dependency_metadata"
  | "external_context"
  | "diagnostic_probe"
  | "semantic_rejudge"
  | "investigate_failure";

export interface SupervisorEvidenceGatherRequest {
  gather_id: string;
  kind: SupervisorEvidenceGatherKind;
  reason: string;
  priority: number;
}

export interface SupervisorEvidenceGatherPlan {
  max_parallel: number;
  gathers: SupervisorEvidenceGatherRequest[];
}

export interface SupervisorCaseFile {
  case_id: string;
  compiled_id: string;
  authored_id: string;
  prior_execution_id: string;
  attempt_index: number;
  failed_at: string;
  failure_class: FailureClass;
  failure_summary: string;
  failure_fingerprint: string;
  repeated_fingerprint_count: number;
  prompt_path?: string;
  prompt_sha256?: string;
  rendered_prompt?: string;
  node_contract: {
    goal?: string;
    acceptance_criteria?: string[];
    constraints?: string[];
    declared_artifacts: Record<string, unknown>;
    sandbox: string;
    repo_alias: string;
  };
  context: {
    packet_path?: string;
    manifest_path?: string;
    provenance_path?: string;
  };
  result: Record<string, unknown>;
  artifacts: Record<string, string>;
  prior_interventions: SupervisorInterventionRecord[];
  evidence: Record<string, unknown>;
}

export interface SupervisorEvidencePatch {
  patch_id: string;
  gather_id: string;
  kind: SupervisorEvidenceGatherKind;
  case_id: string;
  status: "passed" | "failed";
  claims: string[];
  sources: Array<{
    label: string;
    path?: string;
    url?: string;
    digest?: string;
  }>;
  confidence: "low" | "medium" | "high";
  conflicts: string[];
  retry_guidance: string[];
  scope_or_authority_changed: boolean;
  created_at: string;
  artifact_paths: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export type SupervisorApplyAction =
  | "retry_node"
  | "repair_artifact"
  | "pause_for_human"
  | "fail_terminal";

export interface SupervisorRecoveryPlan {
  plan_id: string;
  case_id: string;
  classification: FailureClass;
  apply_action: SupervisorApplyAction;
  retry_directive?: SupervisorRecoveryEnvelope["retry_directive"];
  repair_directive?: {
    summary: string;
    evidence_to_read: string[];
  };
  pause_request?: {
    reason: string;
    unblock_request: string;
  };
  terminal_reason?: string;
  confidence: "low" | "medium" | "high";
  merged_claims: string[];
  provenance: Array<{
    patch_id: string;
    kind: SupervisorEvidenceGatherKind;
    sources: SupervisorEvidencePatch["sources"];
  }>;
  conflicts: string[];
  created_at: string;
}

export interface SupervisorRecoveryEnvelope {
  envelope_id: string;
  compiled_id: string;
  authored_id: string;
  prior_execution_id: string;
  recovery_plan_path: string;
  case_file_path: string;
  action: "retry_node";
  classification: FailureClass;
  failure_fingerprint: string;
  repeated_fingerprint_count: number;
  retry_directive: {
    summary: string;
    must_do: string[];
    must_not_do: string[];
    evidence_to_read: string[];
    validation_focus: string[];
    unchanged_contract: {
      goal: true;
      acceptance_criteria: true;
      constraints: true;
      repo_authority: true;
      sandbox: true;
      declared_artifacts: true;
    };
  };
  created_at: string;
}

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

export interface SupervisorFailureFingerprintState {
  fingerprint: string;
  count: number;
  last_execution_id: string;
  last_seen_at: string;
}

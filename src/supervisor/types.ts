export const supervisorActionKinds = [
  "retry_with_guidance",
  "repair_artifact",
  "rebuild_context",
  "run_diagnostic",
  "pause_for_authority",
  "semantic_evaluation",
  "fail"
] as const;

export type SupervisorActionKind = (typeof supervisorActionKinds)[number];

export const supervisorCapabilityKinds = [
  "review",
  "diagnosis",
  "intervention",
  "environment",
  "authority",
  "memory"
] as const;

export type SupervisorCapabilityKind = (typeof supervisorCapabilityKinds)[number];

export type FailureClass =
  | "context_contract_failure"
  | "graph_context_gap"
  | "missing_context"
  | "missing_dependency_docs"
  | "wrong_local_pattern"
  | "diagnostic_needed"
  | "artifact_contract_failure"
  | "completion_contract_failure"
  | "semantic_misalignment"
  | "unprovable_requirement"
  | "authority_required"
  | "policy_or_scope_risk"
  | "harness_unavailable"
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

export type SupervisorRecoveryOperation =
  | "repair_current_node"
  | "repair_upstream_node"
  | "repair_artifact"
  | "repair_context"
  | "repair_evidence_context"
  | "repair_validation_strategy"
  | "repair_workspace"
  | "repair_environment"
  | "rerun_verification"
  | "investigate_causal_cone"
  | "pause_for_authority"
  | "fail_contract_gap";

export interface SupervisorCausalCaseFile {
  symptom: {
    compiled_id: string;
    authored_id: string;
    kind: string;
    execution_id: string;
    failure_class: FailureClass;
    summary: string;
  };
  upstream_cone: Array<{
    compiled_id: string;
    authored_id: string;
    kind: string;
    distance: number;
    status?: string;
    latest_execution_id?: string;
    latest_attempt_path?: string;
    latest_outcome?: string;
    repo_alias: string;
    artifact_names: string[];
    context_artifact_refs: Array<{
      node: string;
      artifact: string;
    }>;
  }>;
  target_candidates: SupervisorCausalTargetRecord[];
  selected_target: SupervisorCausalTargetRecord;
}

export interface SupervisorCausalTargetRecord {
    operation: SupervisorRecoveryOperation;
    target_compiled_id: string;
    target_authored_id: string;
    target_kind: string;
    confidence: "low" | "medium" | "high";
    reason: string;
    evidence: string[];
    resume_compiled_id: string;
    resume_authored_id: string;
    target_prior_execution_id?: string;
    target_prior_attempt_path?: string;
    target_prior_artifact_paths?: Record<string, string>;
    symptom_compiled_id: string;
    symptom_authored_id: string;
    symptom_execution_id: string;
    requires_investigation: boolean;
}

export interface SupervisorCaseFile {
  case_id: string;
  compiled_id: string;
  authored_id: string;
  prior_execution_id: string;
  prior_attempt_path: string;
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
    intent: {
      goal: string;
      acceptance_criteria: string[];
      constraints: string[];
    };
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
  requirement_evidence_map: SupervisorRequirementEvidenceMap;
  available_evidence: SupervisorEvidenceReference[];
  missing_evidence: SupervisorRequirementEvidence[];
  selected_delta?: SupervisorMaterialDelta;
  retry_blocked_reason?: string;
  prior_interventions: SupervisorInterventionRecord[];
  evidence: Record<string, unknown>;
  causal?: SupervisorCausalCaseFile;
  supervisor_profile?: {
    profile_name: string;
    harness?: string;
    model?: string;
    reasoning_effort?: string;
    timeout_sec: number;
  };
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
  authority_findings: SupervisorAuthorityFinding[];
  created_at: string;
  artifact_paths: Record<string, string>;
  metadata?: Record<string, unknown>;
}

export type SupervisorAuthorityFindingKind =
  | "graph_contract_change"
  | "sandbox_expansion"
  | "repo_scope_expansion"
  | "external_side_effect"
  | "credential_or_auth_mention"
  | "operator_input_mention";

export interface SupervisorAuthorityFinding {
  kind: SupervisorAuthorityFindingKind;
  summary: string;
  evidence?: string[];
}

export type SupervisorApplyAction =
  | "retry_node"
  | "repair_context"
  | "repair_evidence_context"
  | "repair_artifact"
  | "repair_validation_strategy"
  | "repair_workspace"
  | "repair_environment"
  | "rerun_verification"
  | "retry_with_evidence"
  | "pause_for_authority"
  | "fail_terminal"
  | "fail_contract_gap";

export type SupervisorResumePoint =
  | "continue_from_prior_progress"
  | "continue_from_milestone"
  | "repair_artifacts"
  | "rerun_verification"
  | "repair_validation_strategy"
  | "repair_workspace"
  | "fresh_retry"
  | "fail_contract_gap";

export type SupervisorWorkspaceDecision =
  | "preserve"
  | "reset"
  | "partial_cleanup";

export type SupervisorRestartBoundary =
  | "verification"
  | "artifact_repair"
  | "milestone"
  | "work_list_item"
  | "managed_pattern_phase"
  | "node_attempt"
  | "upstream_target";

export type SupervisorRecoveryResumeReasonCode =
  | "validated_progress"
  | "artifact_contract_repair"
  | "verification_substrate_failure"
  | "validation_strategy_repair"
  | "workspace_pollution_cleanup"
  | "prior_progress_unsafe"
  | "upstream_target_selected"
  | "evidence_delta_retry"
  | "fresh_retry_required"
  | "contract_gap";

export interface RecoveryResumeDecision {
  resume_point: SupervisorResumePoint;
  restart_boundary: SupervisorRestartBoundary;
  workspace_decision: SupervisorWorkspaceDecision;
  reuse: string[];
  discard: string[];
  reason_code: SupervisorRecoveryResumeReasonCode;
  confidence: "low" | "medium" | "high";
  evidence: string[];
  required_next_action: string;
  validation_gate: string[];
}

export interface AttemptEvidenceBundle {
  identity: {
    execution_id: string;
    compiled_id: string;
    authored_id: string;
  };
  agent_paths: {
    attempt_root: string;
    response_path?: string;
    artifacts_dir: string;
    artifact_paths: Record<string, string>;
    attempt_memory_path?: string;
    supervisor_recovery_path?: string;
  };
  audit_paths: {
    prompt_path?: string;
    context_path?: string;
    result_path?: string;
    completion_packet_path?: string;
    verifier_json_path?: string;
    verifier_verdict_path?: string;
    stdout_path?: string;
    stderr_path?: string;
    case_file_path?: string;
    recovery_plan_path?: string;
  };
}

export interface SupervisorInterventionDecision {
  decision_kind: "intervention";
  capability: "intervention" | "environment";
  failure_fingerprint: string;
  prior_strategy?: string;
  selected_strategy: SupervisorApplyAction;
  restart_boundary: SupervisorRestartBoundary;
  workspace_decision: SupervisorWorkspaceDecision;
  preserve: string[];
  discard: string[];
  material_delta: SupervisorMaterialDelta[];
  evidence_refs: string[];
  required_next_action: string;
  validation_gate: string[];
  fallback_if_repeated: SupervisorApplyAction | "fail_contract_gap";
}

export type SupervisorRecoveryFollowStatus = "yes" | "no" | "partial" | "unknown";

export type SupervisorRecoveryRepeatedFailureDiagnosis =
  | "guidance_ignored"
  | "guidance_insufficient"
  | "material_delta_irrelevant"
  | "target_wrong"
  | "boundary_wrong"
  | "validation_gate_weak"
  | "new_worker_error"
  | "contract_gap"
  | "authority_gap";

export interface SupervisorRecoveryLearningRecord {
  prior_failure_fingerprint: string;
  prior_selected_strategy?: SupervisorApplyAction;
  prior_restart_boundary?: SupervisorRestartBoundary;
  prior_workspace_decision?: SupervisorWorkspaceDecision;
  prior_material_delta: SupervisorMaterialDelta[];
  prior_required_next_action?: string;
  prior_validation_gate: string[];
  retry_attempt_outcome: string;
  followed_required_next_action: SupervisorRecoveryFollowStatus;
  followed_validation_gate: SupervisorRecoveryFollowStatus;
  material_delta_used: SupervisorRecoveryFollowStatus;
  repeated_forbidden_tactic: SupervisorRecoveryFollowStatus;
  diagnosis: SupervisorRecoveryRepeatedFailureDiagnosis;
  evidence: string[];
}

export type SupervisorRequirementEvidenceStatus =
  | "available"
  | "missing"
  | "conflicting"
  | "unknown";

export interface SupervisorEvidenceReference {
  label: string;
  path?: string;
  url?: string;
  digest?: string;
  kind?: string;
}

export interface SupervisorRequirementEvidence {
  id: string;
  requirement: string;
  source:
    | "goal"
    | "acceptance_criteria"
    | "constraint"
    | "check_rubric"
    | "failure_issue"
    | "failure_summary";
  status: SupervisorRequirementEvidenceStatus;
  evidence_refs: SupervisorEvidenceReference[];
  missing_reason?: string;
}

export interface SupervisorRequirementEvidenceMap {
  map_id: string;
  node_compiled_id: string;
  node_authored_id: string;
  attempt_execution_id?: string;
  generated_at: string;
  requirements: SupervisorRequirementEvidence[];
  available_evidence: SupervisorEvidenceReference[];
  missing_evidence: SupervisorRequirementEvidence[];
}

export interface SupervisorContextRepairMaterial {
  key: string;
  title: string;
  text: string;
}

export interface SupervisorContextRepairPatch {
  patch_id: string;
  strategy: "replace_authored_context";
  reason: string;
  materials: SupervisorContextRepairMaterial[];
  omitted: Array<{
    key: string;
    reason: string;
    source_name?: string;
    source_path?: string;
  }>;
  analysis_path?: string;
  created_at: string;
}

export interface SupervisorValidationStrategyRepair {
  reason: string;
  focus: string[];
  avoid_repeating: string[];
  required_handoff_evidence: string[];
}

export interface SupervisorWorkspaceRepairPatch {
  patch_id: string;
  strategy: "restore_failed_attempt_changes";
  reason: string;
  baseline_path: string;
  changed_files_path: string;
  status_path?: string;
  diff_patch_path?: string;
  changed_file_count: number;
  result_path?: string;
  created_at: string;
}

export interface SupervisorEnvironmentRepair {
  reason: string;
  safe_repairs: string[];
  retry_effect: string;
}

export interface SupervisorMaterialDelta {
  kind:
    | "context_changed"
    | "context_overlay_added"
    | "workspace_cleaned"
    | "artifact_repaired"
    | "validation_strategy_changed"
    | "environment_repaired"
    | "requirement_evidence_mapped"
    | "public_artifact_consistency_repair"
    | "target_reranked_with_evidence";
  summary: string;
  artifact_paths?: Record<string, string>;
}

export interface SupervisorRuntimeOverlay {
  overlay_id: string;
  apply_action: SupervisorApplyAction;
  material_delta: SupervisorMaterialDelta[];
  context_repair?: SupervisorContextRepairPatch;
  validation_strategy?: SupervisorValidationStrategyRepair;
  workspace_repair?: SupervisorWorkspaceRepairPatch;
  environment_repair?: SupervisorEnvironmentRepair;
  created_at: string;
}

export interface SupervisorRecoveryPlan {
  plan_id: string;
  case_id: string;
  classification: FailureClass;
  apply_action: SupervisorApplyAction;
  operation?: SupervisorRecoveryOperation;
  recovery_target?: SupervisorCausalTargetRecord;
  retry_directive?: SupervisorRecoveryEnvelope["retry_directive"];
  runtime_overlay?: SupervisorRuntimeOverlay;
  repair_directive?: {
    summary: string;
    evidence_to_read: string[];
  };
  recovery_learning?: SupervisorRecoveryLearningRecord;
  pause_request?: {
    reason: string;
    unblock_request: string;
  };
  intervention_decision?: SupervisorInterventionDecision;
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
  prior_attempt_evidence: AttemptEvidenceBundle;
  symptom_compiled_id?: string;
  symptom_authored_id?: string;
  symptom_execution_id?: string;
  recovery_plan_path: string;
  case_file_path: string;
  action: "retry_node";
  classification: FailureClass;
  failure_fingerprint: string;
  repeated_fingerprint_count: number;
  resume_point: SupervisorResumePoint;
  workspace_decision: SupervisorWorkspaceDecision;
  resume_decision: RecoveryResumeDecision;
  preserve_progress: string[];
  do_not_redo: string[];
  required_next_action: string;
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
  runtime_overlay?: SupervisorRuntimeOverlay;
  created_at: string;
}

export type SupervisorDecisionKind =
  | "review_finding"
  | "diagnosis_finding"
  | "intervention"
  | "environment_action"
  | "authority_request"
  | "contract_failure";

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
  capability?: SupervisorCapabilityKind;
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
  intervention_decision?: SupervisorInterventionDecision;
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

export interface SupervisorRecoveryChainState {
  chain_id: string;
  intervention_id: string;
  decision_id: string;
  status: "recovering" | "resuming" | "completed" | "failed";
  symptom_compiled_id: string;
  symptom_authored_id: string;
  symptom_execution_id: string;
  target_compiled_id: string;
  target_authored_id: string;
  operation: SupervisorRecoveryOperation;
  resume_ready_node: {
    compiled_id: string;
    deps_satisfied: string[];
    repeat_scope_id?: string;
    iteration_index?: number;
  };
  recovery_plan_path?: string;
  recovery_chain_path?: string;
  created_at: string;
  updated_at: string;
}

export interface SupervisorFailureFingerprintState {
  fingerprint: string;
  count: number;
  last_execution_id: string;
  last_seen_at: string;
}

import type { ArtifactDefinition } from "../../graph/authored.js";
import type { CompiledExecutableNode } from "../../graph/compiled.js";
import type { RuntimeNodeAttempt } from "../attempts.js";
import type { AuthorityRequest } from "../authority.js";
import type { SupervisorRecoveryEnvelope } from "../../supervisor/types.js";

export const completionStatuses = ["ready_for_verification", "incomplete", "blocked"] as const;
export type CompletionStatus = (typeof completionStatuses)[number];

export const runtimeLogTypes = ["progress", "finding", "decision"] as const;
export type RuntimeLogType = (typeof runtimeLogTypes)[number];

export const findingKinds = ["observation", "issue", "risk", "blocker"] as const;
export type FindingKind = (typeof findingKinds)[number];

export const evidenceKinds = [
  "command_output",
  "artifact",
  "workspace_diff",
  "context",
  "runtime_event",
  "external_state",
  "human_input",
  "tool_output"
] as const;
export type CompletionEvidenceKind = (typeof evidenceKinds)[number];

export const helperPurposes = ["investigation", "implementation", "verification", "repair"] as const;
export type HelperPurpose = (typeof helperPurposes)[number];

export interface CompletionEvidence {
  kind: CompletionEvidenceKind;
  ref?: string;
  summary: string;
  status?: "passed" | "failed" | "blocked" | "unknown";
  data?: Record<string, unknown>;
}

export interface RuntimeLogEntry {
  log_id: string;
  run_id?: string;
  graph_id?: string;
  agent_id?: string;
  execution_id: string;
  node_id?: string;
  compiled_id?: string;
  type: RuntimeLogType;
  summary: string;
  body?: string;
  finding_kind?: FindingKind;
  severity?: "info" | "warning" | "error";
  blocking?: boolean;
  blocked_on?: string;
  recoverable_by?: string;
  decision?: string;
  rationale?: string;
  contract_implication?: string;
  evidence?: CompletionEvidence[];
  artifact_refs?: string[];
  created_at: string;
}

export const milestoneStatuses = ["active", "completed", "blocked"] as const;
export type RuntimeMilestoneStatus = (typeof milestoneStatuses)[number];

export const milestoneLogKinds = ["finding", "decision", "validation"] as const;
export type RuntimeMilestoneLogKind = (typeof milestoneLogKinds)[number];

export interface RuntimeMilestoneLogEntry {
  log_id: string;
  kind: RuntimeMilestoneLogKind;
  summary: string;
  evidence?: string;
  command?: string;
  result?: "pass" | "fail" | "blocked";
  created_at: string;
}

export interface RuntimeMilestone {
  id: string;
  run_id?: string;
  graph_id?: string;
  agent_id?: string;
  execution_id: string;
  node_id?: string;
  compiled_id?: string;
  title: string;
  goal: string;
  status: RuntimeMilestoneStatus;
  logs: RuntimeMilestoneLogEntry[];
  completion_evidence?: string;
  blocked_on?: string;
  recoverable_by?: string;
  blocked_evidence?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  blocked_at?: string;
}

export interface RuntimeMilestoneState {
  version: "1";
  execution_id: string;
  milestones: RuntimeMilestone[];
}

export interface CompletionMilestoneSummary {
  total: number;
  active: number;
  completed: number;
  blocked: number;
  validation_logs: number;
  milestones: RuntimeMilestone[];
}

export interface CompletionOrientationSummary {
  orient_called: boolean;
  evidence_ref?: string;
}

export type ObservationKind = FindingKind;

export interface OperatorObservation {
  observation_id: string;
  run_id?: string;
  author: string;
  kind: ObservationKind;
  severity: "info" | "warning" | "error";
  summary: string;
  body?: string;
  node?: string;
  attempt?: string;
  evidence?: CompletionEvidence[];
  blocking?: boolean;
  blocked_on?: string;
  recoverable_by?: string;
  status: "active" | "resolved" | "superseded";
  resolution_summary?: string;
  created_at: string;
  updated_at?: string;
}

export interface CompletionDeclaredArtifact {
  name: string;
  required: true;
  from: ArtifactDefinition["from"];
  path: string;
  expected_path: string;
  description: string;
  status: "present" | "missing" | "empty" | "placeholder" | "invalid_json" | "forbidden_content" | "missing_required_content" | "content_type_mismatch" | "blocked";
  current_attempt: boolean;
  size_bytes?: number;
  content_type?: string;
  detected_content_type?: string;
  declared_content_type?: string;
  media_kind?: string;
  encoding?: string;
  sha256?: string;
  preview?: Record<string, unknown>;
}

export interface CompletionArtifactFinding {
  artifact: string;
  kind: "missing" | "empty" | "placeholder" | "invalid_json" | "forbidden_content" | "missing_required_content" | "content_type_mismatch" | "stale_prior_attempt" | "blocked";
  summary: string;
  evidence_ref?: string;
}

export interface CompletionValidationEvidence {
  requirement: string;
  status: "present" | "missing_evidence" | "blocked" | "advisory";
  source?: "acceptance_criteria" | "runtime_log" | "milestone" | "captured_transcript" | "supervisor_recovery" | "managed_criteria" | "declared_artifact";
  evidence_ref?: string;
  summary?: string;
}

export interface CompletionRuntimeLogSummary {
  progress: number;
  finding: number;
  decision: number;
  blocking_findings: number;
}

export interface CompletionOperatorObservationSummary {
  active: number;
  blocking: number;
  latest: Array<Pick<OperatorObservation, "observation_id" | "kind" | "summary" | "author" | "severity" | "status"> & {
    target?: string;
  }>;
}

export interface CompletionSupervisorRecoverySummary {
  active: boolean;
  envelope_path?: string;
  requirements?: string[];
  summary?: string;
}

export interface CompletionManagedSummary {
  active: boolean;
  managed_kind?: string;
  cycle?: number;
  cycle_limit?: number;
  failing_required_criteria?: string[];
  regressions?: Array<{
    criterion: string;
    from?: string;
    to?: string;
    cycle?: number;
  }>;
  blocking_criteria?: string[];
  ready_for_publish?: boolean;
  material_delta?: string[];
  evidence_refs?: string[];
}

export interface CompletionHelperSummary {
  active: number;
  completed: number;
  pending: number;
  failed: number;
  missing_artifacts: string[];
  latest: Array<{
    agent_id: string;
    purpose: HelperPurpose;
    role?: "evidence_mapper" | "causal_investigator" | "verification_auditor" | "repair_planner";
    status: "starting" | "running" | "completed" | "failed" | "canceled";
    summary: string;
    artifact_refs: string[];
    evidence_ref: string;
  }>;
}

export interface CompletionPacket {
  version: "1";
  attempt_id: string;
  execution_id: string;
  execution_dir: string;
  packet_path: string;
  compiled_id: string;
  authored_id: string;
  kind: CompiledExecutableNode["kind"];
  goal: string;
  acceptance_criteria: string[];
  constraints: string[];
  authority: {
    sandbox: "read-only" | "workspace-write" | "danger-full-access";
    repos: string[];
  };
  declared_artifacts: CompletionDeclaredArtifact[];
  published_artifacts: string[];
  missing_artifacts: string[];
  artifact_findings: CompletionArtifactFinding[];
  validation_evidence: CompletionValidationEvidence[];
  orientation: CompletionOrientationSummary;
  milestones: CompletionMilestoneSummary;
  runtime_logs: CompletionRuntimeLogSummary;
  active_blockers: RuntimeLogEntry[];
  operator_observations: CompletionOperatorObservationSummary;
  supervisor_recovery: CompletionSupervisorRecoverySummary;
  managed: CompletionManagedSummary;
  helpers: CompletionHelperSummary;
  completion_status: CompletionStatus;
  ready_for_verification: boolean;
  authority_requests: AuthorityRequest[];
  blocking_reasons: string[];
}

export interface CompletionProjection {
  version: "1";
  attempt_id: string;
  execution_id: string;
  compiled_id: string;
  authored_id: string;
  completion_status: CompletionStatus;
  ready_for_verification: boolean;
  authority_requests: AuthorityRequest[];
  blocking_reasons: string[];
  missing_artifacts: string[];
  artifact_findings: CompletionArtifactFinding[];
  validation_evidence: CompletionValidationEvidence[];
  orientation: CompletionOrientationSummary;
  milestones: CompletionMilestoneSummary;
  active_blockers: Array<Pick<RuntimeLogEntry, "log_id" | "summary" | "finding_kind" | "severity" | "blocked_on" | "recoverable_by">>;
  operator_observations: CompletionOperatorObservationSummary;
  supervisor_recovery: CompletionSupervisorRecoverySummary;
  managed: CompletionManagedSummary;
  helpers: CompletionHelperSummary;
  packet_path: string;
  omitted?: {
    blocking_reasons?: number;
    artifact_findings?: number;
    validation_evidence?: number;
    active_blockers?: number;
  };
}

export interface BuildCompletionPacketOptions {
  runRoot: string;
  node: CompiledExecutableNode;
  attempt: RuntimeNodeAttempt;
  workspacePath: string;
  outputDir?: string;
  runtimeDir?: string;
  toolInvocationsPath?: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  priorAttempts?: RuntimeNodeAttempt[];
  supervisorRecoveryEnvelope?: SupervisorRecoveryEnvelope;
  supervisorRecoveryEnvelopePath?: string;
  authorityRequests?: AuthorityRequest[];
  managed?: CompletionManagedSummary;
  observations?: OperatorObservation[];
  now?: () => Date;
}

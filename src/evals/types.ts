import type { HarnessName, ReasoningEffort } from "../graph/schema.js";

export const evalSuiteVersion = "1";
export const evalSourceReference =
  "Primary: Anthropic, Demystifying evals for AI agents (https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents). Adopted mechanics: ADK evaluation criteria, trajectory evaluation, and deterministic environment simulation (https://adk.dev/evaluate/).";

export type EvalOutcomeStatus = "passed" | "failed" | "paused" | "canceled";
export type EvalTrialStatus = "passed" | "failed" | "errored" | "skipped";
export type EvalCriterionKind =
  | "outcome"
  | "artifact"
  | "workspace"
  | "supervisor"
  | "trajectory"
  | "quality"
  | "delivery"
  | "custom_script";
export type EvalTrajectoryMatchMode = "exact_order" | "contains_ordered" | "contains_any_order" | "forbid";

export interface EvalDiagnostic {
  path: string;
  message: string;
}

export interface EvalSuiteThresholds {
  pass_rate?: number;
  max_blocker_rate?: number;
  min_average_score?: number;
}

export interface EvalCriterion {
  id: string;
  kind: EvalCriterionKind;
  required: boolean;
  description?: string;
  command?: string;
  rubric?: string;
  rubric_path?: string;
  dimensions?: string[];
  threshold?: number;
  harness?: HarnessName;
  model?: string;
  reasoning_effort?: ReasoningEffort;
  timeout_sec?: number;
}

export interface EvalSuite {
  version: "1";
  suite_id: string;
  objective: string;
  source_reference: string;
  default_trials: number;
  scenarios: string[];
  variants: string[];
  criteria: EvalCriterion[];
  thresholds: EvalSuiteThresholds;
}

export interface EvalSimulationMatch {
  argv_exact?: string[];
  argv_contains?: string[];
  cwd_contains?: string;
}

export interface EvalSimulationResponse {
  stdout?: string;
  stderr?: string;
  exit_code?: number;
}

export interface EvalSimulationError {
  stderr: string;
  exit_code?: number;
}

export interface EvalSimulationRule {
  id: string;
  command: string;
  match: EvalSimulationMatch;
  response?: EvalSimulationResponse;
  response_file?: string;
  response_file_path?: string;
  error?: EvalSimulationError;
  latency_ms?: number;
  probability?: number;
}

export interface EvalEnvironmentSimulation {
  seed?: string;
  tool_calls: EvalSimulationRule[];
}

export interface EvalCheckpointDecisionScript {
  decision: "pass" | "deny" | "abort";
  feedback?: string;
}

export interface EvalCheckpointScript {
  decisions: EvalCheckpointDecisionScript[];
}

export interface EvalSupervisorResumeScript {
  human_action: "approve" | "fail" | "add_context" | "retry_with_guidance" | "rebuild_context_then_retry";
  human_note?: string;
  reset_supervisor_budget?: boolean;
}

export interface EvalScenarioEnvironment {
  repo: string;
  repo_path: string;
  init_git: boolean;
  docs?: string;
  docs_path?: string;
  tools?: string;
  tools_path?: string;
  simulation?: EvalEnvironmentSimulation;
  scripted_checkpoints?: EvalCheckpointScript;
  scripted_resume?: EvalSupervisorResumeScript;
}

export interface EvalScenarioWorkflow {
  graph_template: string;
  graph_template_path: string;
  harness: HarnessName;
  workspace_backend?: "inplace" | "worktree";
  launch_profile?: string;
}

export interface EvalScenarioMeasurement {
  claim: string;
  scenario_type: string;
  metrics: string[];
  expected_failure_modes: string[];
  tweak_signal: string;
}

export interface EvalExpectedArtifact {
  name: string;
  contains?: string[];
}

export interface EvalExpectedSupervisor {
  classifications?: string[];
  gatherers?: string[];
  apply_actions?: string[];
  forbidden_apply_actions?: string[];
  recovery_diagnoses?: string[];
  forbidden_recovery_diagnoses?: string[];
}

export interface EvalScenarioRealWorldMetadata {
  source_repo: string;
  license: "MIT";
  base_sha: string;
  issue_url: string;
  pr_url: string;
  oracle_commit_sha: string;
  package_manager: string;
  regression_patch: string;
  regression_patch_path: string;
  setup_command: string;
  focused_test_command: string;
  allowed_changed_globs: string[];
  forbidden_changed_globs: string[];
  hidden_oracle_changed_files: string[];
}

export interface EvalScenarioMetadata {
  realworld?: EvalScenarioRealWorldMetadata;
  [key: string]: unknown;
}

export type EvalScenarioCriterionConfig = Record<string, unknown>;

export interface EvalScenario {
  id: string;
  bucket: string;
  difficulty: string;
  description: string;
  measurement: EvalScenarioMeasurement;
  scenario_dir: string;
  graph_template_path: string;
  environment: EvalScenarioEnvironment;
  workflow: EvalScenarioWorkflow;
  criteria: Record<string, EvalScenarioCriterionConfig>;
  metadata: EvalScenarioMetadata;
}

export interface EvalVariant {
  id: string;
  description: string;
  variant_path: string;
  graph_template?: string;
  graph_template_path?: string;
  env: Record<string, string>;
  prompt_pack?: string;
}

export interface LoadedEvalSuite {
  suite: EvalSuite;
  suite_path: string;
  suite_dir: string;
  scenarios: EvalScenario[];
  variants: EvalVariant[];
  criteria: EvalCriterion[];
  diagnostics: EvalDiagnostic[];
}

export interface EvalTemplateTrialContext {
  id: string;
  index: number;
  root: string;
}

export interface EvalTemplateEnvironmentContext {
  repo: string;
  docs_url?: string;
  tools?: string;
  simulation_events_file?: string;
  eval_root?: string;
  trial_root?: string;
}

export interface EvalAssertionResult {
  id: string;
  passed: boolean;
  evidence?: string;
}

export interface EvalScriptCriterionPayload {
  passed: boolean;
  score?: number;
  summary?: string;
  assertions?: EvalAssertionResult[];
  metrics?: Record<string, unknown>;
  blockers?: string[];
}

export interface EvalJudgePayload {
  passed_quality_bar: boolean;
  score: number;
  dimension_scores: Record<string, number>;
  blockers: string[];
  rationale: string;
  prompt_feedback: {
    helpful_sections: string[];
    noisy_sections: string[];
    missing_guidance: string[];
  };
}

export interface EvalCriterionResult {
  id: string;
  kind: EvalCriterionKind;
  required: boolean;
  status: "passed" | "failed" | "errored" | "skipped";
  passed: boolean;
  blockers: string[];
  assertions: EvalAssertionResult[];
  output_dir?: string;
  score?: number;
  dimension_scores?: Record<string, number>;
  rationale?: string;
  prompt_feedback?: {
    helpful_sections: string[];
    noisy_sections: string[];
    missing_guidance: string[];
  };
  metrics?: Record<string, unknown>;
  error?: string;
}

export interface EvalTraceArtifact {
  name: string;
  path: string;
  content?: string;
}

export interface EvalTraceAttempt {
  execution_id?: string;
  compiled_id?: string;
  authored_id?: string;
  kind?: string;
  status?: string;
  outcome?: string;
  attempt_index?: number;
  duration_ms?: number;
  artifacts?: Record<string, string>;
}

export interface EvalTracePromptDiagnosticEntry {
  path: string;
  prompt_kind?: string;
  renderer?: string;
  total_chars?: number;
  context_pointer_count?: number;
  context_read_first_count?: number;
  context_glob_set_count?: number;
  context_glob_match_count?: number;
  context_glob_included_count?: number;
  context_limited_glob_count?: number;
  has_supervisor_recovery?: boolean;
  warnings: string[];
}

export interface EvalTracePromptDiagnosticsSummary {
  count: number;
  total_chars: number;
  max_prompt_chars: number;
  context_pointer_count: number;
  context_read_first_count: number;
  context_glob_set_count: number;
  context_glob_match_count: number;
  context_glob_included_count: number;
  context_limited_glob_count: number;
  warnings: string[];
  warning_counts: Record<string, number>;
  entries: EvalTracePromptDiagnosticEntry[];
}

export interface EvalTraceRecoveryLearning {
  diagnosis?: string;
  followed_required_next_action?: string;
  followed_validation_gate?: string;
  material_delta_used?: string;
  repeated_forbidden_tactic?: string;
}

export interface EvalTrajectoryEvent {
  order: number;
  kind: string;
  source: string;
  timestamp?: string;
  type?: string;
  node_id?: string;
  node_label?: string;
  status?: string;
  action?: string;
  command?: string;
  artifact?: string;
  rule_id?: string;
  matched?: boolean;
  [key: string]: unknown;
}

export interface EvalTracePacket {
  schema_version: "1";
  run_root: string;
  outcome: {
    status: string;
    counts?: unknown;
  };
  attempts: EvalTraceAttempt[];
  artifacts: EvalTraceArtifact[];
  events: Array<Record<string, unknown>>;
  trajectory: EvalTrajectoryEvent[];
  simulation_events: Array<Record<string, unknown>>;
  supervisor: {
    classifications: string[];
    gatherers: string[];
    apply_actions: string[];
    resume_decisions: Array<{
      resume_point?: string;
      restart_boundary?: string;
      workspace_decision?: string;
      reason_code?: string;
    }>;
    intervention_decisions: Array<{
      selected_strategy?: string;
      prior_strategy?: string;
      restart_boundary?: string;
      workspace_decision?: string;
      material_delta_count?: number;
      fallback_if_repeated?: string;
    }>;
    recovery_learning: EvalTraceRecoveryLearning[];
    intervention_count: number;
    recovery_count: number;
  };
  prompt_diagnostics: EvalTracePromptDiagnosticsSummary;
  delivery: {
    manifest_path?: string;
    review_brief_path?: string;
    curation_verdict_path?: string;
    graph_status?: string;
    delivery_status?: string;
    review_ready?: boolean;
    curation_verdict?: unknown;
    manifest?: unknown;
  };
  metrics: {
    attempts: number;
    events: number;
    artifacts: number;
    recovery_cycles: number;
    simulation_events: number;
    trajectory_events: number;
    prompt_diagnostics_count: number;
    prompt_diagnostics_warnings: number;
    prompt_diagnostics_total_chars: number;
    prompt_diagnostics_max_chars: number;
    recovery_learning_records: number;
    duration_ms?: number;
  };
}

export interface EvalScorecard {
  schema_version: "1";
  suite_id: string;
  scenario_id: string;
  variant_id: string;
  trial_id: string;
  status: EvalTrialStatus;
  passed: boolean;
  criteria_results: EvalCriterionResult[];
  scores: {
    average: number;
    dimensions: Record<string, number>;
  };
  metrics: {
    attempts: number;
    recovery_cycles: number;
    duration_ms?: number;
    blockers: number;
    prompt_diagnostics_count?: number;
    prompt_diagnostics_warnings?: number;
    prompt_diagnostics_total_chars?: number;
    prompt_diagnostics_max_chars?: number;
    recovery_learning_records?: number;
  };
  prompt_feedback: {
    helpful_sections: string[];
    noisy_sections: string[];
    missing_guidance: string[];
  };
  error?: string;
}

export interface EvalTrialResult {
  scenario_id: string;
  variant_id: string;
  trial_id: string;
  trial_index: number;
  status: EvalTrialStatus;
  passed: boolean;
  rendered_graph_file: string;
  trial_file: string;
  trace_file?: string;
  trace_packet_file?: string;
  scorecard_file: string;
  summary_file: string;
  run_root?: string;
  error?: string;
  scorecard?: EvalScorecard;
}

export interface EvalBenchmarkCriterion {
  criterion_id: string;
  kind: EvalCriterionKind;
  required: boolean;
  total_trials: number;
  passed: number;
  failed: number;
  errored: number;
  pass_rate: number;
  blocker_count: number;
  average_score: number;
}

export interface EvalBenchmarkVariant {
  variant_id: string;
  total_trials: number;
  passed: number;
  failed: number;
  errored: number;
  pass_rate: number;
  blocker_rate: number;
  average_score: number;
  criteria: EvalBenchmarkCriterion[];
}

export interface EvalBenchmark {
  total_trials: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
  pass_rate: number;
  blocker_rate: number;
  average_score: number;
  score_variance: number;
  pass_at_1: number;
  pass_at_k: number;
  threshold_passed: boolean;
  variants: EvalBenchmarkVariant[];
  criteria: EvalBenchmarkCriterion[];
}

export interface EvalRunLedger {
  version: "1";
  suite_id: string;
  eval_root: string;
  suite_path: string;
  source_reference: string;
  started_at: string;
  ended_at: string;
  status: "passed" | "failed";
  filters: {
    scenario_id?: string;
    variant_id?: string;
  };
  trials_per_scenario: number;
  thresholds: EvalSuiteThresholds;
  benchmark: EvalBenchmark;
  results: EvalTrialResult[];
}

import type { HarnessName, ReasoningEffort } from "../graph/schema.js";

export const evalSuiteVersion = "2";
export const evalSourceReference =
  "Anthropic: Demystifying evals for AI agents (https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)";

export type EvalOutcomeStatus = "passed" | "failed" | "paused" | "canceled";
export type EvalTrialStatus = "passed" | "failed" | "errored" | "skipped";

export interface EvalDiagnostic {
  path: string;
  message: string;
}

export interface EvalSuiteThresholds {
  pass_rate?: number;
  max_blocker_rate?: number;
  min_average_score?: number;
}

export interface EvalScriptGrader {
  id: string;
  kind: "script";
  command: string;
  required: boolean;
  timeout_sec?: number;
}

export interface EvalJudge {
  id: string;
  rubric: string;
  rubric_path: string;
  required: boolean;
  harness: HarnessName;
  model?: string;
  reasoning_effort?: ReasoningEffort;
  timeout_sec?: number;
}

export interface EvalSuite {
  version: "2";
  suite_id: string;
  objective: string;
  source_reference: string;
  default_trials: number;
  scenarios: string[];
  variants: string[];
  graders: EvalScriptGrader[];
  judges: EvalJudge[];
  thresholds: EvalSuiteThresholds;
}

export interface EvalScenarioFixture {
  repo: string;
  repo_path: string;
  init_git: boolean;
  docs?: string;
  docs_path?: string;
  tools?: string;
  tools_path?: string;
}

export interface EvalScenarioWorkflow {
  graph_template: string;
  graph_template_path: string;
  harness: HarnessName;
  workspace_backend?: "inplace" | "worktree";
  launch_profile?: string;
}

export interface EvalExpectedArtifact {
  name: string;
  contains?: string[];
}

export interface EvalExpectedSupervisor {
  classifications?: string[];
  gatherers?: string[];
  apply_actions?: string[];
}

export interface EvalScenarioExpected {
  final_outcome: EvalOutcomeStatus;
  required_artifacts: EvalExpectedArtifact[];
  forbidden_edits: string[];
  supervisor: EvalExpectedSupervisor;
  expected_pause?: boolean;
}

export interface EvalScenarioGrading {
  dimensions: string[];
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

export interface EvalScenario {
  id: string;
  bucket: string;
  difficulty: string;
  description: string;
  scenario_dir: string;
  graph_template_path: string;
  fixture: EvalScenarioFixture;
  workflow: EvalScenarioWorkflow;
  expected: EvalScenarioExpected;
  grading: EvalScenarioGrading;
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
  graders: EvalScriptGrader[];
  judges: EvalJudge[];
  diagnostics: EvalDiagnostic[];
}

export interface EvalTemplateTrialContext {
  id: string;
  index: number;
  root: string;
}

export interface EvalTemplateFixtureContext {
  repo: string;
  docs_url?: string;
  tools?: string;
  eval_root?: string;
  trial_root?: string;
}

export interface EvalAssertionResult {
  id: string;
  passed: boolean;
  evidence?: string;
}

export interface EvalScriptGraderPayload {
  passed: boolean;
  score?: number;
  summary?: string;
  assertions?: EvalAssertionResult[];
  metrics?: Record<string, unknown>;
}

export interface EvalGraderResult extends EvalScriptGraderPayload {
  id: string;
  kind: "script";
  required: boolean;
  status: "passed" | "failed" | "errored" | "skipped";
  output_dir: string;
  error?: string;
}

export interface EvalJudgeResult {
  id: string;
  kind: "llm_judge";
  required: boolean;
  status: "passed" | "failed" | "errored" | "skipped";
  output_dir: string;
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

export interface EvalTracePacket {
  schema_version: "2";
  run_root: string;
  outcome: {
    status: string;
    counts?: unknown;
  };
  attempts: EvalTraceAttempt[];
  artifacts: EvalTraceArtifact[];
  events: Array<Record<string, unknown>>;
  supervisor: {
    classifications: string[];
    gatherers: string[];
    apply_actions: string[];
    intervention_count: number;
    recovery_count: number;
  };
  delivery: {
    manifest_path?: string;
    manifest?: unknown;
  };
  metrics: {
    attempts: number;
    events: number;
    artifacts: number;
    recovery_cycles: number;
    duration_ms?: number;
  };
}

export interface EvalDeterministicResult {
  passed: boolean;
  blockers: string[];
  assertions: EvalAssertionResult[];
}

export interface EvalScorecard {
  schema_version: "2";
  suite_id: string;
  scenario_id: string;
  variant_id: string;
  trial_id: string;
  status: EvalTrialStatus;
  passed: boolean;
  deterministic: EvalDeterministicResult;
  graders: EvalGraderResult[];
  judges: EvalJudgeResult[];
  scores: {
    average: number;
    dimensions: Record<string, number>;
  };
  metrics: {
    attempts: number;
    recovery_cycles: number;
    duration_ms?: number;
    blockers: number;
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

export interface EvalBenchmarkVariant {
  variant_id: string;
  total_trials: number;
  passed: number;
  failed: number;
  errored: number;
  pass_rate: number;
  blocker_rate: number;
  average_score: number;
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
}

export interface EvalRunLedger {
  version: "2";
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

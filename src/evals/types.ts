import type { ReasoningEffort } from "../graph/schema.js";

export const evalSuiteVersion = "1";

export interface EvalDiagnostic {
  path: string;
  message: string;
}

export interface EvalSuiteTarget {
  graph_template: string;
}

export interface EvalSuiteVariant {
  graph_template?: string;
  optional?: boolean;
}

export interface EvalSuiteThresholds {
  pass_rate?: number;
  critical_failures?: number;
}

export interface EvalScriptGrader {
  id: string;
  kind: "script";
  command: string;
  required?: boolean;
  timeout_sec?: number;
}

export interface EvalAiRubricGrader {
  id: string;
  kind: "ai_rubric";
  rubric: string;
  required?: boolean;
  model?: string;
  reasoning_effort?: ReasoningEffort;
  timeout_sec?: number;
}

export type EvalGrader = EvalScriptGrader | EvalAiRubricGrader;

export interface EvalSuite {
  version: "1";
  suite_id: string;
  target: EvalSuiteTarget;
  cases: string;
  variants?: Record<string, EvalSuiteVariant>;
  graders?: EvalGrader[];
  thresholds?: EvalSuiteThresholds;
}

export interface EvalCase {
  id: string;
  task: string;
  fixtures?: string[] | Record<string, string>;
  repos?: Record<string, string | { path: string }>;
  expected?: unknown;
  tags?: string[];
  [key: string]: unknown;
}

export interface LoadedEvalSuite {
  suite: EvalSuite;
  suite_path: string;
  suite_dir: string;
  cases: EvalCase[];
  diagnostics: EvalDiagnostic[];
}

export interface EvalVariantResolution {
  id: string;
  graph_template: string;
  graph_template_path: string;
  optional: boolean;
  skipped?: boolean;
  skip_reason?: string;
}

export interface EvalAssertionResult {
  id: string;
  passed: boolean;
  evidence?: string;
}

export interface EvalGraderNormalizedPayload {
  passed: boolean;
  score?: number;
  summary?: string;
  assertions?: EvalAssertionResult[];
  metrics?: Record<string, unknown>;
}

export interface EvalGraderResult extends EvalGraderNormalizedPayload {
  id: string;
  kind: EvalGrader["kind"];
  required: boolean;
  status: "passed" | "failed" | "errored" | "skipped";
  output_dir: string;
  error?: string;
}

export interface EvalCaseVariantResult {
  case_id: string;
  variant_id: string;
  status: "passed" | "failed" | "errored" | "skipped";
  passed: boolean;
  graph_status?: string;
  rendered_graph_file?: string;
  run_root?: string;
  trace_file?: string;
  grading_file: string;
  summary_file: string;
  graders: EvalGraderResult[];
  error?: string;
}

export interface EvalBenchmark {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
  pass_rate: number;
  threshold_passed: boolean;
  critical_failures: number;
}

export interface EvalRunLedger {
  version: "1";
  suite_id: string;
  eval_root: string;
  suite_path: string;
  started_at: string;
  ended_at: string;
  status: "passed" | "failed";
  filters: {
    case_id?: string;
    variant_id?: string;
  };
  thresholds: EvalSuiteThresholds;
  benchmark: EvalBenchmark;
  results: EvalCaseVariantResult[];
}

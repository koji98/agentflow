/** Shared type contracts for the agentflow runtime. */

export type Provider = 'codex';
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type RetryOn = 'FAILED' | 'TIMEOUT' | 'BLOCKED';

/** Parsed CLI arguments for one invocation. */
export interface CliArgs {
  planFile: string | null;
  dryRunOverride: boolean | null;
  skipGitRepoCheck: boolean;
  planHelp: boolean;
  help: boolean;
}

/** Global retry settings applied to all task nodes. */
export interface RetryPolicy {
  max_retries: number;
  retry_on: RetryOn[];
}

/** Defaults applied to task launches and AI gate launches. */
export interface PlanDefaults {
  provider: Provider;
  model: string | null;
  reasoning_effort: ReasoningEffort | null;
  profile: string | null;
}

/** Execution/runtime controls for a run. */
export interface PlanRuntime {
  run_root: string;
  run_id: string | null;
  use_worktrees: boolean;
  continue_on_error: boolean;
  cleanup_worktrees: boolean;
  dry_run: boolean;
  skip_git_repo_check: boolean;
  worker_timeout_sec: number;
  timeout_grace_sec: number;
  max_parallel_tasks: number | null;
}

/** Top-level run termination policy. */
export interface TerminationPolicy {
  max_iterations: number | null;
  max_runtime_sec: number | null;
  max_total_tasks: number | null;
  max_failures: number | null;
  stop_on_first_failure: boolean;
}

/** Prompt-level completion contract expected from workers. */
export interface PromptContract {
  require_status_line: boolean;
  allowed_statuses: string[];
  require_report_for_done: boolean;
}

/** Shared task shape used by workflow task nodes and launch rendering. */
export interface PlanTask {
  task_id: string;
  task: string;
  provider: Provider | null;
  model: string | null;
  context_files: string[];
}

/** One task node in workflow tree. */
export interface TaskNode extends PlanTask {
  type: 'task';
}

/** One evaluator execution block used by while gates. */
export interface EvaluatorExec {
  command: string;
  args: string[];
  cwd: string | null;
  timeout_sec: number | null;
}

/** Shared gate fields for loop evaluation. */
export interface BaseGate {
  id: string;
  type: 'deterministic' | 'ai';
  score_threshold: number | null;
  timeout_sec: number | null;
  required_artifacts: string[];
}

/** Deterministic gate: execute command and parse JSON output. */
export interface DeterministicGate extends BaseGate {
  type: 'deterministic';
  exec: EvaluatorExec;
}

/** AI gate: prompt a model and parse JSON output. */
export interface AiGate extends BaseGate {
  type: 'ai';
  prompt: string;
  provider: Provider | null;
  model: string | null;
  reasoning_effort: ReasoningEffort | null;
  profile: string | null;
  include_recent_tasks: number | null;
}

/** While loop gate definition. */
export type EvaluatorGate = DeterministicGate | AiGate;

/** Group node with sequential or parallel child execution. */
export interface GroupNode {
  type: 'group';
  id: string;
  parallel: boolean;
  steps: WorkflowNode[];
}

/** While node that repeats body until gate passes or caps reached. */
export interface WhileNode {
  type: 'while';
  id: string;
  max_iterations: number | null;
  until: EvaluatorGate;
  body: WorkflowNode[];
}

/** Supported workflow node union. */
export type WorkflowNode = TaskNode | GroupNode | WhileNode;

/** Fully normalized plan payload loaded from disk. */
export interface WorkerPlan {
  setup: string;
  objective: string | null;
  target_repo_root: string;
  defaults: PlanDefaults;
  retry_policy: RetryPolicy;
  runtime: PlanRuntime;
  termination: TerminationPolicy;
  prompt_contract: PromptContract;
  context_files: string[];
  workflow: WorkflowNode[];
}

/** One concrete launch unit, materialized from a task with runtime paths. */
export interface TaskLaunch {
  group_index: number;
  task_index: number;
  task_key: string;
  task: PlanTask;
  provider: Provider;
  model: string | null;
  reasoning_effort: ReasoningEffort | null;
  profile: string | null;
  prompt_text: string;
  task_dir: string;
  prompt_path: string;
  log_path: string;
  last_message_path: string;
  report_path: string;
  worker_report_path: string;
  report_json_path: string;
  workspace_cwd: string;
  branch: string | null;
  use_worktree: boolean;
  skip_git_repo_check: boolean;
  node_path: string;
  attempt: number;
}

/** Runtime status values tracked on groups/tasks. */
export type RuntimeStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'DONE'
  | 'FAILED'
  | 'BLOCKED'
  | (string & {});

/** Group-level state row in run_state.json. */
export interface GroupStateRow {
  groupIndex: number;
  taskCount: number;
  label: string;
  status: RuntimeStatus;
  failureCount: number;
}

/** Task-level state row in run_state.json. */
export interface TaskStateRow {
  taskKey: string;
  taskId: string;
  groupIndex: number;
  taskIndex: number;
  nodePath: string;
  attempt: number;
  status: RuntimeStatus;
  provider: Provider;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  profile: string | null;
  promptPath: string;
  logPath: string;
  lastMessagePath: string;
  reportPath: string;
  reportJsonPath: string;
  cwd: string;
  branch: string | null;
  exitCode?: number;
  startedAtUtc?: string;
  endedAtUtc?: string;
  durationSec?: number;
  timedOut?: boolean;
  timeoutSeconds?: number | null;
  timeoutClassification?: string | null;
  timeoutTerminationOutcome?: string | null;
  declaredStatus?: string | null;
  statusParseError?: string | null;
  completionContractErrors?: string[];
  completionContractSatisfied?: boolean;
}

/** Top-level persisted run state model. */
export interface RunState {
  runId: string;
  createdAtUtc: string;
  updatedAtUtc: string;
  configPath: string;
  workflowLength: number;
  totalTaskCount: number;
  totalFailureCount: number;
  totalLoopIterations: number;
  groups: Record<string, GroupStateRow>;
  tasks: Record<string, TaskStateRow>;
  eventsFile: string;
  rawThoughtsPath: string;
  decisionTraceFile: string;
}

/** Decision trace record for loop/evaluator and retry behavior. */
export interface DecisionTraceEntry {
  atUtc: string;
  type:
    | 'while_gate_evaluation'
    | 'while_iteration_started'
    | 'while_satisfied'
    | 'while_exhausted'
    | 'task_retry'
    | 'termination_guard';
  nodePath: string;
  detail: Record<string, unknown>;
}

/** In-memory execution session shared across orchestration functions. */
export interface Session {
  project_root: string;
  config_path: string;
  plan: WorkerPlan;
  run_root: string;
  run_id: string;
  dry_run: boolean;
  global_context_files: string[];
  state: RunState;
  state_path: string;
  events_path: string;
  summary_path: string;
  decision_trace_path: string;
  created_worktrees: Set<string>;
  created_worktree_branches: Set<string>;
  shutdown_signal: NodeJS.Signals | null;
  next_group_index: number;
  started_at_ms: number;
  executed_task_count: number;
  failure_task_count: number;
  loop_iteration_count: number;
  decision_trace: DecisionTraceEntry[];
}

/** Result of one subprocess execution. */
export interface RunCommandResult {
  exitCode: number;
  timedOut: boolean;
  timeoutSeconds: number | null;
  timeoutClassification: string | null;
  timeoutTerminationOutcome: string | null;
}

/** Params used to launch one subprocess. */
export interface RunCommandParams {
  cmd: string[];
  cwd: string;
  stdinText: string;
  logPath: string;
  dryRun: boolean;
  timeoutSeconds: number | null;
  timeoutGraceSeconds: number;
  rawThoughtsPath: string;
  rawThoughtsTaskLabel: string;
}

/** Parsed/evaluated status contract from worker output. */
export interface ContractResult {
  status: RuntimeStatus;
  declaredStatus: string | null;
  statusParseError: string | null;
  completionContractErrors: string[];
  completionContractSatisfied: boolean;
}

/** Result row emitted per task completion. */
export interface TaskExecutionResult {
  group_index: number;
  task_index: number;
  task_key: string;
  task_id: string;
  node_path: string;
  attempt: number;
  status: RuntimeStatus;
  exit_code: number;
  started_at_utc: string;
  ended_at_utc: string;
  duration_sec: number;
  timed_out: boolean;
  timeout_seconds: number | null;
  timeout_classification: string | null;
  timeout_termination_outcome: string | null;
  declared_status: string | null;
  status_parse_error: string | null;
  completion_contract_errors: string[];
  completion_contract_satisfied: boolean;
  report_json_path: string;
}

/** Evaluator command output used for while gates. */
export interface EvaluatorOutput {
  passed: boolean;
  score: number | null;
  reasons: string[];
  raw: unknown;
}

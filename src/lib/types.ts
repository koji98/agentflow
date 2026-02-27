/** Shared type contracts for the agentflow runtime. */

export type Provider = 'codex' | 'cursor';
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type RetryOn = 'FAILED' | 'TIMEOUT' | 'BLOCKED';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** Parsed CLI arguments for one invocation. */
export interface CliArgs {
  planFile: string | null;
  dryRunOverride: boolean | null;
  skipGitRepoCheck: boolean;
  sandboxMode: SandboxMode | null;
  planHelp: boolean;
  help: boolean;
}

/** Shared task shape used by workflow task nodes and launch rendering. */
export interface PlanTask {
  task_id: string;
  task: string;
  provider: Provider | null;
  model: string | null;
  persona: string | null;
  context_files: string[];
  context_from: string[];
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

/** Resource limits and retry/termination policy. */
export interface PlanLimits {
  max_retries: number;
  retry_on: RetryOn[];
  max_iterations: number | null;
  max_runtime_sec: number | null;
  max_total_tasks: number | null;
  max_failures: number | null;
  worker_timeout_sec: number;
  timeout_grace_sec: number;
  max_parallel_tasks: number | null;
}

/** Rarely-changed runtime options. */
export interface PlanOptions {
  run_root: string;
  run_id: string | null;
  cleanup_worktrees: boolean;
  dry_run: boolean;
  skip_git_repo_check: boolean;
  sandbox_mode: SandboxMode;
}

/** Fully normalized plan payload loaded from disk. */
export interface WorkerPlan {
  setup: string;
  objective: string | null;
  persona: string | null;
  target_repo_root: string;
  provider: Provider;
  model: string | null;
  reasoning_effort: ReasoningEffort | null;
  profile: string | null;
  on_failure: 'stop' | 'continue';
  worktrees: boolean;
  context_files: string[];
  limits: PlanLimits;
  options: PlanOptions;
  workflow: WorkflowNode[];
}

/** Summary of a previously completed task, injected into subsequent prompts. */
export interface PriorTaskSummary {
  taskId: string;
  status: string;
  summary: string;
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
  summary_path: string;
  worker_summary_path: string;
  workspace_cwd: string;
  branch: string | null;
  use_worktree: boolean;
  skip_git_repo_check: boolean;
  sandbox_mode: SandboxMode;
  node_path: string;
  attempt: number;
}

/** Runtime status values tracked on groups/tasks. */
export type RuntimeStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'DONE'
  | 'FAILED'
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
  summaryPath: string;
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
  failureReason?: string | null;
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

/** Resolved filesystem paths for one run. */
export interface RunPaths {
  project_root: string;
  config_path: string;
  run_root: string;
  run_id: string;
  state_path: string;
  summary_path: string;
}

/** Mutable execution counters tracked across the run lifetime. */
export interface RunCounters {
  next_group_index: number;
  started_at_ms: number;
  executed_task_count: number;
  failure_task_count: number;
  loop_iteration_count: number;
}

/** Tracks worktrees and branches created during the run for cleanup. */
export interface WorktreeTracker {
  created: Set<string>;
  created_branches: Set<string>;
}

/** In-memory execution session shared across orchestration functions. */
export interface Session {
  plan: WorkerPlan;
  dry_run: boolean;
  global_context_files: string[];
  paths: RunPaths;
  counters: RunCounters;
  worktree_tracker: WorktreeTracker;
  state: RunState;
  shutdown_signal: NodeJS.Signals | null;
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
  /** When true, pipe stdinText to the child process. When false, close stdin immediately. */
  useStdin: boolean;
  /** When set, write stdout-only content to this path on process close. */
  stdoutCapturePath: string | null;
}

/** Parsed/evaluated completion contract from worker output. */
export interface ContractResult {
  status: RuntimeStatus;
  reason: string | null;
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
  failure_reason: string | null;
}

/** Evaluator command output used for while gates. */
export interface EvaluatorOutput {
  passed: boolean;
  score: number | null;
  reasons: string[];
  raw: unknown;
}

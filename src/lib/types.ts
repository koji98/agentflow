/** Shared type contracts for the agentflow runtime. */

export type Provider = 'codex' | 'cursor';
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type RetryOn = 'FAILED' | 'TIMEOUT';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

/** Parsed CLI arguments for one invocation. */
export interface CliArgs {
  planFile: string | null;
  dryRunOverride: boolean | null;
  skipGitRepoCheck: boolean;
  sandboxMode: SandboxMode | null;
  validate: boolean;
  resumeDir: string | null;
  planHelp: boolean;
  help: boolean;
}

/** Shared task shape used by workflow task nodes and launch rendering. */
export interface PlanTask {
  taskId: string;
  task: string;
  repo: string | null;
  provider: Provider | null;
  model: string | null;
  persona: string | null;
  contextFiles: string[];
  contextFrom: string[];
}

/** One task node in workflow tree. */
export interface TaskNode extends PlanTask {
  type: 'task';
}

/** One deterministic shell command node in workflow tree. */
export interface CommandNode {
  type: 'command';
  id: string;
  repo: string | null;
  command: string;
  args: string[];
  cwd: string | null;
  timeoutSec: number | null;
  allowFailure: boolean;
}

/** One evaluator execution block used by while gates. */
export interface EvaluatorExec {
  command: string;
  args: string[];
  cwd: string | null;
  timeoutSec: number | null;
}

/** Shared gate fields for loop evaluation. */
export interface BaseGate {
  id: string;
  type: 'deterministic' | 'ai';
  repo: string | null;
  scoreThreshold: number | null;
  timeoutSec: number | null;
  requiredArtifacts: string[];
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
  persona: string | null;
  provider: Provider | null;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  profile: string | null;
  includeRecentTasks: number | null;
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
  maxIterations: number | null;
  until: EvaluatorGate;
  body: WorkflowNode[];
}

/** Supported workflow node union. */
export type WorkflowNode = TaskNode | CommandNode | GroupNode | WhileNode;

/** Resource limits and retry/termination policy. */
export interface PlanLimits {
  maxRetries: number;
  retryOn: RetryOn[];
  maxIterations: number | null;
  maxRuntimeSec: number | null;
  maxTotalTasks: number | null;
  maxFailures: number | null;
  workerTimeoutSec: number;
  timeoutGraceSec: number;
  maxParallelTasks: number | null;
}

/** Rarely-changed runtime options. */
export interface PlanOptions {
  runRoot: string;
  runId: string | null;
  cleanupWorktrees: boolean;
  worktreeBranchTemplate: string;
  dryRun: boolean;
  skipGitRepoCheck: boolean;
  sandboxMode: SandboxMode;
}

/** Fully normalized plan payload loaded from disk. */
export interface WorkerPlan {
  setup: string;
  objective: string | null;
  persona: string | null;
  repos: Record<string, string>;
  provider: Provider;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  profile: string | null;
  onFailure: 'stop' | 'continue';
  worktrees: boolean;
  contextFiles: string[];
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
  groupIndex: number;
  taskIndex: number;
  taskKey: string;
  task: PlanTask;
  repoAlias: string;
  provider: Provider;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  profile: string | null;
  promptText: string;
  taskDir: string;
  promptPath: string;
  logPath: string;
  lastMessagePath: string;
  reportPath: string;
  workerReportPath: string;
  summaryPath: string;
  workerSummaryPath: string;
  workspaceCwd: string;
  baseRef: string;
  branch: string | null;
  useWorktree: boolean;
  skipGitRepoCheck: boolean;
  sandboxMode: SandboxMode;
  nodePath: string;
  attempt: number;
  repoRoot: string;
}

/** One concrete command launch unit, materialized from a command node with runtime paths. */
export interface CommandLaunch {
  groupIndex: number;
  taskIndex: number;
  taskKey: string;
  taskId: string;
  repoAlias: string;
  command: string;
  args: string[];
  timeoutSeconds: number | null;
  allowFailure: boolean;
  priorTaskSummaries: PriorTaskSummary[];
  taskDir: string;
  promptPath: string;
  logPath: string;
  lastMessagePath: string;
  reportPath: string;
  summaryPath: string;
  resultPath: string;
  workspaceRoot: string;
  workspaceCwd: string;
  baseRef: string;
  branch: string | null;
  useWorktree: boolean;
  nodePath: string;
  attempt: number;
  repoRoot: string;
}

/** Generic launch row used by run-state persistence for both task and command nodes. */
export type ExecutionLaunch = TaskLaunch | CommandLaunch;

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
  repoAlias?: string | null;
  groupIndex: number;
  taskIndex: number;
  nodePath: string;
  attempt: number;
  status: RuntimeStatus;
  provider: Provider | null;
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
  totalTaskFailureCount?: number;
  totalRunFailureCount?: number;
  runFailureReasons?: string[];
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
  repoRoots: Record<string, string>;
  configPath: string;
  runRoot: string;
  runId: string;
  statePath: string;
  summaryPath: string;
  decisionTracePath: string;
}

/** Mutable execution counters tracked across the run lifetime. */
export interface RunCounters {
  nextGroupIndex: number;
  startedAtMs: number;
  totalTaskCount: number;
  executedTaskCount: number;
  failureTaskCount: number;
  runFailureCount: number;
  loopIterationCount: number;
}

/** Tracks worktrees and branches created during the run for cleanup. Maps path/branch to origin repoRoot. */
export interface WorktreeTracker {
  created: Map<string, string>;
  createdBranches: Map<string, string>;
  latestRefByRepo: Map<string, string>;
  latestGroupIndexByRepo: Map<string, number>;
}

/** In-memory execution session shared across orchestration functions. */
export interface Session {
  plan: WorkerPlan;
  dryRun: boolean;
  globalContextFiles: string[];
  paths: RunPaths;
  counters: RunCounters;
  worktreeTracker: WorktreeTracker;
  state: RunState;
  /** Map of nodePath -> TaskStateRow for tasks completed in a prior run (used by --resume). */
  resumedTasks: Map<string, TaskStateRow>;
  shutdownSignal: NodeJS.Signals | null;
  decisionTrace: DecisionTraceEntry[];
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
  groupIndex: number;
  taskIndex: number;
  taskKey: string;
  taskId: string;
  nodePath: string;
  attempt: number;
  status: RuntimeStatus;
  exitCode: number;
  startedAtUtc: string;
  endedAtUtc: string;
  durationSec: number;
  timedOut: boolean;
  timeoutSeconds: number | null;
  timeoutClassification: string | null;
  timeoutTerminationOutcome: string | null;
  failureReason: string | null;
}

/** Evaluator command output used for while gates. */
export interface EvaluatorOutput {
  passed: boolean;
  score: number | null;
  reasons: string[];
  raw: unknown;
}

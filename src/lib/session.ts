import fs from 'node:fs';
import path from 'node:path';

import { nowRunId, nowUtcIso } from './utils.ts';
import type {
  DecisionTraceEntry,
  ExecutionLaunch,
  GroupStateRow,
  RunState,
  Session,
  TaskExecutionResult,
  TaskStateRow,
  WorkflowNode,
  WorkerPlan,
} from './types.ts';

/**
 * Writes a JSON-serializable value to disk, creating parent directories as needed.
 * @param filePath Absolute path for the output file.
 * @param payload Value to serialize.
 */
function saveJson(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

/**
 * Persists the in-memory decision trace to `decision_trace.json`.
 * @param session Current run session.
 */
function saveDecisionTrace(session: Session): void {
  if (session.dryRun) return;
  saveJson(session.paths.decisionTracePath, session.decisionTrace);
}

/**
 * Builds the in-memory execution session and initial persisted run state values.
 *
 * @param params Session initialization inputs.
 * @param params.repoRoots Map of alias to resolved absolute repo root.
 * @param params.planPath Absolute path to the plan JSON file.
 * @param params.plan Normalized worker plan.
 * @param params.globalContextFiles Resolved global context file paths.
 * @param params.totalTaskCount Total number of executable task-like nodes (task + command).
 * @returns Fully initialized session object.
 */
export function createSession({
  repoRoots,
  planPath,
  plan,
  globalContextFiles,
  totalTaskCount,
}: {
  repoRoots: Record<string, string>;
  planPath: string;
  plan: WorkerPlan;
  globalContextFiles: string[];
  totalTaskCount: number;
}): Session {
  const runId = plan.options.runId || nowRunId();
  const runRoot = path.resolve(path.dirname(planPath), plan.options.runRoot, runId);
  const state: RunState = {
    runId,
    createdAtUtc: nowUtcIso(),
    updatedAtUtc: nowUtcIso(),
    configPath: planPath,
    workflowLength: plan.workflow.length,
    totalTaskCount: 0,
    totalFailureCount: 0,
    totalLoopIterations: 0,
    groups: {},
    tasks: {},
  };

  return {
    plan,
    dryRun: Boolean(plan.options.dryRun),
    globalContextFiles,
    paths: {
      repoRoots,
      configPath: planPath,
      runRoot,
      runId,
      statePath: path.resolve(runRoot, 'run_state.json'),
      summaryPath: path.resolve(runRoot, 'run_summary.md'),
      decisionTracePath: path.resolve(runRoot, 'decision_trace.json'),
    },
    counters: {
      nextGroupIndex: 1,
      startedAtMs: Date.now(),
      totalTaskCount,
      executedTaskCount: 0,
      failureTaskCount: 0,
      loopIterationCount: 0,
    },
    worktreeTracker: {
      created: new Map(),
      createdBranches: new Map(),
      latestRefByRepo: new Map(),
      latestGroupIndexByRepo: new Map(),
    },
    state,
    resumedTasks: new Map(),
    shutdownSignal: null,
    decisionTrace: [],
  };
}

/**
 * Loads a prior run's state from disk for resume.
 * @param runDir Absolute path to the previous run directory.
 * @returns The deserialized RunState.
 * @throws {Error} When run_state.json cannot be read or parsed.
 */
export function loadResumedState(runDir: string): RunState {
  const statePath = path.resolve(runDir, 'run_state.json');
  if (!fs.existsSync(statePath)) {
    throw new Error(`Cannot resume: run_state.json not found in ${runDir}`);
  }
  const raw = fs.readFileSync(statePath, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  const requiredFields = ['runId', 'configPath', 'groups', 'tasks'] as const;
  const missing = requiredFields.filter((f) => !(f in parsed));
  if (missing.length > 0) {
    throw new Error(`Cannot resume: run_state.json is missing required fields: ${missing.join(', ')}`);
  }

  return parsed as unknown as RunState;
}

/**
 * Resolves a workflow node from a persisted nodePath (for example `flow[0].steps[1]`).
 * Returns null when the path is malformed or does not resolve in the current plan.
 */
function resolveWorkflowNodeAtPath(plan: WorkerPlan, nodePath: string): WorkflowNode | null {
  const segments = Array.from(nodePath.matchAll(/(flow|steps|body)\[(\d+)\]/g));
  if (segments.length === 0) return null;

  let cursor: unknown = { flow: plan.workflow };
  for (const segment of segments) {
    const key = segment[1];
    const index = Number(segment[2]);
    if (!Number.isInteger(index) || index < 0) return null;
    if (!cursor || typeof cursor !== 'object') return null;
    const next = (cursor as Record<string, unknown>)[key];
    if (!Array.isArray(next) || index >= next.length) return null;
    cursor = next[index];
  }

  if (!cursor || typeof cursor !== 'object') return null;
  return cursor as WorkflowNode;
}

/**
 * Resolves the concrete repo root for a completed node row.
 * Falls back to the plan default repo alias when the node cannot be resolved.
 */
function resolveRepoRootForNodePath(
  plan: WorkerPlan,
  repoRoots: Record<string, string>,
  nodePath: string,
): string {
  const defaultRepoAlias = Object.keys(repoRoots)[0];
  const fallbackRepoRoot = repoRoots[defaultRepoAlias];
  const node = resolveWorkflowNodeAtPath(plan, nodePath);
  if (!node || (node.type !== 'task' && node.type !== 'command')) {
    return fallbackRepoRoot;
  }
  return repoRoots[node.repo ?? defaultRepoAlias] || fallbackRepoRoot;
}

/**
 * Creates a session that resumes a prior failed run.
 * Completed tasks are loaded from the previous run_state.json and will be
 * skipped during workflow execution.
 *
 * @param params Session initialization inputs.
 * @param params.repoRoots Map of alias to resolved absolute repo root.
 * @param params.planPath Absolute path to the plan JSON file.
 * @param params.plan Normalized worker plan.
 * @param params.globalContextFiles Resolved global context file paths.
 * @param params.totalTaskCount Total number of executable task-like nodes in the workflow.
 * @param params.priorState The RunState loaded from the previous run.
 * @param params.runDir Absolute path to the previous run directory.
 * @returns Session pre-populated with completed task state.
 */
export function createResumedSession({
  repoRoots,
  planPath,
  plan,
  globalContextFiles,
  totalTaskCount,
  priorState,
  runDir,
}: {
  repoRoots: Record<string, string>;
  planPath: string;
  plan: WorkerPlan;
  globalContextFiles: string[];
  totalTaskCount: number;
  priorState: RunState;
  runDir: string;
}): Session {
  const runRoot = path.resolve(runDir);
  const runId = priorState.runId;
  const decisionTracePath = path.resolve(runRoot, 'decision_trace.json');
  let resumedDecisionTrace: DecisionTraceEntry[] = [];
  if (fs.existsSync(decisionTracePath)) {
    try {
      const rawTrace = JSON.parse(fs.readFileSync(decisionTracePath, 'utf8'));
      if (Array.isArray(rawTrace)) {
        resumedDecisionTrace = rawTrace as DecisionTraceEntry[];
      }
    } catch {
      resumedDecisionTrace = [];
    }
  }

  const resumedTasks = new Map<string, TaskStateRow>();
  const doneTasks: Record<string, TaskStateRow> = {};
  let maxGroupIndex = 0;
  let doneCount = 0;

  for (const [key, row] of Object.entries(priorState.tasks)) {
    if (row.groupIndex > maxGroupIndex) {
      maxGroupIndex = row.groupIndex;
    }
    if (row.status === 'DONE') {
      resumedTasks.set(row.nodePath, row);
      doneTasks[key] = row;
      doneCount += 1;
    }
  }

  const state: RunState = {
    ...priorState,
    tasks: doneTasks,
    groups: {},
    updatedAtUtc: nowUtcIso(),
  };
  const latestRefByRepo = new Map<string, string>();
  const latestGroupIndexByRepo = new Map<string, number>();
  if (plan.worktrees) {
    const doneRows = Object.values(doneTasks)
      .filter((row) => Boolean(row.branch))
      .sort((a, b) => (
        a.groupIndex - b.groupIndex ||
        a.taskIndex - b.taskIndex ||
        a.attempt - b.attempt
      ));
    for (const row of doneRows) {
      const repoRoot = resolveRepoRootForNodePath(plan, repoRoots, row.nodePath);
      latestRefByRepo.set(repoRoot, String(row.branch));
      latestGroupIndexByRepo.set(repoRoot, row.groupIndex);
    }
  }

  return {
    plan,
    dryRun: Boolean(plan.options.dryRun),
    globalContextFiles,
    paths: {
      repoRoots,
      configPath: planPath,
      runRoot,
      runId,
      statePath: path.resolve(runRoot, 'run_state.json'),
      summaryPath: path.resolve(runRoot, 'run_summary.md'),
      decisionTracePath,
    },
    counters: {
      nextGroupIndex: maxGroupIndex + 1,
      startedAtMs: Date.now(),
      totalTaskCount,
      executedTaskCount: doneCount,
      failureTaskCount: 0,
      loopIterationCount: priorState.totalLoopIterations,
    },
    worktreeTracker: {
      created: new Map(),
      createdBranches: new Map(),
      latestRefByRepo,
      latestGroupIndexByRepo,
    },
    state,
    resumedTasks,
    shutdownSignal: null,
    decisionTrace: resumedDecisionTrace,
  };
}

/**
 * Allocates the next monotonic execution group index for the current run.
 * @param session Current run session.
 * @returns Next sequential group index.
 */
export function allocateGroupIndex(session: Session): number {
  const out = session.counters.nextGroupIndex;
  session.counters.nextGroupIndex += 1;
  return out;
}

/**
 * Persists run state and updates aggregate counters/timestamps.
 * @param session Current run session.
 */
export function saveState(session: Session): void {
  if (session.dryRun) return;
  session.state.updatedAtUtc = nowUtcIso();
  session.state.totalTaskCount = session.counters.executedTaskCount;
  session.state.totalFailureCount = session.counters.failureTaskCount;
  session.state.totalLoopIterations = session.counters.loopIterationCount;
  saveJson(session.paths.statePath, session.state);
}

/**
 * Records one decision trace entry in memory (used for loop control flow).
 * @param session Current run session.
 * @param type Decision type label.
 * @param nodePath Workflow node path where the decision occurred.
 * @param detail Arbitrary detail payload for the trace entry.
 */
export function recordDecision(
  session: Session,
  type: DecisionTraceEntry['type'],
  nodePath: string,
  detail: Record<string, unknown>,
): void {
  const entry: DecisionTraceEntry = { atUtc: nowUtcIso(), type, nodePath, detail };
  session.decisionTrace.push(entry);
  saveDecisionTrace(session);
}

/** Truncates a potentially long line for markdown summary readability. */
function truncateLine(text: string, max = 180): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

/**
 * Converts a decision trace entry into one summary markdown bullet.
 * Only decisions relevant to gating/retry outcomes are surfaced.
 * @param entry One decision trace entry.
 * @returns One markdown bullet or `null` when not relevant for the summary section.
 */
function renderDecisionSummaryLine(entry: DecisionTraceEntry): string | null {
  if (entry.type === 'while_gate_evaluation') {
    const gateId = String(entry.detail.gateId || '(unknown_gate)');
    const iteration = Number(entry.detail.iteration || 0);
    const phase = String(entry.detail.phase || 'unknown_phase');
    const passed = entry.detail.passed === true ? 'true' : 'false';
    const score = entry.detail.score === null || entry.detail.score === undefined
      ? 'null'
      : String(entry.detail.score);
    const reasons = Array.isArray(entry.detail.reasons)
      ? (entry.detail.reasons as unknown[]).map((r) => String(r)).join('; ')
      : '(none)';
    return `- \`${entry.atUtc}\` gate=${gateId} iteration=${iteration} phase=${phase} passed=${passed} score=${score} reasons=${truncateLine(reasons)}`;
  }
  if (entry.type === 'task_retry') {
    const taskId = String(entry.detail.taskId || '(unknown_task)');
    const attempt = Number(entry.detail.attempt || 0);
    const nextAttempt = Number(entry.detail.nextAttempt || 0);
    const status = String(entry.detail.status || '(unknown_status)');
    const timedOut = entry.detail.timedOut === true ? 'true' : 'false';
    return `- \`${entry.atUtc}\` retry task=${taskId} attempt=${attempt}->${nextAttempt} status=${status} timed_out=${timedOut}`;
  }
  if (entry.type === 'while_exhausted') {
    const whileId = String(entry.detail.whileId || '(unknown_while)');
    const maxIterations = Number(entry.detail.maxIterations || 0);
    const gateId = String(entry.detail.gateId || '(unknown_gate)');
    return `- \`${entry.atUtc}\` while exhausted while_id=${whileId} gate=${gateId} max_iterations=${maxIterations}`;
  }
  if (entry.type === 'termination_guard') {
    const reason = String(entry.detail.reason || '(unknown)');
    return `- \`${entry.atUtc}\` termination guard triggered reason=${reason}`;
  }
  return null;
}

/**
 * Renders and writes the markdown run summary file.
 * @param session Current run session.
 */
export function writeSummary(session: Session): void {
  if (session.dryRun) return;

  const lines: string[] = [];
  lines.push('# Agentflow Run Summary');
  lines.push('');
  lines.push(`- Run ID: \`${session.paths.runId}\``);
  lines.push(`- Updated: \`${session.state.updatedAtUtc || ''}\``);
  lines.push(`- Executed tasks: \`${session.counters.executedTaskCount}\``);
  lines.push(`- Failed tasks: \`${session.counters.failureTaskCount}\``);
  lines.push(`- Loop iterations: \`${session.counters.loopIterationCount}\``);
  lines.push('');
  lines.push('## Groups');
  lines.push('');
  lines.push('| Group | Label | Status | Tasks | Failures |');
  lines.push('|---|---|---|---:|---:|');

  for (const groupKey of Object.keys(session.state.groups).sort()) {
    const row = session.state.groups[groupKey];
    lines.push(`| ${groupKey} | ${row.label} | ${row.status} | ${row.taskCount} | ${row.failureCount} |`);
  }

  lines.push('');
  lines.push('## Tasks');
  lines.push('');
  lines.push('| Task Key | Node | Attempt | Status | Exit | Provider | Model |');
  lines.push('|---|---|---:|---|---:|---|---|');

  for (const taskName of Object.keys(session.state.tasks).sort()) {
    const row = session.state.tasks[taskName];
    lines.push(
      `| ${taskName} | ${row.nodePath} | ${row.attempt} | ${row.status} | ${row.exitCode ?? ''} | ${row.provider || ''} | ${row.model || ''} |`,
    );
  }

  lines.push('');
  lines.push('## Latest Decisions');
  lines.push('');
  const decisionLines = session.decisionTrace
    .map(renderDecisionSummaryLine)
    .filter((line): line is string => line !== null)
    .slice(-10);
  if (decisionLines.length === 0) {
    lines.push('- (none yet)');
  } else {
    lines.push(...decisionLines);
  }

  fs.mkdirSync(path.dirname(session.paths.summaryPath), { recursive: true });
  fs.writeFileSync(session.paths.summaryPath, `${lines.join('\n')}\n`, 'utf8');
}

/**
 * Creates initial run artifacts (run_state, summary).
 * @param session Current run session.
 */
export function initializeSessionArtifacts(session: Session): void {
  if (session.dryRun) return;
  fs.mkdirSync(session.paths.runRoot, { recursive: true });
  saveState(session);
  saveDecisionTrace(session);
  writeSummary(session);
}

/**
 * Marks a group as running in state.
 * @param session Current run session.
 * @param groupIndex Numeric group index.
 * @param taskCount Number of tasks in the group.
 * @param label Human-readable group label.
 */
export function markGroupRunning(
  session: Session,
  groupIndex: number,
  taskCount: number,
  label: string,
): void {
  const groupKey = `group_${String(groupIndex).padStart(2, '0')}`;
  const row: GroupStateRow = session.state.groups[groupKey] || {
    groupIndex,
    taskCount,
    label,
    status: 'PENDING',
    failureCount: 0,
  };
  row.taskCount = taskCount;
  row.label = label;
  row.status = 'RUNNING';
  session.state.groups[groupKey] = row;
  saveState(session);
}

/**
 * Gets the stable task id for state rows across launch variants.
 * @param launch Task or command launch descriptor.
 * @returns Stable task id.
 */
function stateTaskId(launch: ExecutionLaunch): string {
  if ('task' in launch) return launch.task.taskId;
  return launch.taskId;
}

/**
 * Gets provider metadata for state rows across launch variants.
 * @param launch Task or command launch descriptor.
 * @returns Provider id or null for command launches.
 */
function stateProvider(launch: ExecutionLaunch): TaskStateRow['provider'] {
  if ('task' in launch) return launch.provider;
  return null;
}

/**
 * Gets model metadata for state rows across launch variants.
 * @param launch Task or command launch descriptor.
 * @returns Model id or null.
 */
function stateModel(launch: ExecutionLaunch): TaskStateRow['model'] {
  if ('task' in launch) return launch.model;
  return null;
}

/**
 * Gets reasoning metadata for state rows across launch variants.
 * @param launch Task or command launch descriptor.
 * @returns Reasoning effort or null.
 */
function stateReasoningEffort(launch: ExecutionLaunch): TaskStateRow['reasoningEffort'] {
  if ('task' in launch) return launch.reasoningEffort;
  return null;
}

/**
 * Gets profile metadata for state rows across launch variants.
 * @param launch Task or command launch descriptor.
 * @returns Profile or null.
 */
function stateProfile(launch: ExecutionLaunch): TaskStateRow['profile'] {
  if ('task' in launch) return launch.profile;
  return null;
}

/**
 * Marks a launch (task or command) as running in state.
 * @param session Current run session.
 * @param launch Launch descriptor to register.
 */
export function markLaunchRunning(session: Session, launch: ExecutionLaunch): void {
  const row = session.state.tasks[launch.taskKey] || {
    taskKey: launch.taskKey,
    taskId: stateTaskId(launch),
    groupIndex: launch.groupIndex,
    taskIndex: launch.taskIndex,
    nodePath: launch.nodePath,
    attempt: launch.attempt,
    status: 'PENDING',
    provider: stateProvider(launch),
    model: stateModel(launch),
    reasoningEffort: stateReasoningEffort(launch),
    profile: stateProfile(launch),
    promptPath: launch.promptPath,
    logPath: launch.logPath,
    lastMessagePath: launch.lastMessagePath,
    reportPath: launch.reportPath,
    summaryPath: launch.summaryPath,
    cwd: launch.workspaceCwd,
    branch: launch.branch,
  };
  row.status = 'RUNNING';
  row.startedAtUtc = nowUtcIso();
  session.state.tasks[launch.taskKey] = row;
  saveState(session);
}

/**
 * Stores completed task results for a group, updates counters.
 * @param session Current run session.
 * @param groupIndex Numeric group index.
 * @param label Human-readable group label.
 * @param results Ordered array of task execution results.
 */
export function recordGroupResults(
  session: Session,
  groupIndex: number,
  label: string,
  results: TaskExecutionResult[],
): void {
  const groupKey = `group_${String(groupIndex).padStart(2, '0')}`;
  let groupFailureCount = 0;

  for (const result of results) {
    const row = session.state.tasks[result.taskKey];
    row.status = result.status;
    row.exitCode = result.exitCode;
    row.startedAtUtc = result.startedAtUtc;
    row.endedAtUtc = result.endedAtUtc;
    row.durationSec = Number(result.durationSec.toFixed(3));
    row.timedOut = result.timedOut;
    row.timeoutSeconds = result.timeoutSeconds;
    row.timeoutClassification = result.timeoutClassification;
    row.timeoutTerminationOutcome = result.timeoutTerminationOutcome;
    row.failureReason = result.failureReason;

    if (result.attempt === 1) {
      session.counters.executedTaskCount += 1;
    }
    if (result.status !== 'DONE') {
      groupFailureCount += 1;
      session.counters.failureTaskCount += 1;
    }
  }

  const groupRow = session.state.groups[groupKey] || {
    groupIndex,
    label,
    taskCount: results.length,
    status: 'PENDING',
    failureCount: 0,
  };
  groupRow.failureCount = groupFailureCount;
  groupRow.taskCount = results.length;
  groupRow.label = label;
  groupRow.status = groupFailureCount === 0 ? 'DONE' : 'FAILED';
  session.state.groups[groupKey] = groupRow;
  saveState(session);
  writeSummary(session);
}

/**
 * Counts non-DONE task rows in the current run state.
 * @param session Current run session.
 * @returns Number of task rows with a status other than DONE.
 */
export function failureCount(session: Session): number {
  const latestByNode = new Map<string, TaskStateRow>();
  for (const row of Object.values(session.state.tasks)) {
    const current = latestByNode.get(row.nodePath);
    if (!current || row.attempt > current.attempt) {
      latestByNode.set(row.nodePath, row);
    }
  }
  return Array.from(latestByNode.values()).filter((row) => row.status !== 'DONE').length;
}

/**
 * Finalizes the run by writing terminal state and summary.
 * @param session Current run session.
 */
export function finalizeSession(session: Session): void {
  saveState(session);
  saveDecisionTrace(session);
  writeSummary(session);
}

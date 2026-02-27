import fs from 'node:fs';
import path from 'node:path';

import { nowRunId, nowUtcIso } from './utils.ts';
import type {
  DecisionTraceEntry,
  GroupStateRow,
  RunState,
  Session,
  TaskExecutionResult,
  TaskLaunch,
  TaskStateRow,
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
 * Builds the in-memory execution session and initial persisted run state values.
 *
 * @param params Session initialization inputs.
 * @param params.projectRoot Absolute path to the target repository.
 * @param params.planPath Absolute path to the plan JSON file.
 * @param params.plan Normalized worker plan.
 * @param params.globalContextFiles Resolved global context file paths.
 * @returns Fully initialized session object.
 */
export function createSession({
  projectRoot,
  planPath,
  plan,
  globalContextFiles,
  totalTaskCount,
}: {
  projectRoot: string;
  planPath: string;
  plan: WorkerPlan;
  globalContextFiles: string[];
  totalTaskCount: number;
}): Session {
  const runId = plan.options.run_id || nowRunId();
  const runRoot = path.resolve(projectRoot, plan.options.run_root, runId);
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
    dry_run: Boolean(plan.options.dry_run),
    global_context_files: globalContextFiles,
    paths: {
      project_root: projectRoot,
      config_path: planPath,
      run_root: runRoot,
      run_id: runId,
      state_path: path.resolve(runRoot, 'run_state.json'),
      summary_path: path.resolve(runRoot, 'run_summary.md'),
    },
    counters: {
      next_group_index: 1,
      started_at_ms: Date.now(),
      total_task_count: totalTaskCount,
      executed_task_count: 0,
      failure_task_count: 0,
      loop_iteration_count: 0,
    },
    worktree_tracker: {
      created: new Set(),
      created_branches: new Set(),
    },
    state,
    resumed_tasks: new Map(),
    shutdown_signal: null,
    decision_trace: [],
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
  return JSON.parse(raw) as RunState;
}

/**
 * Creates a session that resumes a prior failed run.
 * Completed tasks are loaded from the previous run_state.json and will be
 * skipped during workflow execution.
 *
 * @param params Session initialization inputs.
 * @param params.projectRoot Absolute path to the target repository.
 * @param params.planPath Absolute path to the plan JSON file.
 * @param params.plan Normalized worker plan.
 * @param params.globalContextFiles Resolved global context file paths.
 * @param params.totalTaskCount Total number of task nodes in the workflow.
 * @param params.priorState The RunState loaded from the previous run.
 * @param params.runDir Absolute path to the previous run directory.
 * @returns Session pre-populated with completed task state.
 */
export function createResumedSession({
  projectRoot,
  planPath,
  plan,
  globalContextFiles,
  totalTaskCount,
  priorState,
  runDir,
}: {
  projectRoot: string;
  planPath: string;
  plan: WorkerPlan;
  globalContextFiles: string[];
  totalTaskCount: number;
  priorState: RunState;
  runDir: string;
}): Session {
  const runRoot = path.resolve(runDir);
  const runId = priorState.runId;

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

  return {
    plan,
    dry_run: Boolean(plan.options.dry_run),
    global_context_files: globalContextFiles,
    paths: {
      project_root: projectRoot,
      config_path: planPath,
      run_root: runRoot,
      run_id: runId,
      state_path: path.resolve(runRoot, 'run_state.json'),
      summary_path: path.resolve(runRoot, 'run_summary.md'),
    },
    counters: {
      next_group_index: maxGroupIndex + 1,
      started_at_ms: Date.now(),
      total_task_count: totalTaskCount,
      executed_task_count: doneCount,
      failure_task_count: 0,
      loop_iteration_count: priorState.totalLoopIterations,
    },
    worktree_tracker: {
      created: new Set(),
      created_branches: new Set(),
    },
    state,
    resumed_tasks: resumedTasks,
    shutdown_signal: null,
    decision_trace: [],
  };
}

/**
 * Allocates the next monotonic execution group index for the current run.
 * @param session Current run session.
 * @returns Next sequential group index.
 */
export function allocateGroupIndex(session: Session): number {
  const out = session.counters.next_group_index;
  session.counters.next_group_index += 1;
  return out;
}

/**
 * Persists run state and updates aggregate counters/timestamps.
 * @param session Current run session.
 */
export function saveState(session: Session): void {
  if (session.dry_run) return;
  session.state.updatedAtUtc = nowUtcIso();
  session.state.totalTaskCount = session.counters.executed_task_count;
  session.state.totalFailureCount = session.counters.failure_task_count;
  session.state.totalLoopIterations = session.counters.loop_iteration_count;
  saveJson(session.paths.state_path, session.state);
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
  session.decision_trace.push(entry);
}

/**
 * Renders and writes the markdown run summary file.
 * @param session Current run session.
 */
export function writeSummary(session: Session): void {
  if (session.dry_run) return;

  const lines: string[] = [];
  lines.push('# Agentflow Run Summary');
  lines.push('');
  lines.push(`- Run ID: \`${session.paths.run_id}\``);
  lines.push(`- Updated: \`${session.state.updatedAtUtc || ''}\``);
  lines.push(`- Executed tasks: \`${session.counters.executed_task_count}\``);
  lines.push(`- Failed tasks: \`${session.counters.failure_task_count}\``);
  lines.push(`- Loop iterations: \`${session.counters.loop_iteration_count}\``);
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

  fs.mkdirSync(path.dirname(session.paths.summary_path), { recursive: true });
  fs.writeFileSync(session.paths.summary_path, `${lines.join('\n')}\n`, 'utf8');
}

/**
 * Creates initial run artifacts (run_state, summary).
 * @param session Current run session.
 */
export function initializeSessionArtifacts(session: Session): void {
  if (session.dry_run) return;
  fs.mkdirSync(session.paths.run_root, { recursive: true });
  saveState(session);
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
 * Marks a task launch as running in state.
 * @param session Current run session.
 * @param launch Task launch descriptor to register.
 */
export function markTaskRunning(session: Session, launch: TaskLaunch): void {
  const row = session.state.tasks[launch.task_key] || {
    taskKey: launch.task_key,
    taskId: launch.task.task_id,
    groupIndex: launch.group_index,
    taskIndex: launch.task_index,
    nodePath: launch.node_path,
    attempt: launch.attempt,
    status: 'PENDING',
    provider: launch.provider,
    model: launch.model,
    reasoningEffort: launch.reasoning_effort,
    profile: launch.profile,
    promptPath: launch.prompt_path,
    logPath: launch.log_path,
    lastMessagePath: launch.last_message_path,
    reportPath: launch.report_path,
    summaryPath: launch.summary_path,
    cwd: launch.workspace_cwd,
    branch: launch.branch,
  };
  row.status = 'RUNNING';
  row.startedAtUtc = nowUtcIso();
  session.state.tasks[launch.task_key] = row;
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
    const row = session.state.tasks[result.task_key];
    row.status = result.status;
    row.exitCode = result.exit_code;
    row.startedAtUtc = result.started_at_utc;
    row.endedAtUtc = result.ended_at_utc;
    row.durationSec = Number(result.duration_sec.toFixed(3));
    row.timedOut = result.timed_out;
    row.timeoutSeconds = result.timeout_seconds;
    row.timeoutClassification = result.timeout_classification;
    row.timeoutTerminationOutcome = result.timeout_termination_outcome;
    row.failureReason = result.failure_reason;

    session.counters.executed_task_count += 1;
    if (result.status !== 'DONE') {
      groupFailureCount += 1;
      session.counters.failure_task_count += 1;
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
  return Object.values(session.state.tasks).filter((row) => row.status !== 'DONE').length;
}

/**
 * Finalizes the run by writing terminal state and summary.
 * @param session Current run session.
 * @param _status Terminal run status string (reserved for future use).
 */
export function finalizeSession(session: Session, _status: string): void {
  saveState(session);
  writeSummary(session);
}

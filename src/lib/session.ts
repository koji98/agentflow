import fs from 'node:fs';
import path from 'node:path';

import { appendRawThoughts, nowRunId, nowUtcIso } from './utils.ts';
import type {
  DecisionTraceEntry,
  GroupStateRow,
  RunState,
  Session,
  TaskExecutionResult,
  TaskLaunch,
  WorkerPlan,
} from './types.ts';

/** Writes JSON helper with mkdir safety. */
function saveJson(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

/** Appends one jsonl event line. */
function appendJsonLine(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

/** Builds initial session state for workflow execution. */
export function createSession({
  projectRoot,
  planPath,
  plan,
  planDocPath,
  globalContextFiles,
}: {
  projectRoot: string;
  planPath: string;
  plan: WorkerPlan;
  planDocPath: string | null;
  globalContextFiles: string[];
}): Session {
  const runId = plan.runtime.run_id || nowRunId();
  const runRoot = path.resolve(projectRoot, plan.runtime.run_root, runId);
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
    eventsFile: 'run_events.jsonl',
    rawThoughtsPath: path.resolve(runRoot, 'raw_thoughts.md'),
    decisionTraceFile: 'decision_trace.json',
  };

  return {
    project_root: projectRoot,
    config_path: planPath,
    plan,
    run_root: runRoot,
    run_id: runId,
    dry_run: Boolean(plan.runtime.dry_run),
    plan_doc_path: planDocPath,
    global_context_files: globalContextFiles,
    state,
    state_path: path.resolve(runRoot, 'run_state.json'),
    events_path: path.resolve(runRoot, 'run_events.jsonl'),
    summary_path: path.resolve(runRoot, 'run_summary.md'),
    decision_trace_path: path.resolve(runRoot, 'decision_trace.json'),
    created_worktrees: new Set(),
    created_worktree_branches: new Set(),
    shutdown_signal: null,
    next_group_index: 1,
    started_at_ms: Date.now(),
    executed_task_count: 0,
    failure_task_count: 0,
    loop_iteration_count: 0,
    decision_trace: [],
  };
}

/** Allocates a new monotonic group index. */
export function allocateGroupIndex(session: Session): number {
  const out = session.next_group_index;
  session.next_group_index += 1;
  return out;
}

/** Saves run state with refreshed timestamp. */
export function saveState(session: Session): void {
  if (session.dry_run) return;
  session.state.updatedAtUtc = nowUtcIso();
  session.state.totalTaskCount = session.executed_task_count;
  session.state.totalFailureCount = session.failure_task_count;
  session.state.totalLoopIterations = session.loop_iteration_count;
  saveJson(session.state_path, session.state);
}

/** Appends run event line. */
export function appendEvent(session: Session, event: Record<string, unknown>): void {
  if (session.dry_run) return;
  appendJsonLine(session.events_path, { atUtc: nowUtcIso(), ...event });
}

/** Writes decision trace snapshot file. */
function writeDecisionTrace(session: Session): void {
  if (session.dry_run) return;
  saveJson(session.decision_trace_path, {
    runId: session.run_id,
    updatedAtUtc: nowUtcIso(),
    entries: session.decision_trace,
  });
}

/** Adds one decision trace entry and mirrors it to events stream. */
export function recordDecision(
  session: Session,
  type: DecisionTraceEntry['type'],
  nodePath: string,
  detail: Record<string, unknown>,
): void {
  const entry: DecisionTraceEntry = { atUtc: nowUtcIso(), type, nodePath, detail };
  session.decision_trace.push(entry);
  appendEvent(session, { type: 'decision', decisionType: type, nodePath, detail });
  writeDecisionTrace(session);
}

/** Writes markdown summary table. */
export function writeSummary(session: Session): void {
  if (session.dry_run) return;

  const lines: string[] = [];
  lines.push('# Agentflow Run Summary');
  lines.push('');
  lines.push(`- Run ID: \`${session.run_id}\``);
  lines.push(`- Updated: \`${session.state.updatedAtUtc || ''}\``);
  lines.push(`- Executed tasks: \`${session.executed_task_count}\``);
  lines.push(`- Failed tasks: \`${session.failure_task_count}\``);
  lines.push(`- Loop iterations: \`${session.loop_iteration_count}\``);
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
  lines.push('| Task Key | Node | Attempt | Status | Exit | Provider | Model | Report |');
  lines.push('|---|---|---:|---|---:|---|---|---|');

  for (const taskName of Object.keys(session.state.tasks).sort()) {
    const row = session.state.tasks[taskName];
    lines.push(
      `| ${taskName} | ${row.nodePath} | ${row.attempt} | ${row.status} | ${row.exitCode ?? ''} | ${row.provider || ''} | ${row.model || ''} | \`${row.reportJsonPath || ''}\` |`,
    );
  }

  fs.mkdirSync(path.dirname(session.summary_path), { recursive: true });
  fs.writeFileSync(session.summary_path, `${lines.join('\n')}\n`, 'utf8');
}

/** Initializes run root artifacts for non-dry runs. */
export function initializeSessionArtifacts(session: Session): void {
  if (session.dry_run) return;
  fs.mkdirSync(session.run_root, { recursive: true });
  saveState(session);
  appendEvent(session, { type: 'run_started', runId: session.run_id });
  writeDecisionTrace(session);
  writeSummary(session);
}

/** Marks group start in state+events. */
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
  appendEvent(session, {
    type: 'group_started',
    groupIndex,
    label,
    taskCount,
  });
}

/** Marks task start in state+events. */
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
    reportJsonPath: launch.report_json_path,
    cwd: launch.workspace_cwd,
    branch: launch.branch,
  };
  row.status = 'RUNNING';
  row.startedAtUtc = nowUtcIso();
  session.state.tasks[launch.task_key] = row;
  saveState(session);
  appendEvent(session, {
    type: 'task_started',
    taskKey: launch.task_key,
    taskId: launch.task.task_id,
    nodePath: launch.node_path,
    groupIndex: launch.group_index,
    taskIndex: launch.task_index,
    attempt: launch.attempt,
  });
}

/** Records ordered results for one group. */
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
    row.declaredStatus = result.declared_status;
    row.statusParseError = result.status_parse_error;
    row.completionContractErrors = result.completion_contract_errors;
    row.completionContractSatisfied = result.completion_contract_satisfied;

    session.executed_task_count += 1;
    if (result.status !== 'DONE') {
      groupFailureCount += 1;
      session.failure_task_count += 1;
    }

    appendEvent(session, {
      type: 'task_completed',
      taskKey: result.task_key,
      taskId: result.task_id,
      nodePath: result.node_path,
      groupIndex: result.group_index,
      taskIndex: result.task_index,
      attempt: result.attempt,
      status: result.status,
      exitCode: result.exit_code,
      timedOut: result.timed_out,
      timeoutClassification: result.timeout_classification,
      reportJsonPath: result.report_json_path,
    });
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

  appendEvent(session, {
    type: 'group_completed',
    groupIndex,
    label,
    status: groupRow.status,
    failureCount: groupFailureCount,
  });
}

/** Returns current count of failed tasks. */
export function failureCount(session: Session): number {
  return Object.values(session.state.tasks).filter((row) => row.status !== 'DONE').length;
}

/** Finalizes run and writes final state+summary. */
export function finalizeSession(session: Session, status: string): void {
  appendEvent(session, { type: 'run_completed', status, failureCount: failureCount(session) });
  saveState(session);
  writeDecisionTrace(session);
  writeSummary(session);
}

/** Appends a raw thoughts note for operational visibility. */
export function noteRawThoughts(session: Session, text: string): void {
  appendRawThoughts(path.resolve(session.run_root, 'raw_thoughts.md'), text);
}

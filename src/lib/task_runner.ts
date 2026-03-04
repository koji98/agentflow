import fs from 'node:fs';
import path from 'node:path';

import { evaluateContract } from './contracts.ts';
import { evaluateGate } from './gates.ts';
import { buildLaunchFromCommandNode, buildLaunchFromTaskNode } from './launch_builder.ts';
import { log } from './log.ts';
import { buildProviderCommand } from './providers.ts';
import { runCommand } from './process_runner.ts';
import {
  allocateGroupIndex,
  markGroupRunning,
  markLaunchRunning,
  recordDecision,
  recordGroupResults,
  saveState,
} from './session.ts';
import type {
  CommandLaunch,
  CommandNode,
  ContractResult,
  EvaluatorOutput,
  GroupNode,
  Session,
  TaskExecutionResult,
  TaskLaunch,
  TaskNode,
  WhileNode,
  WorkflowNode,
} from './types.ts';
import {
  captureSuccessfulWorktreeSnapshot,
  prepareCommandLaunch,
  prepareLaunches,
} from './worktrees.ts';

/**
 * Copies worker-generated artifacts into canonical run artifact paths when they differ.
 * @param session Current run session.
 * @param launch Task launch descriptor containing worker/canonical artifact paths.
 */
function syncWorkerArtifacts(session: Session, launch: TaskLaunch): void {
  if (session.dryRun) return;

  const artifacts = [
    { workerPath: launch.workerReportPath, canonicalPath: launch.reportPath },
    { workerPath: launch.workerSummaryPath, canonicalPath: launch.summaryPath },
  ];

  for (const { workerPath, canonicalPath } of artifacts) {
    if (workerPath === canonicalPath) continue;
    if (!fs.existsSync(workerPath)) continue;
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    fs.copyFileSync(workerPath, canonicalPath);
    try {
      fs.unlinkSync(workerPath);
    } catch {
      // Best-effort cleanup: canonical artifact already persisted.
    }
  }
}

/**
 * Validates global termination guards before launching more work.
 * @param session Current run session.
 * @param nodePath Workflow node path for decision trace.
 * @throws {Error} When any termination limit is exceeded.
 */
function assertTerminationGuards(session: Session, nodePath: string): void {
  const limits = session.plan.limits;
  const elapsedSec = (Date.now() - session.counters.startedAtMs) / 1000;

  if (session.shutdownSignal) {
    recordDecision(session, 'termination_guard', nodePath, {
      reason: 'shutdown_signal',
      signal: session.shutdownSignal,
    });
    throw new Error(`Termination requested by signal: ${session.shutdownSignal}.`);
  }
  if (limits.maxRuntimeSec !== null && elapsedSec > limits.maxRuntimeSec) {
    recordDecision(session, 'termination_guard', nodePath, {
      reason: 'max_runtime_sec',
      elapsedSec: Number(elapsedSec.toFixed(3)),
      maxRuntimeSec: limits.maxRuntimeSec,
    });
    throw new Error(`Termination guard exceeded: max_runtime_sec (${limits.maxRuntimeSec}).`);
  }
  if (limits.maxTotalTasks !== null && session.counters.executedTaskCount >= limits.maxTotalTasks) {
    recordDecision(session, 'termination_guard', nodePath, {
      reason: 'max_total_tasks',
      executedTaskCount: session.counters.executedTaskCount,
      maxTotalTasks: limits.maxTotalTasks,
    });
    throw new Error(`Termination guard exceeded: max_total_tasks (${limits.maxTotalTasks}).`);
  }
  if (limits.maxFailures !== null && session.counters.failureTaskCount > limits.maxFailures) {
    recordDecision(session, 'termination_guard', nodePath, {
      reason: 'max_failures',
      failureTaskCount: session.counters.failureTaskCount,
      maxFailures: limits.maxFailures,
    });
    throw new Error(`Termination guard exceeded: max_failures (${limits.maxFailures}).`);
  }
}

/** Formats a `[current/total]` progress prefix for log output. Retries show as `[current/total retry #N]`. */
function progressTag(session: Session, attempt: number): string {
  const current = session.counters.executedTaskCount + 1;
  const total = session.counters.totalTaskCount;
  const suffix = attempt > 1 ? ` retry #${attempt - 1}` : '';
  return `[${current}/${total}${suffix}]`;
}

/** Renders one shell-safe token for logging/markdown artifacts. */
function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

/** Renders a command line for logs/artifacts. */
function formatCommandLine(command: string, args: string[]): string {
  return [command, ...args].map(quoteShellArg).join(' ');
}

/** Chooses failure reason label for a command execution result. */
function commandFailureReason(
  exitCode: number,
  timedOut: boolean,
  timeoutTerminationOutcome: string | null,
): string | null {
  if (timedOut) return 'timed_out';
  if (timeoutTerminationOutcome === 'spawn_error') return 'spawn_error';
  if (exitCode !== 0) return 'nonzero_exit';
  return null;
}

/** Writes static command-request metadata before execution. */
function writeCommandRequestArtifact(launch: CommandLaunch): void {
  const lines: string[] = [];
  lines.push('# Command Node Request');
  lines.push('');
  lines.push(`- Node ID: \`${launch.taskId}\``);
  lines.push(`- Attempt: \`${launch.attempt}\``);
  lines.push(`- Repo Root: \`${launch.repoRoot}\``);
  lines.push(`- CWD: \`${launch.workspaceCwd}\``);
  lines.push(`- Timeout Seconds: \`${launch.timeoutSeconds ?? 'plan_default'}\``);
  lines.push(`- allow_failure: \`${launch.allowFailure}\``);
  lines.push('');
  lines.push('## Command');
  lines.push('');
  lines.push('```bash');
  lines.push(formatCommandLine(launch.command, launch.args));
  lines.push('```');
  lines.push('');
  lines.push('## Prior Summaries');
  lines.push('');
  if (launch.priorTaskSummaries.length === 0) {
    lines.push('- (none)');
  } else {
    for (const summary of launch.priorTaskSummaries) {
      lines.push(`### ${summary.taskId} (${summary.status})`);
      lines.push('');
      lines.push(summary.summary || '(empty)');
      lines.push('');
    }
  }
  fs.mkdirSync(path.dirname(launch.promptPath), { recursive: true });
  fs.writeFileSync(launch.promptPath, `${lines.join('\n')}\n`, 'utf8');
}

/** Writes command node report + summary + JSON result artifacts. */
function writeCommandResultArtifacts(
  launch: CommandLaunch,
  result: TaskExecutionResult,
): void {
  const commandLine = formatCommandLine(launch.command, launch.args);
  const jsonResult = {
    task_id: result.taskId,
    node_path: result.nodePath,
    attempt: result.attempt,
    status: result.status,
    exit_code: result.exitCode,
    timed_out: result.timedOut,
    timeout_seconds: result.timeoutSeconds,
    timeout_classification: result.timeoutClassification,
    timeout_termination_outcome: result.timeoutTerminationOutcome,
    failure_reason: result.failureReason,
    started_at_utc: result.startedAtUtc,
    ended_at_utc: result.endedAtUtc,
    duration_sec: Number(result.durationSec.toFixed(3)),
  };

  const summaryLines: string[] = [];
  summaryLines.push(
    `Command \`${launch.taskId}\` finished with status \`${result.status}\` (exit=${result.exitCode}, timed_out=${result.timedOut}, duration_sec=${Number(result.durationSec.toFixed(3))}).`,
  );
  summaryLines.push(`Command: \`${commandLine}\``);
  summaryLines.push(`cwd: \`${launch.workspaceCwd}\``);
  if (result.failureReason) summaryLines.push(`failure_reason: \`${result.failureReason}\``);

  const reportLines: string[] = [];
  reportLines.push(`# Command Node Report: ${launch.taskId}`);
  reportLines.push('');
  reportLines.push('## Result');
  reportLines.push('');
  reportLines.push(`- status: \`${result.status}\``);
  reportLines.push(`- exit_code: \`${result.exitCode}\``);
  reportLines.push(`- timed_out: \`${result.timedOut}\``);
  reportLines.push(`- timeout_seconds: \`${result.timeoutSeconds ?? ''}\``);
  reportLines.push(`- timeout_classification: \`${result.timeoutClassification ?? ''}\``);
  reportLines.push(`- timeout_termination_outcome: \`${result.timeoutTerminationOutcome ?? ''}\``);
  reportLines.push(`- failure_reason: \`${result.failureReason ?? ''}\``);
  reportLines.push(`- started_at_utc: \`${result.startedAtUtc}\``);
  reportLines.push(`- ended_at_utc: \`${result.endedAtUtc}\``);
  reportLines.push(`- duration_sec: \`${Number(result.durationSec.toFixed(3))}\``);
  reportLines.push('');
  reportLines.push('## Command');
  reportLines.push('');
  reportLines.push('```bash');
  reportLines.push(commandLine);
  reportLines.push('```');
  reportLines.push('');
  reportLines.push('## Execution Metadata');
  reportLines.push('');
  reportLines.push(`- repo_root: \`${launch.repoRoot}\``);
  reportLines.push(`- cwd: \`${launch.workspaceCwd}\``);
  reportLines.push(`- allow_failure: \`${launch.allowFailure}\``);
  reportLines.push(`- exec_log: \`${launch.logPath}\``);
  reportLines.push(`- stdout_capture: \`${launch.lastMessagePath}\``);
  reportLines.push('');
  reportLines.push('## Prior Summaries');
  reportLines.push('');
  if (launch.priorTaskSummaries.length === 0) {
    reportLines.push('- (none)');
  } else {
    for (const summary of launch.priorTaskSummaries) {
      reportLines.push(`### ${summary.taskId} (${summary.status})`);
      reportLines.push('');
      reportLines.push(summary.summary || '(empty)');
      reportLines.push('');
    }
  }

  fs.mkdirSync(path.dirname(launch.resultPath), { recursive: true });
  fs.writeFileSync(launch.resultPath, `${JSON.stringify(jsonResult, null, 2)}\n`, 'utf8');
  fs.writeFileSync(launch.summaryPath, `${summaryLines.join('\n')}\n`, 'utf8');
  fs.writeFileSync(launch.reportPath, `${reportLines.join('\n')}\n`, 'utf8');
}

/**
 * Executes one launch command and produces normalized task result artifacts.
 * Spawns the provider CLI, captures output, evaluates the completion contract,
 * and writes execution logs, report, and summary files.
 *
 * @param session Current run session.
 * @param launch Task launch descriptor with command, paths, and timeout config.
 * @returns Promise resolving to the task execution result.
 */
export async function executeLaunch(
  session: Session,
  launch: TaskLaunch,
): Promise<TaskExecutionResult> {
  const cmd = buildProviderCommand({
    provider: launch.provider,
    model: launch.model,
    reasoningEffort: launch.reasoningEffort,
    profile: launch.profile,
    promptText: launch.promptText,
    workspaceCwd: launch.workspaceCwd,
    lastMessagePath: launch.lastMessagePath,
    skipGitRepoCheck: launch.skipGitRepoCheck,
    sandboxMode: launch.sandboxMode,
  });

  const tag = progressTag(session, launch.attempt);
  log(
    `${tag} [group ${String(launch.groupIndex).padStart(2, '0')}] task=${launch.task.taskId} provider=${launch.provider} cwd=${launch.workspaceCwd}`,
  );

  const startedAtUtc = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const started = Date.now();

  const isCursor = launch.provider === 'cursor';
  const runResult = await runCommand({
    cmd,
    cwd: launch.workspaceCwd,
    stdinText: launch.promptText,
    logPath: launch.logPath,
    dryRun: session.dryRun,
    timeoutSeconds:
      session.plan.limits.workerTimeoutSec > 0 ? session.plan.limits.workerTimeoutSec : null,
    timeoutGraceSeconds: Math.max(1, session.plan.limits.timeoutGraceSec),
    useStdin: !isCursor,
    stdoutCapturePath: isCursor ? launch.lastMessagePath : null,
  });

  syncWorkerArtifacts(session, launch);

  const reportExists =
    fs.existsSync(launch.reportPath) ||
    (launch.workerReportPath !== launch.reportPath && fs.existsSync(launch.workerReportPath));

  const contract: ContractResult = session.dryRun
    ? { status: 'DONE', reason: null }
    : evaluateContract({
        exitCode: runResult.exitCode,
        timedOut: runResult.timedOut,
        reportExists,
      });

  const result: TaskExecutionResult = {
    groupIndex: launch.groupIndex,
    taskIndex: launch.taskIndex,
    taskKey: launch.taskKey,
    taskId: launch.task.taskId,
    nodePath: launch.nodePath,
    attempt: launch.attempt,
    status: contract.status,
    exitCode: runResult.exitCode,
    startedAtUtc,
    endedAtUtc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    durationSec: Math.max(0, (Date.now() - started) / 1000),
    timedOut: runResult.timedOut,
    timeoutSeconds: runResult.timeoutSeconds,
    timeoutClassification: runResult.timeoutClassification,
    timeoutTerminationOutcome: runResult.timeoutTerminationOutcome,
    failureReason: contract.reason,
  };
  captureSuccessfulWorktreeSnapshot(
    session,
    launch,
    result.status,
    `${launch.task.taskId}#a${launch.attempt}`,
  );

  if (result.timedOut) {
    log(
      `${tag}   -> task ${result.taskId} timed out classification=${result.timeoutClassification} (log: ${launch.logPath})`,
    );
  } else if (result.exitCode === 0 && result.status === 'DONE') {
    log(`${tag}   -> task ${result.taskId} done (log: ${launch.logPath})`);
  } else {
    log(
      `${tag}   -> task ${result.taskId} status=${result.status} exit=${result.exitCode} (log: ${launch.logPath})`,
    );
  }

  return result;
}

/**
 * Executes one command node launch and produces normalized result artifacts.
 *
 * @param session Current run session.
 * @param launch Command launch descriptor with argv/cwd/timeout + artifact paths.
 * @returns Promise resolving to the command execution result.
 */
async function executeCommandLaunch(
  session: Session,
  launch: CommandLaunch,
): Promise<TaskExecutionResult> {
  const cmd = [launch.command, ...launch.args];
  const timeoutSeconds = launch.timeoutSeconds ?? (
    session.plan.limits.workerTimeoutSec > 0 ? session.plan.limits.workerTimeoutSec : null
  );
  const tag = progressTag(session, launch.attempt);
  log(
    `${tag} [group ${String(launch.groupIndex).padStart(2, '0')}] command=${launch.taskId} cwd=${launch.workspaceCwd}`,
  );

  if (!session.dryRun) {
    writeCommandRequestArtifact(launch);
  }

  const startedAtUtc = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const started = Date.now();
  const runResult = await runCommand({
    cmd,
    cwd: launch.workspaceCwd,
    stdinText: '',
    logPath: launch.logPath,
    dryRun: session.dryRun,
    timeoutSeconds,
    timeoutGraceSeconds: Math.max(1, session.plan.limits.timeoutGraceSec),
    useStdin: false,
    stdoutCapturePath: launch.lastMessagePath,
    teeOutput: true,
  });
  const failureReason = commandFailureReason(
    runResult.exitCode,
    runResult.timedOut,
    runResult.timeoutTerminationOutcome,
  );
  const status = failureReason ? 'FAILED' : 'DONE';
  const result: TaskExecutionResult = {
    groupIndex: launch.groupIndex,
    taskIndex: launch.taskIndex,
    taskKey: launch.taskKey,
    taskId: launch.taskId,
    nodePath: launch.nodePath,
    attempt: launch.attempt,
    status,
    exitCode: runResult.exitCode,
    startedAtUtc,
    endedAtUtc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    durationSec: Math.max(0, (Date.now() - started) / 1000),
    timedOut: runResult.timedOut,
    timeoutSeconds: runResult.timeoutSeconds,
    timeoutClassification: runResult.timeoutClassification,
    timeoutTerminationOutcome: runResult.timeoutTerminationOutcome,
    failureReason,
  };
  captureSuccessfulWorktreeSnapshot(
    session,
    launch,
    result.status,
    `${launch.taskId}#a${launch.attempt}`,
  );

  if (!session.dryRun) {
    writeCommandResultArtifacts(launch, result);
  }

  if (result.timedOut) {
    log(
      `${tag}   -> command ${result.taskId} timed out classification=${result.timeoutClassification} (log: ${launch.logPath})`,
    );
  } else if (result.exitCode === 0 && result.status === 'DONE') {
    log(`${tag}   -> command ${result.taskId} done (log: ${launch.logPath})`);
  } else {
    log(
      `${tag}   -> command ${result.taskId} status=${result.status} exit=${result.exitCode} (log: ${launch.logPath})`,
    );
  }
  return result;
}

/**
 * Executes a group batch, persists results, and returns ordered results.
 * @param session Current run session.
 * @param launches Array of task launch descriptors.
 * @param label Human-readable label for the batch group.
 * @returns Promise resolving to ordered task execution results.
 */
async function runLaunchBatch(
  session: Session,
  launches: TaskLaunch[],
  label: string,
): Promise<TaskExecutionResult[]> {
  if (launches.length === 0) return [];
  const groupIndex = launches[0].groupIndex;
  markGroupRunning(session, groupIndex, launches.length, label);
  prepareLaunches(session, launches);
  launches.forEach((launch) => markLaunchRunning(session, launch));

  const rawResults =
    launches.length === 1
      ? [await executeLaunch(session, launches[0])]
      : await Promise.all(launches.map((launch) => executeLaunch(session, launch)));
  const ordered = [...rawResults].sort((a, b) => a.taskIndex - b.taskIndex);
  recordGroupResults(session, groupIndex, label, ordered);
  return ordered;
}

/**
 * Executes one command launch, persists result, and returns the normalized row.
 * @param session Current run session.
 * @param launch Command launch descriptor.
 * @param label Human-readable label for the execution group.
 * @returns Promise resolving to a single command execution result.
 */
async function runCommandBatch(
  session: Session,
  launch: CommandLaunch,
  label: string,
): Promise<TaskExecutionResult> {
  markGroupRunning(session, launch.groupIndex, 1, label);
  prepareCommandLaunch(session, launch);
  markLaunchRunning(session, launch);
  const result = await executeCommandLaunch(session, launch);
  recordGroupResults(session, launch.groupIndex, label, [result]);
  return result;
}

/**
 * Determines whether a completed attempt qualifies for retry.
 * @param result Completed task execution result.
 * @param limits Plan limits configuration with retry policy.
 * @returns `true` when the result matches a configured retry condition.
 */
function shouldRetry(result: TaskExecutionResult, limits: Session['plan']['limits']): boolean {
  const retrySet = new Set(limits.retryOn);
  if (result.timedOut && retrySet.has('TIMEOUT')) return true;
  if (result.status === 'FAILED' && retrySet.has('FAILED')) return true;
  return false;
}

/**
 * Merges gate feedback lines while preserving order and removing duplicates.
 * @param existing Existing feedback lines already in scope.
 * @param incoming New feedback lines to append.
 * @returns Deduplicated feedback lines.
 */
function mergeGateFeedback(existing: string[], incoming: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of [...existing, ...incoming]) {
    const normalized = String(line || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/**
 * Produces concise feedback lines from a failed gate evaluation for task prompt injection.
 * @param gateId Gate identifier.
 * @param iteration Current loop iteration.
 * @param phase Gate phase where evaluation happened.
 * @param evaluation Gate evaluation output.
 * @returns Prompt-ready feedback lines.
 */
function summarizeFailedGateEvaluation(
  gateId: string,
  iteration: number,
  phase: 'pre_body' | 'post_body',
  evaluation: EvaluatorOutput,
): string[] {
  const headline = `Gate ${gateId} failed (iteration=${iteration}, phase=${phase}, score=${evaluation.score ?? 'null'}).`;
  const reasons = evaluation.reasons.length > 0
    ? evaluation.reasons.map((reason) => `Reason: ${reason}`)
    : ['Reason: (gate returned no explicit reasons)'];
  return [headline, ...reasons];
}

/**
 * Executes one task node, applying retry policy when configured.
 * @param session Current run session.
 * @param node Task workflow node.
 * @param nodePath Workflow node path for tracing.
 * @param gateFeedbackToAddress Optional gate feedback to include in the task prompt.
 */
async function executeTaskNode(
  session: Session,
  node: TaskNode,
  nodePath: string,
  gateFeedbackToAddress: string[] = [],
): Promise<void> {
  const resumed = session.resumedTasks.get(nodePath);
  if (resumed && resumed.status === 'DONE') {
    log(`[skip] task ${node.taskId} already completed (resumed)`);
    return;
  }

  const maxAttempts = 1 + Math.max(0, session.plan.limits.maxRetries);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    assertTerminationGuards(session, nodePath);
    const groupIndex = allocateGroupIndex(session);
    const launch = buildLaunchFromTaskNode({
      session,
      node,
      nodePath,
      attempt,
      groupIndex,
      taskIndex: 1,
      gateFeedbackToAddress,
    });
    const [result] = await runLaunchBatch(
      session,
      [launch],
      `${nodePath}#attempt_${attempt}`,
    );

    if (result.status === 'DONE') return;
    const canRetry = attempt < maxAttempts && shouldRetry(result, session.plan.limits);
    if (canRetry) {
      recordDecision(session, 'task_retry', nodePath, {
        taskId: node.taskId,
        attempt,
        nextAttempt: attempt + 1,
        status: result.status,
        timedOut: result.timedOut,
      });
      continue;
    }
    if (session.plan.onFailure === 'continue') {
      return;
    }
    throw new Error(
      `Task ${node.taskId} failed after ${attempt} attempt(s): ${result.status} (exit=${result.exitCode}).`,
    );
  }
}

/**
 * Executes one command node, applying retry policy and allow_failure semantics.
 * @param session Current run session.
 * @param node Command workflow node.
 * @param nodePath Workflow node path for tracing.
 */
async function executeCommandNode(
  session: Session,
  node: CommandNode,
  nodePath: string,
): Promise<void> {
  const resumed = session.resumedTasks.get(nodePath);
  if (resumed && resumed.status === 'DONE') {
    log(`[skip] command ${node.id} already completed (resumed)`);
    return;
  }

  const maxAttempts = 1 + Math.max(0, session.plan.limits.maxRetries);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    assertTerminationGuards(session, nodePath);
    const groupIndex = allocateGroupIndex(session);
    const launch = buildLaunchFromCommandNode({
      session,
      node,
      nodePath,
      attempt,
      groupIndex,
      taskIndex: 1,
    });
    const result = await runCommandBatch(
      session,
      launch,
      `${nodePath}#attempt_${attempt}`,
    );

    if (result.status === 'DONE') return;
    const canRetry = attempt < maxAttempts && shouldRetry(result, session.plan.limits);
    if (canRetry) {
      recordDecision(session, 'task_retry', nodePath, {
        taskId: node.id,
        attempt,
        nextAttempt: attempt + 1,
        status: result.status,
        timedOut: result.timedOut,
      });
      continue;
    }

    if (node.allowFailure) {
      log(`[allow_failure] command ${node.id} failed but execution will continue`);
      return;
    }
    if (session.plan.onFailure === 'continue') {
      return;
    }
    throw new Error(
      `Command ${node.id} failed after ${attempt} attempt(s): ${result.status} (exit=${result.exitCode}).`,
    );
  }
}

/**
 * Executes a group node sequentially or in concurrent chunked batches.
 * @param session Current run session.
 * @param node Group workflow node.
 * @param nodePath Workflow node path for tracing.
 * @param gateFeedbackToAddress Optional gate feedback propagated to child tasks.
 */
async function executeGroupNode(
  session: Session,
  node: GroupNode,
  nodePath: string,
  gateFeedbackToAddress: string[] = [],
): Promise<void> {
  if (!node.parallel) {
    for (let i = 0; i < node.steps.length; i += 1) {
      await executeWorkflowNode(session, node.steps[i], `${nodePath}/step_${i + 1}`, gateFeedbackToAddress);
    }
    return;
  }

  const maxParallel = session.plan.limits.maxParallelTasks || node.steps.length;
  for (let i = 0; i < node.steps.length; i += maxParallel) {
    const chunk = node.steps.slice(i, i + maxParallel);
    const settled = await Promise.allSettled(
      chunk.map((child, idx) =>
        executeWorkflowNode(session, child, `${nodePath}/step_${i + idx + 1}`, gateFeedbackToAddress),
      ),
    );
    const rejected = settled
      .filter((entry) => entry.status === 'rejected')
      .map((entry) => (entry.status === 'rejected' ? entry.reason : null))
      .filter(Boolean);
    if (rejected.length > 0) {
      const first = rejected[0];
      const head = first instanceof Error ? `${first.name}: ${first.message}` : String(first);
      throw new Error(
        `Group ${node.id} (parallel=true) failed (${rejected.length} rejection${rejected.length === 1 ? '' : 's'}). First error: ${head}`,
      );
    }
  }
}

/**
 * Executes a while node until its evaluator gate passes or iteration limits are exhausted.
 * @param session Current run session.
 * @param node While workflow node with gate and body.
 * @param nodePath Workflow node path for tracing.
 * @param inheritedGateFeedback Optional gate feedback propagated from an outer loop.
 * @throws {Error} When loop exhausts max_iterations without gate satisfaction.
 */
async function executeWhileNode(
  session: Session,
  node: WhileNode,
  nodePath: string,
  inheritedGateFeedback: string[] = [],
): Promise<void> {
  const globalCap = session.plan.limits.maxIterations;
  const localCap = node.maxIterations || globalCap || 1;
  let carryForwardGateFeedback: string[] = [];

  for (let iteration = 1; iteration <= localCap; iteration += 1) {
    if (globalCap !== null && session.counters.loopIterationCount >= globalCap) {
      recordDecision(session, 'termination_guard', nodePath, {
        reason: 'max_iterations',
        globalCap,
        loopIterationCount: session.counters.loopIterationCount,
      });
      throw new Error(`Global max_iterations reached (${globalCap}).`);
    }
    session.counters.loopIterationCount += 1;
    saveState(session);
    recordDecision(session, 'while_iteration_started', nodePath, {
      whileId: node.id,
      iteration,
    });

    const preEval = evaluateGate(session, node.until, nodePath, iteration, 'pre_body');
    recordDecision(session, 'while_gate_evaluation', nodePath, {
      whileId: node.id,
      gateId: node.until.id,
      iteration,
      phase: 'pre_body',
      passed: preEval.passed,
      score: preEval.score,
      reasons: preEval.reasons,
    });
    if (preEval.passed) {
      recordDecision(session, 'while_satisfied', nodePath, {
        whileId: node.id,
        gateId: node.until.id,
        iteration,
        phase: 'pre_body',
      });
      return;
    }

    const preFailureFeedback = summarizeFailedGateEvaluation(
      node.until.id,
      iteration,
      'pre_body',
      preEval,
    );
    const loopGateFeedback = carryForwardGateFeedback.length > 0
      ? carryForwardGateFeedback
      : preFailureFeedback;
    const feedbackForLoopBody = mergeGateFeedback(inheritedGateFeedback, loopGateFeedback);

    for (let i = 0; i < node.body.length; i += 1) {
      await executeWorkflowNode(
        session,
        node.body[i],
        `${nodePath}/iter_${iteration}/body_${i + 1}`,
        feedbackForLoopBody,
      );
    }

    const postEval = evaluateGate(session, node.until, nodePath, iteration, 'post_body');
    recordDecision(session, 'while_gate_evaluation', nodePath, {
      whileId: node.id,
      gateId: node.until.id,
      iteration,
      phase: 'post_body',
      passed: postEval.passed,
      score: postEval.score,
      reasons: postEval.reasons,
    });
    if (postEval.passed) {
      recordDecision(session, 'while_satisfied', nodePath, {
        whileId: node.id,
        gateId: node.until.id,
        iteration,
        phase: 'post_body',
      });
      return;
    }

    carryForwardGateFeedback = summarizeFailedGateEvaluation(
      node.until.id,
      iteration,
      'post_body',
      postEval,
    );
  }

  recordDecision(session, 'while_exhausted', nodePath, {
    whileId: node.id,
    maxIterations: localCap,
    gateId: node.until.id,
  });
  throw new Error(`While node ${node.id} exhausted max_iterations=${localCap} without satisfying gate.`);
}

/**
 * Executes one workflow node by dispatching to task/command/group/while handlers.
 * @param session Current run session.
 * @param node Workflow node to execute (task, group, or while).
 * @param nodePath Workflow node path for tracing.
 * @param gateFeedbackToAddress Optional gate feedback propagated from loop context.
 */
async function executeWorkflowNode(
  session: Session,
  node: WorkflowNode,
  nodePath: string,
  gateFeedbackToAddress: string[] = [],
): Promise<void> {
  assertTerminationGuards(session, nodePath);
  if (node.type === 'task') {
    await executeTaskNode(session, node, `${nodePath}/task:${node.taskId}`, gateFeedbackToAddress);
    return;
  }
  if (node.type === 'command') {
    await executeCommandNode(session, node, `${nodePath}/command:${node.id}`);
    return;
  }
  if (node.type === 'group') {
    await executeGroupNode(session, node, `${nodePath}/group:${node.id}`, gateFeedbackToAddress);
    return;
  }
  await executeWhileNode(session, node, `${nodePath}/while:${node.id}`, gateFeedbackToAddress);
}

/**
 * Runs the full workflow in plan order.
 * @param session Current run session.
 */
export async function runWorkflow(session: Session): Promise<void> {
  for (let i = 0; i < session.plan.workflow.length; i += 1) {
    await executeWorkflowNode(session, session.plan.workflow[i], `workflow[${i}]`);
  }
}

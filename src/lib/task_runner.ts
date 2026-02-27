import fs from 'node:fs';
import path from 'node:path';

import { evaluateContract } from './contracts.ts';
import { evaluateGate } from './gates.ts';
import { buildLaunchFromTaskNode } from './launch_builder.ts';
import { log } from './log.ts';
import { buildProviderCommand } from './providers.ts';
import { runCommand } from './process_runner.ts';
import {
  allocateGroupIndex,
  markGroupRunning,
  markTaskRunning,
  recordDecision,
  recordGroupResults,
  saveState,
} from './session.ts';
import type {
  ContractResult,
  GroupNode,
  Session,
  TaskExecutionResult,
  TaskLaunch,
  TaskNode,
  WhileNode,
  WorkflowNode,
} from './types.ts';
import { prepareLaunches } from './worktrees.ts';

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

  if (
    !session.dryRun &&
    launch.workerReportPath !== launch.reportPath &&
    !fs.existsSync(launch.reportPath) &&
    fs.existsSync(launch.workerReportPath)
  ) {
    fs.mkdirSync(path.dirname(launch.reportPath), { recursive: true });
    fs.copyFileSync(launch.workerReportPath, launch.reportPath);
  }

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
  launches.forEach((launch) => markTaskRunning(session, launch));

  const rawResults =
    launches.length === 1
      ? [await executeLaunch(session, launches[0])]
      : await Promise.all(launches.map((launch) => executeLaunch(session, launch)));
  const ordered = [...rawResults].sort((a, b) => a.taskIndex - b.taskIndex);
  recordGroupResults(session, groupIndex, label, ordered);
  return ordered;
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
 * Executes one task node, applying retry policy when configured.
 * @param session Current run session.
 * @param node Task workflow node.
 * @param nodePath Workflow node path for tracing.
 */
async function executeTaskNode(session: Session, node: TaskNode, nodePath: string): Promise<void> {
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
 * Executes a group node sequentially or in concurrent chunked batches.
 * @param session Current run session.
 * @param node Group workflow node.
 * @param nodePath Workflow node path for tracing.
 */
async function executeGroupNode(session: Session, node: GroupNode, nodePath: string): Promise<void> {
  if (!node.parallel) {
    for (let i = 0; i < node.steps.length; i += 1) {
      await executeWorkflowNode(session, node.steps[i], `${nodePath}/step_${i + 1}`);
    }
    return;
  }

  const maxParallel = session.plan.limits.maxParallelTasks || node.steps.length;
  for (let i = 0; i < node.steps.length; i += maxParallel) {
    const chunk = node.steps.slice(i, i + maxParallel);
    const settled = await Promise.allSettled(
      chunk.map((child, idx) =>
        executeWorkflowNode(session, child, `${nodePath}/step_${i + idx + 1}`),
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
 * @throws {Error} When loop exhausts max_iterations without gate satisfaction.
 */
async function executeWhileNode(session: Session, node: WhileNode, nodePath: string): Promise<void> {
  const globalCap = session.plan.limits.maxIterations;
  const localCap = node.maxIterations || globalCap || 1;

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

    for (let i = 0; i < node.body.length; i += 1) {
      await executeWorkflowNode(session, node.body[i], `${nodePath}/iter_${iteration}/body_${i + 1}`);
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
  }

  recordDecision(session, 'while_exhausted', nodePath, {
    whileId: node.id,
    maxIterations: localCap,
    gateId: node.until.id,
  });
  throw new Error(`While node ${node.id} exhausted max_iterations=${localCap} without satisfying gate.`);
}

/**
 * Executes one workflow node by dispatching to task/group/while handlers.
 * @param session Current run session.
 * @param node Workflow node to execute (task, group, or while).
 * @param nodePath Workflow node path for tracing.
 */
async function executeWorkflowNode(
  session: Session,
  node: WorkflowNode,
  nodePath: string,
): Promise<void> {
  assertTerminationGuards(session, nodePath);
  if (node.type === 'task') {
    await executeTaskNode(session, node, `${nodePath}/task:${node.taskId}`);
    return;
  }
  if (node.type === 'group') {
    await executeGroupNode(session, node, `${nodePath}/group:${node.id}`);
    return;
  }
  await executeWhileNode(session, node, `${nodePath}/while:${node.id}`);
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

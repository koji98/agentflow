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
  const elapsedSec = (Date.now() - session.counters.started_at_ms) / 1000;

  if (session.shutdown_signal) {
    recordDecision(session, 'termination_guard', nodePath, {
      reason: 'shutdown_signal',
      signal: session.shutdown_signal,
    });
    throw new Error(`Termination requested by signal: ${session.shutdown_signal}.`);
  }
  if (limits.max_runtime_sec !== null && elapsedSec > limits.max_runtime_sec) {
    recordDecision(session, 'termination_guard', nodePath, {
      reason: 'max_runtime_sec',
      elapsedSec: Number(elapsedSec.toFixed(3)),
      maxRuntimeSec: limits.max_runtime_sec,
    });
    throw new Error(`Termination guard exceeded: max_runtime_sec (${limits.max_runtime_sec}).`);
  }
  if (limits.max_total_tasks !== null && session.counters.executed_task_count >= limits.max_total_tasks) {
    recordDecision(session, 'termination_guard', nodePath, {
      reason: 'max_total_tasks',
      executedTaskCount: session.counters.executed_task_count,
      maxTotalTasks: limits.max_total_tasks,
    });
    throw new Error(`Termination guard exceeded: max_total_tasks (${limits.max_total_tasks}).`);
  }
  if (limits.max_failures !== null && session.counters.failure_task_count > limits.max_failures) {
    recordDecision(session, 'termination_guard', nodePath, {
      reason: 'max_failures',
      failureTaskCount: session.counters.failure_task_count,
      maxFailures: limits.max_failures,
    });
    throw new Error(`Termination guard exceeded: max_failures (${limits.max_failures}).`);
  }
}

/**
 * Executes one launch command and produces normalized task result artifacts.
 * @param session Current run session.
 * @param launch Task launch descriptor.
 * @returns Promise resolving to the task execution result.
 */
export async function executeLaunch(
  session: Session,
  launch: TaskLaunch,
): Promise<TaskExecutionResult> {
  const cmd = buildProviderCommand({
    provider: launch.provider,
    model: launch.model,
    reasoning_effort: launch.reasoning_effort,
    profile: launch.profile,
    promptText: launch.prompt_text,
    workspaceCwd: launch.workspace_cwd,
    lastMessagePath: launch.last_message_path,
    skipGitRepoCheck: launch.skip_git_repo_check,
    sandboxMode: launch.sandbox_mode,
  });

  log(
    `[group ${String(launch.group_index).padStart(2, '0')}] task=${launch.task.task_id} provider=${launch.provider} cwd=${launch.workspace_cwd}`,
  );

  const startedAtUtc = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const started = Date.now();

  const isCursor = launch.provider === 'cursor';
  const runResult = await runCommand({
    cmd,
    cwd: launch.workspace_cwd,
    stdinText: launch.prompt_text,
    logPath: launch.log_path,
    dryRun: session.dry_run,
    timeoutSeconds:
      session.plan.limits.worker_timeout_sec > 0 ? session.plan.limits.worker_timeout_sec : null,
    timeoutGraceSeconds: Math.max(1, session.plan.limits.timeout_grace_sec),
    useStdin: !isCursor,
    stdoutCapturePath: isCursor ? launch.last_message_path : null,
  });

  if (
    !session.dry_run &&
    launch.worker_report_path !== launch.report_path &&
    !fs.existsSync(launch.report_path) &&
    fs.existsSync(launch.worker_report_path)
  ) {
    fs.mkdirSync(path.dirname(launch.report_path), { recursive: true });
    fs.copyFileSync(launch.worker_report_path, launch.report_path);
  }

  const reportExists =
    fs.existsSync(launch.report_path) ||
    (launch.worker_report_path !== launch.report_path && fs.existsSync(launch.worker_report_path));

  const contract: ContractResult = session.dry_run
    ? { status: 'DONE', reason: null }
    : evaluateContract({
        exitCode: runResult.exitCode,
        timedOut: runResult.timedOut,
        reportExists,
      });

  const result: TaskExecutionResult = {
    group_index: launch.group_index,
    task_index: launch.task_index,
    task_key: launch.task_key,
    task_id: launch.task.task_id,
    node_path: launch.node_path,
    attempt: launch.attempt,
    status: contract.status,
    exit_code: runResult.exitCode,
    started_at_utc: startedAtUtc,
    ended_at_utc: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    duration_sec: Math.max(0, (Date.now() - started) / 1000),
    timed_out: runResult.timedOut,
    timeout_seconds: runResult.timeoutSeconds,
    timeout_classification: runResult.timeoutClassification,
    timeout_termination_outcome: runResult.timeoutTerminationOutcome,
    failure_reason: contract.reason,
  };

  if (result.timed_out) {
    log(
      `  -> task ${result.task_id} timed out classification=${result.timeout_classification} (log: ${launch.log_path})`,
    );
  } else if (result.exit_code === 0 && result.status === 'DONE') {
    log(`  -> task ${result.task_id} done (log: ${launch.log_path})`);
  } else {
    log(
      `  -> task ${result.task_id} status=${result.status} exit=${result.exit_code} (log: ${launch.log_path})`,
    );
  }

  return result;
}

/**
 * Executes a group batch, persists results, and enforces on_failure policy.
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
  const groupIndex = launches[0].group_index;
  markGroupRunning(session, groupIndex, launches.length, label);
  prepareLaunches(session, launches);
  launches.forEach((launch) => markTaskRunning(session, launch));

  const rawResults =
    launches.length === 1
      ? [await executeLaunch(session, launches[0])]
      : await Promise.all(launches.map((launch) => executeLaunch(session, launch)));
  const ordered = [...rawResults].sort((a, b) => a.task_index - b.task_index);
  recordGroupResults(session, groupIndex, label, ordered);

  const failures = ordered.filter((r) => r.status !== 'DONE');
  if (failures.length > 0 && session.plan.on_failure === 'stop') {
    recordDecision(session, 'termination_guard', label, {
      reason: 'stop_on_first_failure',
      failures: failures.map((f) => `${f.task_id}:${f.status}`),
    });
    throw new Error(`stop_on_first_failure triggered for ${label}.`);
  }
  return ordered;
}

/**
 * Determines whether a completed attempt qualifies for retry.
 * @param result Completed task execution result.
 * @param limits Plan limits configuration with retry policy.
 * @returns `true` when the result matches a configured retry condition.
 */
function shouldRetry(result: TaskExecutionResult, limits: Session['plan']['limits']): boolean {
  const retrySet = new Set(limits.retry_on);
  if (result.timed_out && retrySet.has('TIMEOUT')) return true;
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
  const maxAttempts = 1 + Math.max(0, session.plan.limits.max_retries);
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
        taskId: node.task_id,
        attempt,
        nextAttempt: attempt + 1,
        status: result.status,
        timedOut: result.timed_out,
      });
      continue;
    }
    if (session.plan.on_failure === 'continue') {
      return;
    }
    throw new Error(
      `Task ${node.task_id} failed after ${attempt} attempt(s): ${result.status} (exit=${result.exit_code}).`,
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

  const maxParallel = session.plan.limits.max_parallel_tasks || node.steps.length;
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
  const globalCap = session.plan.limits.max_iterations;
  const localCap = node.max_iterations || globalCap || 1;

  for (let iteration = 1; iteration <= localCap; iteration += 1) {
    if (globalCap !== null && session.counters.loop_iteration_count >= globalCap) {
      recordDecision(session, 'termination_guard', nodePath, {
        reason: 'max_iterations',
        globalCap,
        loopIterationCount: session.counters.loop_iteration_count,
      });
      throw new Error(`Global max_iterations reached (${globalCap}).`);
    }
    session.counters.loop_iteration_count += 1;
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
    await executeTaskNode(session, node, `${nodePath}/task:${node.task_id}`);
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

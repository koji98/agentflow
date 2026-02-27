import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { evaluateContract } from './contracts.ts';
import { DEFAULT_REPORT_FILENAME } from './constants.ts';
import { resolveConfigPaths } from './plan.ts';
import { buildPrompt } from './prompt.ts';
import { buildProviderCommand } from './providers.ts';
import { runCommand } from './process_runner.ts';
import {
  allocateGroupIndex,
  appendEvent,
  markGroupRunning,
  markTaskRunning,
  recordDecision,
  recordGroupResults,
  saveState,
} from './session.ts';
import type {
  AiGate,
  ContractResult,
  DeterministicGate,
  EvaluatorGate,
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
  excerptText,
  mapProjectPathToWorker,
  mapSandboxForCursor,
  readText,
  safeSlug,
  taskKey,
  tailText,
} from './utils.ts';
import { prepareLaunches } from './worktrees.ts';

/**
 * Materializes one executable task launch from a workflow task node.
 * @param params Launch construction parameters.
 * @param params.session Active execution session.
 * @param params.node Task node definition to materialize.
 * @param params.nodePath Logical workflow path for the node.
 * @param params.attempt 1-based retry attempt number.
 * @param params.groupIndex Execution group index assigned to this launch.
 * @param params.taskIndex 1-based task index within the group.
 * @returns Concrete launch metadata used by the process runner.
 */
function buildLaunchFromTaskNode({
  session,
  node,
  nodePath,
  attempt,
  groupIndex,
  taskIndex,
}: {
  session: Session;
  node: TaskNode;
  nodePath: string;
  attempt: number;
  groupIndex: number;
  taskIndex: number;
}): TaskLaunch {
  const task = {
    task_id: node.task_id,
    task: node.task,
    provider: node.provider,
    model: node.model,
    context_files: node.context_files,
  };
  const taskSlug = safeSlug(`${node.task_id}-a${attempt}`);
  const taskDir = path.resolve(
    session.run_root,
    `group_${String(groupIndex).padStart(2, '0')}`,
    `task_${taskSlug}`,
  );
  const reportFilename = DEFAULT_REPORT_FILENAME;
  const promptPath = path.resolve(taskDir, 'prompt.md');
  const logPath = path.resolve(taskDir, 'worker_exec.log');
  const lastMessagePath = path.resolve(taskDir, 'worker_last_message.md');
  const reportPath = path.resolve(taskDir, reportFilename);
  const reportJsonPath = reportPath.replace(/\.[^.]*$/, '') + '.json';

  const useWorktree = Boolean(session.plan.runtime.use_worktrees);
  const branch = useWorktree
    ? `agentflow/${safeSlug(`${session.run_id}-g${groupIndex}-t${task.task_id}-a${attempt}`)}`
    : null;
  const workspaceCwd = useWorktree ? path.resolve(taskDir, 'worktree') : session.project_root;

  const mergedContextFiles = [
    ...session.global_context_files,
    ...resolveConfigPaths(session.config_path, session.project_root, task.context_files),
  ];
  const workerContextFiles = mergedContextFiles.map((f) =>
    mapProjectPathToWorker(session.project_root, workspaceCwd, f),
  );
  const workerReportPath = mapProjectPathToWorker(session.project_root, workspaceCwd, reportPath);

  const provider = task.provider || session.plan.defaults.provider;
  const promptText = buildPrompt({
    setup: session.plan.setup,
    task,
    provider,
    contextFiles: workerContextFiles,
    reportPath: workerReportPath,
    promptContract: session.plan.prompt_contract,
  });

  return {
    group_index: groupIndex,
    task_index: taskIndex,
    task_key: taskKey(groupIndex, `${task.task_id}#a${attempt}`),
    task,
    provider,
    model: task.model || session.plan.defaults.model,
    reasoning_effort: session.plan.defaults.reasoning_effort,
    profile: session.plan.defaults.profile,
    prompt_text: promptText,
    task_dir: taskDir,
    prompt_path: promptPath,
    log_path: logPath,
    last_message_path: lastMessagePath,
    report_path: reportPath,
    worker_report_path: workerReportPath,
    report_json_path: reportJsonPath,
    workspace_cwd: workspaceCwd,
    branch,
    use_worktree: useWorktree,
    skip_git_repo_check: session.plan.runtime.skip_git_repo_check,
    sandbox_mode: session.plan.runtime.sandbox_mode,
    node_path: nodePath,
    attempt,
  };
}

/**
 * Validates global termination guards before launching more work.
 * @param session Active execution session.
 * @param nodePath Logical workflow path where the guard is being checked.
 * @returns Nothing.
 * @throws {Error} When shutdown signal or configured termination limits are exceeded.
 */
function assertTerminationGuards(session: Session, nodePath: string): void {
  const term = session.plan.termination;
  const elapsedSec = (Date.now() - session.started_at_ms) / 1000;

  if (session.shutdown_signal) {
    recordDecision(session, 'termination_guard', nodePath, {
      reason: 'shutdown_signal',
      signal: session.shutdown_signal,
    });
    throw new Error(`Termination requested by signal: ${session.shutdown_signal}.`);
  }
  if (term.max_runtime_sec !== null && elapsedSec > term.max_runtime_sec) {
    recordDecision(session, 'termination_guard', nodePath, {
      reason: 'max_runtime_sec',
      elapsedSec: Number(elapsedSec.toFixed(3)),
      maxRuntimeSec: term.max_runtime_sec,
    });
    throw new Error(`Termination guard exceeded: max_runtime_sec (${term.max_runtime_sec}).`);
  }
  if (term.max_total_tasks !== null && session.executed_task_count >= term.max_total_tasks) {
    recordDecision(session, 'termination_guard', nodePath, {
      reason: 'max_total_tasks',
      executedTaskCount: session.executed_task_count,
      maxTotalTasks: term.max_total_tasks,
    });
    throw new Error(`Termination guard exceeded: max_total_tasks (${term.max_total_tasks}).`);
  }
  if (term.max_failures !== null && session.failure_task_count > term.max_failures) {
    recordDecision(session, 'termination_guard', nodePath, {
      reason: 'max_failures',
      failureTaskCount: session.failure_task_count,
      maxFailures: term.max_failures,
    });
    throw new Error(`Termination guard exceeded: max_failures (${term.max_failures}).`);
  }
}

/**
 * Executes one launch command and produces normalized task result artifacts.
 * @param session Active execution session.
 * @param launch Materialized launch metadata for this attempt.
 * @returns Normalized task execution result.
 */
export async function executeLaunch(
  session: Session,
  launch: TaskLaunch,
): Promise<TaskExecutionResult> {
  const cmd = buildProviderCommand(launch);

  // eslint-disable-next-line no-console
  console.log(
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
      session.plan.runtime.worker_timeout_sec > 0 ? session.plan.runtime.worker_timeout_sec : null,
    timeoutGraceSeconds: Math.max(1, session.plan.runtime.timeout_grace_sec),
    rawThoughtsPath: path.resolve(session.run_root, 'raw_thoughts.md'),
    rawThoughtsTaskLabel: `group_${String(launch.group_index).padStart(2, '0')}:${launch.task.task_id}`,
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
  const reportExcerptPath = fs.existsSync(launch.report_path)
    ? launch.report_path
    : launch.worker_report_path;

  const contract: ContractResult = session.dry_run
    ? {
        status: 'DONE',
        declaredStatus: 'DONE',
        statusParseError: null,
        completionContractErrors: [],
        completionContractSatisfied: true,
      }
    : evaluateContract({
        exitCode: runResult.exitCode,
        timedOut: runResult.timedOut,
        lastMessageText: readText(launch.last_message_path),
        reportExists,
        promptContract: session.plan.prompt_contract,
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
    declared_status: contract.declaredStatus,
    status_parse_error: contract.statusParseError,
    completion_contract_errors: contract.completionContractErrors,
    completion_contract_satisfied: contract.completionContractSatisfied,
    report_json_path: launch.report_json_path,
  };

  const reportPayload = {
    taskKey: result.task_key,
    taskId: result.task_id,
    groupIndex: result.group_index,
    taskIndex: result.task_index,
    nodePath: result.node_path,
    attempt: result.attempt,
    provider: launch.provider,
    status: result.status,
    exitCode: result.exit_code,
    startedAtUtc: result.started_at_utc,
    endedAtUtc: result.ended_at_utc,
    durationSec: Number(result.duration_sec.toFixed(3)),
    timedOut: result.timed_out,
    timeoutSeconds: result.timeout_seconds,
    timeoutClassification: result.timeout_classification,
    timeoutTerminationOutcome: result.timeout_termination_outcome,
    declaredStatus: result.declared_status,
    statusParseError: result.status_parse_error,
    completionContractErrors: result.completion_contract_errors,
    completionContractSatisfied: result.completion_contract_satisfied,
    promptPath: launch.prompt_path,
    logPath: launch.log_path,
    lastMessagePath: launch.last_message_path,
    reportPath: launch.report_path,
    workerReportPath: launch.worker_report_path,
    cwd: launch.workspace_cwd,
    branch: launch.branch,
    lastMessageExcerpt: excerptText(launch.last_message_path),
    reportExcerpt: excerptText(reportExcerptPath),
    logTail: tailText(launch.log_path),
  };

  if (!session.dry_run) {
    fs.mkdirSync(path.dirname(launch.report_json_path), { recursive: true });
    fs.writeFileSync(launch.report_json_path, JSON.stringify(reportPayload, null, 2), 'utf8');
  }

  if (result.timed_out) {
    // eslint-disable-next-line no-console
    console.log(
      `  -> task ${result.task_id} timed out classification=${result.timeout_classification} (log: ${launch.log_path})`,
    );
  } else if (result.exit_code === 0 && result.status === 'DONE') {
    // eslint-disable-next-line no-console
    console.log(`  -> task ${result.task_id} done (log: ${launch.log_path})`);
  } else {
    // eslint-disable-next-line no-console
    console.log(
      `  -> task ${result.task_id} status=${result.status} exit=${result.exit_code} (log: ${launch.log_path})`,
    );
  }

  return result;
}

/**
 * Executes a group batch (single or concurrent launches), persists results, and enforces gate rules.
 * @param session Active execution session.
 * @param launches Launches to execute in this group.
 * @param label Group label for logs, state, and decision events.
 * @param enforceGate Whether to enforce `continue_on_error` for this batch.
 * @returns Ordered task execution results for the batch.
 * @throws {Error} When stop-on-failure or continue-on-error policy blocks progress.
 */
async function runLaunchBatch(
  session: Session,
  launches: TaskLaunch[],
  label: string,
  enforceGate: boolean,
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
  if (failures.length > 0 && session.plan.termination.stop_on_first_failure) {
    recordDecision(session, 'termination_guard', label, {
      reason: 'stop_on_first_failure',
      failures: failures.map((f) => `${f.task_id}:${f.status}`),
    });
    throw new Error(`stop_on_first_failure triggered for ${label}.`);
  }
  if (enforceGate && failures.length > 0 && !session.plan.runtime.continue_on_error) {
    throw new Error(
      `${label} contains non-DONE tasks and continue_on_error=false: ${failures.map((f) => `${f.task_id}:${f.status}`).join(', ')}`,
    );
  }
  return ordered;
}

/**
 * Determines whether a completed attempt qualifies for retry based on global retry policy.
 * @param result Completed attempt result.
 * @param retryPolicy Global retry policy.
 * @returns `true` when the result should be retried, otherwise `false`.
 */
function shouldRetry(result: TaskExecutionResult, retryPolicy: Session['plan']['retry_policy']): boolean {
  const retrySet = new Set(retryPolicy.retry_on);
  if (result.timed_out && retrySet.has('TIMEOUT')) return true;
  if (result.status === 'FAILED' && retrySet.has('FAILED')) return true;
  if (result.status === 'BLOCKED' && retrySet.has('BLOCKED')) return true;
  return false;
}

/**
 * Parses evaluator output into a JSON object from plain text, fenced JSON, or inline object text.
 * @param text Raw evaluator output text.
 * @returns Parsed JSON object or `null` when no valid JSON object can be extracted.
 */
function parseGateJsonOutput(text: string): Record<string, unknown> | null {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // fall through
  }

  const fenced = /```json\s*([\s\S]*?)\s*```/i.exec(trimmed);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]) as Record<string, unknown>;
    } catch {
      // fall through
    }
  }

  const firstObj = trimmed.match(/\{[\s\S]*\}/);
  if (firstObj) {
    try {
      return JSON.parse(firstObj[0]) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Applies gate pass/fail rules to parsed evaluator payload.
 * @param gate Evaluator gate configuration.
 * @param payload Parsed evaluator JSON payload.
 * @returns Normalized evaluator result used by while-loop control flow.
 */
function evaluateGateOutcome(
  gate: EvaluatorGate,
  payload: Record<string, unknown> | null,
): EvaluatorOutput {
  if (!payload) {
    return {
      passed: false,
      score: null,
      reasons: ['gate output is not valid JSON'],
      raw: null,
    };
  }
  const basePassed = payload.passed === true;
  const scoreRaw = payload.score;
  const score = typeof scoreRaw === 'number' ? scoreRaw : null;
  const reasons = Array.isArray(payload.reasons) ? payload.reasons.map((v) => String(v)) : [];

  let passed = true;
  const evaluationReasons = [...reasons];
  if (gate.score_threshold !== null) {
    if (score === null || score < gate.score_threshold) {
      passed = false;
      evaluationReasons.push(`score below score_threshold (${gate.score_threshold})`);
    }
  } else if (!basePassed) {
    passed = false;
    evaluationReasons.push('passed=true not satisfied');
  }

  return {
    passed,
    score,
    reasons: evaluationReasons,
    raw: payload,
  };
}

/**
 * Builds the AI gate evaluation prompt, injecting recent loop group/task summaries.
 * @param session Active execution session.
 * @param gate AI evaluator gate configuration.
 * @param nodePath Logical path of the while node being evaluated.
 * @param iteration Current 1-based loop iteration.
 * @param phase Evaluation phase (`pre_body` or `post_body`).
 * @returns Prompt text passed to the AI gate provider CLI.
 */
function buildAiGatePrompt(
  session: Session,
  gate: AiGate,
  nodePath: string,
  iteration: number,
  phase: 'pre_body' | 'post_body',
): string {
  const groupRows = Object.values(session.state.groups)
    .filter((row) => row.label.startsWith(nodePath))
    .sort((a, b) => a.groupIndex - b.groupIndex);
  const taskRows = Object.values(session.state.tasks)
    .filter((row) => row.nodePath.startsWith(`${nodePath}/`))
    .sort((a, b) => (a.endedAtUtc || '').localeCompare(b.endedAtUtc || ''));
  const recentLimit = gate.include_recent_tasks || 20;
  const recentGroups = groupRows.slice(-recentLimit);
  const recentRows = taskRows.slice(-recentLimit);

  const groupSummary =
    recentGroups.length === 0
      ? '- (none yet in this loop)'
      : recentGroups
          .map(
            (row) =>
              `- group=${row.groupIndex} label=${row.label} status=${row.status} failures=${row.failureCount}`,
          )
          .join('\n');

  const taskSummary =
    recentRows.length === 0
      ? '- (none yet in this loop)'
      : recentRows
          .map(
            (row) =>
              `- ${row.taskId} attempt=${row.attempt} status=${row.status} exit=${row.exitCode ?? ''} report=${row.reportPath}`,
          )
          .join('\n');

  return `You are an evaluator gate for an agent workflow.\n\nEvaluate whether the loop objective is satisfied.\n\nLoop metadata:\n- loop_node_path: ${nodePath}\n- iteration: ${iteration}\n- phase: ${phase}\n\nRun setup:\n${session.plan.setup}\n\nObjective:\n${session.plan.objective || '(not provided)'}\n\nGate instruction:\n${gate.prompt}\n\nRecent loop group context:\n${groupSummary}\n\nRecent loop task context:\n${taskSummary}\n\nOutput format requirements:\n- Return JSON only.\n- Schema: { \"passed\": boolean, \"score\": number, \"reasons\": string[] }\n- If uncertain, set passed=false and include reasons.\n`;
}

/**
 * Runs a deterministic evaluator command and normalizes its JSON/text output.
 * @param session Active execution session.
 * @param gate Deterministic evaluator configuration.
 * @param gateDir Directory where evaluator log/json artifacts are written.
 * @param evalBase File stem used for evaluator artifact filenames.
 * @returns Normalized evaluator output.
 */
function runDeterministicGate(
  session: Session,
  gate: DeterministicGate,
  gateDir: string,
  evalBase: string,
): EvaluatorOutput {
  const logPath = path.resolve(gateDir, `${evalBase}.log`);
  const jsonPath = path.resolve(gateDir, `${evalBase}.json`);
  const cwd = gate.exec.cwd ? path.resolve(session.project_root, gate.exec.cwd) : session.project_root;
  const cmd = [gate.exec.command, ...gate.exec.args];
  const timeoutSec = gate.timeout_sec || gate.exec.timeout_sec || 120;
  const result = spawnSync(cmd[0], cmd.slice(1), {
    cwd,
    encoding: 'utf8',
    timeout: timeoutSec * 1000,
    maxBuffer: 20 * 1024 * 1024,
  });

  const logText = [
    `$ (cd ${JSON.stringify(cwd)} && ${cmd.map((c) => JSON.stringify(c)).join(' ')})`,
    '',
    '--- stdout ---',
    result.stdout || '',
    '',
    '--- stderr ---',
    result.stderr || '',
    '',
    `exit_status=${result.status}`,
    `signal=${result.signal || ''}`,
    `error=${result.error ? String(result.error) : ''}`,
  ].join('\n');
  fs.writeFileSync(logPath, logText, 'utf8');

  let out: EvaluatorOutput;
  if (result.error) {
    out = { passed: false, score: null, reasons: [`gate error: ${String(result.error)}`], raw: null };
  } else if (result.status !== 0) {
    out = { passed: false, score: null, reasons: [`gate non-zero exit: ${result.status}`], raw: null };
  } else {
    const parsed = parseGateJsonOutput(String(result.stdout || ''));
    out = evaluateGateOutcome(gate, parsed);
  }
  fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2), 'utf8');
  return out;
}

/**
 * Runs an AI evaluator gate through provider CLI and normalizes parsed JSON output.
 * @param session Active execution session.
 * @param gate AI evaluator configuration.
 * @param nodePath Logical path of the while node being evaluated.
 * @param iteration Current 1-based loop iteration.
 * @param phase Evaluation phase (`pre_body` or `post_body`).
 * @param gateDir Directory where evaluator artifacts are written.
 * @param evalBase File stem used for evaluator artifact filenames.
 * @returns Normalized evaluator output.
 */
function runAiGate(
  session: Session,
  gate: AiGate,
  nodePath: string,
  iteration: number,
  phase: 'pre_body' | 'post_body',
  gateDir: string,
  evalBase: string,
): EvaluatorOutput {
  const provider = gate.provider || session.plan.defaults.provider;
  const model = gate.model || session.plan.defaults.model;
  const reasoning = gate.reasoning_effort || session.plan.defaults.reasoning_effort;
  const profile = gate.profile || session.plan.defaults.profile;

  if (provider !== 'codex' && provider !== 'cursor') {
    const out: EvaluatorOutput = {
      passed: false,
      score: null,
      reasons: [`ai gate provider '${provider}' is not implemented`],
      raw: null,
    };
    fs.writeFileSync(path.resolve(gateDir, `${evalBase}.json`), JSON.stringify(out, null, 2), 'utf8');
    return out;
  }

  const messagePath = path.resolve(gateDir, `${evalBase}.last_message.md`);
  const logPath = path.resolve(gateDir, `${evalBase}.log`);
  const jsonPath = path.resolve(gateDir, `${evalBase}.json`);
  const prompt = buildAiGatePrompt(session, gate, nodePath, iteration, phase);
  const timeoutSec = gate.timeout_sec || 120;

  let cmd: string[];
  let spawnInput: string | undefined;

  if (provider === 'codex') {
    cmd = ['codex', 'exec', '-o', messagePath];
    if (profile) cmd.push('--profile', profile);
    if (model) cmd.push('-m', model);
    if (reasoning) cmd.push('-c', `model_reasoning_effort=${reasoning}`);
    cmd.push('-');
    spawnInput = prompt;
  } else {
    cmd = ['agent', '-p'];
    cmd.push('--output-format', 'text');
    cmd.push('--force');
    cmd.push('--workspace', session.project_root);
    const cursorSandbox = mapSandboxForCursor(session.plan.runtime.sandbox_mode);
    if (cursorSandbox) cmd.push('--sandbox', cursorSandbox);
    if (model) cmd.push('--model', model);
    cmd.push(prompt);
    spawnInput = undefined;
  }

  const result = spawnSync(cmd[0], cmd.slice(1), {
    cwd: session.project_root,
    input: spawnInput,
    encoding: 'utf8',
    timeout: timeoutSec * 1000,
    maxBuffer: 30 * 1024 * 1024,
  });

  const logText = [
    `$ (cd ${JSON.stringify(session.project_root)} && ${cmd.map((c) => JSON.stringify(c)).join(' ')})`,
    '',
    '--- stdout ---',
    result.stdout || '',
    '',
    '--- stderr ---',
    result.stderr || '',
    '',
    `exit_status=${result.status}`,
    `signal=${result.signal || ''}`,
    `error=${result.error ? String(result.error) : ''}`,
  ].join('\n');
  fs.writeFileSync(logPath, logText, 'utf8');

  if (provider === 'cursor' && result.stdout) {
    fs.writeFileSync(messagePath, result.stdout, 'utf8');
  }

  let out: EvaluatorOutput;
  if (result.error) {
    out = { passed: false, score: null, reasons: [`ai gate error: ${String(result.error)}`], raw: null };
  } else if (result.status !== 0) {
    out = { passed: false, score: null, reasons: [`ai gate non-zero exit: ${result.status}`], raw: null };
  } else {
    const text = readText(messagePath) || String(result.stdout || '');
    const parsed = parseGateJsonOutput(text);
    out = evaluateGateOutcome(gate, parsed);
  }
  fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2), 'utf8');
  return out;
}

/**
 * Evaluates a while gate (deterministic or AI) and returns normalized evaluator output.
 * @param session Active execution session.
 * @param gate Evaluator gate configuration.
 * @param nodePath Logical path of the while node.
 * @param iteration Current 1-based loop iteration.
 * @param phase Evaluation phase (`pre_body` or `post_body`).
 * @returns Normalized evaluator output used to decide loop continuation.
 */
function evaluateGate(
  session: Session,
  gate: EvaluatorGate,
  nodePath: string,
  iteration: number,
  phase: 'pre_body' | 'post_body',
): EvaluatorOutput {
  if (session.dry_run) {
    return {
      passed: phase === 'post_body',
      score: phase === 'post_body' ? 1 : 0,
      reasons: [`dry_run simulated ${phase}`],
      raw: { simulated: true, phase },
    };
  }

  const missingArtifacts: string[] = [];
  for (const artifact of gate.required_artifacts) {
    const artifactPath = path.isAbsolute(artifact)
      ? path.resolve(artifact)
      : path.resolve(session.project_root, artifact);
    if (!fs.existsSync(artifactPath)) missingArtifacts.push(artifact);
  }
  if (missingArtifacts.length > 0) {
    return {
      passed: false,
      score: null,
      reasons: [`missing required artifacts: ${missingArtifacts.join(', ')}`],
      raw: { missingArtifacts },
    };
  }

  const evalDir = path.resolve(session.run_root, 'evaluations', safeSlug(gate.id));
  const evalBase = `iter_${String(iteration).padStart(2, '0')}_${phase}`;
  fs.mkdirSync(evalDir, { recursive: true });

  if (gate.type === 'deterministic') {
    return runDeterministicGate(session, gate, evalDir, evalBase);
  }
  return runAiGate(session, gate, nodePath, iteration, phase, evalDir, evalBase);
}

/**
 * Executes one task node, applying retry policy when configured.
 * @param session Active execution session.
 * @param node Task node to execute.
 * @param nodePath Logical workflow path for this node.
 * @returns Nothing.
 * @throws {Error} When task fails and policy does not allow continuation.
 */
async function executeTaskNode(session: Session, node: TaskNode, nodePath: string): Promise<void> {
  const maxAttempts = 1 + Math.max(0, session.plan.retry_policy.max_retries);
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
      false,
    );

    if (result.status === 'DONE') return;
    const canRetry = attempt < maxAttempts && shouldRetry(result, session.plan.retry_policy);
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
    if (!session.plan.runtime.continue_on_error) {
      throw new Error(
        `Task ${node.task_id} failed after ${attempt} attempt(s): ${result.status} (exit=${result.exit_code}).`,
      );
    }
    return;
  }
}

/**
 * Executes a group node sequentially or in concurrent chunked batches.
 * @param session Active execution session.
 * @param node Group node to execute.
 * @param nodePath Logical workflow path for this node.
 * @returns Nothing.
 * @throws {Error} When one or more concurrent child nodes reject.
 */
async function executeGroupNode(session: Session, node: GroupNode, nodePath: string): Promise<void> {
  if (!node.parallel) {
    for (let i = 0; i < node.steps.length; i += 1) {
      await executeWorkflowNode(session, node.steps[i], `${nodePath}/step_${i + 1}`);
    }
    return;
  }

  const maxParallel = session.plan.runtime.max_parallel_tasks || node.steps.length;
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
 * @param session Active execution session.
 * @param node While node to execute.
 * @param nodePath Logical workflow path for this node.
 * @returns Nothing.
 * @throws {Error} When global/local iteration limits are exceeded without gate satisfaction.
 */
async function executeWhileNode(session: Session, node: WhileNode, nodePath: string): Promise<void> {
  const globalCap = session.plan.termination.max_iterations;
  const localCap = node.max_iterations || globalCap || 1;

  for (let iteration = 1; iteration <= localCap; iteration += 1) {
    if (globalCap !== null && session.loop_iteration_count >= globalCap) {
      recordDecision(session, 'termination_guard', nodePath, {
        reason: 'max_iterations',
        globalCap,
        loopIterationCount: session.loop_iteration_count,
      });
      throw new Error(`Global max_iterations reached (${globalCap}).`);
    }
    session.loop_iteration_count += 1;
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
 * @param session Active execution session.
 * @param node Workflow node to execute.
 * @param nodePath Logical workflow path for this node.
 * @returns Nothing.
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
 * Runs the full workflow in plan order and emits pipeline lifecycle events.
 * @param session Active execution session.
 * @returns Nothing.
 */
export async function runWorkflow(session: Session): Promise<void> {
  appendEvent(session, { type: 'pipeline_started', workflowNodeCount: session.plan.workflow.length });
  for (let i = 0; i < session.plan.workflow.length; i += 1) {
    await executeWorkflowNode(session, session.plan.workflow[i], `workflow[${i}]`);
  }
  appendEvent(session, { type: 'pipeline_completed', workflowNodeCount: session.plan.workflow.length });
}

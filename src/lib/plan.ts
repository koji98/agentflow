import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_TIMEOUT_GRACE_SEC,
  DEFAULT_WORKER_TIMEOUT_SEC,
} from './constants.ts';
import {
  normalizeProvider,
  normalizeReasoningEffort,
  normalizeStringArray,
  optionalString,
  requiredString,
} from './utils.ts';
import type {
  AiGate,
  DeterministicGate,
  EvaluatorGate,
  GroupNode,
  Provider,
  RetryOn,
  RetryPolicy,
  TaskNode,
  TerminationPolicy,
  WhileNode,
  WorkerPlan,
  WorkflowNode,
} from './types.ts';

/**
 * Loads and parses a JSON plan file.
 * @param planPath Absolute or relative file path to the plan.
 * @returns Raw JSON payload before schema normalization.
 * @throws {Error} When file content is not valid JSON.
 */
export function loadPayload(planPath: string): unknown {
  const text = fs.readFileSync(planPath, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Plan file must be valid JSON. ${String(error)}`);
  }
}

/**
 * Parses an optional positive integer field.
 * @param value Raw value to parse.
 * @param fieldName Field label used in validation errors.
 * @returns Positive integer value or `null` when unset.
 * @throws {Error} When provided value is not an integer greater than zero.
 */
function optionalPositiveInt(value: unknown, fieldName: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${fieldName} must be an integer > 0.`);
  }
  return n;
}

/**
 * Parses an optional non-negative integer field.
 * @param value Raw value to parse.
 * @param fieldName Field label used in validation errors.
 * @returns Non-negative integer value or `null` when unset.
 * @throws {Error} When provided value is not an integer greater than or equal to zero.
 */
function optionalNonNegativeInt(value: unknown, fieldName: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${fieldName} must be an integer >= 0.`);
  }
  return n;
}

/**
 * Parses an optional object field.
 * @param value Raw value to parse.
 * @param fieldName Field label used in validation errors.
 * @returns Object payload or `{}` when omitted.
 * @throws {Error} When provided value is not an object.
 */
function optionalObject(value: unknown, fieldName: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object.`);
  }
  return value as Record<string, unknown>;
}

/**
 * Ensures an object contains only supported keys.
 * @param payload Object to validate.
 * @param fieldName Field label used in validation errors.
 * @param allowedKeys Exact supported keys.
 * @returns Nothing.
 * @throws {Error} When one or more unknown keys are found.
 */
function assertNoUnknownKeys(
  payload: Record<string, unknown>,
  fieldName: string,
  allowedKeys: readonly string[],
): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(payload).filter((key) => !allowed.has(key));
  if (unknown.length === 0) return;
  const label = unknown.length === 1 ? 'key' : 'keys';
  const names = unknown.map((key) => `"${key}"`).join(', ');
  throw new Error(`${fieldName} contains unknown ${label}: ${names}.`);
}

/**
 * Parses an optional boolean field.
 * @param value Raw value to parse.
 * @param fieldName Field label used in validation errors.
 * @returns Boolean value or `null` when omitted.
 * @throws {Error} When provided value is not boolean.
 */
function optionalBoolean(value: unknown, fieldName: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') throw new Error(`${fieldName} must be a boolean.`);
  return value;
}

/**
 * Parses a required boolean field.
 * @param value Raw value to parse.
 * @param fieldName Field label used in validation errors.
 * @returns Boolean value.
 * @throws {Error} When value is not boolean.
 */
function requiredBoolean(value: unknown, fieldName: string): boolean {
  const parsed = optionalBoolean(value, fieldName);
  if (parsed === null) throw new Error(`${fieldName} must be a boolean.`);
  return parsed;
}

/**
 * Normalizes retry policy with strict defaults and validation.
 * @param value Raw retry payload from plan.
 * @param fieldName Field label used in validation errors.
 * @returns Normalized retry policy.
 */
function normalizeRetryPolicy(value: unknown, fieldName: string): RetryPolicy {
  const payload = optionalObject(value, fieldName);
  assertNoUnknownKeys(payload, fieldName, ['max_retries', 'retry_on']);
  const maxRetriesRaw = payload.max_retries;
  const maxRetries = maxRetriesRaw === undefined ? 0 : Number(maxRetriesRaw);
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error(`${fieldName}.max_retries must be an integer >= 0.`);
  }

  const retryOnRaw = payload.retry_on;
  const retryOn = normalizeStringArray(
    retryOnRaw === undefined ? ['FAILED', 'TIMEOUT'] : retryOnRaw,
    `${fieldName}.retry_on`,
  )
    .map((v) => v.toUpperCase())
    .filter((v, i, arr) => arr.indexOf(v) === i);

  const allowed = new Set(['FAILED', 'TIMEOUT', 'BLOCKED']);
  for (const valueItem of retryOn) {
    if (!allowed.has(valueItem)) {
      throw new Error(`${fieldName}.retry_on contains unsupported value: ${valueItem}`);
    }
  }

  return {
    max_retries: maxRetries,
    retry_on: retryOn as RetryOn[],
  };
}

/**
 * Normalizes a deterministic gate payload.
 * @param gatePayload Raw gate object.
 * @param fieldName Field label used in validation errors.
 * @param fallbackId Fallback id prefix used when gate id is missing.
 * @returns Normalized deterministic gate.
 */
function normalizeDeterministicGate(
  gatePayload: Record<string, unknown>,
  fieldName: string,
  fallbackId: string,
): DeterministicGate {
  assertNoUnknownKeys(gatePayload, fieldName, [
    'type',
    'id',
    'score_threshold',
    'timeout_sec',
    'required_artifacts',
    'command',
    'args',
    'cwd',
  ]);
  const thresholdRaw = gatePayload.score_threshold;
  const threshold =
    thresholdRaw === undefined || thresholdRaw === null ? null : Number(thresholdRaw);
  if (thresholdRaw !== undefined && thresholdRaw !== null && Number.isNaN(threshold)) {
    throw new Error(`${fieldName}.score_threshold must be a number when provided.`);
  }

  return {
    type: 'deterministic',
    id: optionalString(gatePayload.id) || `${fallbackId}_gate`,
    score_threshold: threshold,
    timeout_sec: optionalPositiveInt(gatePayload.timeout_sec, `${fieldName}.timeout_sec`),
    required_artifacts: normalizeStringArray(
      gatePayload.required_artifacts,
      `${fieldName}.required_artifacts`,
    ),
    exec: {
      command: requiredString(gatePayload.command, `${fieldName}.command`),
      args: normalizeStringArray(gatePayload.args, `${fieldName}.args`),
      cwd: optionalString(gatePayload.cwd),
      timeout_sec: optionalPositiveInt(gatePayload.timeout_sec, `${fieldName}.timeout_sec`),
    },
  };
}

/**
 * Normalizes an AI gate payload.
 * @param gatePayload Raw gate object.
 * @param fieldName Field label used in validation errors.
 * @param fallbackId Fallback id prefix used when gate id is missing.
 * @returns Normalized AI gate.
 */
function normalizeAiGate(
  gatePayload: Record<string, unknown>,
  fieldName: string,
  fallbackId: string,
): AiGate {
  assertNoUnknownKeys(gatePayload, fieldName, [
    'type',
    'id',
    'score_threshold',
    'timeout_sec',
    'required_artifacts',
    'prompt',
    'provider',
    'model',
    'reasoning',
    'profile',
    'include_recent_tasks',
  ]);
  const thresholdRaw = gatePayload.score_threshold;
  const threshold =
    thresholdRaw === undefined || thresholdRaw === null ? null : Number(thresholdRaw);
  if (thresholdRaw !== undefined && thresholdRaw !== null && Number.isNaN(threshold)) {
    throw new Error(`${fieldName}.score_threshold must be a number when provided.`);
  }

  return {
    type: 'ai',
    id: optionalString(gatePayload.id) || `${fallbackId}_gate`,
    score_threshold: threshold,
    timeout_sec: optionalPositiveInt(gatePayload.timeout_sec, `${fieldName}.timeout_sec`),
    required_artifacts: normalizeStringArray(
      gatePayload.required_artifacts,
      `${fieldName}.required_artifacts`,
    ),
    prompt: requiredString(gatePayload.prompt, `${fieldName}.prompt`),
    provider: normalizeProvider(gatePayload.provider) as Provider | null,
    model: optionalString(gatePayload.model),
    reasoning_effort: normalizeReasoningEffort(gatePayload.reasoning),
    profile: optionalString(gatePayload.profile),
    include_recent_tasks: optionalPositiveInt(
      gatePayload.include_recent_tasks,
      `${fieldName}.include_recent_tasks`,
    ),
  };
}

/**
 * Normalizes a public gate object into internal evaluator gate shape.
 * @param gatePayload Raw gate object.
 * @param fieldName Field label used in validation errors.
 * @param fallbackId Fallback id prefix used when gate id is missing.
 * @returns Normalized evaluator gate.
 */
function normalizeLoopGate(
  gatePayload: Record<string, unknown>,
  fieldName: string,
  fallbackId: string,
): EvaluatorGate {
  const gateType = requiredString(gatePayload.type, `${fieldName}.type`).toLowerCase();
  if (gateType === 'deterministic') {
    return normalizeDeterministicGate(gatePayload, fieldName, fallbackId);
  }
  if (gateType === 'ai') {
    return normalizeAiGate(gatePayload, fieldName, fallbackId);
  }
  throw new Error(`${fieldName}.type must be one of: deterministic, ai.`);
}

/**
 * Normalizes one public task flow node.
 * @param payload Raw node object.
 * @param fieldName Field label used in validation errors.
 * @param seenTaskIds Set used to enforce unique task ids.
 * @returns Normalized task node.
 */
function normalizeTaskNode(
  payload: Record<string, unknown>,
  fieldName: string,
  seenTaskIds: Set<string>,
): TaskNode {
  assertNoUnknownKeys(payload, fieldName, [
    'type',
    'id',
    'prompt',
    'provider',
    'model',
    'context_files',
  ]);
  const taskId = requiredString(payload.id, `${fieldName}.id`);
  if (seenTaskIds.has(taskId)) {
    throw new Error(`task id values must be unique across flow. Duplicate: ${taskId}`);
  }
  seenTaskIds.add(taskId);

  return {
    type: 'task',
    task_id: taskId,
    task: requiredString(payload.prompt, `${fieldName}.prompt`),
    provider: normalizeProvider(payload.provider) as Provider | null,
    model: optionalString(payload.model),
    context_files: normalizeStringArray(payload.context_files, `${fieldName}.context_files`),
  };
}

/**
 * Recursively normalizes one public flow node.
 * @param payload Raw node value.
 * @param fieldName Field label used in validation errors.
 * @param seenTaskIds Set used to enforce unique task ids.
 * @returns Normalized workflow node.
 */
function normalizeFlowNode(
  payload: unknown,
  fieldName: string,
  seenTaskIds: Set<string>,
): WorkflowNode {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`${fieldName} must be an object.`);
  }
  const nodePayload = payload as Record<string, unknown>;
  const type = requiredString(nodePayload.type, `${fieldName}.type`).toLowerCase();

  if (type === 'task') {
    return normalizeTaskNode(nodePayload, fieldName, seenTaskIds);
  }

  if (type === 'group') {
    assertNoUnknownKeys(nodePayload, fieldName, ['type', 'id', 'parallel', 'steps']);
    const stepsPayload = nodePayload.steps;
    if (!Array.isArray(stepsPayload) || stepsPayload.length === 0) {
      throw new Error(`${fieldName}.steps must include at least one flow node.`);
    }
    const node: GroupNode = {
      type: 'group',
      id: requiredString(nodePayload.id, `${fieldName}.id`),
      parallel: requiredBoolean(nodePayload.parallel, `${fieldName}.parallel`),
      steps: [],
    };
    for (let i = 0; i < stepsPayload.length; i += 1) {
      node.steps.push(
        normalizeFlowNode(stepsPayload[i], `${fieldName}.steps[${i}]`, seenTaskIds),
      );
    }
    return node;
  }

  if (type === 'loop') {
    assertNoUnknownKeys(nodePayload, fieldName, ['type', 'id', 'max_iterations', 'gate', 'body']);
    const bodyPayload = nodePayload.body;
    if (!Array.isArray(bodyPayload) || bodyPayload.length === 0) {
      throw new Error(`${fieldName}.body must include at least one flow node.`);
    }
    const loopId = requiredString(nodePayload.id, `${fieldName}.id`);
    const gatePayload = optionalObject(nodePayload.gate, `${fieldName}.gate`);
    const node: WhileNode = {
      type: 'while',
      id: loopId,
      max_iterations: optionalPositiveInt(nodePayload.max_iterations, `${fieldName}.max_iterations`),
      until: normalizeLoopGate(gatePayload, `${fieldName}.gate`, loopId),
      body: [],
    };
    for (let i = 0; i < bodyPayload.length; i += 1) {
      node.body.push(
        normalizeFlowNode(bodyPayload[i], `${fieldName}.body[${i}]`, seenTaskIds),
      );
    }
    return node;
  }

  throw new Error(`${fieldName}.type must be one of: task, group, loop.`);
}

/**
 * Validates and normalizes a raw plan payload into runtime schema.
 * @param payload Raw parsed JSON payload.
 * @returns Fully normalized worker plan.
 * @throws {Error} When payload violates plan schema.
 */
export function normalizePlan(payload: unknown): WorkerPlan {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Plan payload must be a JSON object.');
  }

  const input = payload as Record<string, unknown>;
  assertNoUnknownKeys(input, 'plan', [
    'version',
    'setup',
    'objective',
    'target',
    'defaults',
    'policy',
    'runtime',
    'context_files',
    'flow',
  ]);
  const targetPayload = optionalObject(input.target, 'target');
  const defaultsPayload = optionalObject(input.defaults, 'defaults');
  const runtimePayload = optionalObject(input.runtime, 'runtime');
  const policyPayload = optionalObject(input.policy, 'policy');
  assertNoUnknownKeys(targetPayload, 'target', ['repo_root', 'use_worktrees']);
  assertNoUnknownKeys(defaultsPayload, 'defaults', ['provider', 'model', 'reasoning', 'profile']);
  assertNoUnknownKeys(policyPayload, 'policy', [
    'fail_mode',
    'max_runtime_sec',
    'max_iterations',
    'max_total_tasks',
    'max_failures',
    'retry',
  ]);
  assertNoUnknownKeys(runtimePayload, 'runtime', [
    'run_root',
    'run_id',
    'cleanup_worktrees',
    'dry_run',
    'worker_timeout_sec',
    'timeout_grace_sec',
    'max_parallel_tasks',
  ]);

  const failMode = (optionalString(policyPayload.fail_mode) || 'stop').toLowerCase();
  if (!['stop', 'continue'].includes(failMode)) {
    throw new Error('policy.fail_mode must be one of: stop, continue.');
  }

  const retryPolicy = normalizeRetryPolicy(policyPayload.retry, 'policy.retry');
  const workerTimeoutCandidate = Number(runtimePayload.worker_timeout_sec);
  const timeoutGraceCandidate = Number(runtimePayload.timeout_grace_sec);
  const maxParallelCandidate = optionalPositiveInt(
    runtimePayload.max_parallel_tasks,
    'runtime.max_parallel_tasks',
  );

  const defaults = {
    provider: normalizeProvider(defaultsPayload.provider) || 'codex',
    model: optionalString(defaultsPayload.model) || 'gpt-5-nano',
    reasoning_effort: normalizeReasoningEffort(defaultsPayload.reasoning) || 'xhigh',
    profile: optionalString(defaultsPayload.profile),
  };

  const runtime = {
    run_root: requiredString(runtimePayload.run_root ?? 'tmp/agentflow_runs', 'runtime.run_root'),
    run_id: optionalString(runtimePayload.run_id),
    use_worktrees:
      optionalBoolean(targetPayload.use_worktrees, 'target.use_worktrees') ?? true,
    continue_on_error: failMode === 'continue',
    cleanup_worktrees:
      optionalBoolean(runtimePayload.cleanup_worktrees, 'runtime.cleanup_worktrees') ?? true,
    dry_run: optionalBoolean(runtimePayload.dry_run, 'runtime.dry_run') ?? false,
    skip_git_repo_check: false,
    worker_timeout_sec: Number.isInteger(workerTimeoutCandidate)
      ? workerTimeoutCandidate
      : DEFAULT_WORKER_TIMEOUT_SEC,
    timeout_grace_sec: Number.isInteger(timeoutGraceCandidate)
      ? timeoutGraceCandidate
      : DEFAULT_TIMEOUT_GRACE_SEC,
    max_parallel_tasks: maxParallelCandidate,
  };

  if (runtime.worker_timeout_sec < 0) throw new Error('runtime.worker_timeout_sec must be >= 0.');
  if (runtime.timeout_grace_sec < 1) throw new Error('runtime.timeout_grace_sec must be >= 1.');

  const termination: TerminationPolicy = {
    max_iterations: optionalPositiveInt(policyPayload.max_iterations, 'policy.max_iterations'),
    max_runtime_sec: optionalPositiveInt(policyPayload.max_runtime_sec, 'policy.max_runtime_sec'),
    max_total_tasks: optionalPositiveInt(policyPayload.max_total_tasks, 'policy.max_total_tasks'),
    max_failures: optionalNonNegativeInt(policyPayload.max_failures, 'policy.max_failures'),
    stop_on_first_failure: failMode === 'stop',
  };

  const flowPayload = input.flow;
  if (!Array.isArray(flowPayload) || flowPayload.length === 0) {
    throw new Error('flow must include at least one node (task, group, loop).');
  }
  const seenTaskIds = new Set<string>();
  const workflow: WorkflowNode[] = [];
  for (let i = 0; i < flowPayload.length; i += 1) {
    workflow.push(normalizeFlowNode(flowPayload[i], `flow[${i}]`, seenTaskIds));
  }

  return {
    setup: requiredString(input.setup, 'setup'),
    objective: optionalString(input.objective),
    target_repo_root: requiredString(targetPayload.repo_root, 'target.repo_root'),
    defaults,
    retry_policy: retryPolicy,
    runtime,
    termination,
    prompt_contract: {
      // Keep this internal and fixed for now.
      require_status_line: true,
      allowed_statuses: ['DONE', 'BLOCKED'],
      require_report_for_done: true,
    },
    context_files: normalizeStringArray(input.context_files, 'context_files'),
    workflow,
  };
}

/**
 * Resolves target project root for a run.
 * @param planPath Plan file path.
 * @param targetRepoRoot Repo root declared in plan (if any).
 * @returns Absolute project root path.
 */
export function resolveProjectRoot(planPath: string, targetRepoRoot: string | null = null): string {
  if (targetRepoRoot) {
    const baseDir = path.dirname(planPath);
    return path.isAbsolute(targetRepoRoot)
      ? path.resolve(targetRepoRoot)
      : path.resolve(baseDir, targetRepoRoot);
  }

  const envRoot =
    optionalString(process.env.AGENTFLOW_PROJECT_ROOT) ||
    optionalString(process.env.AGENT_WORKERS_PROJECT_ROOT);
  if (envRoot) return path.resolve(envRoot);

  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: path.dirname(planPath),
    encoding: 'utf8',
  });
  if (git.status === 0) {
    const out = optionalString(git.stdout);
    if (out) return path.resolve(out);
  }

  return process.cwd();
}

/**
 * Resolves and validates configured file paths.
 * @param planPath Plan file path.
 * @param projectRoot Resolved project root.
 * @param values Path values to resolve.
 * @returns Absolute existing file paths.
 * @throws {Error} When any configured file is missing.
 */
export function resolveConfigPaths(planPath: string, projectRoot: string, values: string[]): string[] {
  const planDir = path.dirname(planPath);
  const out: string[] = [];
  const missing: string[] = [];

  for (const raw of values) {
    let resolved: string;
    if (path.isAbsolute(raw)) {
      resolved = path.resolve(raw);
    } else if (raw.startsWith('repo:')) {
      resolved = path.resolve(projectRoot, raw.slice('repo:'.length));
    } else if (raw.startsWith('plan:')) {
      resolved = path.resolve(planDir, raw.slice('plan:'.length));
    } else {
      resolved = path.resolve(planDir, raw);
    }
    if (fs.existsSync(resolved)) out.push(resolved);
    else missing.push(raw);
  }

  if (missing.length > 0) {
    throw new Error(`Configured context file(s) not found:\n${missing.map((m) => `- ${m}`).join('\n')}`);
  }

  return out;
}

/**
 * Collects all task nodes from a workflow tree.
 * @param workflow Root workflow node list.
 * @returns Flattened task node list in traversal order.
 */
export function collectTaskNodes(workflow: WorkflowNode[]): TaskNode[] {
  const tasks: TaskNode[] = [];
  const walk = (node: WorkflowNode): void => {
    if (node.type === 'task') {
      tasks.push(node);
      return;
    }
    if (node.type === 'group') {
      node.steps.forEach(walk);
      return;
    }
    node.body.forEach(walk);
  };
  workflow.forEach(walk);
  return tasks;
}

/**
 * Counts all workflow nodes including nested group/loop children.
 * @param workflow Root workflow node list.
 * @returns Total node count.
 */
export function countWorkflowNodes(workflow: WorkflowNode[]): number {
  let count = 0;
  const walk = (node: WorkflowNode): void => {
    count += 1;
    if (node.type === 'group') node.steps.forEach(walk);
    if (node.type === 'while') node.body.forEach(walk);
  };
  workflow.forEach(walk);
  return count;
}

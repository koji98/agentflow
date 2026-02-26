import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_TIMEOUT_GRACE_SEC,
  DEFAULT_WORKER_TIMEOUT_SEC,
  MARKDOWN_JSON_BLOCK_RE,
} from './constants.ts';
import {
  normalizeProvider,
  normalizeReasoningEffort,
  normalizeStringArray,
  optionalString,
  requiredString,
  validateRelativePath,
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

/** Loads raw plan payload from JSON or fenced markdown JSON block. */
export function loadPayload(planPath: string): unknown {
  const text = fs.readFileSync(planPath, 'utf8');
  try {
    return JSON.parse(text);
  } catch {
    const match = MARKDOWN_JSON_BLOCK_RE.exec(text);
    if (!match) {
      throw new Error('Plan file must be JSON or markdown with one fenced json block.');
    }
    return JSON.parse(match[1]);
  }
}

/** Parses an optional positive integer and returns null when absent. */
function optionalPositiveInt(value: unknown, fieldName: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${fieldName} must be an integer > 0.`);
  }
  return n;
}

/** Parses an optional non-negative integer and returns null when absent. */
function optionalNonNegativeInt(value: unknown, fieldName: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${fieldName} must be an integer >= 0.`);
  }
  return n;
}

/** Normalizes retry policy with strict defaults. */
function normalizeRetryPolicy(value: unknown, fieldName: string): RetryPolicy {
  const payload = (value || {}) as Record<string, unknown>;
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

/** Normalizes deterministic gate payload. */
function normalizeDeterministicGate(
  gatePayload: Record<string, unknown>,
  fieldName: string,
  fallbackId: string,
): DeterministicGate {
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

/** Normalizes ai gate payload. */
function normalizeAiGate(
  gatePayload: Record<string, unknown>,
  fieldName: string,
  fallbackId: string,
): AiGate {
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

/** Normalizes the public gate object into internal evaluator gate. */
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

/** Normalizes one public task node payload into internal task node. */
function normalizeTaskNode(
  payload: Record<string, unknown>,
  fieldName: string,
  seenTaskIds: Set<string>,
  defaultRetry: RetryPolicy,
): TaskNode {
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
    reasoning_effort: normalizeReasoningEffort(payload.reasoning),
    profile: optionalString(payload.profile),
    notes: optionalString(payload.notes) || '',
    context_files: normalizeStringArray(payload.context_files, `${fieldName}.context_files`),
    report_filename: validateRelativePath(payload.report_filename, `${fieldName}.report_filename`),
    retry: normalizeRetryPolicy(payload.retry ?? defaultRetry, `${fieldName}.retry`),
  };
}

/** Recursively normalizes one public flow node. */
function normalizeFlowNode(
  payload: unknown,
  fieldName: string,
  seenTaskIds: Set<string>,
  defaultRetry: RetryPolicy,
): WorkflowNode {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`${fieldName} must be an object.`);
  }
  const nodePayload = payload as Record<string, unknown>;
  const type = requiredString(nodePayload.type, `${fieldName}.type`).toLowerCase();

  if (type === 'task') {
    return normalizeTaskNode(nodePayload, fieldName, seenTaskIds, defaultRetry);
  }

  if (type === 'parallel') {
    const stepsPayload = nodePayload.steps;
    if (!Array.isArray(stepsPayload) || stepsPayload.length === 0) {
      throw new Error(`${fieldName}.steps must include at least one flow node.`);
    }
    const node: GroupNode = {
      type: 'group',
      id: requiredString(nodePayload.id, `${fieldName}.id`),
      parallel: true,
      steps: [],
    };
    for (let i = 0; i < stepsPayload.length; i += 1) {
      node.steps.push(
        normalizeFlowNode(stepsPayload[i], `${fieldName}.steps[${i}]`, seenTaskIds, defaultRetry),
      );
    }
    return node;
  }

  if (type === 'loop') {
    const bodyPayload = nodePayload.body;
    if (!Array.isArray(bodyPayload) || bodyPayload.length === 0) {
      throw new Error(`${fieldName}.body must include at least one flow node.`);
    }
    const loopId = requiredString(nodePayload.id, `${fieldName}.id`);
    const gatePayload = (nodePayload.gate || {}) as Record<string, unknown>;
    const node: WhileNode = {
      type: 'while',
      id: loopId,
      max_iterations: optionalPositiveInt(nodePayload.max_iterations, `${fieldName}.max_iterations`),
      until: normalizeLoopGate(gatePayload, `${fieldName}.gate`, loopId),
      body: [],
    };
    for (let i = 0; i < bodyPayload.length; i += 1) {
      node.body.push(
        normalizeFlowNode(bodyPayload[i], `${fieldName}.body[${i}]`, seenTaskIds, defaultRetry),
      );
    }
    return node;
  }

  throw new Error(`${fieldName}.type must be one of: task, parallel, loop.`);
}

/** Validates and normalizes plan schema into runtime-friendly objects. */
export function normalizePlan(payload: unknown): WorkerPlan {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Plan payload must be a JSON object.');
  }

  const input = payload as Record<string, unknown>;
  const targetPayload = (input.target || {}) as Record<string, unknown>;
  const defaultsPayload = (input.defaults || {}) as Record<string, unknown>;
  const runtimePayload = (input.runtime || {}) as Record<string, unknown>;
  const policyPayload = (input.policy || {}) as Record<string, unknown>;

  const failMode = (optionalString(policyPayload.fail_mode) || 'stop').toLowerCase();
  if (!['stop', 'continue'].includes(failMode)) {
    throw new Error('policy.fail_mode must be one of: stop, continue.');
  }

  const defaultRetry = normalizeRetryPolicy(policyPayload.retry, 'policy.retry');
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
      targetPayload.use_worktrees === undefined
        ? true
        : Boolean(targetPayload.use_worktrees),
    continue_on_error: failMode === 'continue',
    cleanup_worktrees:
      runtimePayload.cleanup_worktrees === undefined
        ? true
        : Boolean(runtimePayload.cleanup_worktrees),
    dry_run: runtimePayload.dry_run === undefined ? false : Boolean(runtimePayload.dry_run),
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
    throw new Error('flow must include at least one node (task, parallel, loop).');
  }
  const seenTaskIds = new Set<string>();
  const workflow: WorkflowNode[] = [];
  for (let i = 0; i < flowPayload.length; i += 1) {
    workflow.push(
      normalizeFlowNode(flowPayload[i], `flow[${i}]`, seenTaskIds, defaultRetry),
    );
  }

  return {
    setup: requiredString(input.setup, 'setup'),
    objective: optionalString(input.objective),
    target_repo_root: requiredString(targetPayload.repo_root, 'target.repo_root'),
    defaults,
    runtime,
    termination,
    prompt_contract: {
      // Keep this internal and fixed for now.
      require_status_line: true,
      allowed_statuses: ['DONE', 'BLOCKED'],
      require_report_for_done: true,
      default_report_filename: 'worker_report.md',
    },
    plan_doc: optionalString(input.plan_doc),
    context_files: normalizeStringArray(input.context_files, 'context_files'),
    workflow,
  };
}

/** Resolves a project root from explicit target first, then env/git/cwd fallback. */
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

/** Resolves and validates configured file paths. */
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

/** Collects all task nodes from workflow tree. */
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

/** Returns true when at least one parallel group exists in workflow. */
export function hasParallelGroups(workflow: WorkflowNode[]): boolean {
  let found = false;
  const walk = (node: WorkflowNode): void => {
    if (found) return;
    if (node.type === 'group') {
      if (node.parallel) {
        found = true;
        return;
      }
      node.steps.forEach(walk);
      return;
    }
    if (node.type === 'while') node.body.forEach(walk);
  };
  workflow.forEach(walk);
  return found;
}

/** Flattens nodes for simple top-level reporting. */
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

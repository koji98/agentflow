import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_WORKTREE_BRANCH_TEMPLATE,
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
import { validateWorktreeBranchTemplate } from './worktree_branch.ts';
import type {
  AiGate,
  CommandNode,
  DeterministicGate,
  EvaluatorGate,
  GroupNode,
  Provider,
  RetryOn,
  TaskNode,
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

// ---------------------------------------------------------------------------
// Lightweight field helpers
// ---------------------------------------------------------------------------

/** Parses an optional integer with a configurable minimum. */
function optionalInt(value: unknown, fieldName: string, min: number): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${fieldName} must be an integer >= ${min}.`);
  }
  return n;
}

function optionalObject(value: unknown, fieldName: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function optionalBoolean(value: unknown, fieldName: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') throw new Error(`${fieldName} must be a boolean.`);
  return value;
}

/**
 * Parses an optional numeric score threshold.
 * @returns The threshold number or `null` when unset.
 * @throws {Error} When the value is present but not a valid number.
 */
function parseScoreThreshold(value: unknown, fieldName: string): number | null {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  if (Number.isNaN(n)) throw new Error(`${fieldName} must be a number when provided.`);
  return n;
}

function normalizeContextArtifact(value: unknown, fieldName: string): 'summary' | 'report' {
  if (value === undefined || value === null || value === '') return 'summary';
  const artifact = requiredString(value, fieldName).toLowerCase();
  if (artifact !== 'summary' && artifact !== 'report') {
    throw new Error(`${fieldName} must be one of: summary, report.`);
  }
  return artifact;
}

/**
 * Creates a scoped field accessor for a payload after validating that it
 * contains no keys outside `allowed`. Each accessor method builds the
 * `fieldName.key` path automatically, eliminating repetitive string
 * concatenation in individual normalizer functions.
 *
 * @param payload The raw object to validate and access.
 * @param fieldName Schema path prefix used in error messages.
 * @param allowed Exhaustive list of permitted key names.
 * @throws {Error} When unknown keys are found.
 */
function fields(
  payload: Record<string, unknown>,
  fieldName: string,
  allowed: readonly string[],
) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(payload).filter((k) => !allowedSet.has(k));
  if (unknown.length > 0) {
    const label = unknown.length === 1 ? 'key' : 'keys';
    const names = unknown.map((k) => `"${k}"`).join(', ');
    throw new Error(`${fieldName} contains unknown ${label}: ${names}.`);
  }
  const p = (key: string) => `${fieldName}.${key}`;
  return {
    str: (key: string) => optionalString(payload[key]),
    strReq: (key: string) => requiredString(payload[key], p(key)),
    bool: (key: string) => optionalBoolean(payload[key], p(key)),
    boolReq: (key: string) => {
      const v = optionalBoolean(payload[key], p(key));
      if (v === null) throw new Error(`${p(key)} must be a boolean.`);
      return v;
    },
    posInt: (key: string) => optionalInt(payload[key], p(key), 1),
    nnInt: (key: string) => optionalInt(payload[key], p(key), 0),
    strArr: (key: string) => normalizeStringArray(payload[key], p(key)),
    obj: (key: string) => optionalObject(payload[key], p(key)),
    threshold: (key: string) => parseScoreThreshold(payload[key], p(key)),
    raw: (key: string) => payload[key],
  };
}

// ---------------------------------------------------------------------------
// Gate normalizers
// ---------------------------------------------------------------------------

const SHARED_GATE_KEYS = ['type', 'id', 'repo', 'score_threshold', 'timeout_sec', 'required_artifacts'] as const;

/**
 * Normalizes an optional gate repo alias and validates it against declared repos.
 * @param repo Raw gate repo alias.
 * @param fieldName Gate field path for errors.
 * @param repoAliases Declared repo aliases from the plan.
 * @returns Validated repo alias or `null` when omitted.
 */
function normalizeGateRepo(
  repo: string | null,
  fieldName: string,
  repoAliases: string[],
): string | null {
  if (!repo) return null;
  if (!repoAliases.includes(repo)) {
    throw new Error(`${fieldName}.repo "${repo}" does not match any key in repos (${repoAliases.join(', ')}).`);
  }
  return repo;
}

function normalizeDeterministicGate(
  gatePayload: Record<string, unknown>,
  fieldName: string,
  fallbackId: string,
  repoAliases: string[],
): DeterministicGate {
  const f = fields(gatePayload, fieldName, [...SHARED_GATE_KEYS, 'command', 'args', 'cwd']);
  return {
    type: 'deterministic',
    id: f.str('id') || `${fallbackId}_gate`,
    repo: normalizeGateRepo(f.str('repo'), fieldName, repoAliases),
    scoreThreshold: f.threshold('score_threshold'),
    timeoutSec: f.posInt('timeout_sec'),
    requiredArtifacts: f.strArr('required_artifacts'),
    exec: {
      command: f.strReq('command'),
      args: f.strArr('args'),
      cwd: f.str('cwd'),
      timeoutSec: f.posInt('timeout_sec'),
    },
  };
}

function normalizeAiGate(
  gatePayload: Record<string, unknown>,
  fieldName: string,
  fallbackId: string,
  repoAliases: string[],
): AiGate {
  const f = fields(gatePayload, fieldName, [
    ...SHARED_GATE_KEYS, 'prompt', 'persona', 'provider', 'model', 'reasoning', 'profile',
    'include_recent_tasks',
  ]);
  return {
    type: 'ai',
    id: f.str('id') || `${fallbackId}_gate`,
    repo: normalizeGateRepo(f.str('repo'), fieldName, repoAliases),
    scoreThreshold: f.threshold('score_threshold'),
    timeoutSec: f.posInt('timeout_sec'),
    requiredArtifacts: f.strArr('required_artifacts'),
    prompt: f.strReq('prompt'),
    persona: f.str('persona'),
    provider: normalizeProvider(f.raw('provider')) as Provider | null,
    model: f.str('model'),
    reasoningEffort: normalizeReasoningEffort(f.raw('reasoning')),
    profile: f.str('profile'),
    includeRecentTasks: f.posInt('include_recent_tasks'),
  };
}

/**
 * Normalizes a loop gate definition, dispatching to deterministic or AI handler.
 * @throws {Error} When gate type is not `deterministic` or `ai`.
 */
function normalizeLoopGate(
  gatePayload: Record<string, unknown>,
  fieldName: string,
  fallbackId: string,
  repoAliases: string[],
): EvaluatorGate {
  const gateType = requiredString(gatePayload.type, `${fieldName}.type`).toLowerCase();
  if (gateType === 'deterministic') {
    return normalizeDeterministicGate(gatePayload, fieldName, fallbackId, repoAliases);
  }
  if (gateType === 'ai') return normalizeAiGate(gatePayload, fieldName, fallbackId, repoAliases);
  throw new Error(`${fieldName}.type must be one of: deterministic, ai.`);
}

// ---------------------------------------------------------------------------
// Flow node normalizers
// ---------------------------------------------------------------------------

/**
 * Normalizes a loop_judge node by compiling it into a while node with an AI gate.
 * The gate prompt is synthesized from a rubric and pass_threshold (0..10).
 */
function normalizeLoopJudgeNode(
  payload: Record<string, unknown>,
  fieldName: string,
  seenTaskIds: Set<string>,
  repoAliases: string[],
): WhileNode {
  const f = fields(payload, fieldName, [
    'type',
    'id',
    'max_iterations',
    'pass_threshold',
    'rubric',
    'judge',
    'body',
  ]);

  const bodyPayload = payload.body;
  if (!Array.isArray(bodyPayload) || bodyPayload.length === 0) {
    throw new Error(`${fieldName}.body must include at least one flow node.`);
  }

  const loopId = f.strReq('id');

  // pass_threshold (0..10)
  const passRaw = (payload as Record<string, unknown>).pass_threshold;
  if (passRaw === undefined || passRaw === null || passRaw === '') {
    throw new Error(`${fieldName}.pass_threshold is required and must be a number between 0 and 10.`);
  }
  const passThreshold = Number(passRaw);
  if (!Number.isFinite(passThreshold) || passThreshold < 0 || passThreshold > 10) {
    throw new Error(`${fieldName}.pass_threshold must be a number between 0 and 10.`);
  }

  // rubric.criteria: non-empty, weights >= 0 and sum > 0; normalize to sum=1
  const rubricPayload = f.obj('rubric');
  const rf = fields(rubricPayload, `${fieldName}.rubric`, ['scale', 'criteria', 'notes']);
  const criteriaRaw = rubricPayload.criteria;
  if (!Array.isArray(criteriaRaw) || criteriaRaw.length === 0) {
    throw new Error(`${fieldName}.rubric.criteria must be a non-empty array.`);
  }
  type Criterion = { id: string; label: string; weight: number; guidance?: string };
  const criteria: Criterion[] = criteriaRaw.map((c, i) => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      throw new Error(`${fieldName}.rubric.criteria[${i}] must be an object.`);
    }
    const obj = c as Record<string, unknown>;
    const id = requiredString(obj.id, `${fieldName}.rubric.criteria[${i}].id`);
    const label = requiredString(obj.label, `${fieldName}.rubric.criteria[${i}].label`);
    const wRaw = obj.weight;
    const weight = Number(wRaw);
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(`${fieldName}.rubric.criteria[${i}].weight must be a number >= 0.`);
    }
    const guidance = optionalString(obj.guidance);
    return { id, label, weight, guidance: guidance || undefined };
  });
  const weightSum = criteria.reduce((acc, c) => acc + c.weight, 0);
  if (!(weightSum > 0)) {
    throw new Error(`${fieldName}.rubric.criteria weights must sum to > 0.`);
  }
  const normalized = criteria.map((c) => ({ ...c, weight: c.weight / weightSum }));
  const notes = rf.str('notes') || null;

  // judge overrides (provider/model/persona/reasoning/profile/include_recent_tasks)
  const judgePayload = f.obj('judge');
  const jf = fields(judgePayload, `${fieldName}.judge`, [
    'provider',
    'model',
    'persona',
    'reasoning',
    'profile',
    'include_recent_tasks',
  ]);
  const judgeProvider = normalizeProvider(jf.raw('provider')) as Provider | null;
  const judgeModel = jf.str('model');
  const judgePersona = jf.str('persona');
  const judgeReasoning = normalizeReasoningEffort(jf.raw('reasoning'));
  const judgeProfile = jf.str('profile');
  const judgeRecent = jf.posInt('include_recent_tasks');

  // Synthesize rubric prompt deterministically
  const toPct = (w: number) => `${Math.round(w * 100)}%`;
  const lines: string[] = [];
  lines.push('Rubric-Based Judging (0–10)');
  lines.push('Score each criterion 0–10. Compute weighted average.');
  lines.push(`Pass threshold: ${passThreshold} (score >= threshold passes).`);
  lines.push('Criteria:');
  for (const c of normalized) {
    const guide = c.guidance ? ` — ${c.guidance}` : '';
    lines.push(`- ${c.id}: ${c.label} (weight ${toPct(c.weight)})${guide}`);
  }
  if (notes) lines.push(`Notes: ${notes}`);
  lines.push(
    'Output JSON only. Required keys: passed (boolean), score (number), reasons (string[]). Optional: breakdown (object criterionId->score), feedback (string[]).',
  );
  const rubricPrompt = lines.join('\n');

  const gate: AiGate = {
    type: 'ai',
    id: `${loopId}_judge`,
    repo: null,
    scoreThreshold: passThreshold,
    timeoutSec: null,
    requiredArtifacts: [],
    prompt: rubricPrompt,
    persona: judgePersona,
    provider: judgeProvider,
    model: judgeModel,
    reasoningEffort: judgeReasoning,
    profile: judgeProfile,
    includeRecentTasks: judgeRecent,
  };

  return {
    type: 'while',
    id: loopId,
    maxIterations: f.posInt('max_iterations'),
    until: gate,
    body: bodyPayload.map((b, i) => normalizeFlowNode(b, `${fieldName}.body[${i}]`, seenTaskIds, repoAliases)),
  };
}

function normalizeTaskNode(
  payload: Record<string, unknown>,
  fieldName: string,
  seenTaskIds: Set<string>,
  repoAliases: string[],
): TaskNode {
  const f = fields(payload, fieldName, [
    'type', 'id', 'prompt', 'repo', 'provider', 'model', 'context_files', 'context_from', 'context_from_artifact', 'persona',
  ]);
  const taskId = f.strReq('id');
  if (seenTaskIds.has(taskId)) {
    throw new Error(`task id values must be unique across flow. Duplicate: ${taskId}`);
  }
  seenTaskIds.add(taskId);

  const repo = f.str('repo');
  if (repoAliases.length > 1 && !repo) {
    throw new Error(`${fieldName}.repo is required when multiple repos are defined. Task "${taskId}" is missing it.`);
  }
  if (repo && !repoAliases.includes(repo)) {
    throw new Error(`${fieldName}.repo "${repo}" does not match any key in repos (${repoAliases.join(', ')}).`);
  }

  return {
    type: 'task',
    taskId,
    task: f.strReq('prompt'),
    repo: repo || null,
    provider: normalizeProvider(f.raw('provider')) as Provider | null,
    model: f.str('model'),
    contextFiles: f.strArr('context_files'),
    contextFrom: f.strArr('context_from'),
    contextFromArtifact: normalizeContextArtifact(f.raw('context_from_artifact'), `${fieldName}.context_from_artifact`),
    persona: f.str('persona'),
  };
}


function normalizeCommandNode(
  payload: Record<string, unknown>,
  fieldName: string,
  seenTaskIds: Set<string>,
  repoAliases: string[],
): CommandNode {
  const f = fields(payload, fieldName, [
    'type', 'id', 'repo', 'command', 'args', 'cwd', 'timeout_sec', 'allow_failure',
  ]);
  const id = f.strReq('id');
  if (seenTaskIds.has(id)) {
    throw new Error(`task id values must be unique across flow. Duplicate: ${id}`);
  }
  seenTaskIds.add(id);

  const repo = f.str('repo');
  if (repoAliases.length > 1 && !repo) {
    throw new Error(`${fieldName}.repo is required when multiple repos are defined. Command "${id}" is missing it.`);
  }
  if (repo && !repoAliases.includes(repo)) {
    throw new Error(`${fieldName}.repo "${repo}" does not match any key in repos (${repoAliases.join(', ')}).`);
  }

  if (!Object.prototype.hasOwnProperty.call(payload, 'args')) {
    throw new Error(`${fieldName}.args is required and must be an array of strings.`);
  }
  if (payload.args === null) {
    throw new Error(`${fieldName}.args is required and must be an array of strings.`);
  }
  const cwd = f.str('cwd');
  if (cwd && path.isAbsolute(cwd)) {
    throw new Error(`${fieldName}.cwd must be a relative path.`);
  }

  return {
    type: 'command',
    id,
    repo: repo || null,
    command: f.strReq('command'),
    args: f.strArr('args'),
    cwd,
    timeoutSec: f.posInt('timeout_sec'),
    allowFailure: f.bool('allow_failure') ?? false,
  };
}

/**
 * Normalizes a flow node (task, command, group, or loop) from raw plan JSON.
 * @throws {Error} When node type is invalid or schema is violated.
 */
function normalizeFlowNode(
  payload: unknown,
  fieldName: string,
  seenTaskIds: Set<string>,
  repoAliases: string[],
): WorkflowNode {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`${fieldName} must be an object.`);
  }
  const nodePayload = payload as Record<string, unknown>;
  const type = requiredString(nodePayload.type, `${fieldName}.type`).toLowerCase();

  if (type === 'task') return normalizeTaskNode(nodePayload, fieldName, seenTaskIds, repoAliases);

  if (type === 'command') return normalizeCommandNode(nodePayload, fieldName, seenTaskIds, repoAliases);

  if (type === 'group') {
    const f = fields(nodePayload, fieldName, ['type', 'id', 'parallel', 'steps']);
    const stepsPayload = nodePayload.steps;
    if (!Array.isArray(stepsPayload) || stepsPayload.length === 0) {
      throw new Error(`${fieldName}.steps must include at least one flow node.`);
    }
    const node: GroupNode = {
      type: 'group',
      id: f.strReq('id'),
      parallel: f.boolReq('parallel'),
      steps: stepsPayload.map((s, i) => normalizeFlowNode(s, `${fieldName}.steps[${i}]`, seenTaskIds, repoAliases)),
    };
    return node;
  }

  if (type === 'loop') {
    const f = fields(nodePayload, fieldName, ['type', 'id', 'max_iterations', 'gate', 'body']);
    const bodyPayload = nodePayload.body;
    if (!Array.isArray(bodyPayload) || bodyPayload.length === 0) {
      throw new Error(`${fieldName}.body must include at least one flow node.`);
    }
    const loopId = f.strReq('id');
    const gatePayload = f.obj('gate');
    return {
      type: 'while',
      id: loopId,
      maxIterations: f.posInt('max_iterations'),
      until: normalizeLoopGate(gatePayload, `${fieldName}.gate`, loopId, repoAliases),
      body: bodyPayload.map((b, i) => normalizeFlowNode(b, `${fieldName}.body[${i}]`, seenTaskIds, repoAliases)),
    };
  }

  if (type === 'loop_judge') {
    return normalizeLoopJudgeNode(nodePayload, fieldName, seenTaskIds, repoAliases);
  }

  throw new Error(`${fieldName}.type must be one of: task, command, group, loop, loop_judge.`);
}

// ---------------------------------------------------------------------------
// Top-level plan normalizer
// ---------------------------------------------------------------------------

function normalizeRetryFields(
  limitsPayload: Record<string, unknown>,
): { maxRetries: number; retryOn: RetryOn[] } {
  const maxRetriesRaw = limitsPayload.max_retries;
  const maxRetries = maxRetriesRaw === undefined ? 0 : Number(maxRetriesRaw);
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error('limits.max_retries must be an integer >= 0.');
  }

  const retryOnRaw = limitsPayload.retry_on;
  const retryOn = normalizeStringArray(
    retryOnRaw === undefined ? ['FAILED', 'TIMEOUT'] : retryOnRaw,
    'limits.retry_on',
  )
    .map((v) => v.toUpperCase())
    .filter((v, i, arr) => arr.indexOf(v) === i);

  const allowed = new Set(['FAILED', 'TIMEOUT']);
  for (const valueItem of retryOn) {
    if (!allowed.has(valueItem)) {
      throw new Error(`limits.retry_on contains unsupported value: ${valueItem}`);
    }
  }
  return { maxRetries, retryOn: retryOn as RetryOn[] };
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

  const f = fields(payload as Record<string, unknown>, 'plan', [
    'version', 'setup', 'objective', 'persona', 'repos', 'provider', 'model',
    'reasoning', 'profile', 'on_failure', 'worktrees', 'context_files',
    'limits', 'options', 'flow',
  ]);

  const limitsPayload = f.obj('limits');
  const lf = fields(limitsPayload, 'limits', [
    'max_retries', 'retry_on', 'max_iterations', 'max_runtime_sec',
    'max_total_tasks', 'max_failures', 'worker_timeout_sec', 'timeout_grace_sec',
    'max_parallel_tasks',
  ]);

  const optionsPayload = f.obj('options');
  const of = fields(optionsPayload, 'options', [
    'run_root',
    'run_id',
    'cleanup_worktrees',
    'worktree_branch_template',
  ]);

  const onFailure = (f.str('on_failure') || 'stop').toLowerCase();
  if (!['stop', 'continue'].includes(onFailure)) {
    throw new Error('on_failure must be one of: stop, continue.');
  }

  const retryFields = normalizeRetryFields(limitsPayload);

  const workerTimeoutCandidate = Number(limitsPayload.worker_timeout_sec);
  const workerTimeoutSec = Number.isInteger(workerTimeoutCandidate)
    ? workerTimeoutCandidate
    : DEFAULT_WORKER_TIMEOUT_SEC;
  const timeoutGraceCandidate = Number(limitsPayload.timeout_grace_sec);
  const timeoutGraceSec = Number.isInteger(timeoutGraceCandidate)
    ? timeoutGraceCandidate
    : DEFAULT_TIMEOUT_GRACE_SEC;

  if (workerTimeoutSec < 0) throw new Error('limits.worker_timeout_sec must be >= 0.');
  if (timeoutGraceSec < 1) throw new Error('limits.timeout_grace_sec must be >= 1.');

  const reposRaw = f.obj('repos');
  const reposEntries = Object.entries(reposRaw);
  if (reposEntries.length === 0) {
    throw new Error('plan.repos must define at least one repository alias.');
  }
  const repos: Record<string, string> = {};
  for (const [alias, val] of reposEntries) {
    if (typeof val !== 'string' || !val) {
      throw new Error(`plan.repos.${alias} must be a non-empty string path.`);
    }
    repos[alias] = val;
  }
  const repoAliases = Object.keys(repos);

  const flowPayload = (payload as Record<string, unknown>).flow;
  if (!Array.isArray(flowPayload) || flowPayload.length === 0) {
    throw new Error('flow must include at least one node (task, command, group, loop).');
  }
  const seenTaskIds = new Set<string>();
  const workflow = flowPayload.map((n, i) => normalizeFlowNode(n, `flow[${i}]`, seenTaskIds, repoAliases));

  const worktreeBranchTemplate =
    of.str('worktree_branch_template') || DEFAULT_WORKTREE_BRANCH_TEMPLATE;
  validateWorktreeBranchTemplate(worktreeBranchTemplate, 'options.worktree_branch_template');

  return {
    setup: f.str('setup') || '',
    objective: f.str('objective'),
    persona: f.str('persona'),
    repos,
    provider: (normalizeProvider(f.raw('provider')) || 'codex') as WorkerPlan['provider'],
    model: f.str('model') || 'gpt-5-nano',
    reasoningEffort: normalizeReasoningEffort(f.raw('reasoning')) || 'xhigh',
    profile: f.str('profile'),
    onFailure: onFailure as WorkerPlan['onFailure'],
    worktrees: f.bool('worktrees') ?? false,
    contextFiles: f.strArr('context_files'),
    limits: {
      maxRetries: retryFields.maxRetries,
      retryOn: retryFields.retryOn,
      maxIterations: lf.posInt('max_iterations'),
      maxRuntimeSec: lf.posInt('max_runtime_sec'),
      maxTotalTasks: lf.posInt('max_total_tasks'),
      maxFailures: lf.nnInt('max_failures'),
      workerTimeoutSec,
      timeoutGraceSec,
      maxParallelTasks: lf.posInt('max_parallel_tasks'),
    },
    options: {
      runRoot: requiredString(optionsPayload.run_root ?? 'tmp/agentflow_runs', 'options.run_root'),
      runId: of.str('run_id'),
      cleanupWorktrees: of.bool('cleanup_worktrees') ?? false,
      worktreeBranchTemplate,
      dryRun: false,
      skipGitRepoCheck: false,
      sandboxMode: 'workspace-write',
    },
    workflow,
  };
}

// ---------------------------------------------------------------------------
// Path resolution & tree utilities
// ---------------------------------------------------------------------------

/**
 * Resolves repo alias paths to absolute directories.
 * @param planPath Absolute path to the plan JSON file.
 * @param repos Map of alias to unresolved path from plan.
 * @returns Map of alias to resolved absolute path.
 */
export function resolveRepoRoots(planPath: string, repos: Record<string, string>): Record<string, string> {
  const baseDir = path.dirname(planPath);
  const resolved: Record<string, string> = {};
  for (const [alias, raw] of Object.entries(repos)) {
    resolved[alias] = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(baseDir, raw);
  }
  return resolved;
}

/**
 * Resolves and validates configured file paths.
 * Supports prefixes: `plan:`, `<alias>:` (repo alias from repos map), and absolute paths.
 * Plain relative paths resolve from the plan directory.
 *
 * @param planPath Absolute path to the plan JSON file.
 * @param repoRoots Map of alias to resolved absolute repo root.
 * @param values Array of raw path strings from the plan.
 * @param defaultRoot Optional base directory for bare relative paths. When provided,
 *   bare paths (no prefix) resolve relative to this directory instead of the plan
 *   file directory. Used for task-level context files so they resolve against the
 *   task's repo root.
 * @returns Array of resolved absolute paths.
 * @throws {Error} When any configured file does not exist.
 */
export function resolveConfigPaths(
  planPath: string,
  repoRoots: Record<string, string>,
  values: string[],
  defaultRoot?: string,
): string[] {
  const planDir = path.dirname(planPath);
  const bareBase = defaultRoot ?? planDir;
  const out: string[] = [];
  const missing: string[] = [];

  for (const raw of values) {
    let resolved: string;
    if (path.isAbsolute(raw)) {
      resolved = path.resolve(raw);
    } else if (raw.startsWith('plan:')) {
      resolved = path.resolve(planDir, raw.slice('plan:'.length));
    } else {
      const colonIdx = raw.indexOf(':');
      if (colonIdx > 0) {
        const prefix = raw.slice(0, colonIdx);
        const rest = raw.slice(colonIdx + 1);
        const root = repoRoots[prefix];
        if (root) {
          resolved = path.resolve(root, rest);
        } else {
          resolved = path.resolve(bareBase, raw);
        }
      } else {
        resolved = path.resolve(bareBase, raw);
      }
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
 * @param workflow Array of top-level workflow nodes.
 * @returns Flat array of all task nodes in depth-first order.
 */
export function collectTaskNodes(workflow: WorkflowNode[]): TaskNode[] {
  const tasks: TaskNode[] = [];
  const walk = (node: WorkflowNode): void => {
    if (node.type === 'task') { tasks.push(node); return; }
    if (node.type === 'command') return;
    if (node.type === 'group') { node.steps.forEach(walk); return; }
    node.body.forEach(walk);
  };
  workflow.forEach(walk);
  return tasks;
}

/**
 * Counts executable task-like nodes (task + command) in a workflow tree.
 * @param workflow Array of top-level workflow nodes.
 * @returns Count of task and command nodes in depth-first order.
 */
export function countExecutableNodes(workflow: WorkflowNode[]): number {
  let count = 0;
  const walk = (node: WorkflowNode): void => {
    if (node.type === 'task' || node.type === 'command') {
      count += 1;
      return;
    }
    if (node.type === 'group') {
      node.steps.forEach(walk);
      return;
    }
    node.body.forEach(walk);
  };
  workflow.forEach(walk);
  return count;
}

/**
 * Counts all workflow nodes including nested group/loop children.
 * @param workflow Array of top-level workflow nodes.
 * @returns Total count of all nodes in the tree.
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

import type { GraphOutcome } from "../graph/schema.js";
import type { CompiledExecutableNode } from "../graph/compiled.js";

export interface RuntimeNodeAttempt {
  execution_id: string;
  compiled_id: string;
  authored_id: string;
  kind: CompiledExecutableNode["kind"];
  repo_alias: string;
  execution_dir: string;
  attempt_index: number;
  repeat_scope_id?: string;
  iteration_index?: number;
  status: "running" | "passed" | "failed" | "canceled";
  outcome?: GraphOutcome;
  started_at: string;
  ended_at?: string;
  duration_ms?: number;
  stdout_log_path?: string;
  stderr_log_path?: string;
  result_path?: string;
  context_packet_path?: string;
  context_summary_path?: string;
  output_artifacts: Record<string, string>;
  metadata: Record<string, unknown>;
}

export type AttemptSelector = "latest" | "latest_passed" | "latest_failed" | number;

export interface AttemptRegistry {
  by_compiled_id: Map<string, RuntimeNodeAttempt[]>;
  active_by_execution_id: Map<string, RuntimeNodeAttempt>;
  next_attempt_index_by_compiled_id: Map<string, number>;
}

export function createAttemptRegistry(): AttemptRegistry {
  return {
    by_compiled_id: new Map(),
    active_by_execution_id: new Map(),
    next_attempt_index_by_compiled_id: new Map()
  };
}

export function buildExecutionId(
  compiledId: string,
  attemptIndex: number,
  options: {
    repeat_scope_id?: string;
    iteration_index?: number;
  } = {}
): string {
  const base = `exec__${compiledId}__attempt_${attemptIndex}`;

  if (!options.repeat_scope_id || options.iteration_index === undefined) {
    return base;
  }

  return `${base}__repeat_${options.repeat_scope_id}__iter_${options.iteration_index}`;
}

export function openNodeAttempt(
  registry: AttemptRegistry,
  node: CompiledExecutableNode,
  executionDir: string,
  options: {
    repeat_scope_id?: string;
    iteration_index?: number;
  } = {}
): RuntimeNodeAttempt {
  const attempt_index = (registry.next_attempt_index_by_compiled_id.get(node.compiled_id) ?? 0) + 1;
  registry.next_attempt_index_by_compiled_id.set(node.compiled_id, attempt_index);

  const attempt: RuntimeNodeAttempt = {
    execution_id: buildExecutionId(node.compiled_id, attempt_index, options),
    compiled_id: node.compiled_id,
    authored_id: node.authored_id,
    kind: node.kind,
    repo_alias: node.repo,
    execution_dir: executionDir,
    attempt_index,
    ...(options.repeat_scope_id ? { repeat_scope_id: options.repeat_scope_id } : {}),
    ...(options.iteration_index !== undefined ? { iteration_index: options.iteration_index } : {}),
    status: "running",
    started_at: new Date().toISOString(),
    output_artifacts: {},
    metadata: {}
  };

  const attempts = registry.by_compiled_id.get(node.compiled_id) ?? [];
  attempts.push(attempt);
  registry.by_compiled_id.set(node.compiled_id, attempts);
  registry.active_by_execution_id.set(attempt.execution_id, attempt);

  return attempt;
}

export function peekNextAttemptIndex(
  registry: AttemptRegistry,
  compiledId: string
): number {
  return (registry.next_attempt_index_by_compiled_id.get(compiledId) ?? 0) + 1;
}

export function closeNodeAttempt(
  registry: AttemptRegistry,
  executionId: string,
  update: {
    status: "passed" | "failed" | "canceled";
    outcome?: GraphOutcome;
    stdout_log_path?: string;
    stderr_log_path?: string;
    result_path?: string;
    context_packet_path?: string;
    context_summary_path?: string;
    output_artifacts?: Record<string, string>;
    metadata?: Record<string, unknown>;
  }
): RuntimeNodeAttempt {
  const attempt = registry.active_by_execution_id.get(executionId);

  if (!attempt) {
    throw new Error(`Unknown execution_id "${executionId}".`);
  }

  const endedAt = new Date().toISOString();
  const duration_ms = Math.max(0, Date.parse(endedAt) - Date.parse(attempt.started_at));

  attempt.status = update.status;
  attempt.ended_at = endedAt;
  attempt.duration_ms = duration_ms;

  if (update.outcome) {
    attempt.outcome = update.outcome;
  }

  if (update.stdout_log_path) {
    attempt.stdout_log_path = update.stdout_log_path;
  }

  if (update.stderr_log_path) {
    attempt.stderr_log_path = update.stderr_log_path;
  }

  if (update.result_path) {
    attempt.result_path = update.result_path;
  }

  if (update.context_packet_path) {
    attempt.context_packet_path = update.context_packet_path;
  }

  if (update.context_summary_path) {
    attempt.context_summary_path = update.context_summary_path;
  }

  if (update.output_artifacts) {
    attempt.output_artifacts = update.output_artifacts;
  }

  if (update.metadata) {
    attempt.metadata = update.metadata;
  }

  registry.active_by_execution_id.delete(executionId);
  return attempt;
}

export function listAttemptsForCompiledNode(
  registry: AttemptRegistry,
  compiledId: string
): RuntimeNodeAttempt[] {
  return [...(registry.by_compiled_id.get(compiledId) ?? [])];
}

export function selectAttempt(
  attempts: RuntimeNodeAttempt[],
  selector: AttemptSelector
): RuntimeNodeAttempt | undefined {
  if (attempts.length === 0) {
    return undefined;
  }

  if (typeof selector === "number") {
    return attempts.find((attempt) => attempt.attempt_index === selector);
  }

  if (selector === "latest") {
    return attempts.at(-1);
  }

  if (selector === "latest_passed") {
    return [...attempts].reverse().find((attempt) => attempt.outcome === "passed");
  }

  return [...attempts].reverse().find((attempt) => attempt.outcome === "failed");
}

export function latestOutcomeForIteration(
  registry: AttemptRegistry,
  compiledId: string,
  iterationIndex?: number
): GraphOutcome | undefined {
  const attempts = listAttemptsForCompiledNode(registry, compiledId)
    .filter((attempt) => attempt.iteration_index === iterationIndex);

  return attempts.at(-1)?.outcome;
}

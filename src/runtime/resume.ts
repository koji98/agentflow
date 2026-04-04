import type { CompiledGraph, CompiledRepeatScope } from "../graph/compiled.js";
import type { RuntimeEventEnvelope } from "./events.js";
import {
  createAttemptRegistry,
  type AttemptRegistry,
  type RuntimeNodeAttempt
} from "./attempts.js";
import {
  createRuntimeSession,
  type ExecutionManifest,
  type LatestExecutionSummary,
  type RuntimeSession,
  type RuntimeStateSnapshot
} from "./session.js";

function buildLatestExecutionSummary(attempt: RuntimeNodeAttempt): LatestExecutionSummary {
  const status =
    attempt.status === "canceled"
      ? "canceled"
      : (attempt.outcome ?? attempt.status) as LatestExecutionSummary["status"];

  return {
    execution_id: attempt.execution_id,
    compiled_id: attempt.compiled_id,
    authored_id: attempt.authored_id,
    kind: attempt.kind,
    status,
    attempt_index: attempt.attempt_index,
    ...(attempt.repeat_scope_id ? { repeat_scope_id: attempt.repeat_scope_id } : {}),
    ...(attempt.iteration_index !== undefined ? { iteration_index: attempt.iteration_index } : {}),
    started_at: attempt.started_at,
    ...(attempt.ended_at ? { ended_at: attempt.ended_at } : {}),
    ...(attempt.duration_ms !== undefined ? { duration_ms: attempt.duration_ms } : {})
  };
}

function collectMaxAttemptIndexes(
  attempts: RuntimeNodeAttempt[]
): Map<string, number> {
  const nextAttemptIndexByCompiledId = new Map<string, number>();

  for (const attempt of attempts) {
    const previous = nextAttemptIndexByCompiledId.get(attempt.compiled_id) ?? 0;
    nextAttemptIndexByCompiledId.set(
      attempt.compiled_id,
      Math.max(previous, attempt.attempt_index)
    );
  }

  return nextAttemptIndexByCompiledId;
}

function buildResumeAttemptRegistry(options: {
  graph: CompiledGraph;
  prior_state: RuntimeStateSnapshot;
  attempts: RuntimeNodeAttempt[];
}): {
  registry: AttemptRegistry;
  preserved_compiled_ids: Set<string>;
  restarted_repeat_scope_ids: Set<string>;
} {
  const registry = createAttemptRegistry();
  registry.next_attempt_index_by_compiled_id = collectMaxAttemptIndexes(options.attempts);
  const attempts_by_compiled_id = new Map<string, RuntimeNodeAttempt[]>();

  for (const attempt of options.attempts) {
    const current = attempts_by_compiled_id.get(attempt.compiled_id) ?? [];
    current.push(attempt);
    attempts_by_compiled_id.set(attempt.compiled_id, current);
  }

  const restarted_repeat_scope_ids = new Set(
    options.graph.scopes
      .filter((scope): scope is CompiledRepeatScope => scope.kind === "repeat")
      .map((scope) => scope.scope_id)
      .filter((scopeId) => options.prior_state.repeat_scopes[scopeId]?.status !== "passed")
  );

  const preserved_compiled_ids = new Set<string>();

  for (const node of options.graph.nodes) {
    if (
      node.repeat_scope_id
      && restarted_repeat_scope_ids.has(node.repeat_scope_id)
    ) {
      continue;
    }

    if (options.prior_state.node_statuses[node.compiled_id] !== "passed") {
      continue;
    }

    const nodeAttempts = attempts_by_compiled_id.get(node.compiled_id) ?? [];

    if (nodeAttempts.length === 0) {
      continue;
    }

    registry.by_compiled_id.set(node.compiled_id, nodeAttempts);
    preserved_compiled_ids.add(node.compiled_id);
  }

  return {
    registry,
    preserved_compiled_ids,
    restarted_repeat_scope_ids
  };
}

export function createResumedRuntimeSession(options: {
  run_root: string;
  graph: CompiledGraph;
  manifest: ExecutionManifest;
  prior_state: RuntimeStateSnapshot;
  attempts: RuntimeNodeAttempt[];
  events: RuntimeEventEnvelope[];
}): {
  session: RuntimeSession;
  previous_status: RuntimeStateSnapshot["status"];
  preserved_node_count: number;
  restarted_node_count: number;
} {
  const {
    registry,
    preserved_compiled_ids,
    restarted_repeat_scope_ids
  } = buildResumeAttemptRegistry({
    graph: options.graph,
    prior_state: options.prior_state,
    attempts: options.attempts
  });

  const session = createRuntimeSession(
    options.prior_state.run_id,
    options.run_root,
    options.graph,
    registry,
    options.manifest.repo_workspaces
  );

  session.manifest = options.manifest;
  session.started_at = options.prior_state.started_at;
  session.next_event_seq = Math.max(
    options.prior_state.snapshot_seq + 1,
    (options.events.at(-1)?.seq ?? 0) + 1
  );

  for (const node of options.graph.nodes) {
    if (preserved_compiled_ids.has(node.compiled_id)) {
      const attempts = registry.by_compiled_id.get(node.compiled_id) ?? [];
      const latest = attempts.at(-1);

      if (latest) {
        session.node_statuses.set(node.compiled_id, options.prior_state.node_statuses[node.compiled_id] ?? "passed");
        session.latest_execution_by_compiled_id.set(node.compiled_id, buildLatestExecutionSummary(latest));
      }

      continue;
    }

    session.node_statuses.set(node.compiled_id, "pending");
  }

  for (const scope of options.graph.scopes) {
    if (scope.kind !== "repeat") {
      continue;
    }

    const existing = options.prior_state.repeat_scopes[scope.scope_id];
    const shouldRestart = restarted_repeat_scope_ids.has(scope.scope_id);

    session.repeat_scopes.set(scope.scope_id, {
      repeat_scope_id: scope.scope_id,
      authored_id: scope.authored_id,
      max_attempts: scope.max_attempts,
      until_compiled_id: scope.until_compiled_id,
      latest_iteration_index: shouldRestart ? 0 : (existing?.latest_iteration_index ?? 0),
      active_iteration_index: undefined,
      status: shouldRestart ? "pending" : "passed"
    });
  }

  return {
    session,
    previous_status: options.prior_state.status,
    preserved_node_count: preserved_compiled_ids.size,
    restarted_node_count: options.graph.nodes.length - preserved_compiled_ids.size
  };
}

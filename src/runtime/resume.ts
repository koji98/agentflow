import type {
  CompiledExecutableNode,
  CompiledGraph,
  CompiledRepeatScope
} from "../graph/compiled.js";
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

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJson(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortJson((value as Record<string, unknown>)[key])])
    );
  }

  return value;
}

function fingerprintCompiledNode(node: CompiledExecutableNode): string {
  const shared = {
    kind: node.kind,
    repo: node.repo,
    deps: node.deps,
    effective_policy: node.effective_policy,
    inputs: node.inputs,
    context_from: node.context_from,
    declared_outputs: node.declared_outputs,
    ...(node.lowered_from ? { lowered_from: node.lowered_from } : {})
  };

  if (node.kind === "agent") {
    return JSON.stringify(sortJson({
      ...shared,
      prompt: node.prompt
    }));
  }

  if (node.kind === "exec") {
    return JSON.stringify(sortJson({
      ...shared,
      command: node.command,
      args: node.args,
      ...(node.cwd ? { cwd: node.cwd } : {}),
      ...(node.env ? { env: node.env } : {})
    }));
  }

  if (node.kind === "checkpoint") {
    return JSON.stringify(sortJson({
      ...shared,
      prompt: node.prompt,
      review_from: node.review_from
    }));
  }

  return JSON.stringify(sortJson({
    ...shared,
    check_kind: node.check_kind,
    ...(node.command ? { command: node.command } : {}),
    ...(node.args ? { args: node.args } : {}),
    ...(node.cwd ? { cwd: node.cwd } : {}),
    ...(node.env ? { env: node.env } : {}),
    ...(node.pass_if ? { pass_if: node.pass_if } : {}),
    ...(node.prompt ? { prompt: node.prompt } : {}),
    ...(node.rubric ? { rubric: node.rubric } : {})
  }));
}

function fingerprintRepeatScope(scope: CompiledRepeatScope): string {
  return JSON.stringify(sortJson({
    authored_id: scope.authored_id,
    kind: scope.kind,
    parent_scope_id: scope.parent_scope_id,
    entry_node_ids: scope.entry_node_ids,
    exit_node_ids: scope.exit_node_ids,
    compiled_node_ids: scope.compiled_node_ids,
    max_attempts: scope.max_attempts,
    until_compiled_id: scope.until_compiled_id,
    body_entry_node_ids: scope.body_entry_node_ids,
    body_exit_node_ids: scope.body_exit_node_ids
  }));
}

function collectInvalidatedCompiledIds(options: {
  prior_graph: CompiledGraph;
  graph: CompiledGraph;
  prior_state: RuntimeStateSnapshot;
}): {
  invalidated_compiled_ids: Set<string>;
  restarted_repeat_scope_ids: Set<string>;
} {
  const priorNodesById = new Map(
    options.prior_graph.nodes.map((node) => [node.compiled_id, node])
  );
  const priorRepeatScopesById = new Map(
    options.prior_graph.scopes
      .filter((scope): scope is CompiledRepeatScope => scope.kind === "repeat")
      .map((scope) => [scope.scope_id, scope])
  );
  const repeatScopes = options.graph.scopes.filter(
    (scope): scope is CompiledRepeatScope => scope.kind === "repeat"
  );
  const invalidated_compiled_ids = new Set<string>();
  const restarted_repeat_scope_ids = new Set<string>();

  const restartRepeatScope = (scope: CompiledRepeatScope): boolean => {
    if (restarted_repeat_scope_ids.has(scope.scope_id)) {
      return false;
    }

    restarted_repeat_scope_ids.add(scope.scope_id);

    for (const compiledId of scope.compiled_node_ids) {
      invalidated_compiled_ids.add(compiledId);
    }

    return true;
  };

  for (const node of options.graph.nodes) {
    const priorNode = priorNodesById.get(node.compiled_id);

    if (!priorNode || fingerprintCompiledNode(priorNode) !== fingerprintCompiledNode(node)) {
      invalidated_compiled_ids.add(node.compiled_id);
    }
  }

  for (const scope of repeatScopes) {
    const priorScope = priorRepeatScopesById.get(scope.scope_id);
    const priorStatus = options.prior_state.repeat_scopes[scope.scope_id]?.status;
    const hasIncompletePriorNodeState = scope.compiled_node_ids.some(
      (compiledId) => options.prior_state.node_statuses[compiledId] !== "passed"
    );
    const changed =
      !priorScope ||
      fingerprintRepeatScope(priorScope) !== fingerprintRepeatScope(scope);

    if (changed || priorStatus !== "passed" || hasIncompletePriorNodeState) {
      restartRepeatScope(scope);
    }
  }

  const adjacency = new Map<string, string[]>();

  for (const node of options.graph.nodes) {
    adjacency.set(node.compiled_id, []);
  }

  for (const edge of options.graph.edges) {
    if (edge.kind === "repeat-back") {
      continue;
    }

    adjacency.get(edge.from)?.push(edge.to);
  }

  const queue = [...invalidated_compiled_ids];

  while (queue.length > 0) {
    const next = queue.shift();

    if (!next) {
      continue;
    }

    for (const downstreamId of adjacency.get(next) ?? []) {
      if (invalidated_compiled_ids.has(downstreamId)) {
        continue;
      }

      invalidated_compiled_ids.add(downstreamId);
      queue.push(downstreamId);
    }

    for (const scope of repeatScopes) {
      if (!scope.compiled_node_ids.includes(next)) {
        continue;
      }

      if (!restartRepeatScope(scope)) {
        continue;
      }

      for (const compiledId of scope.compiled_node_ids) {
        if (compiledId === next) {
          continue;
        }

        queue.push(compiledId);
      }
    }
  }

  return {
    invalidated_compiled_ids,
    restarted_repeat_scope_ids
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
  prior_graph: CompiledGraph;
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

  const {
    invalidated_compiled_ids,
    restarted_repeat_scope_ids
  } = collectInvalidatedCompiledIds({
    prior_graph: options.prior_graph,
    graph: options.graph,
    prior_state: options.prior_state
  });

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

    if (invalidated_compiled_ids.has(node.compiled_id)) {
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
  graph_path?: string;
  prior_graph: CompiledGraph;
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
    prior_graph: options.prior_graph,
    graph: options.graph,
    prior_state: options.prior_state,
    attempts: options.attempts
  });

  const session = createRuntimeSession(
    options.prior_state.run_id,
    options.run_root,
    options.graph,
    registry,
    options.manifest.repo_workspaces,
    options.graph_path
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

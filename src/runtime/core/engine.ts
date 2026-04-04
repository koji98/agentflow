import { basename, join, resolve } from "node:path";

import type { AuthoredGraphDocument } from "../../graph/authored.js";
import type {
  CompiledAgentNode,
  CompiledCheckNode,
  CompiledExecNode,
  CompiledExecutableNode,
  CompiledGraph
} from "../../graph/compiled.js";
import { createRunOwnerRecord, type RunOwnerRecord } from "../../artifacts/owner.js";
import type { GraphDiagnostic, GraphOutcome, HarnessName } from "../../graph/schema.js";
import { ArtifactWriter } from "../../artifacts/writer.js";
import { readRunEvents } from "../../artifacts/reader.js";
import { renderRunSummary } from "../delivery/summary.js";
import {
  buildExecutionId,
  closeNodeAttempt,
  createAttemptRegistry,
  latestOutcomeForIteration,
  listAttemptsForCompiledNode,
  openNodeAttempt,
  peekNextAttemptIndex,
  type RuntimeNodeAttempt
} from "../attempts.js";
import { runAiCheck } from "../checks/ai.js";
import { runDeterministicCheck, runLocalProcess } from "../checks/deterministic.js";
import { resolveExecutionContext } from "../context/resolve.js";
import {
  createRuntimeEvent,
  type CheckEvaluatedPayload,
  type RuntimeEventContext,
  type RuntimeEventEnvelope
} from "../events.js";
import type { HarnessAdapter } from "../harness/types.js";
import {
  buildRuntimeStateSnapshot,
  completeRepeatIteration,
  createRuntimeSession,
  finalizeExecutionSummary,
  openRepeatIteration,
  registerActiveExecution,
  setNodeStatus,
  type RuntimeRunStatus,
  type RuntimeSession,
  type WorkspaceBinding
} from "../session.js";
import { initializeInplaceWorkspace } from "../workspace/inplace.js";
import type { WorkspaceSetup } from "../workspace/types.js";
import { initializeWorktreeWorkspace } from "../workspace/worktree.js";
import {
  buildSchedulerTopology,
  createReadyNodeKey,
  getIncomingEdges,
  getNodeParallelScopes,
  getOutgoingEdges,
  isRepeatBodyEntryNode,
  type ReadyNode,
  type SchedulerTopology
} from "./scheduler.js";

export interface RuntimeNodeExecutionResult {
  status: "passed" | "failed" | "canceled";
  outcome?: GraphOutcome;
  result: unknown;
  stdout: string | undefined;
  stderr: string | undefined;
  metadata?: Record<string, unknown>;
  check?: CheckEvaluatedPayload;
}

export interface RuntimeNodeExecutorContext<TNode extends CompiledExecutableNode> {
  run_id: string;
  node: TNode;
  attempt: RuntimeNodeAttempt;
  workspace_path: string;
  execution_dir: string;
  context_packet_path: string;
  context_summary_path: string;
  signal: AbortSignal | undefined;
  on_stdout_chunk?: (chunk: string) => void;
  on_stderr_chunk?: (chunk: string) => void;
}

export type RuntimeNodeExecutor<TNode extends CompiledExecutableNode> = (
  context: RuntimeNodeExecutorContext<TNode>
) => Promise<RuntimeNodeExecutionResult>;

export interface RuntimeExecutorRegistry {
  agent?: RuntimeNodeExecutor<CompiledAgentNode>;
  exec?: RuntimeNodeExecutor<CompiledExecNode>;
  check?: RuntimeNodeExecutor<CompiledCheckNode>;
}

export interface RunCompiledGraphOptions {
  run_root: string;
  compiled_graph: CompiledGraph;
  repo_sources: Record<string, string>;
  authored_graph?: AuthoredGraphDocument;
  compile_diagnostics?: GraphDiagnostic[];
  executors?: RuntimeExecutorRegistry;
  harnesses?: Partial<Record<HarnessName, HarnessAdapter>>;
  signal?: AbortSignal;
}

export interface RunCompiledGraphResult {
  run_id: string;
  run_root: string;
  outcome: RuntimeRunStatus;
  state: ReturnType<typeof buildRuntimeStateSnapshot>;
  attempts: RuntimeNodeAttempt[];
  events: RuntimeEventEnvelope[];
}

interface ActiveExecutionHandle {
  ready_node: ReadyNode;
  attempt: RuntimeNodeAttempt;
  node: CompiledExecutableNode;
  cancel: () => void;
  promise: Promise<{
    node: CompiledExecutableNode;
    attempt: RuntimeNodeAttempt;
    result: RuntimeNodeExecutionResult;
  }>;
}

interface ExecutionAbortControl {
  signal: AbortSignal;
  cancel: () => void;
  dispose: () => void;
}

interface StreamingLogSink {
  on_stdout_chunk: (chunk: string) => void;
  on_stderr_chunk: (chunk: string) => void;
  flush: () => Promise<void>;
}

function deriveRunId(runRoot: string): string {
  return basename(runRoot);
}

function flattenAttempts(session: RuntimeSession): RuntimeNodeAttempt[] {
  return [...session.attempts.by_compiled_id.values()]
    .flat()
    .sort((left, right) => Date.parse(left.started_at) - Date.parse(right.started_at));
}

function createStreamingLogSink(
  writer: ArtifactWriter,
  executionPaths: {
    stdout_log_path: string;
    stderr_log_path: string;
  }
): StreamingLogSink {
  let stdoutPending = Promise.resolve();
  let stderrPending = Promise.resolve();

  const queueAppend = (
    stream: "stdout" | "stderr",
    chunk: string
  ) => {
    if (chunk.length === 0) {
      return;
    }

    const logPath =
      stream === "stdout" ? executionPaths.stdout_log_path : executionPaths.stderr_log_path;
    const append = () =>
      writer.appendExecutionLogChunk(logPath, chunk).catch(() => {
        // Live log streaming is best-effort. Final completion rewrites the authoritative log.
      });

    if (stream === "stdout") {
      stdoutPending = stdoutPending.then(append, append);
      return;
    }

    stderrPending = stderrPending.then(append, append);
  };

  return {
    on_stdout_chunk(chunk) {
      queueAppend("stdout", chunk);
    },
    on_stderr_chunk(chunk) {
      queueAppend("stderr", chunk);
    },
    async flush() {
      await Promise.all([stdoutPending, stderrPending]);
    }
  };
}

async function initializeWorkspace(
  backend: CompiledGraph["launch"]["workspace_backend"],
  runRoot: string,
  repoSources: Record<string, string>
): Promise<WorkspaceSetup> {
  return backend === "inplace"
    ? initializeInplaceWorkspace({
        run_root: runRoot,
        repo_sources: repoSources
      })
    : initializeWorktreeWorkspace({
        run_root: runRoot,
        repo_sources: repoSources
      });
}

function predictWorkspaceBindings(
  backend: CompiledGraph["launch"]["workspace_backend"],
  runRoot: string,
  repoSources: Record<string, string>
): Record<string, WorkspaceBinding> {
  return Object.fromEntries(
    Object.entries(repoSources).map(([repo_alias, source_path]) => [
      repo_alias,
      {
        repo_alias,
        source_path,
        workspace_path:
          backend === "inplace" ? source_path : resolve(runRoot, "workspaces", repo_alias),
        backend
      }
    ])
  );
}

function latestOutcomeOverall(session: RuntimeSession, compiledId: string): GraphOutcome | undefined {
  return listAttemptsForCompiledNode(session.attempts, compiledId).at(-1)?.outcome;
}

function getNodeIterationAttempts(
  session: RuntimeSession,
  compiledId: string,
  iterationIndex?: number
): RuntimeNodeAttempt[] {
  return listAttemptsForCompiledNode(session.attempts, compiledId).filter(
    (attempt) => attempt.iteration_index === iterationIndex
  );
}

function hasCompletedNodeIteration(
  session: RuntimeSession,
  compiledId: string,
  iterationIndex?: number
): boolean {
  return getNodeIterationAttempts(session, compiledId, iterationIndex).some(
    (attempt) => attempt.status !== "running"
  );
}

function hasActiveNodeIteration(
  session: RuntimeSession,
  compiledId: string,
  iterationIndex?: number
): boolean {
  return getNodeIterationAttempts(session, compiledId, iterationIndex).some(
    (attempt) => attempt.status === "running"
  );
}

function computeReadyDeps(
  session: RuntimeSession,
  topology: SchedulerTopology,
  node: CompiledExecutableNode,
  iterationIndex?: number
): string[] | undefined {
  const incomingEdges = getIncomingEdges(topology, node.compiled_id);

  if (incomingEdges.length === 0) {
    return [];
  }

  const satisfied: string[] = [];

  for (const edge of incomingEdges) {
    if (node.repeat_scope_id && isRepeatBodyEntryNode(topology, node.compiled_id, node.repeat_scope_id)) {
      if (iterationIndex === 1 && edge.kind === "repeat-back") {
        continue;
      }

      if (iterationIndex !== 1 && edge.kind !== "repeat-back" && edge.repeat_scope_id === undefined) {
        const outcome = latestOutcomeOverall(session, edge.from);

        if (outcome !== edge.on) {
          return undefined;
        }

        satisfied.push(edge.from);
        continue;
      }
    }

    const sourceNode = topology.nodes_by_id.get(edge.from);
    const outcome =
      node.repeat_scope_id && sourceNode?.repeat_scope_id === node.repeat_scope_id
        ? latestOutcomeForIteration(session.attempts, edge.from, iterationIndex)
        : latestOutcomeOverall(session, edge.from);

    if (outcome !== edge.on) {
      return undefined;
    }

    satisfied.push(edge.from);
  }

  return satisfied;
}

function createReadyQueueState() {
  return {
    queue: [] as ReadyNode[],
    queued_keys: new Set<string>()
  };
}

function createExecutionAbortControl(parentSignal: AbortSignal | undefined): ExecutionAbortControl {
  const controller = new AbortController();
  const onParentAbort = () => {
    controller.abort();
  };

  if (parentSignal?.aborted) {
    controller.abort();
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cancel() {
      controller.abort();
    },
    dispose() {
      parentSignal?.removeEventListener("abort", onParentAbort);
    }
  };
}

function cancelActiveExecutions(
  activeExecutions: Map<string, ActiveExecutionHandle>,
  excludeExecutionId?: string
): void {
  for (const [executionId, handle] of activeExecutions.entries()) {
    if (executionId === excludeExecutionId) {
      continue;
    }

    handle.cancel();
  }
}

function buildRunRecord(session: RuntimeSession, runOwner: RunOwnerRecord) {
  return {
    run_id: session.run_id,
    graph_id: session.graph.graph_id,
    launch_profile: session.graph.launch.launch_profile,
    workspace_backend: session.graph.launch.workspace_backend,
    status: session.status,
    started_at: session.started_at,
    ...(session.ended_at ? { ended_at: session.ended_at } : {}),
    ...(session.status === "pending" || session.status === "running"
      ? {
          ...(runOwner.owner_pid !== undefined ? { owner_pid: runOwner.owner_pid } : {}),
          ...(runOwner.owner_started_at ? { owner_started_at: runOwner.owner_started_at } : {}),
          ...(runOwner.owner_hostname ? { owner_hostname: runOwner.owner_hostname } : {})
        }
      : {})
  };
}

async function syncRunArtifacts(
  session: RuntimeSession,
  writer: ArtifactWriter,
  runOwner: RunOwnerRecord
): Promise<ReturnType<typeof buildRuntimeStateSnapshot>> {
  const state = buildRuntimeStateSnapshot(session);
  await Promise.all([
    writer.writeState(state),
    writer.writeRunRecord(buildRunRecord(session, runOwner))
  ]);
  return state;
}

async function writeTerminalRunSummary(
  session: RuntimeSession,
  writer: ArtifactWriter,
  events: RuntimeEventEnvelope[]
): Promise<ReturnType<typeof buildRuntimeStateSnapshot>> {
  const state = buildRuntimeStateSnapshot(session);
  await writer.writeRunSummary(renderRunSummary(state, flattenAttempts(session), events));
  return state;
}

async function emitEvent(
  session: RuntimeSession,
  writer: ArtifactWriter,
  runOwner: RunOwnerRecord,
  events: RuntimeEventEnvelope[],
  type: RuntimeEventEnvelope["type"],
  payload: unknown,
  context: RuntimeEventContext = {
    compiled_id: undefined,
    execution_id: undefined,
    repeat_scope_id: undefined,
    iteration_index: undefined,
    attempt_index: undefined
  }
): Promise<RuntimeEventEnvelope> {
  const event = createRuntimeEvent(
    session.next_event_seq,
    session.run_id,
    type,
    payload,
    context
  );
  session.next_event_seq += 1;
  events.push(event);
  await writer.appendEvent(event);
  await syncRunArtifacts(session, writer, runOwner);
  return event;
}

async function queueReadyNode(
  readyQueue: ReturnType<typeof createReadyQueueState>,
  session: RuntimeSession,
  writer: ArtifactWriter,
  runOwner: RunOwnerRecord,
  events: RuntimeEventEnvelope[],
  readyNode: ReadyNode
): Promise<void> {
  const key = createReadyNodeKey(readyNode);

  if (readyQueue.queued_keys.has(key)) {
    return;
  }

  readyQueue.queued_keys.add(key);
  readyQueue.queue.push(readyNode);
  setNodeStatus(session, readyNode.compiled_id, "ready");
  await emitEvent(session, writer, runOwner, events, "node.ready", {
    deps_satisfied: readyNode.deps_satisfied
  }, {
    compiled_id: readyNode.compiled_id,
    execution_id: undefined,
    repeat_scope_id: readyNode.repeat_scope_id,
    iteration_index: readyNode.iteration_index,
    attempt_index: undefined
  });
}

async function refreshReadyNodes(
  session: RuntimeSession,
  writer: ArtifactWriter,
  runOwner: RunOwnerRecord,
  events: RuntimeEventEnvelope[],
  topology: SchedulerTopology,
  readyQueue: ReturnType<typeof createReadyQueueState>
): Promise<void> {
  for (const [repeatScopeId, repeatScope] of session.repeat_scopes.entries()) {
    if (repeatScope.latest_iteration_index > 0 || repeatScope.status === "running") {
      continue;
    }

    const scope = topology.repeat_scopes_by_id.get(repeatScopeId);

    if (!scope) {
      continue;
    }

    const bodyEntryDeps = scope.body_entry_node_ids.map((compiledId) =>
      computeReadyDeps(
        session,
        topology,
        topology.nodes_by_id.get(compiledId)!,
        1
      )
    );

    if (bodyEntryDeps.some((deps) => deps === undefined)) {
      continue;
    }

    const opened = openRepeatIteration(session, repeatScopeId);
    await emitEvent(session, writer, runOwner, events, "repeat.iteration.started", {
      max_attempts: opened.max_attempts
    }, {
      compiled_id: undefined,
      execution_id: undefined,
      repeat_scope_id: repeatScopeId,
      iteration_index: opened.active_iteration_index,
      attempt_index: undefined
    });

    await Promise.all(
      scope.body_entry_node_ids.map((compiledId, index) =>
        queueReadyNode(readyQueue, session, writer, runOwner, events, {
          compiled_id: compiledId,
          deps_satisfied: bodyEntryDeps[index] ?? [],
          repeat_scope_id: repeatScopeId,
          iteration_index: opened.active_iteration_index
        })
      )
    );
  }

  for (const node of session.graph.nodes) {
    if (node.repeat_scope_id) {
      const repeatScope = session.repeat_scopes.get(node.repeat_scope_id);

      if (!repeatScope?.active_iteration_index) {
        continue;
      }

      if (isRepeatBodyEntryNode(topology, node.compiled_id, node.repeat_scope_id)) {
        continue;
      }

      if (hasCompletedNodeIteration(session, node.compiled_id, repeatScope.active_iteration_index)) {
        continue;
      }

      if (hasActiveNodeIteration(session, node.compiled_id, repeatScope.active_iteration_index)) {
        continue;
      }

      const depsSatisfied = computeReadyDeps(
        session,
        topology,
        node,
        repeatScope.active_iteration_index
      );

      if (depsSatisfied) {
        await queueReadyNode(readyQueue, session, writer, runOwner, events, {
          compiled_id: node.compiled_id,
          deps_satisfied: depsSatisfied,
          repeat_scope_id: node.repeat_scope_id,
          iteration_index: repeatScope.active_iteration_index
        });
      }

      continue;
    }

    if (hasCompletedNodeIteration(session, node.compiled_id)) {
      continue;
    }

    if (hasActiveNodeIteration(session, node.compiled_id)) {
      continue;
    }

    const depsSatisfied = computeReadyDeps(session, topology, node);

    if (depsSatisfied) {
      await queueReadyNode(readyQueue, session, writer, runOwner, events, {
        compiled_id: node.compiled_id,
        deps_satisfied: depsSatisfied,
        repeat_scope_id: undefined,
        iteration_index: undefined
      });
    }
  }
}

function canDispatchReadyNode(
  session: RuntimeSession,
  topology: SchedulerTopology,
  node: CompiledExecutableNode
): boolean {
  const parallelScopes = getNodeParallelScopes(topology, node.compiled_id).filter(
    (scope) => scope.max_concurrency !== undefined
  );

  if (parallelScopes.length === 0) {
    return true;
  }

  const activeNodes = [...session.active_executions.values()].map((activeExecution) =>
    topology.nodes_by_id.get(activeExecution.compiled_id)
  );

  return parallelScopes.every((scope) => {
    const activeCount = activeNodes.filter((activeNode) =>
      activeNode?.scope_stack.includes(scope.scope_id)
    ).length;

    return activeCount < (scope.max_concurrency ?? Number.MAX_SAFE_INTEGER);
  });
}

async function defaultExecExecutor(
  context: RuntimeNodeExecutorContext<CompiledExecNode>
): Promise<RuntimeNodeExecutionResult> {
  const processResult = await runLocalProcess({
    command: context.node.command,
    args: context.node.args,
    cwd: context.node.cwd ? resolve(context.workspace_path, context.node.cwd) : context.workspace_path,
    env: context.node.env,
    timeout_sec: context.node.effective_policy.timeout_sec,
    signal: context.signal
  });

  if (processResult.canceled) {
    return {
      status: "canceled",
      result: processResult,
      stdout: processResult.stdout,
      stderr: processResult.stderr
    };
  }

  return {
    status: processResult.exit_code === 0 && !processResult.timed_out ? "passed" : "failed",
    outcome: processResult.exit_code === 0 && !processResult.timed_out ? "passed" : "failed",
    result: processResult,
    stdout: processResult.stdout,
    stderr: processResult.stderr
  };
}

async function defaultCheckExecutor(
  context: RuntimeNodeExecutorContext<CompiledCheckNode>,
  harnesses: Partial<Record<HarnessName, HarnessAdapter>>
): Promise<RuntimeNodeExecutionResult> {
  if (context.node.check_kind === "deterministic") {
    const result = await runDeterministicCheck({
      command: context.node.command ?? "",
      args: context.node.args ?? [],
      cwd: context.node.cwd ? resolve(context.workspace_path, context.node.cwd) : context.workspace_path,
      env: undefined,
      timeout_sec: context.node.effective_policy.timeout_sec,
      pass_if: context.node.pass_if,
      signal: context.signal
    });

    if (result.canceled) {
      return {
        status: "canceled",
        result,
        stdout: result.stdout,
        stderr: result.stderr
      };
    }

    return {
      status: result.passed ? "passed" : "failed",
      outcome: result.passed ? "passed" : "failed",
      result,
      stdout: result.stdout,
      stderr: result.stderr,
      check: {
        check_kind: "deterministic",
        passed: result.passed,
        summary: result.summary
      }
    };
  }

  const harnessName = context.node.effective_policy.harness;

  if (!harnessName || !harnesses[harnessName]) {
    throw new Error(`AI check "${context.node.compiled_id}" requires harness "${harnessName ?? "unknown"}".`);
  }

  const aiCheckResult = await runAiCheck({
    harness: harnesses[harnessName]!,
    run_id: context.run_id,
    execution_id: context.attempt.execution_id,
    repo_alias: context.node.repo,
    repo_path: context.workspace_path,
    model: context.node.effective_policy.model,
    ...(context.node.effective_policy.reasoning_effort
      ? { reasoning_effort: context.node.effective_policy.reasoning_effort }
      : {}),
    prompt: context.node.prompt ?? "",
    rubric: context.node.rubric,
    context_packet_path: context.context_packet_path,
    output_dir: context.execution_dir,
    timeout_sec: context.node.effective_policy.timeout_sec,
    signal: context.signal,
    ...(context.on_stdout_chunk ? { on_stdout_chunk: context.on_stdout_chunk } : {}),
    ...(context.on_stderr_chunk ? { on_stderr_chunk: context.on_stderr_chunk } : {})
  });
  const { harness_result, evaluation } = aiCheckResult;

  if (harness_result.status === "canceled") {
    return {
      status: "canceled",
      result: {
        exit_code: harness_result.exitCode,
        metadata: harness_result.metadata ?? {}
      },
      stdout: harness_result.stdout,
      stderr: harness_result.stderr
    };
  }

  const passed = harness_result.status === "passed" && evaluation.passed;

  return {
    status: passed ? "passed" : "failed",
    outcome: passed ? "passed" : "failed",
    result: {
      exit_code: harness_result.exitCode,
      passed,
      score: evaluation.score,
      summary: evaluation.summary,
      issues: evaluation.issues,
      raw: evaluation.raw,
      metadata: harness_result.metadata ?? {}
    },
    stdout: harness_result.stdout,
    stderr: harness_result.stderr,
    check: {
      check_kind: "ai",
      passed,
      ...(evaluation.score !== undefined ? { score: evaluation.score } : {}),
      ...(evaluation.summary ? { summary: evaluation.summary } : {})
    }
  };
}

async function defaultAgentExecutor(
  context: RuntimeNodeExecutorContext<CompiledAgentNode>,
  harnesses: Partial<Record<HarnessName, HarnessAdapter>>
): Promise<RuntimeNodeExecutionResult> {
  const harnessName = context.node.effective_policy.harness;

  if (!harnessName || !harnesses[harnessName]) {
    throw new Error(`Agent "${context.node.compiled_id}" requires harness "${harnessName ?? "unknown"}".`);
  }

  const harnessResult = await harnesses[harnessName]!.run({
    runId: context.run_id,
    executionId: context.attempt.execution_id,
    repoAlias: context.node.repo,
    repoPath: context.workspace_path,
    sandbox: context.node.effective_policy.sandbox ?? "workspace-write",
    model: context.node.effective_policy.model,
    ...(context.node.effective_policy.reasoning_effort
      ? { reasoningEffort: context.node.effective_policy.reasoning_effort }
      : {}),
    prompt: context.node.prompt,
    contextPacketPath: context.context_packet_path,
    outputDir: context.execution_dir,
    timeoutSec: context.node.effective_policy.timeout_sec,
    signal: context.signal,
    ...(context.on_stdout_chunk ? { onStdoutChunk: context.on_stdout_chunk } : {}),
    ...(context.on_stderr_chunk ? { onStderrChunk: context.on_stderr_chunk } : {})
  });

  return {
    status: harnessResult.status,
    ...(harnessResult.status !== "canceled" ? { outcome: harnessResult.status } : {}),
    result: {
      exit_code: harnessResult.exitCode,
      metadata: harnessResult.metadata ?? {}
    },
    stdout: harnessResult.stdout,
    stderr: harnessResult.stderr,
    ...(harnessResult.metadata ? { metadata: harnessResult.metadata } : {})
  };
}

async function executeNode(
  options: RunCompiledGraphOptions,
  session: RuntimeSession,
  writer: ArtifactWriter,
  node: CompiledExecutableNode,
  attempt: RuntimeNodeAttempt,
  signal: AbortSignal | undefined
): Promise<{
  node: CompiledExecutableNode;
  attempt: RuntimeNodeAttempt;
  result: RuntimeNodeExecutionResult;
}> {
  const workspace = session.manifest.repo_workspaces[node.repo];

  if (!workspace) {
    throw new Error(`Missing workspace binding for repo "${node.repo}".`);
  }
  const packet_path = join(attempt.execution_dir, "context_packet.json");
  const summary_path = join(attempt.execution_dir, "context_summary.md");
  let executionPaths:
    | Awaited<ReturnType<ArtifactWriter["writeExecutionStart"]>>
    | undefined;
  let logSink: StreamingLogSink | undefined;

  try {
    const context = await resolveExecutionContext({
      compiled_graph: session.graph,
      node,
      execution_id: attempt.execution_id,
      execution_dir: attempt.execution_dir,
      workspace_path: workspace.workspace_path,
      repo_workspaces: Object.fromEntries(
        Object.entries(session.manifest.repo_workspaces).map(([repoAlias, binding]) => [
          repoAlias,
          binding.workspace_path
        ])
      ),
      attempts: session.attempts
    });

    executionPaths = await writer.writeExecutionStart(attempt, {
      packet_path: context.packet_path,
      summary_path: context.summary_path
    });
    logSink = createStreamingLogSink(writer, executionPaths);

    let result: RuntimeNodeExecutionResult;

    if (node.kind === "exec") {
      result = options.executors?.exec
        ? await options.executors.exec({
            run_id: session.run_id,
            node,
            attempt,
            workspace_path: workspace.workspace_path,
            execution_dir: attempt.execution_dir,
            context_packet_path: context.packet_path,
            context_summary_path: context.summary_path,
            signal,
            on_stdout_chunk: logSink.on_stdout_chunk,
            on_stderr_chunk: logSink.on_stderr_chunk
          })
        : await defaultExecExecutor({
            run_id: session.run_id,
            node,
            attempt,
            workspace_path: workspace.workspace_path,
            execution_dir: attempt.execution_dir,
            context_packet_path: context.packet_path,
            context_summary_path: context.summary_path,
            signal
          });
    } else if (node.kind === "check") {
      result = options.executors?.check
        ? await options.executors.check({
            run_id: session.run_id,
            node,
            attempt,
            workspace_path: workspace.workspace_path,
            execution_dir: attempt.execution_dir,
            context_packet_path: context.packet_path,
            context_summary_path: context.summary_path,
            signal,
            on_stdout_chunk: logSink.on_stdout_chunk,
            on_stderr_chunk: logSink.on_stderr_chunk
          })
        : await defaultCheckExecutor(
            {
              run_id: session.run_id,
              node,
              attempt,
              workspace_path: workspace.workspace_path,
              execution_dir: attempt.execution_dir,
              context_packet_path: context.packet_path,
              context_summary_path: context.summary_path,
              signal
            },
            options.harnesses ?? {}
          );
    } else {
      result = options.executors?.agent
        ? await options.executors.agent({
            run_id: session.run_id,
            node,
            attempt,
            workspace_path: workspace.workspace_path,
            execution_dir: attempt.execution_dir,
            context_packet_path: context.packet_path,
            context_summary_path: context.summary_path,
            signal
          })
        : await defaultAgentExecutor(
            {
              run_id: session.run_id,
              node,
              attempt,
              workspace_path: workspace.workspace_path,
            execution_dir: attempt.execution_dir,
            context_packet_path: context.packet_path,
            context_summary_path: context.summary_path,
            signal,
            on_stdout_chunk: logSink.on_stdout_chunk,
            on_stderr_chunk: logSink.on_stderr_chunk
          },
          options.harnesses ?? {}
        );
    }

    await logSink.flush();

    await writer.writeExecutionCompletion(attempt, {
      result: result.result,
      ...(result.stdout !== undefined ? { stdout: result.stdout } : {}),
      ...(result.stderr !== undefined ? { stderr: result.stderr } : {})
    });

    const output_artifacts =
      result.status === "canceled"
        ? {}
        : await writer.materializeDeclaredOutputs(node, attempt, workspace.workspace_path);

    const completedAttempt = closeNodeAttempt(session.attempts, attempt.execution_id, {
      status: result.status,
      ...(result.outcome ? { outcome: result.outcome } : {}),
      stdout_log_path: executionPaths.stdout_log_path,
      stderr_log_path: executionPaths.stderr_log_path,
      result_path: executionPaths.result_path,
      context_packet_path: context.packet_path,
      context_summary_path: context.summary_path,
      output_artifacts,
      ...(result.metadata ? { metadata: result.metadata } : {})
    });

    await writer.writeExecutionCompletion(completedAttempt, {
      result: result.result,
      ...(result.stdout !== undefined ? { stdout: result.stdout } : {}),
      ...(result.stderr !== undefined ? { stderr: result.stderr } : {})
    });

    return {
      node,
      attempt: completedAttempt,
      result
    };
  } catch (error) {
    if (!executionPaths) {
      executionPaths = await writer.writeExecutionStart(attempt, {
        packet_path,
        summary_path
      });
      logSink = createStreamingLogSink(writer, executionPaths);
    }

    if (logSink) {
      await logSink.flush();
    }

    const message = error instanceof Error ? error.message : String(error);
    const completedAttempt = closeNodeAttempt(session.attempts, attempt.execution_id, {
      status: "failed",
      outcome: "failed",
      stdout_log_path: executionPaths.stdout_log_path,
      stderr_log_path: executionPaths.stderr_log_path,
      result_path: executionPaths.result_path,
      context_packet_path: packet_path,
      context_summary_path: summary_path,
      metadata: {
        error: message
      }
    });

    await writer.writeExecutionCompletion(completedAttempt, {
      result: {
        error: message
      },
      stderr: message
    });

    return {
      node,
      attempt: completedAttempt,
      result: {
        status: "failed",
        outcome: "failed",
        result: {
          error: message
        },
        stdout: undefined,
        stderr: message,
        metadata: {
          error: message
        }
      }
    };
  }
}

async function startReadyNode(
  options: RunCompiledGraphOptions,
  session: RuntimeSession,
  writer: ArtifactWriter,
  runOwner: RunOwnerRecord,
  events: RuntimeEventEnvelope[],
  activeExecutions: Map<string, ActiveExecutionHandle>,
  readyQueue: ReturnType<typeof createReadyQueueState>,
  topology: SchedulerTopology
): Promise<boolean> {
  for (let index = 0; index < readyQueue.queue.length; index += 1) {
    const readyNode = readyQueue.queue[index];

    if (!readyNode) {
      continue;
    }

    const node = topology.nodes_by_id.get(readyNode.compiled_id);

    if (!node) {
      continue;
    }

    if (!canDispatchReadyNode(session, topology, node)) {
      continue;
    }

    readyQueue.queue.splice(index, 1);
    readyQueue.queued_keys.delete(createReadyNodeKey(readyNode));

    const nextAttemptIndex = peekNextAttemptIndex(session.attempts, node.compiled_id);
    const executionId = buildExecutionId(node.compiled_id, nextAttemptIndex, {
      ...(readyNode.repeat_scope_id ? { repeat_scope_id: readyNode.repeat_scope_id } : {}),
      ...(readyNode.iteration_index !== undefined ? { iteration_index: readyNode.iteration_index } : {})
    });
    const executionDir = writer.getExecutionDirectory(node.compiled_id, executionId);
    const attempt = openNodeAttempt(session.attempts, node, executionDir, {
      ...(readyNode.repeat_scope_id ? { repeat_scope_id: readyNode.repeat_scope_id } : {}),
      ...(readyNode.iteration_index !== undefined ? { iteration_index: readyNode.iteration_index } : {})
    });
    registerActiveExecution(session, attempt);
    const abortControl = createExecutionAbortControl(options.signal);
    const execution = executeNode(
      options,
      session,
      writer,
      node,
      attempt,
      abortControl.signal
    ).finally(() => {
      abortControl.dispose();
    });

    await emitEvent(session, writer, runOwner, events, "node.started", {
      kind: node.kind,
      repo_alias: node.repo,
      profile_name: node.effective_policy.profile_name
    }, {
      compiled_id: node.compiled_id,
      execution_id: attempt.execution_id,
      repeat_scope_id: readyNode.repeat_scope_id,
      iteration_index: readyNode.iteration_index,
      attempt_index: attempt.attempt_index
    });
    activeExecutions.set(attempt.execution_id, {
      ready_node: readyNode,
      attempt,
      node,
      cancel: abortControl.cancel,
      promise: execution
    });
    return true;
  }

  return false;
}

function hasFailureContinuation(
  topology: SchedulerTopology,
  node: CompiledExecutableNode
): boolean {
  return getOutgoingEdges(topology, node.compiled_id).some((edge) => edge.on === "failed");
}

async function markPendingNodesBlocked(
  session: RuntimeSession,
  writer: ArtifactWriter,
  runOwner: RunOwnerRecord,
  events: RuntimeEventEnvelope[],
  failedNode: CompiledExecutableNode
): Promise<void> {
  for (const [compiledId, status] of session.node_statuses.entries()) {
    if (!["pending", "ready"].includes(status)) {
      continue;
    }

    setNodeStatus(session, compiledId, "blocked");
    await emitEvent(session, writer, runOwner, events, "node.blocked", {
      reason: "terminal_failure",
      upstream_compiled_id: failedNode.compiled_id
    }, {
      compiled_id: compiledId,
      execution_id: undefined,
      repeat_scope_id: undefined,
      iteration_index: undefined,
      attempt_index: undefined
    });
  }
}

async function markPendingNodesSkipped(
  session: RuntimeSession,
  writer: ArtifactWriter,
  runOwner: RunOwnerRecord,
  events: RuntimeEventEnvelope[],
  reason: string
): Promise<void> {
  for (const [compiledId, status] of session.node_statuses.entries()) {
    if (!["pending", "ready"].includes(status)) {
      continue;
    }

    setNodeStatus(session, compiledId, "skipped");
    await emitEvent(session, writer, runOwner, events, "node.skipped", {
      reason
    }, {
      compiled_id: compiledId,
      execution_id: undefined,
      repeat_scope_id: undefined,
      iteration_index: undefined,
      attempt_index: undefined
    });
  }
}

async function finalizeRun(
  session: RuntimeSession,
  writer: ArtifactWriter,
  runOwner: RunOwnerRecord,
  events: RuntimeEventEnvelope[],
  outcome: RuntimeRunStatus,
  reason?: string
): Promise<RunCompiledGraphResult> {
  session.status = outcome;
  session.ended_at = new Date().toISOString();
  const duration_ms = Math.max(0, Date.parse(session.ended_at) - Date.parse(session.started_at));

  if (outcome === "canceled") {
    await emitEvent(session, writer, runOwner, events, "run.canceled", {
      reason: reason ?? "operator_cancel"
    });
  } else {
    await emitEvent(session, writer, runOwner, events, "run.completed", {
      outcome,
      duration_ms,
      ...(reason ? { reason } : {})
    });
  }

  const attempts = flattenAttempts(session);
  const state = await writeTerminalRunSummary(session, writer, events);

  return {
    run_id: session.run_id,
    run_root: writer.run_root,
    outcome,
    state,
    attempts,
    events: await readRunEvents(writer.run_root)
  };
}

async function finalizeRunWithWorkspaceCleanup(
  session: RuntimeSession,
  writer: ArtifactWriter,
  runOwner: RunOwnerRecord,
  events: RuntimeEventEnvelope[],
  workspace: WorkspaceSetup | undefined,
  outcome: RuntimeRunStatus,
  reason?: string
): Promise<RunCompiledGraphResult> {
  let finalOutcome = outcome;
  let finalReason = reason;

  if (workspace) {
    try {
      await workspace.cleanup();
    } catch (error) {
      finalOutcome = "failed";
      const message = error instanceof Error ? error.message : String(error);
      finalReason = finalReason
        ? `${finalReason} | Workspace cleanup failed: ${message}`
        : `Workspace cleanup failed: ${message}`;
    }
  }

  return finalizeRun(session, writer, runOwner, events, finalOutcome, finalReason);
}

function collectPreflightDiagnostics(
  graph: CompiledGraph,
  repoSources: Record<string, string>,
  executors: RuntimeExecutorRegistry | undefined,
  harnesses: Partial<Record<HarnessName, HarnessAdapter>> | undefined
): string[] {
  const diagnostics: string[] = [];
  const checkedHarnesses = new Set<HarnessName>();

  for (const node of graph.nodes) {
    if (!(node.repo in repoSources)) {
      diagnostics.push(`Missing repo source for alias "${node.repo}".`);
    }

    if (node.kind === "agent" && !executors?.agent) {
      const harnessName = node.effective_policy.harness;

      if (!harnessName || !harnesses?.[harnessName]) {
        diagnostics.push(`Agent node "${node.compiled_id}" has no executor or harness adapter.`);
      } else if (!checkedHarnesses.has(harnessName)) {
        diagnostics.push(...(harnesses[harnessName]!.preflight?.() ?? []));
        checkedHarnesses.add(harnessName);
      }
    }

    if (node.kind === "check" && node.check_kind === "ai" && !executors?.check) {
      const harnessName = node.effective_policy.harness;

      if (!harnessName || !harnesses?.[harnessName]) {
        diagnostics.push(`AI check node "${node.compiled_id}" has no executor or harness adapter.`);
      } else if (!checkedHarnesses.has(harnessName)) {
        diagnostics.push(...(harnesses[harnessName]!.preflight?.() ?? []));
        checkedHarnesses.add(harnessName);
      }
    }
  }

  return diagnostics;
}

function buildInitializeArtifactsOptions(
  options: RunCompiledGraphOptions,
  session: RuntimeSession,
  runOwner: RunOwnerRecord
): {
  run_id: string;
  graph: CompiledGraph;
  authored_graph?: AuthoredGraphDocument;
  manifest: RuntimeSession["manifest"];
  compile_diagnostics: GraphDiagnostic[];
  state: ReturnType<typeof buildRuntimeStateSnapshot>;
} & RunOwnerRecord {
  return {
    run_id: session.run_id,
    graph: options.compiled_graph,
    ...(options.authored_graph ? { authored_graph: options.authored_graph } : {}),
    manifest: session.manifest,
    compile_diagnostics: options.compile_diagnostics ?? [],
    state: buildRuntimeStateSnapshot(session),
    ...(session.status === "pending" || session.status === "running"
      ? {
          ...(runOwner.owner_pid !== undefined ? { owner_pid: runOwner.owner_pid } : {}),
          ...(runOwner.owner_started_at ? { owner_started_at: runOwner.owner_started_at } : {}),
          ...(runOwner.owner_hostname ? { owner_hostname: runOwner.owner_hostname } : {})
        }
      : {})
  };
}

export async function runCompiledGraph(
  options: RunCompiledGraphOptions
): Promise<RunCompiledGraphResult> {
  const run_id = deriveRunId(options.run_root);
  const writer = new ArtifactWriter(options.run_root);
  const predictedBindings = predictWorkspaceBindings(
    options.compiled_graph.launch.workspace_backend,
    options.run_root,
    options.repo_sources
  );
  const session = createRuntimeSession(
    run_id,
    options.compiled_graph,
    createAttemptRegistry(),
    predictedBindings
  );
  const events: RuntimeEventEnvelope[] = [];
  const topology = buildSchedulerTopology(options.compiled_graph);
  const readyQueue = createReadyQueueState();
  const activeExecutions = new Map<string, ActiveExecutionHandle>();
  const runOwner = await createRunOwnerRecord();
  let workspace: WorkspaceSetup | undefined;

  await writer.initializeRunArtifacts(buildInitializeArtifactsOptions(options, session, runOwner));
  await emitEvent(session, writer, runOwner, events, "graph.compiled", {
    graph_id: options.compiled_graph.graph_id,
    compiled_node_count: options.compiled_graph.nodes.length,
    scope_count: options.compiled_graph.scopes.length
  });

  const preflightDiagnostics = collectPreflightDiagnostics(
    options.compiled_graph,
    options.repo_sources,
    options.executors,
    options.harnesses
  );

  if (preflightDiagnostics.length > 0) {
    session.status = "failed";
    session.ended_at = new Date().toISOString();
    await emitEvent(session, writer, runOwner, events, "run.preflight_failed", {
      reason: "preflight",
      message: preflightDiagnostics.join(" | ")
    });
    const state = await writeTerminalRunSummary(session, writer, events);

    return {
      run_id,
      run_root: writer.run_root,
      outcome: "failed",
      state,
      attempts: [],
      events: await readRunEvents(writer.run_root)
    };
  }

  try {
    workspace = await initializeWorkspace(
      options.compiled_graph.launch.workspace_backend,
      options.run_root,
      options.repo_sources
    );
    session.manifest.repo_workspaces = workspace.repo_workspaces;
  } catch (error) {
    session.status = "failed";
    session.ended_at = new Date().toISOString();
    await writer.initializeRunArtifacts(buildInitializeArtifactsOptions(options, session, runOwner));
    await emitEvent(session, writer, runOwner, events, "run.preflight_failed", {
      reason: "workspace_backend_init",
      message: error instanceof Error ? error.message : String(error)
    });
    const state = await writeTerminalRunSummary(session, writer, events);

    return {
      run_id,
      run_root: writer.run_root,
      outcome: "failed",
      state,
      attempts: [],
      events: await readRunEvents(writer.run_root)
    };
  }

  session.status = "running";
  await writer.initializeRunArtifacts(buildInitializeArtifactsOptions(options, session, runOwner));
  await emitEvent(session, writer, runOwner, events, "run.started", {
    workspace_backend: session.manifest.workspace_backend,
    repo_workspaces: session.manifest.repo_workspaces
  });

  while (true) {
    if (options.signal?.aborted && session.status !== "canceled") {
      session.status = "canceled";
      await markPendingNodesSkipped(session, writer, runOwner, events, "operator_cancel");
      cancelActiveExecutions(activeExecutions);
    }

    if (session.status === "running") {
      await refreshReadyNodes(session, writer, runOwner, events, topology, readyQueue);
    }

    while (
      session.status === "running" &&
      (await startReadyNode(
        options,
        session,
        writer,
        runOwner,
        events,
        activeExecutions,
        readyQueue,
        topology
      ))
    ) {
      // Keep dispatching while the scheduler can consume ready nodes.
    }

    if (session.status === "canceled" && activeExecutions.size === 0) {
      return finalizeRunWithWorkspaceCleanup(
        session,
        writer,
        runOwner,
        events,
        workspace,
        "canceled",
        "operator_cancel"
      );
    }

    if (session.status === "failed" && activeExecutions.size === 0) {
      return finalizeRunWithWorkspaceCleanup(
        session,
        writer,
        runOwner,
        events,
        workspace,
        "failed"
      );
    }

    if (session.status === "running" && activeExecutions.size === 0) {
      const remainingReady = readyQueue.queue.length > 0;
      const unfinishedNodes = [...session.node_statuses.values()].some((status) =>
        ["pending", "ready", "running"].includes(status)
      );

      if (!remainingReady && !unfinishedNodes) {
        return finalizeRunWithWorkspaceCleanup(
          session,
          writer,
          runOwner,
          events,
          workspace,
          "passed"
        );
      }

      if (!remainingReady && unfinishedNodes && session.status === "running") {
        session.status = "failed";
        const failedNode =
          session.graph.nodes.find((candidate) => session.node_statuses.get(candidate.compiled_id) === "failed") ??
          session.graph.nodes[0];

        if (!failedNode) {
          return finalizeRunWithWorkspaceCleanup(
            session,
            writer,
            runOwner,
            events,
            workspace,
            "failed"
          );
        }

        await markPendingNodesBlocked(
          session,
          writer,
          runOwner,
          events,
          failedNode
        );
        return finalizeRunWithWorkspaceCleanup(
          session,
          writer,
          runOwner,
          events,
          workspace,
          "failed"
        );
      }
    }

    const completion = await Promise.race(
      [...activeExecutions.values()].map(async (handle) => ({
        execution_id: handle.attempt.execution_id,
        completed: await handle.promise
      }))
    );

    activeExecutions.delete(completion.execution_id);
    const { node, attempt, result } = completion.completed;
    finalizeExecutionSummary(session, attempt);

    if (result.check) {
      await emitEvent(session, writer, runOwner, events, "check.evaluated", result.check, {
        compiled_id: node.compiled_id,
        execution_id: attempt.execution_id,
        repeat_scope_id: attempt.repeat_scope_id,
        iteration_index: attempt.iteration_index,
        attempt_index: attempt.attempt_index
      });
    }

    if (result.status === "canceled") {
      await emitEvent(session, writer, runOwner, events, "node.canceled", {
        reason: session.status === "failed" ? "terminal_failure" : "operator_cancel"
      }, {
        compiled_id: node.compiled_id,
        execution_id: attempt.execution_id,
        repeat_scope_id: attempt.repeat_scope_id,
        iteration_index: attempt.iteration_index,
        attempt_index: attempt.attempt_index
      });
      continue;
    }

    const outcome = result.outcome ?? "failed";
    await emitEvent(session, writer, runOwner, events, "node.completed", {
      outcome,
      duration_ms: attempt.duration_ms ?? 0
    }, {
      compiled_id: node.compiled_id,
      execution_id: attempt.execution_id,
      repeat_scope_id: attempt.repeat_scope_id,
      iteration_index: attempt.iteration_index,
      attempt_index: attempt.attempt_index
    });

    const repeatScopeId = node.repeat_scope_id;
    const repeatScope = repeatScopeId ? session.repeat_scopes.get(repeatScopeId) : undefined;

    if (
      repeatScope &&
      repeatScopeId &&
      node.compiled_id === repeatScope.until_compiled_id &&
      attempt.iteration_index !== undefined
    ) {
      await emitEvent(session, writer, runOwner, events, "repeat.iteration.completed", {
        outcome,
        iteration_index: attempt.iteration_index
      }, {
        compiled_id: undefined,
        execution_id: undefined,
        repeat_scope_id: repeatScopeId,
        iteration_index: attempt.iteration_index,
        attempt_index: undefined
      });

      if (outcome === "failed") {
        const attemptsRemaining = repeatScope.latest_iteration_index < repeatScope.max_attempts;

        if (attemptsRemaining) {
          const updatedScope = openRepeatIteration(session, repeatScopeId);
          await emitEvent(session, writer, runOwner, events, "repeat.iteration.started", {
            max_attempts: updatedScope.max_attempts
          }, {
            compiled_id: undefined,
            execution_id: undefined,
            repeat_scope_id: repeatScopeId,
            iteration_index: updatedScope.active_iteration_index,
            attempt_index: undefined
          });

          const bodyEntryDeps = topology.repeat_scopes_by_id.get(repeatScopeId)?.body_entry_node_ids.map(
            (compiledId) =>
              computeReadyDeps(
                session,
                topology,
                topology.nodes_by_id.get(compiledId)!,
                updatedScope.active_iteration_index
              ) ?? []
          ) ?? [];

          await Promise.all(
            (topology.repeat_scopes_by_id.get(repeatScopeId)?.body_entry_node_ids ?? []).map(
              (compiledId, index) =>
                queueReadyNode(readyQueue, session, writer, runOwner, events, {
                  compiled_id: compiledId,
                  deps_satisfied: bodyEntryDeps[index] ?? [],
                  repeat_scope_id: repeatScopeId,
                  iteration_index: updatedScope.active_iteration_index
                })
            )
          );
          continue;
        }

        completeRepeatIteration(session, repeatScopeId, "failed");
        session.status = "failed";
        await markPendingNodesBlocked(session, writer, runOwner, events, node);
        cancelActiveExecutions(activeExecutions);
        continue;
      }

      completeRepeatIteration(session, repeatScopeId, "passed");
      continue;
    }

    if (outcome === "failed" && !hasFailureContinuation(topology, node)) {
      session.status = "failed";
      await markPendingNodesBlocked(session, writer, runOwner, events, node);
      cancelActiveExecutions(activeExecutions);
      continue;
    }
  }
}

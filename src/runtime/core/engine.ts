import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { resolveSubpathWithinRoot } from "../../path_rules.js";
import type { ArtifactDefinition, AuthoredGraphDocument } from "../../graph/authored.js";
import type {
  CompiledAgentNode,
  CompiledCheckNode,
  CompiledCheckpointNode,
  CompiledExecNode,
  CompiledExecutableNode,
  CompiledGraph
} from "../../graph/compiled.js";
import { collectReferencedRepoAliases } from "../../graph/repo_aliases.js";
import { createRunOwnerRecord, type RunOwnerRecord } from "../../artifacts/owner.js";
import type { GraphDiagnostic, GraphOutcome, HarnessName, SupervisorActionKind } from "../../graph/schema.js";
import { ArtifactWriter } from "../../artifacts/writer.js";
import {
  readRunEvents,
  readRunExecutionAttempts,
  readSupervisorInterventions
} from "../../artifacts/reader.js";
import { resolveExecutionArtifactsDirectory } from "../../artifacts/paths.js";
import { renderRunSummary } from "../delivery/summary.js";
import { writeDeliveryPackage, type DeliveryPackageManifest } from "../delivery/package.js";
import {
  buildExecutionId,
  closeNodeAttempt,
  createAttemptRegistry,
  latestOutcomeForIteration,
  listAttemptsForCompiledNode,
  openNodeAttempt,
  peekNextAttemptIndexes,
  type RuntimeNodeAttempt
} from "../attempts.js";
import { runAiCheck } from "../checks/ai.js";
import { runDeterministicCheck, runLocalProcess } from "../checks/deterministic.js";
import { resolveExecutionContext } from "../context/resolve.js";
import type { ContextPacketMaterializedItem } from "../context/packet.js";
import { evaluateGraphReadiness } from "../readiness.js";
import { prepareAgentTools } from "../tools/setup.js";
import {
  createRuntimeEvent,
  type CheckEvaluatedPayload,
  type RuntimeEventContext,
  type RuntimeEventEnvelope,
  type VerificationRecordedPayload
} from "../events.js";
import type { HarnessAdapter } from "../harness/types.js";
import { substituteAgentflowTokens } from "../harness/tokens.js";
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
import { captureWorkspaceChanges } from "../workspace/changes.js";
import { initializeWorktreeWorkspace } from "../workspace/worktree.js";
import { runEvidenceIntervention, runRepairArtifactIntervention } from "../../supervisor/actions.js";
import { classifyNodeFailure, type FailureClassification } from "../../supervisor/classifier.js";
import {
  canSpendSupervisorAction,
  spendSupervisorAction,
  type SupervisorBudgetState
} from "../../supervisor/policy.js";
import type { SupervisorDecision, SupervisorInterventionRecord } from "../../supervisor/types.js";
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
  verification?: VerificationRecordedPayload;
  verification_artifact?: Record<string, unknown>;
  agent_response?: string;
}

export interface RuntimeNodeExecutorContext<TNode extends CompiledExecutableNode> {
  run_root: string;
  run_id: string;
  graph_id: string;
  graph_intent: CompiledGraph["intent"];
  credential_specs?: CompiledGraph["credential_specs"];
  node: TNode;
  attempt: RuntimeNodeAttempt;
  workspace_path: string;
  execution_dir: string;
  context_packet_path: string;
  context_manifest_path: string;
  context_materials?: ContextPacketMaterializedItem[];
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
  checkpoint?: RuntimeNodeExecutor<CompiledCheckpointNode>;
}

export interface RunCompiledGraphOptions {
  run_root: string;
  compiled_graph: CompiledGraph;
  repo_sources: Record<string, string>;
  graph_path?: string;
  authored_graph?: AuthoredGraphDocument;
  compile_diagnostics?: GraphDiagnostic[];
  executors?: RuntimeExecutorRegistry;
  harnesses?: Partial<Record<HarnessName, HarnessAdapter>>;
  signal?: AbortSignal;
  on_event?: (event: RuntimeEventEnvelope) => Promise<void> | void;
}

export interface ResumeCompiledGraphOptions extends RunCompiledGraphOptions {
  resumed_session: RuntimeSession;
  prior_events: RuntimeEventEnvelope[];
  workspace: WorkspaceSetup;
  previous_status: RuntimeRunStatus;
  preserved_node_count: number;
  restarted_node_count: number;
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

interface NodeReadinessCache {
  harnesses: Map<HarnessName, Promise<string[]>>;
}

interface MissingDeclaredArtifact {
  name: string;
  from: ArtifactDefinition["from"];
  path: string;
  description: string;
  expected_path: string;
}

interface ArtifactRepairMetadata {
  status: "passed" | "failed";
  max_attempts: number;
  attempt_count: number;
  missing_artifacts: string[];
}

class ArtifactMaterializationError extends Error {
  readonly repair_metadata: ArtifactRepairMetadata | undefined;

  constructor(message: string, repairMetadata?: ArtifactRepairMetadata) {
    super(message);
    this.name = "ArtifactMaterializationError";
    this.repair_metadata = repairMetadata;
  }
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

function createNodeReadinessCache(): NodeReadinessCache {
  return {
    harnesses: new Map()
  };
}

function filterActiveRepoSources(
  graph: CompiledGraph,
  repoSources: Record<string, string>
): Record<string, string> {
  const activeAliases = new Set(collectReferencedRepoAliases(graph));

  return Object.fromEntries(
    Object.entries(repoSources).filter(([repoAlias]) => activeAliases.has(repoAlias))
  );
}

async function collectHarnessReadinessDiagnostics(
  harnessName: HarnessName,
  harnesses: Partial<Record<HarnessName, HarnessAdapter>> | undefined,
  cache: NodeReadinessCache
): Promise<string[]> {
  const cached = cache.harnesses.get(harnessName);

  if (cached) {
    return cached;
  }

  const harness = harnesses?.[harnessName];

  if (!harness) {
    const diagnostics = Promise.resolve([
      `Harness adapter "${harnessName}" is unavailable at runtime.`
    ]);
    cache.harnesses.set(harnessName, diagnostics);
    return diagnostics;
  }

  const diagnostics = Promise.resolve(harness.checkReadiness?.() ?? []);
  cache.harnesses.set(harnessName, diagnostics);
  return diagnostics;
}

async function ensureNodeReadiness(
  node: CompiledExecutableNode,
  options: RunCompiledGraphOptions,
  cache: NodeReadinessCache
): Promise<void> {
  if (node.kind === "agent" && !options.executors?.agent) {
    const harnessName = node.effective_policy.harness;

    if (!harnessName) {
      throw new Error(`Agent "${node.compiled_id}" requires a resolved harness.`);
    }

    const diagnostics = await collectHarnessReadinessDiagnostics(
      harnessName,
      options.harnesses,
      cache
    );

    if (diagnostics.length > 0) {
      throw new Error(diagnostics.join(" | "));
    }

    return;
  }

  if (node.kind === "check" && node.check_kind === "ai" && !options.executors?.check) {
    const harnessName = node.effective_policy.harness;

    if (!harnessName) {
      throw new Error(`AI check "${node.compiled_id}" requires a resolved harness.`);
    }

    const diagnostics = await collectHarnessReadinessDiagnostics(
      harnessName,
      options.harnesses,
      cache
    );

    if (diagnostics.length > 0) {
      throw new Error(diagnostics.join(" | "));
    }

    return;
  }

  if (node.kind === "checkpoint" && !options.executors?.checkpoint) {
    throw new Error(`Checkpoint "${node.compiled_id}" requires a checkpoint executor.`);
  }
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

function collectSourcePathsFromWorkspace(workspace: WorkspaceSetup): Record<string, string> {
  return Object.fromEntries(
    Object.values(workspace.repo_workspaces).map((binding) => [binding.repo_alias, binding.source_path])
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
    ...(session.graph_path ? { graph_path: session.graph_path } : {}),
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
  events: RuntimeEventEnvelope[],
  deliveryManifest?: DeliveryPackageManifest
): Promise<ReturnType<typeof buildRuntimeStateSnapshot>> {
  const state = buildRuntimeStateSnapshot(session);
  await writer.writeRunSummary(
    renderRunSummary(state, await readRunExecutionAttempts(writer.run_root), events, deliveryManifest)
  );
  return state;
}

async function emitEvent(
  session: RuntimeSession,
  writer: ArtifactWriter,
  runOwner: RunOwnerRecord,
  events: RuntimeEventEnvelope[],
  onEvent: RunCompiledGraphOptions["on_event"],
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
  if (onEvent) {
    try {
      await onEvent(event);
    } catch {
      // CLI progress rendering is best-effort and must not fail the run.
    }
  }
  return event;
}

function canSpendRuntimeSupervisorAction(session: RuntimeSession, action: SupervisorActionKind): boolean {
  return canSpendSupervisorAction({
    remaining: session.supervisor.budget_remaining,
    spent: { total: 0 }
  }, action);
}

function spendRuntimeSupervisorAction(session: RuntimeSession, action: SupervisorActionKind): void {
  const spent = spendSupervisorAction({
    remaining: session.supervisor.budget_remaining,
    spent: { total: 0 }
  } satisfies SupervisorBudgetState, action);
  session.supervisor.budget_remaining = spent.remaining;
}

function createSupervisorDecisionId(attempt: RuntimeNodeAttempt, action: SupervisorActionKind): string {
  return `${attempt.execution_id}__${action}_decision`;
}

function createSupervisorInterventionId(attempt: RuntimeNodeAttempt, action: SupervisorActionKind): string {
  return `${attempt.execution_id}__${action}`;
}

function retryActionForClassification(classification: FailureClassification): SupervisorActionKind | undefined {
  if (!classification.retryable) {
    return undefined;
  }

  switch (classification.recommended_action) {
    case "retry_with_guidance":
    case "rebuild_context":
    case "run_diagnostic":
    case "semantic_evaluation":
      return classification.recommended_action;
    default:
      return undefined;
  }
}

function actionRetrySummary(action: SupervisorActionKind): string {
  switch (action) {
    case "rebuild_context":
      return "Supervisor will retry the node with a freshly materialized context packet.";
    case "run_diagnostic":
      return "Supervisor will retry the node after recording the diagnostic classification.";
    case "semantic_evaluation":
      return "Supervisor will rerun the semantic evaluation node.";
    default:
      return "Supervisor will retry the node with guidance.";
  }
}

function interventionTitle(action: SupervisorActionKind): string {
  switch (action) {
    case "run_diagnostic":
      return "Supervisor diagnostic for failed node.";
    case "rebuild_context":
      return "Supervisor context brief for retry.";
    case "semantic_evaluation":
      return "Supervisor semantic evaluation brief.";
    case "pause_for_human":
      return "Supervisor escalation brief for human input.";
    default:
      return actionRetrySummary(action);
  }
}

function interventionBody(options: {
  action: SupervisorActionKind;
  node: CompiledExecutableNode;
  attempt: RuntimeNodeAttempt;
  classification: FailureClassification;
}): string {
  return [
    `# ${interventionTitle(options.action)}`,
    "",
    `Node: ${options.node.authored_id} (${options.node.compiled_id})`,
    `Execution: ${options.attempt.execution_id}`,
    `Classification: ${options.classification.class}`,
    `Summary: ${options.classification.summary}`,
    "",
    "## Evidence",
    "```json",
    JSON.stringify(options.classification.evidence, null, 2),
    "```",
    "",
    "## Recommended Next Step",
    options.action === "pause_for_human"
      ? "Wait for structured human input before continuing."
      : options.action === "rebuild_context"
        ? "Retry the authored node with this context brief available as supervisor evidence."
        : options.action === "semantic_evaluation"
          ? "Use this semantic assessment as retry guidance for the authored node."
          : "Retry only if this diagnostic confirms the failure is recoverable."
  ].join("\n");
}

async function handleFailedNodeWithSupervisor(options: {
  runOptions: RunCompiledGraphOptions;
  session: RuntimeSession;
  writer: ArtifactWriter;
  runOwner: RunOwnerRecord;
  events: RuntimeEventEnvelope[];
  readyQueue: ReturnType<typeof createReadyQueueState>;
  node: CompiledExecutableNode;
  attempt: RuntimeNodeAttempt;
  result: RuntimeNodeExecutionResult;
  readyNode: ReadyNode;
}): Promise<boolean> {
  const classification = classifyNodeFailure({
    node: options.node,
    attempt: options.attempt,
    result: options.result,
    policy: options.session.graph.supervision
  });
  const action = retryActionForClassification(classification);

  if (!action) {
    const requestedAction = classification.recommended_action;
    const decisionId = createSupervisorDecisionId(options.attempt, requestedAction);
    const decision: SupervisorDecision = {
      decision_id: decisionId,
      kind: requestedAction === "pause_for_human" ? "pause_for_human" : "fail_run",
      classification: classification.class,
      health_state: classification.class === "scope_drift" ? "drifting" : "unhealthy",
      confidence: "medium",
      target_compiled_id: options.node.compiled_id,
      target_execution_id: options.attempt.execution_id,
      action: requestedAction,
      reason: classification.summary,
      evidence: classification.evidence,
      budget_cost: {},
      requires_human: requestedAction === "pause_for_human",
      created_at: new Date().toISOString()
    };
    options.session.supervisor.last_decision_id = decisionId;
    options.session.supervisor.timeline.push(decision);
    if (requestedAction === "pause_for_human") {
      if (!canSpendRuntimeSupervisorAction(options.session, "pause_for_human")) {
        options.session.supervisor.status = "exhausted";
      } else {
        spendRuntimeSupervisorAction(options.session, "pause_for_human");
        options.session.supervisor.intervention_count += 1;
        decision.budget_cost = { total: 1, pause_for_human: 1 };
      }
      options.session.supervisor.status = "paused";
      options.session.supervisor.pause = {
        decision_id: decisionId,
        reason: classification.summary,
        target_compiled_id: options.node.compiled_id,
        target_execution_id: options.attempt.execution_id,
        resume_options: ["retry", "fail", "add_context"]
      };
      options.session.status = "paused";
    }
    await options.writer.appendSupervisorDecision(decision);
    await emitEvent(
      options.session,
      options.writer,
      options.runOwner,
      options.events,
      options.runOptions.on_event,
      "supervisor.decision",
      decision,
      {
        compiled_id: options.node.compiled_id,
        execution_id: options.attempt.execution_id,
        repeat_scope_id: options.attempt.repeat_scope_id,
        iteration_index: options.attempt.iteration_index,
        attempt_index: options.attempt.attempt_index
      }
    );
    if (requestedAction === "pause_for_human") {
      const interventionId = createSupervisorInterventionId(options.attempt, "pause_for_human");
      const intervention = await runEvidenceIntervention({
        action: "pause_for_human",
        attempt: options.attempt,
        decision_id: decisionId,
        intervention_id: interventionId,
        classification,
        title: interventionTitle("pause_for_human"),
        body: interventionBody({
          action: "pause_for_human",
          node: options.node,
          attempt: options.attempt,
          classification
        })
      });
      options.session.supervisor.pause = {
        ...(options.session.supervisor.pause ?? {
          decision_id: decisionId,
          reason: classification.summary,
          resume_options: ["retry", "fail", "add_context"]
        }),
        ...(typeof intervention.artifact_paths.brief === "string"
          ? { brief_path: intervention.artifact_paths.brief }
          : {})
      };
      await options.writer.appendSupervisorIntervention(intervention);
      await emitEvent(
        options.session,
        options.writer,
        options.runOwner,
        options.events,
        options.runOptions.on_event,
        "supervisor.paused",
        {
          decision_id: decisionId,
          target_compiled_id: options.node.compiled_id,
          target_execution_id: options.attempt.execution_id,
          reason: classification.summary,
          resume_options: options.session.supervisor.pause?.resume_options ?? []
        },
        {
          compiled_id: options.node.compiled_id,
          execution_id: options.attempt.execution_id,
          repeat_scope_id: options.attempt.repeat_scope_id,
          iteration_index: options.attempt.iteration_index,
          attempt_index: options.attempt.attempt_index
        }
      );
    }
    return false;
  }

  if (!canSpendRuntimeSupervisorAction(options.session, action)) {
    options.session.supervisor.status = "exhausted";
    const decisionId = createSupervisorDecisionId(options.attempt, action);
    options.session.supervisor.last_decision_id = decisionId;
    const decision: SupervisorDecision = {
      decision_id: decisionId,
      kind: "fail_run",
      classification: classification.class,
      health_state: "unhealthy",
      confidence: "high",
      action: "fail",
      target_compiled_id: options.node.compiled_id,
      target_execution_id: options.attempt.execution_id,
      reason: `Supervisor cannot run action "${action}" because its budget is exhausted or the action is disabled.`,
      evidence: classification.evidence,
      budget_cost: {},
      created_at: new Date().toISOString()
    };
    options.session.supervisor.timeline.push(decision);
    await options.writer.appendSupervisorDecision(decision);
    await emitEvent(
      options.session,
      options.writer,
      options.runOwner,
      options.events,
      options.runOptions.on_event,
      "supervisor.decision",
      decision,
      {
        compiled_id: options.node.compiled_id,
        execution_id: options.attempt.execution_id,
        repeat_scope_id: options.attempt.repeat_scope_id,
        iteration_index: options.attempt.iteration_index,
        attempt_index: options.attempt.attempt_index
      }
    );
    return false;
  }

  spendRuntimeSupervisorAction(options.session, action);
  options.session.supervisor.status = "intervening";
  options.session.supervisor.intervention_count += 1;
  const decisionId = createSupervisorDecisionId(options.attempt, action);
  options.session.supervisor.last_decision_id = decisionId;
  const budgetCost = {
    total: 1,
    [action]: 1
  };
  const decision: SupervisorDecision = {
    decision_id: decisionId,
    kind: "retry_with_guidance",
    classification: classification.class,
    health_state: "unhealthy",
    confidence: "medium",
    target_compiled_id: options.node.compiled_id,
    target_execution_id: options.attempt.execution_id,
    action,
    reason: classification.summary,
    evidence: classification.evidence,
    budget_cost: budgetCost,
    created_at: new Date().toISOString()
  };
  options.session.supervisor.timeline.push(decision);
  await options.writer.appendSupervisorDecision(decision);

  await emitEvent(
    options.session,
    options.writer,
    options.runOwner,
    options.events,
    options.runOptions.on_event,
    "supervisor.decision",
    decision,
    {
      compiled_id: options.node.compiled_id,
      execution_id: options.attempt.execution_id,
      repeat_scope_id: options.attempt.repeat_scope_id,
      iteration_index: options.attempt.iteration_index,
      attempt_index: options.attempt.attempt_index
    }
  );
  if (action === "run_diagnostic" || action === "rebuild_context" || action === "semantic_evaluation") {
    const interventionId = createSupervisorInterventionId(options.attempt, action);
    await emitEvent(
      options.session,
      options.writer,
      options.runOwner,
      options.events,
      options.runOptions.on_event,
      "supervisor.intervention.started",
      {
        intervention_id: interventionId,
        decision_id: decisionId,
        action,
        target_compiled_id: options.node.compiled_id,
        summary: interventionTitle(action)
      },
      {
        compiled_id: options.node.compiled_id,
        execution_id: options.attempt.execution_id,
        repeat_scope_id: options.attempt.repeat_scope_id,
        iteration_index: options.attempt.iteration_index,
        attempt_index: options.attempt.attempt_index
      }
    );
    const intervention = await runEvidenceIntervention({
      action,
      attempt: options.attempt,
      decision_id: decisionId,
      intervention_id: interventionId,
      classification,
      title: interventionTitle(action),
      body: interventionBody({
        action,
        node: options.node,
        attempt: options.attempt,
        classification
      })
    });
    await options.writer.appendSupervisorIntervention(intervention);
    await emitEvent(
      options.session,
      options.writer,
      options.runOwner,
      options.events,
      options.runOptions.on_event,
      "supervisor.intervention.completed",
      {
        intervention_id: intervention.intervention_id,
        decision_id: intervention.decision_id,
        action: intervention.action,
        target_compiled_id: options.node.compiled_id,
        summary: intervention.reason,
        artifacts: intervention.artifact_paths
      },
      {
        compiled_id: options.node.compiled_id,
        execution_id: options.attempt.execution_id,
        repeat_scope_id: options.attempt.repeat_scope_id,
        iteration_index: options.attempt.iteration_index,
        attempt_index: options.attempt.attempt_index
      }
    );
  }

  options.session.supervisor.status = "healthy";
  await queueReadyNode(
    options.readyQueue,
    options.session,
    options.writer,
    options.runOwner,
    options.events,
    options.runOptions.on_event,
    {
      ...options.readyNode,
      deps_satisfied: [...options.readyNode.deps_satisfied]
    }
  );

  return true;
}

async function queueReadyNode(
  readyQueue: ReturnType<typeof createReadyQueueState>,
  session: RuntimeSession,
  writer: ArtifactWriter,
  runOwner: RunOwnerRecord,
  events: RuntimeEventEnvelope[],
  onEvent: RunCompiledGraphOptions["on_event"],
  readyNode: ReadyNode
): Promise<void> {
  const key = createReadyNodeKey(readyNode);

  if (readyQueue.queued_keys.has(key)) {
    return;
  }

  readyQueue.queued_keys.add(key);
  readyQueue.queue.push(readyNode);
  setNodeStatus(session, readyNode.compiled_id, "ready");
  await emitEvent(session, writer, runOwner, events, onEvent, "node.ready", {
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
  onEvent: RunCompiledGraphOptions["on_event"],
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
    await emitEvent(session, writer, runOwner, events, onEvent, "repeat.iteration.started", {
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
        queueReadyNode(readyQueue, session, writer, runOwner, events, onEvent, {
          compiled_id: compiledId,
          deps_satisfied: bodyEntryDeps[index] ?? [],
          repeat_scope_id: repeatScopeId,
          iteration_index: opened.active_iteration_index
        })
      )
    );
  }

  for (const node of session.graph.nodes) {
    if (node.is_cleanup) {
      continue;
    }

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
        await queueReadyNode(readyQueue, session, writer, runOwner, events, onEvent, {
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
      await queueReadyNode(readyQueue, session, writer, runOwner, events, onEvent, {
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

function resolveNodeWorkingDirectory(
  workspacePath: string,
  cwd: string | undefined
): string {
  if (!cwd) {
    return workspacePath;
  }

  if (cwd.includes(":")) {
    throw new Error(`cwd "${cwd}" must be a relative path that stays within its repo or workspace root.`);
  }

  return resolveSubpathWithinRoot(
    workspacePath,
    cwd,
    `cwd "${cwd}"`
  );
}

function resolveNodeEnvFiles(
  workspacePath: string,
  envFiles: string[] | undefined
): string[] | undefined {
  if (envFiles === undefined) {
    return undefined;
  }

  return envFiles.map((envFile) => {
    if (envFile.includes(":")) {
      throw new Error(`env_files entry "${envFile}" must be a relative path that stays within its repo or workspace root.`);
    }

    return resolveSubpathWithinRoot(
      workspacePath,
      envFile,
      `env_files entry "${envFile}"`
    );
  });
}

function contextEnvVarName(name: string): string | undefined {
  const upper = name.toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*$/.test(upper)) {
    return undefined;
  }
  return `AGENTFLOW_CONTEXT_${upper}`;
}

function buildContextMaterialEnv(
  materials: ContextPacketMaterializedItem[] | undefined
): Record<string, string> {
  if (!materials || materials.length === 0) {
    return {};
  }

  const env: Record<string, string> = {};
  for (const material of materials) {
    const source = material.source;
    if ("from" in source && source.from === "runtime_repeat_history") {
      continue;
    }

    const envName = contextEnvVarName(material.key);
    if (!envName) {
      continue;
    }

    if (env[envName] !== undefined) {
      continue;
    }

    env[envName] = material.materialized_path;
  }

  return env;
}

function buildNodeRuntimeEnv(context: RuntimeNodeExecutorContext<CompiledExecutableNode>): Record<string, string> {
  return {
    AGENTFLOW_RUN_ROOT: context.run_root,
    AGENTFLOW_RUN_ID: context.run_id,
    AGENTFLOW_GRAPH_ID: context.graph_id,
    AGENTFLOW_AGENT_ID: context.attempt.execution_id,
    AGENTFLOW_EXECUTION_ID: context.attempt.execution_id,
    AGENTFLOW_NODE_ID: context.node.authored_id,
    AGENTFLOW_COMPILED_ID: context.node.compiled_id,
    AGENTFLOW_REPO_ALIAS: context.node.repo,
    AGENTFLOW_WORKSPACE: context.workspace_path,
    AGENTFLOW_OUTPUT_DIR: resolveExecutionArtifactsDirectory(context.execution_dir),
    AGENTFLOW_CONTEXT_PACKET: context.context_packet_path,
    AGENTFLOW_CONTEXT_MANIFEST: context.context_manifest_path,
    ...buildContextMaterialEnv(context.context_materials)
  };
}

function substituteOptionalTextArray(
  values: string[] | undefined,
  tokens: Record<string, string>
): string[] | undefined {
  return values?.map((value) => substituteAgentflowTokens(value, tokens));
}

function summarizeExecVerification(exitCode: number): string {
  return exitCode === 0 ? "Command completed successfully." : `Command exited with code ${exitCode}.`;
}

function annotateSoftVerificationResult(
  result: Record<string, unknown>,
  verification: VerificationRecordedPayload
): Record<string, unknown> {
  return {
    ...result,
    soft_verification: true,
    verifier_kind: verification.verifier_kind,
    passed: verification.passed,
    summary: verification.summary,
    ...(verification.check_kind ? { check_kind: verification.check_kind } : {}),
    ...(verification.exit_code !== undefined ? { exit_code: verification.exit_code } : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildCheckVerificationArtifact(
  result: RuntimeNodeExecutionResult,
  defaults: {
    passed: boolean;
    summary: string;
    check_kind?: "deterministic" | "ai";
    exit_code?: number;
  }
): Record<string, unknown> {
  const payload = isRecord(result.verification_artifact)
    ? result.verification_artifact
    : (isRecord(result.result) ? result.result : undefined);

  return {
    ...(payload ?? {}),
    ...(typeof payload?.passed === "boolean" ? {} : { passed: defaults.passed }),
    ...(typeof payload?.summary === "string" && payload.summary.trim().length > 0
      ? {}
      : { summary: defaults.summary }),
    ...(typeof payload?.check_kind === "string" || defaults.check_kind === undefined
      ? {}
      : { check_kind: defaults.check_kind }),
    ...(typeof payload?.exit_code === "number" || defaults.exit_code === undefined
      ? {}
      : { exit_code: defaults.exit_code })
  };
}

async function defaultExecExecutor(
  context: RuntimeNodeExecutorContext<CompiledExecNode>
): Promise<RuntimeNodeExecutionResult> {
  const env_files = resolveNodeEnvFiles(context.workspace_path, context.node.env_files);
  const processResult = await runLocalProcess({
    command: context.node.command,
    args: context.node.args,
    cwd: resolveNodeWorkingDirectory(context.workspace_path, context.node.cwd),
    ...(env_files !== undefined ? { env_files } : {}),
    env: context.node.env,
    runtime_env: buildNodeRuntimeEnv(context),
    timeout_sec: context.node.effective_policy.timeout_sec,
    signal: context.signal,
    ...(context.on_stdout_chunk ? { on_stdout_chunk: context.on_stdout_chunk } : {}),
    ...(context.on_stderr_chunk ? { on_stderr_chunk: context.on_stderr_chunk } : {})
  });

  if (processResult.canceled) {
    return {
      status: "canceled",
      result: processResult,
      stdout: processResult.stdout,
      stderr: processResult.stderr
    };
  }

  if (context.node.on_failure === "continue" && !processResult.timed_out) {
    const verification: VerificationRecordedPayload = {
      verifier_kind: "exec",
      passed: processResult.exit_code === 0,
      summary: summarizeExecVerification(processResult.exit_code),
      exit_code: processResult.exit_code
    };

    return {
      status: "passed",
      outcome: "passed",
      result: annotateSoftVerificationResult(
        processResult as unknown as Record<string, unknown>,
        verification
      ),
      stdout: processResult.stdout,
      stderr: processResult.stderr,
      verification
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
    const env_files = resolveNodeEnvFiles(context.workspace_path, context.node.env_files);
    const result = await runDeterministicCheck({
      command: context.node.command ?? "",
      args: context.node.args ?? [],
      cwd: resolveNodeWorkingDirectory(context.workspace_path, context.node.cwd),
      ...(env_files !== undefined ? { env_files } : {}),
      env: context.node.env,
      runtime_env: buildNodeRuntimeEnv(context),
      timeout_sec: context.node.effective_policy.timeout_sec,
      pass_if: context.node.pass_if,
      signal: context.signal,
      ...(context.on_stdout_chunk ? { on_stdout_chunk: context.on_stdout_chunk } : {}),
      ...(context.on_stderr_chunk ? { on_stderr_chunk: context.on_stderr_chunk } : {})
    });

    if (result.canceled) {
      return {
        status: "canceled",
        result,
        stdout: result.stdout,
        stderr: result.stderr
      };
    }

    if (context.node.on_failure === "continue" && !result.timed_out) {
      const verification: VerificationRecordedPayload = {
        verifier_kind: "check",
        passed: result.passed,
        summary: result.summary,
        check_kind: "deterministic",
        exit_code: result.exit_code
      };

      return {
        status: "passed",
        outcome: "passed",
        result: annotateSoftVerificationResult(
          result as unknown as Record<string, unknown>,
          verification
        ),
        stdout: result.stdout,
        stderr: result.stderr,
        check: {
          check_kind: "deterministic",
          passed: result.passed,
          summary: result.summary
        },
        verification,
        verification_artifact: result.verification_json
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
      },
      verification_artifact: result.verification_json
    };
  }

  const harnessName = context.node.effective_policy.harness;

  if (!harnessName || !harnesses[harnessName]) {
    throw new Error(`AI check "${context.node.compiled_id}" requires harness "${harnessName ?? "unknown"}".`);
  }

  const aiCheckPromptTokens = buildNodeRuntimeEnv(context);
  const renderedAiCheckRubric =
    context.node.rubric !== undefined
      ? substituteAgentflowTokens(context.node.rubric, aiCheckPromptTokens)
      : undefined;
  const renderedGraphAcceptanceCriteria = substituteOptionalTextArray(
    context.graph_intent.acceptance_criteria,
    aiCheckPromptTokens
  );
  const renderedGraphConstraints = substituteOptionalTextArray(
    context.graph_intent.constraints,
    aiCheckPromptTokens
  );
  const renderedNodeAcceptanceCriteria = substituteOptionalTextArray(
    context.node.acceptance_criteria,
    aiCheckPromptTokens
  );
  const renderedNodeConstraints = substituteOptionalTextArray(
    context.node.constraints,
    aiCheckPromptTokens
  );

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
    ...(context.node.effective_policy.skip_git_repo_check ? { skip_git_repo_check: true } : {}),
    rubric: renderedAiCheckRubric,
    graph_goal: substituteAgentflowTokens(context.graph_intent.goal, aiCheckPromptTokens),
    ...(renderedGraphAcceptanceCriteria ? { graph_acceptance_criteria: renderedGraphAcceptanceCriteria } : {}),
    ...(renderedGraphConstraints ? { graph_constraints: renderedGraphConstraints } : {}),
    ...(context.node.goal ? { node_goal: substituteAgentflowTokens(context.node.goal, aiCheckPromptTokens) } : {}),
    ...(renderedNodeAcceptanceCriteria ? { node_acceptance_criteria: renderedNodeAcceptanceCriteria } : {}),
    ...(renderedNodeConstraints ? { node_constraints: renderedNodeConstraints } : {}),
    context_packet_path: context.context_packet_path,
    context_manifest_path: context.context_manifest_path,
    output_dir: resolveExecutionArtifactsDirectory(context.execution_dir),
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

  if (context.node.on_failure === "continue" && harness_result.status === "passed") {
    const verification: VerificationRecordedPayload = {
      verifier_kind: "check",
      passed,
      summary: evaluation.summary ?? (passed ? "AI check passed." : "AI check failed."),
      check_kind: "ai"
    };

    return {
      status: "passed",
      outcome: "passed",
      result: annotateSoftVerificationResult({
        exit_code: harness_result.exitCode,
        passed,
        ...(evaluation.score !== undefined ? { score: evaluation.score } : {}),
        ...(evaluation.summary ? { summary: evaluation.summary } : {}),
        ...(evaluation.issues ? { issues: evaluation.issues } : {}),
        ...(evaluation.raw ? { raw: evaluation.raw } : {}),
        metadata: harness_result.metadata ?? {}
      }, verification),
      stdout: harness_result.stdout,
      stderr: harness_result.stderr,
      check: {
        check_kind: "ai",
        passed,
        ...(evaluation.score !== undefined ? { score: evaluation.score } : {}),
        ...(evaluation.summary ? { summary: evaluation.summary } : {})
      },
      verification,
      verification_artifact: {
        passed,
        ...(evaluation.score !== undefined ? { score: evaluation.score } : {}),
        ...(evaluation.summary ? { summary: evaluation.summary } : {}),
        ...(evaluation.issues ? { issues: evaluation.issues } : {}),
        check_kind: "ai"
      }
    };
  }

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
    },
    verification_artifact: {
      passed,
      ...(evaluation.score !== undefined ? { score: evaluation.score } : {}),
      ...(evaluation.summary ? { summary: evaluation.summary } : {}),
      ...(evaluation.issues ? { issues: evaluation.issues } : {}),
      check_kind: "ai"
    }
  };
}

async function readContextManifestContent(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function defaultAgentExecutor(
  context: RuntimeNodeExecutorContext<CompiledAgentNode>,
  harnesses: Partial<Record<HarnessName, HarnessAdapter>>
): Promise<RuntimeNodeExecutionResult> {
  const harnessName = context.node.effective_policy.harness;

  if (!harnessName || !harnesses[harnessName]) {
    throw new Error(`Agent "${context.node.compiled_id}" requires harness "${harnessName ?? "unknown"}".`);
  }

  const outputDir = resolveExecutionArtifactsDirectory(context.execution_dir);
  const runtimeDir = join(context.run_root, "runtime");
  const toolSetup = await prepareAgentTools({
    node: context.node,
    execution_dir: context.execution_dir,
    workspace_path: context.workspace_path,
    artifacts_root: outputDir,
    run_root: context.run_root,
    runtime_dir: runtimeDir,
    run_id: context.run_id,
    graph_id: context.graph_id,
    execution_id: context.attempt.execution_id,
    repo_alias: context.node.repo,
    ...(context.node.effective_policy.harness ? { harness: context.node.effective_policy.harness } : {}),
    ...(context.node.effective_policy.model ? { model: context.node.effective_policy.model } : {}),
    ...(context.node.effective_policy.reasoning_effort
      ? { reasoning_effort: context.node.effective_policy.reasoning_effort }
      : {}),
    sandbox: context.node.effective_policy.sandbox ?? "workspace-write",
    timeout_sec: context.node.effective_policy.timeout_sec,
    context_packet_path: context.context_packet_path,
    context_manifest_path: context.context_manifest_path,
    credential_specs: context.credential_specs ?? {}
  });
  const contextManifest = await readContextManifestContent(context.context_manifest_path);
  const promptTokens = buildNodeRuntimeEnv(context);
  const agentGraphAcceptanceCriteria = substituteOptionalTextArray(
    context.graph_intent.acceptance_criteria,
    promptTokens
  );
  const agentGraphConstraints = substituteOptionalTextArray(context.graph_intent.constraints, promptTokens);
  const agentNodeAcceptanceCriteria = substituteOptionalTextArray(context.node.acceptance_criteria, promptTokens);
  const agentNodeConstraints = substituteOptionalTextArray(context.node.constraints, promptTokens);

  const harnessResult = await harnesses[harnessName]!.run({
    promptKind: "agent",
    runId: context.run_id,
    executionId: context.attempt.execution_id,
    repoAlias: context.node.repo,
    repoPath: context.workspace_path,
    runtimeDir,
    sandbox: context.node.effective_policy.sandbox ?? "workspace-write",
    ...(context.node.effective_policy.skip_git_repo_check ? { skipGitRepoCheck: true } : {}),
    model: context.node.effective_policy.model,
    ...(context.node.effective_policy.reasoning_effort
      ? { reasoningEffort: context.node.effective_policy.reasoning_effort }
      : {}),
    graphGoal: substituteAgentflowTokens(context.graph_intent.goal, promptTokens),
    ...(agentGraphAcceptanceCriteria ? { graphAcceptanceCriteria: agentGraphAcceptanceCriteria } : {}),
    ...(agentGraphConstraints ? { graphConstraints: agentGraphConstraints } : {}),
    ...(context.node.goal ? { nodeGoal: substituteAgentflowTokens(context.node.goal, promptTokens) } : {}),
    ...(agentNodeAcceptanceCriteria ? { nodeAcceptanceCriteria: agentNodeAcceptanceCriteria } : {}),
    ...(agentNodeConstraints ? { nodeConstraints: agentNodeConstraints } : {}),
    contextPacketPath: context.context_packet_path,
    contextManifestPath: context.context_manifest_path,
    contextManifest,
    outputDir,
    artifacts: context.node.declared_artifacts,
    timeoutSec: context.node.effective_policy.timeout_sec,
    signal: context.signal,
    ...(context.on_stdout_chunk ? { onStdoutChunk: context.on_stdout_chunk } : {}),
    ...(context.on_stderr_chunk ? { onStderrChunk: context.on_stderr_chunk } : {}),
    toolBinDir: toolSetup.bin_dir,
    toolEnv: toolSetup.env,
    tools: toolSetup.resolved_tools
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
    agent_response: harnessResult.transcript?.last_message ?? harnessResult.stdout ?? "",
    ...(harnessResult.metadata ? { metadata: harnessResult.metadata } : {})
  };
}

async function writeAutomaticArtifacts(
  node: CompiledExecutableNode,
  attempt: RuntimeNodeAttempt,
  result: RuntimeNodeExecutionResult
): Promise<Record<string, string>> {
  const artifacts: Record<string, string> = {};

  if (node.kind === "check") {
    const verificationJsonPath = join(
      resolveExecutionArtifactsDirectory(attempt.execution_dir),
      "verification.json"
    );
    const passed =
      result.check?.passed
      ?? (result.verification?.passed
        ?? (isRecord(result.result) && typeof result.result.passed === "boolean"
          ? result.result.passed
          : false));
    const summary =
      result.check?.summary
      ?? result.verification?.summary
      ?? (isRecord(result.result) && typeof result.result.summary === "string"
        ? result.result.summary
        : (result.status === "canceled" ? "Check canceled." : (passed ? "Check passed." : "Check failed.")));
    const exit_code =
      result.verification?.exit_code
      ?? (isRecord(result.result) && typeof result.result.exit_code === "number"
        ? result.result.exit_code
        : undefined);

    await writeFile(
      verificationJsonPath,
      `${JSON.stringify(
        buildCheckVerificationArtifact(result, {
          passed,
          summary,
          ...(result.check?.check_kind ? { check_kind: result.check.check_kind } : {}),
          ...(exit_code !== undefined ? { exit_code } : {})
        }),
        null,
        2
      )}\n`,
      "utf8"
    );
    artifacts.verification_json = verificationJsonPath;
  }

  if (node.kind !== "agent") {
    return artifacts;
  }

  const responsePath = join(resolveExecutionArtifactsDirectory(attempt.execution_dir), "agent-response.md");
  const response =
    typeof result.agent_response === "string" && result.agent_response.trim().length > 0
      ? result.agent_response
      : "Agent completed without a captured final response.\n";

  await writeFile(responsePath, response.endsWith("\n") ? response : `${response}\n`, "utf8");
  artifacts.agent_response = responsePath;
  return artifacts;
}

async function writeFailureAutomaticArtifacts(
  node: CompiledExecutableNode,
  attempt: RuntimeNodeAttempt,
  message: string
): Promise<Record<string, string>> {
  const artifacts: Record<string, string> = {};

  if (node.kind === "check") {
    const verificationJsonPath = join(
      resolveExecutionArtifactsDirectory(attempt.execution_dir),
      "verification.json"
    );
    await writeFile(
      verificationJsonPath,
      `${JSON.stringify({
        passed: false,
        summary: message,
        error: message,
        check_kind: node.check_kind
      }, null, 2)}\n`,
      "utf8"
    );
    artifacts.verification_json = verificationJsonPath;
  }

  return artifacts;
}

async function collectMissingDeclaredArtifacts(
  node: CompiledExecutableNode,
  executionDir: string,
  workspacePath: string
): Promise<MissingDeclaredArtifact[]> {
  const artifactsRoot = resolveExecutionArtifactsDirectory(executionDir);
  const missing: MissingDeclaredArtifact[] = [];

  for (const [name, definition] of Object.entries(node.declared_artifacts)) {
    const expected_path = resolveSubpathWithinRoot(
      definition.from === "output_dir" ? artifactsRoot : workspacePath,
      definition.path,
      `Artifact "${name}" path`
    );

    try {
      await access(expected_path);
    } catch {
      missing.push({
        name,
        from: definition.from,
        path: definition.path,
        description: definition.description,
        expected_path
      });
    }
  }

  return missing;
}

function isHumanTextArtifact(artifact: MissingDeclaredArtifact): boolean {
  if (artifact.from !== "output_dir") {
    return false;
  }

  const lowerPath = artifact.path.toLowerCase();
  return lowerPath.endsWith(".md") || lowerPath.endsWith(".markdown") || lowerPath.endsWith(".txt");
}

async function synthesizeMissingArtifactsFromAgentResponse(options: {
  node: CompiledAgentNode;
  attempt: RuntimeNodeAttempt;
  missingArtifacts: MissingDeclaredArtifact[];
  automaticArtifacts: Record<string, string>;
  decisionId: string;
  interventionId: string;
  repairAttempt: number;
  maxAttempts: number;
}): Promise<SupervisorInterventionRecord | undefined> {
  if (
    options.missingArtifacts.length !== 1 ||
    !options.missingArtifacts.every(isHumanTextArtifact)
  ) {
    return undefined;
  }

  const agentResponsePath = options.automaticArtifacts.agent_response;
  if (!agentResponsePath) {
    return undefined;
  }

  let agentResponse: string;
  try {
    agentResponse = await readFile(agentResponsePath, "utf8");
  } catch {
    return undefined;
  }

  const trimmedResponse = agentResponse.trim();
  if (
    trimmedResponse.length === 0 ||
    trimmedResponse === "Agent completed without a captured final response."
  ) {
    return undefined;
  }

  const interventionDir = join(options.attempt.execution_dir, "interventions", options.interventionId);
  const promptPath = join(interventionDir, "prompt.md");
  const stdoutPath = join(interventionDir, "stdout.log");
  const stderrPath = join(interventionDir, "stderr.log");
  const resultPath = join(interventionDir, "result.json");
  const startedAt = new Date().toISOString();

  await mkdir(interventionDir, { recursive: true });

  await Promise.all(options.missingArtifacts.map(async (artifact) => {
    await mkdir(dirname(artifact.expected_path), { recursive: true });
    await writeFile(
      artifact.expected_path,
      [
        "# Recovered Agentflow Artifact",
        "",
        "Agentflow synthesized this human-readable handoff from the node's captured final response because the declared artifact was missing after the node completed.",
        "",
        "## Declared Artifact",
        "",
        `- Name: \`${artifact.name}\``,
        `- Path: \`${artifact.path}\``,
        `- Expected content: ${artifact.description}`,
        "",
        "## Recovered Content",
        "",
        trimmedResponse
      ].join("\n"),
      "utf8"
    );
  }));

  await Promise.all([
    writeFile(
      promptPath,
      [
        "## Agentflow Artifact Repair",
        "",
        "The supervisor recovered missing human-readable artifacts from the captured agent response.",
        "No external harness was invoked because every missing artifact was a text handoff and the node had already completed successfully.",
        "",
        "## Node Task",
        "",
        options.node.goal,
        "",
        "## Recovered Artifacts",
        formatMissingArtifactList(options.missingArtifacts)
      ].join("\n"),
      "utf8"
    ),
    writeFile(stdoutPath, "Synthesized missing text artifacts from agent_response.\n", "utf8"),
    writeFile(stderrPath, "", "utf8"),
    writeFile(
      resultPath,
      `${JSON.stringify({
        status: "passed",
        repair_strategy: "synthesize_from_agent_response",
        missing_artifacts_after: []
      }, null, 2)}\n`,
      "utf8"
    )
  ]);

  return {
    intervention_id: options.interventionId,
    decision_id: options.decisionId,
    action: "repair_artifact",
    status: "passed",
    target_compiled_id: options.node.compiled_id,
    target_execution_id: options.attempt.execution_id,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    reason: "Recovered missing human-readable declared artifacts from the node's captured final response.",
    evidence: {
      repair_attempt: options.repairAttempt,
      max_attempts: options.maxAttempts,
      repair_strategy: "synthesize_from_agent_response",
      source_artifact: "agent_response",
      source_path: agentResponsePath,
      missing_artifacts_before: options.missingArtifacts.map((artifact) => artifact.name),
      missing_artifacts_after: []
    },
    artifact_paths: {
      intervention_dir: interventionDir,
      prompt: promptPath,
      stdout: stdoutPath,
      stderr: stderrPath,
      result: resultPath
    }
  };
}

function formatMissingArtifactList(missingArtifacts: MissingDeclaredArtifact[]): string {
  return missingArtifacts
    .map((artifact) => [
      `- \`${artifact.name}\``,
      `  - from: \`${artifact.from}\``,
      `  - declared path: \`${artifact.path}\``,
      `  - expected absolute path: \`${artifact.expected_path}\``,
      `  - expected content: ${artifact.description}`
    ].join("\n"))
    .join("\n");
}

async function materializeDeclaredArtifactsWithRepair(options: {
  node: CompiledExecutableNode;
  attempt: RuntimeNodeAttempt;
  session: RuntimeSession;
  writer: ArtifactWriter;
  runOwner: RunOwnerRecord;
  events: RuntimeEventEnvelope[];
  onEvent: RunCompiledGraphOptions["on_event"];
  workspacePath: string;
  automaticArtifacts: Record<string, string>;
  resultStatus: RuntimeNodeExecutionResult["status"];
  contextPacketPath: string;
  contextManifestPath: string;
  signal: AbortSignal | undefined;
  harnesses: Partial<Record<HarnessName, HarnessAdapter>>;
}): Promise<{
  artifacts: Record<string, string>;
  repair_metadata?: ArtifactRepairMetadata;
  canceled?: boolean;
}> {
  try {
    return {
      artifacts: await options.writer.materializeDeclaredArtifacts(
        options.node,
        options.attempt,
        options.workspacePath,
        options.automaticArtifacts
      )
    };
  } catch (error) {
    if (
      options.node.kind !== "agent" ||
      options.resultStatus !== "passed" ||
      options.attempt.status === "canceled"
    ) {
      throw error;
    }

    const maxAttempts = options.node.effective_policy.artifact_repair?.max_attempts ?? 0;

    if (maxAttempts <= 0) {
      throw error;
    }

    let missingArtifacts = await collectMissingDeclaredArtifacts(
      options.node,
      options.attempt.execution_dir,
      options.workspacePath
    );

    if (missingArtifacts.length === 0) {
      throw error;
    }

    let attempted = 0;

    for (let repairAttempt = 1; repairAttempt <= maxAttempts; repairAttempt += 1) {
      if (!canSpendRuntimeSupervisorAction(options.session, "repair_artifact")) {
        options.session.supervisor.status = "exhausted";
        break;
      }

      attempted = repairAttempt;
      const missingBeforeRepair = missingArtifacts.map((artifact) => artifact.name);
      const decisionId = `${options.attempt.execution_id}__repair_artifact_decision_${repairAttempt}`;
      const interventionId = `${options.attempt.execution_id}__repair_artifact_${repairAttempt}`;
      const interventionDir = join(options.attempt.execution_dir, "interventions", interventionId);
      options.session.supervisor.status = "intervening";
      options.session.supervisor.intervention_count += 1;
      options.session.supervisor.last_decision_id = decisionId;
      spendRuntimeSupervisorAction(options.session, "repair_artifact");
      const startedRecord: SupervisorInterventionRecord = {
        intervention_id: interventionId,
        decision_id: decisionId,
        action: "repair_artifact",
        status: "running",
        target_compiled_id: options.node.compiled_id,
        target_execution_id: options.attempt.execution_id,
        started_at: new Date().toISOString(),
        reason: "Declared artifact contract is missing after an agent completed.",
        evidence: {
          repair_attempt: repairAttempt,
          max_attempts: maxAttempts,
          missing_artifacts_before: missingBeforeRepair
        },
        artifact_paths: {
          intervention_dir: interventionDir
        }
      };

      const decision: SupervisorDecision = {
        decision_id: decisionId,
        kind: "run_intervention",
        classification: "artifact",
        health_state: "artifact_at_risk",
        confidence: "high",
        action: "repair_artifact",
        target_compiled_id: options.node.compiled_id,
        target_execution_id: options.attempt.execution_id,
        reason: startedRecord.reason,
        evidence: startedRecord.evidence,
        budget_cost: { total: 1, repair_artifact: 1 },
        created_at: startedRecord.started_at
      };
      options.session.supervisor.timeline.push(decision);
      await options.writer.appendSupervisorDecision(decision);
      await emitEvent(
        options.session,
        options.writer,
        options.runOwner,
        options.events,
        options.onEvent,
        "supervisor.decision",
        decision,
        {
          compiled_id: options.node.compiled_id,
          execution_id: options.attempt.execution_id,
          repeat_scope_id: options.attempt.repeat_scope_id,
          iteration_index: options.attempt.iteration_index,
          attempt_index: options.attempt.attempt_index
        }
      );
      await options.writer.appendSupervisorIntervention(startedRecord);
      await emitEvent(
        options.session,
        options.writer,
        options.runOwner,
        options.events,
        options.onEvent,
        "supervisor.intervention.started",
        {
          intervention_id: interventionId,
          decision_id: decisionId,
          action: "repair_artifact",
          target_compiled_id: options.node.compiled_id,
          summary: startedRecord.reason,
          missing_artifacts: missingBeforeRepair
        },
        {
          compiled_id: options.node.compiled_id,
          execution_id: options.attempt.execution_id,
          repeat_scope_id: options.attempt.repeat_scope_id,
          iteration_index: options.attempt.iteration_index,
          attempt_index: options.attempt.attempt_index
        }
      );

      const harnessName = options.node.effective_policy.harness;
      const harnessAvailable = Boolean(harnessName && options.harnesses[harnessName]);
      const synthesizedIntervention = harnessAvailable
        ? undefined
        : await synthesizeMissingArtifactsFromAgentResponse({
            node: options.node,
            attempt: options.attempt,
            missingArtifacts,
            automaticArtifacts: options.automaticArtifacts,
            decisionId,
            interventionId,
            repairAttempt,
            maxAttempts
          });
      const intervention = synthesizedIntervention ?? await runRepairArtifactIntervention({
        node: options.node,
        attempt: options.attempt,
        missing_artifacts: missingArtifacts,
        session: options.session,
        workspace_path: options.workspacePath,
        context_packet_path: options.contextPacketPath,
        context_manifest_path: options.contextManifestPath,
        harnesses: options.harnesses,
        decision_id: decisionId,
        intervention_id: interventionId,
        repair_attempt: repairAttempt,
        max_attempts: maxAttempts,
        ...(options.signal ? { signal: options.signal } : {})
      });
      await options.writer.appendSupervisorIntervention(intervention);

      if (intervention.status === "canceled") {
        await emitEvent(
          options.session,
          options.writer,
          options.runOwner,
          options.events,
          options.onEvent,
          "supervisor.intervention.failed",
          {
            intervention_id: intervention.intervention_id,
            decision_id: intervention.decision_id,
            action: intervention.action,
            target_compiled_id: options.node.compiled_id,
            summary: intervention.reason,
            missing_artifacts: missingArtifacts.map((artifact) => artifact.name)
          },
          {
            compiled_id: options.node.compiled_id,
            execution_id: options.attempt.execution_id,
            repeat_scope_id: options.attempt.repeat_scope_id,
            iteration_index: options.attempt.iteration_index,
            attempt_index: options.attempt.attempt_index
          }
        );
        return {
          artifacts: options.automaticArtifacts,
          repair_metadata: {
            status: "failed",
            max_attempts: maxAttempts,
            attempt_count: attempted,
            missing_artifacts: missingArtifacts.map((artifact) => artifact.name)
          },
          canceled: true
        };
      }

      missingArtifacts = await collectMissingDeclaredArtifacts(
        options.node,
        options.attempt.execution_dir,
        options.workspacePath
      );

      if (missingArtifacts.length === 0) {
        options.session.supervisor.status = "healthy";
        await emitEvent(
          options.session,
          options.writer,
          options.runOwner,
          options.events,
          options.onEvent,
          "supervisor.intervention.completed",
          {
            intervention_id: intervention.intervention_id,
            decision_id: intervention.decision_id,
            action: intervention.action,
            target_compiled_id: options.node.compiled_id,
            summary: intervention.reason,
            repaired_artifacts: missingBeforeRepair
          },
          {
            compiled_id: options.node.compiled_id,
            execution_id: options.attempt.execution_id,
            repeat_scope_id: options.attempt.repeat_scope_id,
            iteration_index: options.attempt.iteration_index,
            attempt_index: options.attempt.attempt_index
          }
        );

        return {
          artifacts: await options.writer.materializeDeclaredArtifacts(
            options.node,
            options.attempt,
            options.workspacePath,
            options.automaticArtifacts
          ),
          repair_metadata: {
            status: "passed",
            max_attempts: maxAttempts,
            attempt_count: attempted,
            missing_artifacts: []
          }
        };
      }

      await emitEvent(
        options.session,
        options.writer,
        options.runOwner,
        options.events,
        options.onEvent,
        "supervisor.intervention.failed",
        {
          intervention_id: intervention.intervention_id,
          decision_id: intervention.decision_id,
          action: intervention.action,
          target_compiled_id: options.node.compiled_id,
          missing_artifacts: missingArtifacts.map((artifact) => artifact.name),
          summary: intervention.reason
        },
        {
          compiled_id: options.node.compiled_id,
          execution_id: options.attempt.execution_id,
          repeat_scope_id: options.attempt.repeat_scope_id,
          iteration_index: options.attempt.iteration_index,
          attempt_index: options.attempt.attempt_index
        }
      );

      if (intervention.evidence.harness_status === "unavailable") {
        options.session.supervisor.status = "exhausted";
        break;
      }
    }

    if (options.session.supervisor.status === "intervening") {
      options.session.supervisor.status = "exhausted";
    }

    throw new ArtifactMaterializationError(
      `Required artifact contract is missing after ${attempted} artifact repair attempt${attempted === 1 ? "" : "s"}: ${missingArtifacts.map((artifact) => `${artifact.name} at ${artifact.path}`).join(", ")}.`,
      {
        status: "failed",
        max_attempts: maxAttempts,
        attempt_count: attempted,
        missing_artifacts: missingArtifacts.map((artifact) => artifact.name)
      }
    );
  }
}

async function ensureCheckpointPassFeedbackArtifact(
  node: CompiledExecutableNode,
  attempt: RuntimeNodeAttempt,
  result: RuntimeNodeExecutionResult
): Promise<void> {
  if (node.kind !== "checkpoint" || result.status !== "passed") {
    return;
  }

  const feedbackArtifact = node.declared_artifacts.operator_feedback;
  if (!feedbackArtifact || feedbackArtifact.from !== "output_dir") {
    return;
  }

  const feedbackPath = resolveSubpathWithinRoot(
    resolveExecutionArtifactsDirectory(attempt.execution_dir),
    feedbackArtifact.path,
    'Checkpoint "operator_feedback" artifact path'
  );

  try {
    await access(feedbackPath);
  } catch {
    await mkdir(dirname(feedbackPath), { recursive: true });
    await writeFile(
      feedbackPath,
      "Checkpoint passed. No operator feedback was provided.\n",
      "utf8"
    );
  }
}

async function executeNode(
  options: RunCompiledGraphOptions,
  session: RuntimeSession,
  writer: ArtifactWriter,
  runOwner: RunOwnerRecord,
  events: RuntimeEventEnvelope[],
  node: CompiledExecutableNode,
  attempt: RuntimeNodeAttempt,
  signal: AbortSignal | undefined,
  readinessCache: NodeReadinessCache
): Promise<{
  node: CompiledExecutableNode;
  attempt: RuntimeNodeAttempt;
  result: RuntimeNodeExecutionResult;
}> {
  const workspace = session.manifest.repo_workspaces[node.repo];

  if (!workspace) {
    throw new Error(`Missing workspace binding for repo "${node.repo}".`);
  }
  let context:
    | Awaited<ReturnType<typeof resolveExecutionContext>>
    | undefined;
  let executionPaths:
    | Awaited<ReturnType<ArtifactWriter["writeExecutionStart"]>>
    | undefined;
  let logSink: StreamingLogSink | undefined;
  let automaticArtifacts: Record<string, string> | undefined;
  let artifactRepairMetadata: ArtifactRepairMetadata | undefined;

  try {
    executionPaths = await writer.writeExecutionStart(attempt);
    logSink = createStreamingLogSink(writer, executionPaths);

    await ensureNodeReadiness(node, options, readinessCache);

    context = await resolveExecutionContext({
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

    let result: RuntimeNodeExecutionResult;

    if (node.kind === "exec") {
      result = options.executors?.exec
        ? await options.executors.exec({
            run_root: options.run_root,
            run_id: session.run_id,
            graph_id: session.graph.graph_id,
            graph_intent: session.graph.intent,
            credential_specs: session.graph.credential_specs ?? {},
            node,
            attempt,
            workspace_path: workspace.workspace_path,
            execution_dir: attempt.execution_dir,
            context_packet_path: context.packet_path,
            context_manifest_path: context.manifest_path,
            context_materials: context.packet.materials,
            signal,
            on_stdout_chunk: logSink.on_stdout_chunk,
            on_stderr_chunk: logSink.on_stderr_chunk
          })
        : await defaultExecExecutor({
            run_root: options.run_root,
            run_id: session.run_id,
            graph_id: session.graph.graph_id,
            graph_intent: session.graph.intent,
            credential_specs: session.graph.credential_specs ?? {},
            node,
            attempt,
            workspace_path: workspace.workspace_path,
            execution_dir: attempt.execution_dir,
            context_packet_path: context.packet_path,
            context_manifest_path: context.manifest_path,
            context_materials: context.packet.materials,
            signal,
            on_stdout_chunk: logSink.on_stdout_chunk,
            on_stderr_chunk: logSink.on_stderr_chunk
          });
    } else if (node.kind === "check") {
      result = options.executors?.check
        ? await options.executors.check({
            run_root: options.run_root,
            run_id: session.run_id,
            graph_id: session.graph.graph_id,
            graph_intent: session.graph.intent,
            credential_specs: session.graph.credential_specs ?? {},
            node,
            attempt,
            workspace_path: workspace.workspace_path,
            execution_dir: attempt.execution_dir,
            context_packet_path: context.packet_path,
            context_manifest_path: context.manifest_path,
            context_materials: context.packet.materials,
            signal,
            on_stdout_chunk: logSink.on_stdout_chunk,
            on_stderr_chunk: logSink.on_stderr_chunk
          })
        : await defaultCheckExecutor(
            {
              run_root: options.run_root,
              run_id: session.run_id,
              graph_id: session.graph.graph_id,
              graph_intent: session.graph.intent,
              credential_specs: session.graph.credential_specs ?? {},
              node,
              attempt,
              workspace_path: workspace.workspace_path,
              execution_dir: attempt.execution_dir,
              context_packet_path: context.packet_path,
              context_manifest_path: context.manifest_path,
              context_materials: context.packet.materials,
              signal,
              on_stdout_chunk: logSink.on_stdout_chunk,
              on_stderr_chunk: logSink.on_stderr_chunk
            },
            options.harnesses ?? {}
          );
    } else if (node.kind === "checkpoint") {
      if (!options.executors?.checkpoint) {
        throw new Error(`Checkpoint "${node.compiled_id}" requires a checkpoint executor.`);
      }

      result = await options.executors.checkpoint({
        run_root: options.run_root,
        run_id: session.run_id,
        graph_id: session.graph.graph_id,
        graph_intent: session.graph.intent,
        credential_specs: session.graph.credential_specs ?? {},
        node,
        attempt,
        workspace_path: workspace.workspace_path,
        execution_dir: attempt.execution_dir,
        context_packet_path: context.packet_path,
        context_manifest_path: context.manifest_path,
        signal,
        on_stdout_chunk: logSink.on_stdout_chunk,
        on_stderr_chunk: logSink.on_stderr_chunk
      });
    } else {
      result = options.executors?.agent
        ? await options.executors.agent({
            run_root: options.run_root,
            run_id: session.run_id,
            graph_id: session.graph.graph_id,
            graph_intent: session.graph.intent,
            credential_specs: session.graph.credential_specs ?? {},
            node,
            attempt,
            workspace_path: workspace.workspace_path,
            execution_dir: attempt.execution_dir,
            context_packet_path: context.packet_path,
            context_manifest_path: context.manifest_path,
            signal
          })
        : await defaultAgentExecutor(
            {
              run_root: options.run_root,
              run_id: session.run_id,
              graph_id: session.graph.graph_id,
              graph_intent: session.graph.intent,
              credential_specs: session.graph.credential_specs ?? {},
              node,
              attempt,
              workspace_path: workspace.workspace_path,
              execution_dir: attempt.execution_dir,
              context_packet_path: context.packet_path,
              context_manifest_path: context.manifest_path,
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

    await ensureCheckpointPassFeedbackArtifact(node, attempt, result);

    automaticArtifacts = await writeAutomaticArtifacts(node, attempt, result);
    const materialized =
      result.status === "canceled"
        ? { artifacts: automaticArtifacts }
        : await materializeDeclaredArtifactsWithRepair({
            node,
            attempt,
            session,
            writer,
            runOwner,
            events,
            onEvent: options.on_event,
            workspacePath: workspace.workspace_path,
            automaticArtifacts,
            resultStatus: result.status,
            contextPacketPath: context.packet_path,
            contextManifestPath: context.manifest_path,
            signal,
            harnesses: options.harnesses ?? {}
          });
    const artifacts = materialized.artifacts;
    artifactRepairMetadata = materialized.repair_metadata;

    if (materialized.canceled) {
      result = {
        ...result,
        status: "canceled"
      };
      delete result.outcome;
    }

    const completedAttempt = closeNodeAttempt(session.attempts, attempt.execution_id, {
      status: result.status,
      ...(result.outcome ? { outcome: result.outcome } : {}),
      stdout_log_path: executionPaths.stdout_log_path,
      stderr_log_path: executionPaths.stderr_log_path,
      result_path: executionPaths.result_path,
      context_packet_path: context.packet_path,
      context_manifest_path: context.manifest_path,
      context_provenance_path: context.provenance_path,
      artifacts,
      ...((result.metadata || result.verification || artifactRepairMetadata)
        ? {
            metadata: {
              ...(result.metadata ?? {}),
              ...(artifactRepairMetadata ? { artifact_repair: artifactRepairMetadata } : {}),
              ...(result.verification ? { verification: result.verification } : {})
            }
          }
        : {})
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
    if (logSink) {
      await logSink.flush();
    }

    const message = error instanceof Error ? error.message : String(error);
    const repairMetadata =
      error instanceof ArtifactMaterializationError
        ? error.repair_metadata
        : artifactRepairMetadata;
    const failureArtifacts: Record<string, string> | undefined = executionPaths
      ? {
          ...(await writeFailureAutomaticArtifacts(node, attempt, message)),
          ...(automaticArtifacts ?? {})
        }
      : undefined;

    if (executionPaths && node.kind === "agent" && !failureArtifacts?.agent_response) {
      const responsePath = join(resolveExecutionArtifactsDirectory(attempt.execution_dir), "agent-response.md");
      await writeFile(responsePath, `Agent failed before a final response was captured: ${message}\n`, "utf8");

      if (failureArtifacts) {
        failureArtifacts.agent_response = responsePath;
      }
    }

    const completedAttempt = closeNodeAttempt(session.attempts, attempt.execution_id, {
      status: "failed",
      outcome: "failed",
      ...(executionPaths
        ? {
            stdout_log_path: executionPaths.stdout_log_path,
            stderr_log_path: executionPaths.stderr_log_path,
            result_path: executionPaths.result_path,
            ...(failureArtifacts ? { artifacts: failureArtifacts } : {})
          }
        : {}),
      ...(context
        ? {
            context_packet_path: context.packet_path,
            context_manifest_path: context.manifest_path,
            context_provenance_path: context.provenance_path
          }
        : {}),
      metadata: {
        error: message,
        context_status: context ? "resolved" : "failed",
        ...(repairMetadata ? { artifact_repair: repairMetadata } : {})
      }
    });

    if (executionPaths) {
      await writer.writeExecutionCompletion(completedAttempt, {
        result: {
          error: message
        },
        stderr: message
      });
    }

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
          error: message,
          context_status: context ? "resolved" : "failed"
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
  topology: SchedulerTopology,
  readinessCache: NodeReadinessCache
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

    const nextAttemptIndexes = peekNextAttemptIndexes(session.attempts, node.compiled_id, {
      ...(readyNode.iteration_index !== undefined ? { iteration_index: readyNode.iteration_index } : {})
    });
    const executionId = buildExecutionId(node.compiled_id, nextAttemptIndexes.attempt_index, {
      ...(readyNode.repeat_scope_id ? { repeat_scope_id: readyNode.repeat_scope_id } : {}),
      ...(readyNode.iteration_index !== undefined ? { iteration_index: readyNode.iteration_index } : {})
    });
    const executionDir = writer.getExecutionDirectory(node.compiled_id, executionId, {
      attemptIndex: nextAttemptIndexes.attempt_index,
      ...(readyNode.iteration_index !== undefined ? { iterationIndex: readyNode.iteration_index } : {}),
      ...(nextAttemptIndexes.iteration_attempt_index !== undefined
        ? { iterationAttemptIndex: nextAttemptIndexes.iteration_attempt_index }
        : {})
    });
    const attempt = openNodeAttempt(session.attempts, node, executionDir, {
      ...(readyNode.repeat_scope_id ? { repeat_scope_id: readyNode.repeat_scope_id } : {}),
      ...(readyNode.iteration_index !== undefined ? { iteration_index: readyNode.iteration_index } : {}),
      attempt_index: nextAttemptIndexes.attempt_index,
      ...(nextAttemptIndexes.iteration_attempt_index !== undefined
        ? { iteration_attempt_index: nextAttemptIndexes.iteration_attempt_index }
        : {})
    });
    registerActiveExecution(session, attempt);
    const abortControl = createExecutionAbortControl(options.signal);
    const execution = executeNode(
      options,
      session,
      writer,
      runOwner,
      events,
      node,
      attempt,
      abortControl.signal,
      readinessCache
    ).finally(() => {
      abortControl.dispose();
    });

    await emitEvent(session, writer, runOwner, events, options.on_event, "node.started", {
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
  onEvent: RunCompiledGraphOptions["on_event"],
  failedNode: CompiledExecutableNode
): Promise<void> {
  const cleanupNodeIds = collectCleanupNodeIds(session.graph);

  for (const [compiledId, status] of session.node_statuses.entries()) {
    if (!["pending", "ready"].includes(status)) {
      continue;
    }

    if (cleanupNodeIds.has(compiledId)) {
      continue;
    }

    setNodeStatus(session, compiledId, "blocked");
    await emitEvent(session, writer, runOwner, events, onEvent, "node.blocked", {
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
  onEvent: RunCompiledGraphOptions["on_event"],
  reason: string
): Promise<void> {
  const cleanupNodeIds = collectCleanupNodeIds(session.graph);

  for (const [compiledId, status] of session.node_statuses.entries()) {
    if (!["pending", "ready"].includes(status)) {
      continue;
    }

    if (cleanupNodeIds.has(compiledId)) {
      continue;
    }

    setNodeStatus(session, compiledId, "skipped");
    await emitEvent(session, writer, runOwner, events, onEvent, "node.skipped", {
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

function collectCleanupNodeIds(graph: CompiledGraph): Set<string> {
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (node.is_cleanup) {
      ids.add(node.compiled_id);
    }
  }
  return ids;
}

interface CleanupChain {
  sequence_scope_id: string;
  sequence_authored_id: string;
  scope_depth: number;
  cleanup_compiled_node_ids: string[];
}

function buildCleanupChains(graph: CompiledGraph): CleanupChain[] {
  const chains: CleanupChain[] = [];

  for (const scope of graph.scopes) {
    if (scope.kind !== "sequence") {
      continue;
    }

    const cleanupIds = scope.cleanup_compiled_node_ids ?? [];

    if (cleanupIds.length === 0) {
      continue;
    }

    chains.push({
      sequence_scope_id: scope.scope_id,
      sequence_authored_id: scope.authored_id,
      scope_depth: scope.scope_stack.length,
      cleanup_compiled_node_ids: cleanupIds
    });
  }

  chains.sort((left, right) => right.scope_depth - left.scope_depth);
  return chains;
}

async function runCleanupChains(
  options: RunCompiledGraphOptions,
  session: RuntimeSession,
  writer: ArtifactWriter,
  runOwner: RunOwnerRecord,
  events: RuntimeEventEnvelope[],
  topology: SchedulerTopology,
  readinessCache: NodeReadinessCache,
  bodyOutcome: "passed" | "failed" | "canceled"
): Promise<{ canceled: boolean }> {
  const chains = buildCleanupChains(session.graph);

  if (chains.length === 0) {
    return { canceled: false };
  }

  let canceledDuringCleanup = false;

  for (const chain of chains) {
    if (canceledDuringCleanup) {
      await markRemainingCleanupSkipped(
        session,
        writer,
        runOwner,
        events,
        options.on_event,
        chain.cleanup_compiled_node_ids,
        "operator_cancel"
      );
      continue;
    }

    await emitEvent(
      session,
      writer,
      runOwner,
      events,
      options.on_event,
      "sequence.cleanup.started",
      {
        sequence_authored_id: chain.sequence_authored_id,
        cleanup_step_count: chain.cleanup_compiled_node_ids.length,
        body_outcome: bodyOutcome
      },
      {
        compiled_id: undefined,
        execution_id: undefined,
        repeat_scope_id: undefined,
        iteration_index: undefined,
        attempt_index: undefined
      }
    );

    const counts = { steps_attempted: 0, steps_passed: 0, steps_failed: 0, steps_skipped: 0 };

    for (const compiledId of chain.cleanup_compiled_node_ids) {
      const node = topology.nodes_by_id.get(compiledId);

      if (!node) {
        counts.steps_skipped += 1;
        continue;
      }

      if (options.signal?.aborted) {
        canceledDuringCleanup = true;
        counts.steps_skipped += 1;
        setNodeStatus(session, compiledId, "skipped");
        await emitEvent(
          session,
          writer,
          runOwner,
          events,
          options.on_event,
          "node.skipped",
          { reason: "operator_cancel" },
          {
            compiled_id: compiledId,
            execution_id: undefined,
            repeat_scope_id: undefined,
            iteration_index: undefined,
            attempt_index: undefined
          }
        );
        continue;
      }

      counts.steps_attempted += 1;

      const stepResult = await runSingleCleanupNode(
        options,
        session,
        writer,
        runOwner,
        events,
        node,
        readinessCache
      );

      if (stepResult.status === "passed") {
        counts.steps_passed += 1;
      } else if (stepResult.status === "canceled") {
        canceledDuringCleanup = true;
      } else {
        counts.steps_failed += 1;
        await emitEvent(
          session,
          writer,
          runOwner,
          events,
          options.on_event,
          "sequence.cleanup.step_failed",
          {
            compiled_id: compiledId,
            message: stepResult.message ?? "cleanup step failed"
          },
          {
            compiled_id: compiledId,
            execution_id: undefined,
            repeat_scope_id: undefined,
            iteration_index: undefined,
            attempt_index: undefined
          }
        );
      }
    }

    if (canceledDuringCleanup) {
      await emitEvent(
        session,
        writer,
        runOwner,
        events,
        options.on_event,
        "sequence.cleanup.canceled",
        {
          sequence_authored_id: chain.sequence_authored_id,
          reason: "operator_cancel"
        },
        {
          compiled_id: undefined,
          execution_id: undefined,
          repeat_scope_id: undefined,
          iteration_index: undefined,
          attempt_index: undefined
        }
      );
    } else {
      await emitEvent(
        session,
        writer,
        runOwner,
        events,
        options.on_event,
        "sequence.cleanup.completed",
        {
          sequence_authored_id: chain.sequence_authored_id,
          ...counts
        },
        {
          compiled_id: undefined,
          execution_id: undefined,
          repeat_scope_id: undefined,
          iteration_index: undefined,
          attempt_index: undefined
        }
      );
    }
  }

  return { canceled: canceledDuringCleanup };
}

async function markRemainingCleanupSkipped(
  session: RuntimeSession,
  writer: ArtifactWriter,
  runOwner: RunOwnerRecord,
  events: RuntimeEventEnvelope[],
  onEvent: RunCompiledGraphOptions["on_event"],
  cleanupCompiledIds: string[],
  reason: string
): Promise<void> {
  for (const compiledId of cleanupCompiledIds) {
    const status = session.node_statuses.get(compiledId);
    if (status && !["pending", "ready"].includes(status)) {
      continue;
    }
    setNodeStatus(session, compiledId, "skipped");
    await emitEvent(session, writer, runOwner, events, onEvent, "node.skipped", { reason }, {
      compiled_id: compiledId,
      execution_id: undefined,
      repeat_scope_id: undefined,
      iteration_index: undefined,
      attempt_index: undefined
    });
  }
}

async function runSingleCleanupNode(
  options: RunCompiledGraphOptions,
  session: RuntimeSession,
  writer: ArtifactWriter,
  runOwner: RunOwnerRecord,
  events: RuntimeEventEnvelope[],
  node: CompiledExecutableNode,
  readinessCache: NodeReadinessCache
): Promise<{ status: "passed" | "failed" | "canceled"; message?: string }> {
  const nextAttemptIndexes = peekNextAttemptIndexes(session.attempts, node.compiled_id, {});
  const executionId = buildExecutionId(node.compiled_id, nextAttemptIndexes.attempt_index, {});
  const executionDir = writer.getExecutionDirectory(node.compiled_id, executionId, {
    attemptIndex: nextAttemptIndexes.attempt_index
  });
  const attempt = openNodeAttempt(session.attempts, node, executionDir, {
    attempt_index: nextAttemptIndexes.attempt_index
  });
  registerActiveExecution(session, attempt);
  const abortControl = createExecutionAbortControl(options.signal);

  await emitEvent(session, writer, runOwner, events, options.on_event, "node.started", {
    kind: node.kind,
    repo_alias: node.repo,
    profile_name: node.effective_policy.profile_name
  }, {
    compiled_id: node.compiled_id,
    execution_id: attempt.execution_id,
    repeat_scope_id: undefined,
    iteration_index: undefined,
    attempt_index: attempt.attempt_index
  });

  let result;
  try {
    const completion = await executeNode(
      options,
      session,
      writer,
      runOwner,
      events,
      node,
      attempt,
      abortControl.signal,
      readinessCache
    );
    result = completion.result;
    finalizeExecutionSummary(session, completion.attempt);
  } catch (error) {
    abortControl.dispose();
    const message = error instanceof Error ? error.message : String(error);
    return { status: "failed", message };
  }

  abortControl.dispose();

  await emitEvent(session, writer, runOwner, events, options.on_event, "node.completed", {
    outcome: result.outcome ?? (result.status === "passed" ? "passed" : "failed"),
    duration_ms: attempt.duration_ms ?? 0
  }, {
    compiled_id: node.compiled_id,
    execution_id: attempt.execution_id,
    repeat_scope_id: undefined,
    iteration_index: undefined,
    attempt_index: attempt.attempt_index
  });

  if (result.status === "canceled") {
    return { status: "canceled" };
  }

  if (result.status === "passed") {
    return { status: "passed" };
  }

  return { status: "failed", message: "cleanup step did not pass" };
}

async function finalizeRun(
  session: RuntimeSession,
  writer: ArtifactWriter,
  runOwner: RunOwnerRecord,
  events: RuntimeEventEnvelope[],
  onEvent: RunCompiledGraphOptions["on_event"],
  outcome: RuntimeRunStatus,
  reason?: string
): Promise<RunCompiledGraphResult> {
  session.status = outcome;
  session.ended_at = new Date().toISOString();
  const duration_ms = Math.max(0, Date.parse(session.ended_at) - Date.parse(session.started_at));

  if (outcome === "canceled") {
    await emitEvent(session, writer, runOwner, events, onEvent, "run.canceled", {
      reason: reason ?? "operator_cancel"
    });
  } else {
    await emitEvent(session, writer, runOwner, events, onEvent, "run.completed", {
      outcome,
      duration_ms,
      ...(reason ? { reason } : {})
    });
  }

  let state = buildRuntimeStateSnapshot(session);
  let attempts = await readRunExecutionAttempts(writer.run_root);
  let deliveryManifest: DeliveryPackageManifest | undefined;

  try {
    deliveryManifest = await writeDeliveryPackage({
      run_root: writer.run_root,
      graph: session.graph,
      state,
      attempts,
      events,
      interventions: await readSupervisorInterventions(writer.run_root)
    });
    await emitEvent(session, writer, runOwner, events, onEvent, "delivery.package.completed", {
      manifest_path: deliveryManifest.manifest_path,
      reviewer_guide: deliveryManifest.sections.reviewer_guide,
      intervention_count: deliveryManifest.intervention_count,
      failed_check_count: deliveryManifest.failed_check_count
    });
    state = buildRuntimeStateSnapshot(session);
    attempts = await readRunExecutionAttempts(writer.run_root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    session.status = "failed";
    state = await syncRunArtifacts(session, writer, runOwner);
    await emitEvent(session, writer, runOwner, events, onEvent, "run.completed", {
      outcome: "failed",
      duration_ms,
      reason: `delivery_package_failed: ${message}`
    });
  }

  state = await writeTerminalRunSummary(session, writer, events, deliveryManifest);

  return {
    run_id: session.run_id,
    run_root: writer.run_root,
    outcome: session.status,
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
  onEvent: RunCompiledGraphOptions["on_event"],
  workspace: WorkspaceSetup | undefined,
  outcome: RuntimeRunStatus,
  reason?: string
): Promise<RunCompiledGraphResult> {
  let finalOutcome = outcome;
  let finalReason = reason;

  if (workspace) {
    session.workspace_change_artifacts = await captureWorkspaceChanges(
      writer.run_root,
      Object.values(workspace.repo_workspaces)
    );

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

  return finalizeRun(session, writer, runOwner, events, onEvent, finalOutcome, finalReason);
}

async function finalizeRunAfterCleanup(
  options: RunCompiledGraphOptions,
  session: RuntimeSession,
  writer: ArtifactWriter,
  runOwner: RunOwnerRecord,
  events: RuntimeEventEnvelope[],
  workspace: WorkspaceSetup | undefined,
  topology: SchedulerTopology,
  readinessCache: NodeReadinessCache,
  outcome: RuntimeRunStatus,
  reason?: string
): Promise<RunCompiledGraphResult> {
  const bodyOutcome: "passed" | "failed" | "canceled" =
    outcome === "passed" || outcome === "failed" || outcome === "canceled"
      ? outcome
      : "failed";
  const previousStatus = session.status;
  session.status = "running";

  let finalOutcome = outcome;
  let finalReason = reason;

  try {
    const cleanupResult = await runCleanupChains(
      options,
      session,
      writer,
      runOwner,
      events,
      topology,
      readinessCache,
      bodyOutcome
    );

    if (cleanupResult.canceled && finalOutcome !== "canceled") {
      finalOutcome = "canceled";
      finalReason = finalReason
        ? `${finalReason} | cleanup canceled by operator`
        : "cleanup canceled by operator";
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finalReason = finalReason
      ? `${finalReason} | cleanup failed: ${message}`
      : `cleanup failed: ${message}`;
  }

  session.status = previousStatus;

  await markRemainingCleanupSkipped(
    session,
    writer,
    runOwner,
    events,
    options.on_event,
    [...collectCleanupNodeIds(session.graph)],
    finalOutcome === "canceled" ? "operator_cancel" : "cleanup_complete"
  );

  return finalizeRunWithWorkspaceCleanup(
    session,
    writer,
    runOwner,
    events,
    options.on_event,
    workspace,
    finalOutcome,
    finalReason
  );
}

async function executeRunLoop(
  options: RunCompiledGraphOptions,
  session: RuntimeSession,
  writer: ArtifactWriter,
  runOwner: RunOwnerRecord,
  events: RuntimeEventEnvelope[],
  workspace: WorkspaceSetup,
  topology: SchedulerTopology
): Promise<RunCompiledGraphResult> {
  const readyQueue = createReadyQueueState();
  const activeExecutions = new Map<string, ActiveExecutionHandle>();
  const readinessCache = createNodeReadinessCache();

  while (true) {
    if (options.signal?.aborted && session.status !== "canceled") {
      session.status = "canceled";
      await markPendingNodesSkipped(session, writer, runOwner, events, options.on_event, "operator_cancel");
      cancelActiveExecutions(activeExecutions);
    }

    if (session.status === "running") {
      await refreshReadyNodes(session, writer, runOwner, events, options.on_event, topology, readyQueue);
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
        topology,
        readinessCache
      ))
    ) {
      // Keep dispatching while the scheduler can consume ready nodes.
    }

    if (session.status === "canceled" && activeExecutions.size === 0) {
      return finalizeRunAfterCleanup(
        options,
        session,
        writer,
        runOwner,
        events,
        workspace,
        topology,
        readinessCache,
        "canceled",
        "operator_cancel"
      );
    }

    if (session.status === "failed" && activeExecutions.size === 0) {
      return finalizeRunAfterCleanup(
        options,
        session,
        writer,
        runOwner,
        events,
        workspace,
        topology,
        readinessCache,
        "failed"
      );
    }

    if (session.status === "paused" && activeExecutions.size === 0) {
      return finalizeRunAfterCleanup(
        options,
        session,
        writer,
        runOwner,
        events,
        workspace,
        topology,
        readinessCache,
        "paused",
        session.supervisor.pause?.reason ?? "paused_for_human"
      );
    }

    if (session.status === "running" && activeExecutions.size === 0) {
      const remainingReady = readyQueue.queue.length > 0;
      const cleanupNodeIds = collectCleanupNodeIds(session.graph);
      const unfinishedNodes = [...session.node_statuses.entries()].some(
        ([compiledId, status]) =>
          !cleanupNodeIds.has(compiledId) &&
          ["pending", "ready", "running"].includes(status)
      );

      if (!remainingReady && !unfinishedNodes) {
        return finalizeRunAfterCleanup(
          options,
          session,
          writer,
          runOwner,
          events,
          workspace,
          topology,
          readinessCache,
          "passed"
        );
      }

      if (!remainingReady && unfinishedNodes && session.status === "running") {
        session.status = "failed";
        const failedNode =
          session.graph.nodes.find((candidate) => session.node_statuses.get(candidate.compiled_id) === "failed") ??
          session.graph.nodes[0];

        if (!failedNode) {
          return finalizeRunAfterCleanup(
            options,
            session,
            writer,
            runOwner,
            events,
            workspace,
            topology,
            readinessCache,
            "failed"
          );
        }

        await markPendingNodesBlocked(
          session,
          writer,
          runOwner,
          events,
          options.on_event,
          failedNode
        );
        return finalizeRunAfterCleanup(
          options,
          session,
          writer,
          runOwner,
          events,
          workspace,
          topology,
          readinessCache,
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
      await emitEvent(session, writer, runOwner, events, options.on_event, "check.evaluated", result.check, {
        compiled_id: node.compiled_id,
        execution_id: attempt.execution_id,
        repeat_scope_id: attempt.repeat_scope_id,
        iteration_index: attempt.iteration_index,
        attempt_index: attempt.attempt_index
      });
    }

    if (result.verification) {
      await emitEvent(session, writer, runOwner, events, options.on_event, "verification.recorded", result.verification, {
        compiled_id: node.compiled_id,
        execution_id: attempt.execution_id,
        repeat_scope_id: attempt.repeat_scope_id,
        iteration_index: attempt.iteration_index,
        attempt_index: attempt.attempt_index
      });
    }

    if (result.status === "canceled") {
      if (session.status === "running") {
        session.status = "canceled";
        await markPendingNodesSkipped(
          session,
          writer,
          runOwner,
          events,
          options.on_event,
          "operator_cancel"
        );
        cancelActiveExecutions(activeExecutions);
      }

      await emitEvent(session, writer, runOwner, events, options.on_event, "node.canceled", {
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
    await emitEvent(session, writer, runOwner, events, options.on_event, "node.completed", {
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
      await emitEvent(session, writer, runOwner, events, options.on_event, "repeat.iteration.completed", {
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
          await emitEvent(session, writer, runOwner, events, options.on_event, "repeat.iteration.started", {
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
                queueReadyNode(readyQueue, session, writer, runOwner, events, options.on_event, {
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
        await markPendingNodesBlocked(session, writer, runOwner, events, options.on_event, node);
        cancelActiveExecutions(activeExecutions);
        continue;
      }

      completeRepeatIteration(session, repeatScopeId, "passed");
      continue;
    }

    if (outcome === "failed" && !hasFailureContinuation(topology, node)) {
      const retried = await handleFailedNodeWithSupervisor({
        runOptions: options,
        session,
        writer,
        runOwner,
        events,
        readyQueue,
        node,
        attempt,
        result,
        readyNode: {
          compiled_id: node.compiled_id,
          deps_satisfied: computeReadyDeps(session, topology, node, attempt.iteration_index) ?? [],
          repeat_scope_id: attempt.repeat_scope_id,
          iteration_index: attempt.iteration_index
        }
      });

      if (retried) {
        continue;
      }

      if (session.status === "paused") {
        cancelActiveExecutions(activeExecutions);
        continue;
      }

      session.status = "failed";
      await markPendingNodesBlocked(session, writer, runOwner, events, options.on_event, node);
      cancelActiveExecutions(activeExecutions);
      continue;
    }
  }
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
    ...(options.graph_path ? { graph_path: options.graph_path } : {}),
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
  const writer = new ArtifactWriter(options.run_root, options.compiled_graph);
  const activeRepoSources = filterActiveRepoSources(options.compiled_graph, options.repo_sources);
  const predictedBindings = predictWorkspaceBindings(
    options.compiled_graph.launch.workspace_backend,
    options.run_root,
    activeRepoSources
  );
  const session = createRuntimeSession(
    run_id,
    options.run_root,
    options.compiled_graph,
    createAttemptRegistry(),
    predictedBindings,
    options.graph_path
  );
  const events: RuntimeEventEnvelope[] = [];
  const topology = buildSchedulerTopology(options.compiled_graph);
  const runOwner = await createRunOwnerRecord();
  let workspace: WorkspaceSetup | undefined;

  await writer.initializeRunArtifacts(buildInitializeArtifactsOptions(options, session, runOwner));
  await emitEvent(session, writer, runOwner, events, options.on_event, "graph.compiled", {
    graph_id: options.compiled_graph.graph_id,
    compiled_node_count: options.compiled_graph.nodes.length,
    scope_count: options.compiled_graph.scopes.length
  });

  const readiness = await evaluateGraphReadiness({
    graph: options.compiled_graph,
    repo_sources: activeRepoSources
  });

  if (readiness.status === "blocked") {
    session.status = "failed";
    session.ended_at = new Date().toISOString();
    await writer.initializeRunArtifacts(buildInitializeArtifactsOptions(options, session, runOwner));
    await emitEvent(session, writer, runOwner, events, options.on_event, "run.preflight_failed", {
      reason: "readiness_blocked",
      message: readiness.checks
        .filter((check) => check.status === "blocked")
        .map((check) => check.message)
        .join(" | ")
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
      activeRepoSources
    );
    session.manifest.repo_workspaces = workspace.repo_workspaces;
  } catch (error) {
    session.status = "failed";
    session.ended_at = new Date().toISOString();
    await writer.initializeRunArtifacts(buildInitializeArtifactsOptions(options, session, runOwner));
    await emitEvent(session, writer, runOwner, events, options.on_event, "run.preflight_failed", {
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
  await emitEvent(session, writer, runOwner, events, options.on_event, "run.started", {
    workspace_backend: session.manifest.workspace_backend,
    repo_workspaces: session.manifest.repo_workspaces
  });

  return executeRunLoop(
    options,
    session,
    writer,
    runOwner,
    events,
    workspace,
    topology
  );
}

export async function resumeCompiledGraph(
  options: ResumeCompiledGraphOptions
): Promise<RunCompiledGraphResult> {
  const writer = new ArtifactWriter(options.run_root, options.compiled_graph);
  const runOwner = await createRunOwnerRecord();
  const session = options.resumed_session;
  const events = [...options.prior_events];
  const topology = buildSchedulerTopology(options.compiled_graph);
  const readiness = await evaluateGraphReadiness({
    graph: options.compiled_graph,
    repo_sources: collectSourcePathsFromWorkspace(options.workspace)
  });

  if (readiness.status === "blocked") {
    session.status = "failed";
    session.ended_at = new Date().toISOString();
    await writer.initializeRunArtifacts(buildInitializeArtifactsOptions(options, session, runOwner));
    await emitEvent(session, writer, runOwner, events, options.on_event, "run.preflight_failed", {
      reason: "readiness_blocked",
      message: readiness.checks
        .filter((check) => check.status === "blocked")
        .map((check) => check.message)
        .join(" | ")
    });
    const state = await writeTerminalRunSummary(session, writer, events);

    return {
      run_id: session.run_id,
      run_root: writer.run_root,
      outcome: "failed",
      state,
      attempts: await readRunExecutionAttempts(writer.run_root),
      events: await readRunEvents(writer.run_root)
    };
  }

  session.status = "running";
  delete session.ended_at;
  await writer.initializeRunArtifacts(buildInitializeArtifactsOptions(options, session, runOwner));
  await emitEvent(session, writer, runOwner, events, options.on_event, "run.started", {
    workspace_backend: session.manifest.workspace_backend,
    repo_workspaces: session.manifest.repo_workspaces,
    resumed: true,
    previous_status: options.previous_status,
    preserved_node_count: options.preserved_node_count,
    restarted_node_count: options.restarted_node_count
  });

  return executeRunLoop(
    options,
    session,
    writer,
    runOwner,
    events,
    options.workspace,
    topology
  );
}

import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
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
import type { GraphDiagnostic, GraphOutcome, HarnessName } from "../../graph/schema.js";
import type { EffectiveSupervisorPolicy } from "../../graph/profiles.js";
import { ArtifactWriter } from "../../artifacts/writer.js";
import {
  readRunEvents,
  readRunExecutionAttempts,
  readSupervisorInterventions
} from "../../artifacts/reader.js";
import { resolveExecutionArtifactsDirectory, resolveInterventionDirectory } from "../../artifacts/paths.js";
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
import { renderHarnessPrompt, type AgentInvocation, type HarnessAdapter } from "../harness/types.js";
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
import type { NodeWorkspaceChangeArtifacts, WorkspaceSetup } from "../workspace/types.js";
import { captureWorkspaceChanges } from "../workspace/changes.js";
import {
  diffNodeSnapshots,
  persistNodeBaselineSnapshot,
  persistNodeWorkspaceChanges,
  restoreNodeWorkspaceChangesFromSnapshot,
  snapshotWorkspaceForNode
} from "../workspace/node-snapshot.js";
import { initializeWorktreeWorkspace } from "../workspace/worktree.js";
import { runOutcomeVerification } from "../verification/verifier.js";
import type { OutcomeVerificationResult } from "../verification/types.js";
import {
  buildCompletionPacket,
  persistCompletionPacket,
  type CompletionManagedSummary,
  type CompletionPacket
} from "../completion/index.js";
import { readOperatorObservations } from "../observations/index.js";
import { runRepairArtifactIntervention } from "../../supervisor/actions.js";
import { buildSupervisorCausalContext } from "../../supervisor/causal.js";
import { classifyNodeFailure, type FailureClassification } from "../../supervisor/classifier.js";
import { runSupervisorRecoveryCycle } from "../../supervisor/recovery.js";
import {
  canSpendSupervisorAction,
  spendSupervisorAction,
  type SupervisorBudgetState
} from "../../supervisor/policy.js";
import type {
  SupervisorDecision,
  SupervisorInterventionRecord,
  SupervisorRecoveryEnvelope,
  SupervisorActionKind
} from "../../supervisor/types.js";
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
  supervisor_recovery_envelope?: SupervisorRecoveryEnvelope;
  environment: NodeJS.ProcessEnv;
  runtime_env?: Record<string, string>;
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
  environment?: NodeJS.ProcessEnv;
  runtime_env?: Record<string, string>;
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

const missingAgentResponseMessage = "No final response was captured from the agent harness.";

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

interface ManagedProgressInfo {
  managed_kind: "pattern_deep_research" | "pattern_deep_work";
  managed_authored_id: string;
  phase: string;
}

function parseManagedAuthoredId(
  authoredId: string,
  loweredFrom?: CompiledExecutableNode["lowered_from"]
): ManagedProgressInfo | undefined {
  if (loweredFrom === "pattern_deep_research" || loweredFrom === "pattern_deep_work") {
    return {
      managed_kind: loweredFrom,
      managed_authored_id: authoredId,
      phase: "public_publisher"
    };
  }

  for (const managedKind of ["pattern_deep_research", "pattern_deep_work"] as const) {
    const marker = `__managed__${managedKind}__`;
    const markerIndex = authoredId.indexOf(marker);

    if (markerIndex !== -1) {
      return {
        managed_kind: managedKind,
        managed_authored_id: authoredId.slice(0, markerIndex),
        phase: authoredId.slice(markerIndex + marker.length)
      };
    }
  }

  return undefined;
}

function managedStatusForNodeOutcome(info: ManagedProgressInfo, outcome: GraphOutcome): string {
  if (outcome === "passed") {
    return "healthy_progress";
  }

  if (info.managed_kind === "pattern_deep_work" && info.phase.includes("completion_gate")) {
    return "ordinary_iteration_feedback";
  }

  return "recoverable_strategy_failure";
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

async function emitManagedNodeProgress(options: {
  session: RuntimeSession;
  writer: ArtifactWriter;
  runOwner: RunOwnerRecord;
  events: RuntimeEventEnvelope[];
  onEvent: RunCompiledGraphOptions["on_event"];
  node: CompiledExecutableNode;
  attempt: RuntimeNodeAttempt;
  outcome: GraphOutcome;
}): Promise<void> {
  const managed = parseManagedAuthoredId(options.node.authored_id, options.node.lowered_from);

  if (!managed) {
    return;
  }

  await emitEvent(
    options.session,
    options.writer,
    options.runOwner,
    options.events,
    options.onEvent,
    "managed.progress",
    {
      ...managed,
      status: managedStatusForNodeOutcome(managed, options.outcome),
      node_authored_id: options.node.authored_id,
      node_kind: options.node.kind,
      outcome: options.outcome,
      evidence_refs: [
        ...(options.attempt.result_path ? [options.attempt.result_path] : []),
        ...Object.values(options.attempt.artifacts)
      ]
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

async function emitManagedRepeatExhaustedProgress(options: {
  session: RuntimeSession;
  writer: ArtifactWriter;
  runOwner: RunOwnerRecord;
  events: RuntimeEventEnvelope[];
  onEvent: RunCompiledGraphOptions["on_event"];
  repeatScopeId: string;
  repeatScopeAuthoredId: string;
  node: CompiledExecutableNode;
  attempt: RuntimeNodeAttempt;
  outcome: GraphOutcome;
}): Promise<boolean> {
  const managed = parseManagedAuthoredId(options.repeatScopeAuthoredId);

  if (!managed) {
    return false;
  }

  const completionPacketPath =
    isRecord(options.attempt.metadata?.completion) &&
    typeof options.attempt.metadata.completion.packet_path === "string"
      ? options.attempt.metadata.completion.packet_path
      : undefined;
  let completionPacket: CompletionPacket | undefined;
  if (completionPacketPath) {
    try {
      completionPacket = JSON.parse(await readFile(completionPacketPath, "utf8")) as CompletionPacket;
    } catch {
      completionPacket = undefined;
    }
  }

  await emitEvent(
    options.session,
    options.writer,
    options.runOwner,
    options.events,
    options.onEvent,
    "managed.progress",
    {
      ...managed,
      phase: "repeat_exhausted",
      status: "recoverable_strategy_failure",
      node_authored_id: options.node.authored_id,
      node_kind: options.node.kind,
      outcome: options.outcome,
      progress: {
        latest_iteration_index: options.attempt.iteration_index,
        max_attempts: options.session.repeat_scopes.get(options.repeatScopeId)?.max_attempts
      },
      ...(completionPacket
        ? {
            completion_status: completionPacket.completion_status,
            blocking_reasons: completionPacket.blocking_reasons,
            managed_summary: completionPacket.managed,
            completion_packet_path: completionPacket.packet_path
          }
        : {}),
      evidence_refs: [
        ...(completionPacketPath ? [completionPacketPath] : []),
        ...(options.attempt.result_path ? [options.attempt.result_path] : []),
        ...Object.values(options.attempt.artifacts)
      ]
    },
    {
      compiled_id: options.node.compiled_id,
      execution_id: options.attempt.execution_id,
      repeat_scope_id: options.repeatScopeId,
      iteration_index: options.attempt.iteration_index,
      attempt_index: options.attempt.attempt_index
    }
  );

  return true;
}

async function readCompletionPacketFromAttempt(attempt: RuntimeNodeAttempt): Promise<CompletionPacket | undefined> {
  const completionPacketPath =
    isRecord(attempt.metadata?.completion) &&
    typeof attempt.metadata.completion.packet_path === "string"
      ? attempt.metadata.completion.packet_path
      : undefined;

  if (!completionPacketPath) {
    return undefined;
  }

  try {
    return JSON.parse(await readFile(completionPacketPath, "utf8")) as CompletionPacket;
  } catch {
    return undefined;
  }
}

function managedBlockingCriteria(summary: CompletionManagedSummary | undefined): string[] {
  if (!summary?.active) {
    return [];
  }

  return [...new Set([
    ...(summary.failing_required_criteria ?? []),
    ...(summary.blocking_criteria ?? [])
  ])].sort();
}

function sameStringList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function emitManagedRepeatStalledProgress(options: {
  session: RuntimeSession;
  writer: ArtifactWriter;
  runOwner: RunOwnerRecord;
  events: RuntimeEventEnvelope[];
  onEvent: RunCompiledGraphOptions["on_event"];
  repeatScopeId: string;
  repeatScopeAuthoredId: string;
  node: CompiledExecutableNode;
  attempt: RuntimeNodeAttempt;
  outcome: GraphOutcome;
}): Promise<boolean> {
  const managed = parseManagedAuthoredId(options.repeatScopeAuthoredId);
  if (!managed || managed.managed_kind !== "pattern_deep_work") {
    return false;
  }

  const currentPacket = await readCompletionPacketFromAttempt(options.attempt);
  if (!currentPacket?.managed.active || currentPacket.managed.ready_for_publish !== false) {
    return false;
  }

  const currentBlockers = managedBlockingCriteria(currentPacket.managed);
  if (currentBlockers.length === 0 || (currentPacket.managed.material_delta?.length ?? 0) > 0) {
    return false;
  }

  const priorPackets = (
    await Promise.all(
      listAttemptsForCompiledNode(options.session.attempts, options.node.compiled_id)
        .filter((attempt) =>
          attempt.execution_id !== options.attempt.execution_id &&
          attempt.repeat_scope_id === options.repeatScopeId
        )
        .map(readCompletionPacketFromAttempt)
    )
  ).filter((packet): packet is CompletionPacket => Boolean(packet));
  const previousPacket = priorPackets.at(-1);
  const previousBlockers = managedBlockingCriteria(previousPacket?.managed);
  if (!previousPacket?.managed.active || !sameStringList(currentBlockers, previousBlockers)) {
    return false;
  }

  await emitEvent(
    options.session,
    options.writer,
    options.runOwner,
    options.events,
    options.onEvent,
    "managed.progress",
    {
      ...managed,
      phase: "stalled_without_delta",
      status: "stalled_without_delta",
      node_authored_id: options.node.authored_id,
      node_kind: options.node.kind,
      outcome: options.outcome,
      blocking_criteria: currentBlockers,
      completion_status: currentPacket.completion_status,
      blocking_reasons: currentPacket.blocking_reasons,
      managed_summary: currentPacket.managed,
      completion_packet_path: currentPacket.packet_path,
      progress: {
        latest_iteration_index: options.attempt.iteration_index,
        previous_iteration_index: previousPacket.managed.cycle,
        max_attempts: options.session.repeat_scopes.get(options.repeatScopeId)?.max_attempts
      },
      evidence_refs: [
        currentPacket.packet_path,
        previousPacket.packet_path,
        ...(options.attempt.result_path ? [options.attempt.result_path] : []),
        ...Object.values(options.attempt.artifacts)
      ]
    },
    {
      compiled_id: options.node.compiled_id,
      execution_id: options.attempt.execution_id,
      repeat_scope_id: options.repeatScopeId,
      iteration_index: options.attempt.iteration_index,
      attempt_index: options.attempt.attempt_index
    }
  );

  return true;
}

interface ManagedCriterionSnapshot {
  id: string;
  required: boolean;
  passed: boolean;
  score: number;
  summary?: string;
  evidence_path?: string;
}

interface ManagedScorecardSnapshot {
  passed: boolean;
  total_score: number;
  criteria: ManagedCriterionSnapshot[];
  path: string;
}

function normalizeManagedCriterion(value: unknown): ManagedCriterionSnapshot | undefined {
  if (!isRecord(value) || typeof value.id !== "string") {
    return undefined;
  }
  const rawScore = typeof value.score === "number" ? value.score : value.passed === true ? 1 : 0;
  return {
    id: value.id,
    required: value.required === true,
    passed: value.passed === true,
    score: Math.max(0, Math.min(1, rawScore)),
    ...(typeof value.summary === "string" ? { summary: value.summary } : {}),
    ...(typeof value.evidence_path === "string" ? { evidence_path: value.evidence_path } : {})
  };
}

async function readManagedScorecard(path: string | undefined): Promise<ManagedScorecardSnapshot | undefined> {
  if (!path) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.criteria)) {
      return undefined;
    }
    return {
      passed: parsed.passed === true,
      total_score: typeof parsed.total_score === "number" ? parsed.total_score : 0,
      criteria: parsed.criteria.flatMap((criterion) => {
        const normalized = normalizeManagedCriterion(criterion);
        return normalized ? [normalized] : [];
      }),
      path
    };
  } catch {
    return undefined;
  }
}

async function buildManagedCompletionSummary(options: {
  session: RuntimeSession;
  node: CompiledExecutableNode;
  attempt: RuntimeNodeAttempt;
  artifacts: Record<string, string>;
}): Promise<CompletionManagedSummary | undefined> {
  const managed = parseManagedAuthoredId(options.node.authored_id, options.node.lowered_from);
  if (!managed || managed.managed_kind !== "pattern_deep_work") {
    return undefined;
  }
  if (!managed.phase.includes("completion_gate")) {
    return undefined;
  }

  const currentScorecard = await readManagedScorecard(options.artifacts.completion_scorecard);
  const cycleLimit = options.attempt.repeat_scope_id
    ? options.session.repeat_scopes.get(options.attempt.repeat_scope_id)?.max_attempts
    : undefined;
  if (!currentScorecard) {
    return {
      active: true,
      managed_kind: managed.managed_kind,
      ...(options.attempt.iteration_index !== undefined ? { cycle: options.attempt.iteration_index } : {}),
      ...(cycleLimit !== undefined ? { cycle_limit: cycleLimit } : {}),
      ready_for_publish: false,
      blocking_criteria: managed.phase.includes("completion_gate") ? ["completion_scorecard_missing"] : [],
      material_delta: [],
      evidence_refs: []
    };
  }

  const priorScorecards = (
    await Promise.all(
      listAttemptsForCompiledNode(options.session.attempts, options.node.compiled_id)
        .filter((attempt) => attempt.execution_id !== options.attempt.execution_id)
        .map((attempt) => readManagedScorecard(attempt.artifacts.completion_scorecard))
    )
  ).filter((scorecard): scorecard is ManagedScorecardSnapshot => Boolean(scorecard));
  const priorCriteriaById = new Map<string, ManagedCriterionSnapshot[]>();
  for (const scorecard of priorScorecards) {
    for (const criterion of scorecard.criteria) {
      const list = priorCriteriaById.get(criterion.id) ?? [];
      list.push(criterion);
      priorCriteriaById.set(criterion.id, list);
    }
  }

  const failingRequired = currentScorecard.criteria
    .filter((criterion) => criterion.required && !criterion.passed)
    .map((criterion) => criterion.id);
  const regressions = currentScorecard.criteria.flatMap((criterion) => {
    if (!criterion.required || criterion.passed) {
      return [];
    }
    const priorPassed = (priorCriteriaById.get(criterion.id) ?? []).find((prior) => prior.passed);
    return priorPassed
      ? [{
          criterion: criterion.id,
          from: "passed",
          to: "failed",
          ...(options.attempt.iteration_index !== undefined ? { cycle: options.attempt.iteration_index } : {})
        }]
      : [];
  });
  const previousScorecard = priorScorecards.at(-1);
  const materialDelta = previousScorecard
    ? [
        ...(previousScorecard.total_score !== currentScorecard.total_score
          ? [`Completion score changed from ${previousScorecard.total_score} to ${currentScorecard.total_score}.`]
          : []),
        ...currentScorecard.criteria.flatMap((criterion) => {
          const previous = previousScorecard.criteria.find((entry) => entry.id === criterion.id);
          return previous && (previous.passed !== criterion.passed || previous.score !== criterion.score)
            ? [`Criterion ${criterion.id} changed from ${previous.passed ? "passed" : "failed"}:${previous.score} to ${criterion.passed ? "passed" : "failed"}:${criterion.score}.`]
            : [];
        })
      ]
    : [];
  const blockingCriteria = [...new Set([
    ...failingRequired,
    ...regressions.map((regression) => regression.criterion)
  ])];

  return {
    active: true,
    managed_kind: managed.managed_kind,
    ...(options.attempt.iteration_index !== undefined ? { cycle: options.attempt.iteration_index } : {}),
    ...(cycleLimit !== undefined ? { cycle_limit: cycleLimit } : {}),
    failing_required_criteria: failingRequired,
    regressions,
    blocking_criteria: blockingCriteria,
    ready_for_publish: currentScorecard.passed && blockingCriteria.length === 0,
    material_delta: materialDelta,
    evidence_refs: [
      currentScorecard.path,
      ...currentScorecard.criteria.flatMap((criterion) => criterion.evidence_path ? [criterion.evidence_path] : [])
    ]
  };
}

function canSpendRuntimeSupervisorAction(session: RuntimeSession, action: SupervisorActionKind): boolean {
  return canSpendSupervisorAction({
    remaining: session.supervisor.budget_remaining,
    spent: { total: 0 }
  }, action);
}

function resolveSupervisorPolicyForNode(
  session: RuntimeSession,
  node: CompiledExecutableNode
): EffectiveSupervisorPolicy {
  return session.graph.supervisor_effective_policy ?? {
    profile_name: node.effective_policy.profile_name,
    ...(node.effective_policy.harness ? { harness: node.effective_policy.harness } : {}),
    ...(node.effective_policy.model ? { model: node.effective_policy.model } : {}),
    ...(node.effective_policy.reasoning_effort ? { reasoning_effort: node.effective_policy.reasoning_effort } : {}),
    ...(node.effective_policy.sandbox ? { sandbox: node.effective_policy.sandbox } : {}),
    ...(node.effective_policy.skip_git_repo_check !== undefined
      ? { skip_git_repo_check: node.effective_policy.skip_git_repo_check }
      : {}),
    timeout_sec: node.effective_policy.timeout_sec
  };
}

function resolveSupervisorHarness(
  session: RuntimeSession,
  node: CompiledExecutableNode,
  harnesses: RunCompiledGraphOptions["harnesses"]
): {
  policy: EffectiveSupervisorPolicy;
  harnessName?: HarnessName;
  harness?: HarnessAdapter;
} {
  const policy = resolveSupervisorPolicyForNode(session, node);
  const harnessName =
    session.graph.supervisor_effective_policy || node.kind === "agent" || node.kind === "check"
      ? policy.harness
      : undefined;
  return {
    policy,
    ...(harnessName ? { harnessName } : {}),
    ...(harnessName && harnesses?.[harnessName] ? { harness: harnesses[harnessName] } : {})
  };
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
    case "repair_artifact":
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
      return "Supervisor will run a semantic-evaluation intervention.";
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
      return "Supervisor semantic-evaluation intervention brief.";
    case "pause_for_human":
      return "Supervisor escalation brief for human input.";
    default:
      return actionRetrySummary(action);
  }
}

function normalizeFingerprintText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\/[^\s"')]+/gu, "<path>")
    .replace(/[a-f0-9]{8,}/gu, "<hex>")
    .replace(/\b\d+\b/gu, "<num>")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 240);
}

function collectEvidenceStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string") {
    output.push(value);
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectEvidenceStrings(item, output);
    }
    return output;
  }

  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (
        key.toLowerCase().includes("artifact")
        || key.toLowerCase().includes("path")
        || key.toLowerCase().includes("category")
        || key.toLowerCase().includes("error")
        || key.toLowerCase().includes("summary")
      ) {
        collectEvidenceStrings(nested, output);
      }
    }
  }

  return output;
}

function createFailureFingerprint(classification: FailureClassification): string {
  const evidenceText = collectEvidenceStrings(classification.evidence)
    .map(normalizeFingerprintText)
    .filter(Boolean)
    .slice(0, 8)
    .join("|");
  return [
    classification.class,
    classification.recommended_action,
    normalizeFingerprintText(classification.summary),
    evidenceText
  ].filter(Boolean).join("::");
}

function updateFailureFingerprintState(
  session: RuntimeSession,
  compiledId: string,
  executionId: string,
  fingerprint: string
): number {
  const previous = session.supervisor.failure_fingerprints[compiledId];
  const now = new Date().toISOString();
  const count = previous?.fingerprint === fingerprint ? previous.count + 1 : 1;
  session.supervisor.failure_fingerprints[compiledId] = {
    fingerprint,
    count,
    last_execution_id: executionId,
    last_seen_at: now
  };
  return count;
}

function retryDelayBaseMs(): number {
  const configured = Number.parseInt(process.env.AGENTFLOW_RETRY_BASE_DELAY_MS ?? "", 10);
  if (Number.isFinite(configured) && configured >= 0) {
    return configured;
  }
  return process.env.NODE_ENV === "test" || process.env.VITEST || process.env.VITEST_WORKER_ID ? 0 : 10_000;
}

function retryDelayMaxMs(): number {
  const configured = Number.parseInt(process.env.AGENTFLOW_RETRY_MAX_DELAY_MS ?? "", 10);
  if (Number.isFinite(configured) && configured >= 0) {
    return configured;
  }
  return 120_000;
}

function computeRetryDelayMs(repeatedFingerprintCount: number): number {
  const base = retryDelayBaseMs();
  const max = retryDelayMaxMs();
  const exponent = Math.max(0, repeatedFingerprintCount - 1);
  return Math.min(max, base * (2 ** exponent));
}

async function sleepForRetryDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) {
    return;
  }

  await new Promise<void>((resolveSleep, reject) => {
    const timer = setTimeout(resolveSleep, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("Retry delay canceled."));
    };

    if (signal?.aborted) {
      abort();
      return;
    }

    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function applyRuntimeOverlayBeforeRetry(options: {
  recovery: Awaited<ReturnType<typeof runSupervisorRecoveryCycle>>;
  attempt: RuntimeNodeAttempt;
  workspacePath: string;
}): Promise<boolean> {
  const overlay = options.recovery.recovery_plan.runtime_overlay;
  if (!overlay) {
    return false;
  }

  if (overlay.apply_action === "repair_workspace") {
    const patch = overlay.workspace_repair;
    if (!patch) {
      return false;
    }
    const result = await restoreNodeWorkspaceChangesFromSnapshot({
      workspacePath: options.workspacePath,
      attemptDir: options.attempt.execution_dir,
      ...(patch.result_path ? { resultPath: patch.result_path } : {})
    });
    return result.status === "passed" || result.status === "partial";
  }

  return true;
}

async function handleFailedNodeWithSupervisor(options: {
  runOptions: RunCompiledGraphOptions;
  session: RuntimeSession;
  writer: ArtifactWriter;
  runOwner: RunOwnerRecord;
  events: RuntimeEventEnvelope[];
  readyQueue: ReturnType<typeof createReadyQueueState>;
  topology: SchedulerTopology;
  node: CompiledExecutableNode;
  attempt: RuntimeNodeAttempt;
  result: RuntimeNodeExecutionResult;
  readyNode: ReadyNode;
}): Promise<boolean> {
  let classification = classifyNodeFailure({
    node: options.node,
    attempt: options.attempt,
    result: options.result
  });
  const failureFingerprint = createFailureFingerprint(classification);
  const previousFingerprint = options.session.supervisor.failure_fingerprints[options.node.compiled_id];
  const repeatedFingerprintCount =
    previousFingerprint?.fingerprint === failureFingerprint ? previousFingerprint.count + 1 : 1;
  if (repeatedFingerprintCount >= 2) {
    classification = classifyNodeFailure({
      node: options.node,
      attempt: options.attempt,
      result: options.result,
      repeated_fingerprint_count: repeatedFingerprintCount
    });
  }
  updateFailureFingerprintState(
    options.session,
    options.node.compiled_id,
    options.attempt.execution_id,
    failureFingerprint
  );
  const causalContext = buildSupervisorCausalContext({
    graph: options.session.graph,
    topology: options.topology,
    attempts: options.session.attempts,
    nodeStatuses: options.session.node_statuses,
    symptomNode: options.node,
    symptomAttempt: options.attempt,
    result: options.result,
    classification,
    repeatedFingerprintCount
  });
  const recoveryTargetNode =
    options.topology.nodes_by_id.get(causalContext.selected_target.target_compiled_id) ?? options.node;
  const action = retryActionForClassification(classification);

  if (!action) {
    const requestedAction = classification.recommended_action;
    const decisionId = createSupervisorDecisionId(options.attempt, requestedAction);
    const decision: SupervisorDecision = {
      decision_id: decisionId,
      kind: requestedAction === "pause_for_human" ? "pause_for_human" : "fail_run",
      classification: classification.class,
      health_state: classification.class === "policy_or_scope_risk" ? "drifting" : "unhealthy",
      confidence: "medium",
      target_compiled_id: recoveryTargetNode.compiled_id,
      target_execution_id: causalContext.selected_target.target_prior_execution_id ?? options.attempt.execution_id,
      action: requestedAction,
      reason: classification.summary,
      evidence: {
        ...classification.evidence,
        failure_fingerprint: failureFingerprint,
        repeated_fingerprint_count: repeatedFingerprintCount,
        symptom_compiled_id: options.node.compiled_id,
        symptom_execution_id: options.attempt.execution_id,
        recovery_target: causalContext.selected_target
      },
      budget_cost: {},
      requires_human: requestedAction === "pause_for_human",
      created_at: new Date().toISOString()
    };
    options.session.supervisor.last_decision_id = decisionId;
    options.session.supervisor.timeline.push(decision);
    if (requestedAction === "pause_for_human") {
      if (!canSpendRuntimeSupervisorAction(options.session, "pause_for_human")) {
        options.session.supervisor.status = "exhausted";
        decision.kind = "fail_run";
        decision.action = "fail";
        decision.requires_human = false;
        decision.reason = 'Supervisor cannot run action "pause_for_human" because its budget is exhausted or the action is disabled.';
      } else {
        spendRuntimeSupervisorAction(options.session, "pause_for_human");
        options.session.supervisor.intervention_count += 1;
        decision.budget_cost = { total: 1, pause_for_human: 1 };
        options.session.supervisor.status = "paused";
        options.session.supervisor.pause = {
          decision_id: decisionId,
          reason: classification.summary,
          target_compiled_id: recoveryTargetNode.compiled_id,
          target_execution_id: causalContext.selected_target.target_prior_execution_id ?? options.attempt.execution_id,
          resume_options: ["retry_with_guidance", "fail", "add_context"]
        };
        options.session.status = "paused";
      }
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
    if (requestedAction === "pause_for_human" && decision.kind === "pause_for_human") {
      const interventionId = createSupervisorInterventionId(options.attempt, "pause_for_human");
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
          action: "pause_for_human",
          target_compiled_id: recoveryTargetNode.compiled_id,
          summary: interventionTitle("pause_for_human")
        },
        {
          compiled_id: options.node.compiled_id,
          execution_id: options.attempt.execution_id,
          repeat_scope_id: options.attempt.repeat_scope_id,
          iteration_index: options.attempt.iteration_index,
          attempt_index: options.attempt.attempt_index
        }
      );
      const supervisorHarness = resolveSupervisorHarness(options.session, options.node, options.runOptions.harnesses);
      const recovery = await runSupervisorRecoveryCycle({
        action: "pause_for_human",
        run_id: options.session.run_id,
        graph_intent: options.session.graph.intent,
        node: options.node,
        attempt: options.attempt,
        result: options.result,
        decision_id: decisionId,
        intervention_id: interventionId,
        classification,
        causal_context: causalContext,
        failure_fingerprint: failureFingerprint,
        repeated_fingerprint_count: repeatedFingerprintCount,
        prior_interventions: await readSupervisorInterventions(options.writer.run_root).catch(() => []),
        workspace_path: options.session.manifest.repo_workspaces[recoveryTargetNode.repo]?.workspace_path ?? options.attempt.execution_dir,
        repo_workspaces: Object.fromEntries(
          Object.entries(options.session.manifest.repo_workspaces).map(([repoAlias, binding]) => [
            repoAlias,
            binding.workspace_path
          ])
        ),
        supervisor_policy: supervisorHarness.policy,
        ...(supervisorHarness.harness ? { harness: supervisorHarness.harness } : {}),
        ...(options.attempt.context_manifest_path ? { context_manifest_path: options.attempt.context_manifest_path } : {}),
        ...(options.runOptions.signal ? { signal: options.runOptions.signal } : {})
      });
      options.session.supervisor.pause = {
        ...(options.session.supervisor.pause ?? {
          decision_id: decisionId,
          reason: classification.summary,
          resume_options: ["retry_with_guidance", "fail", "add_context"]
        }),
        reason: recovery.recovery_plan.pause_request?.reason ?? classification.summary,
        ...(typeof recovery.intervention.artifact_paths.recovery_plan_markdown === "string"
          ? { brief_path: recovery.intervention.artifact_paths.recovery_plan_markdown }
          : {})
      };
      await options.writer.appendSupervisorIntervention(recovery.intervention);
      await emitEvent(
        options.session,
        options.writer,
        options.runOwner,
        options.events,
        options.runOptions.on_event,
        "supervisor.intervention.completed",
        {
          intervention_id: recovery.intervention.intervention_id,
          decision_id: recovery.intervention.decision_id,
          action: recovery.intervention.action,
          target_compiled_id: recovery.intervention.target_compiled_id ?? recoveryTargetNode.compiled_id,
          summary: recovery.intervention.reason,
          apply_action: recovery.recovery_plan.apply_action,
          artifacts: recovery.intervention.artifact_paths
        },
        {
          compiled_id: options.node.compiled_id,
          execution_id: options.attempt.execution_id,
          repeat_scope_id: options.attempt.repeat_scope_id,
          iteration_index: options.attempt.iteration_index,
          attempt_index: options.attempt.attempt_index
        }
      );
      await emitEvent(
        options.session,
        options.writer,
        options.runOwner,
        options.events,
        options.runOptions.on_event,
        "supervisor.paused",
        {
          decision_id: decisionId,
          target_compiled_id: recoveryTargetNode.compiled_id,
          target_execution_id: causalContext.selected_target.target_prior_execution_id ?? options.attempt.execution_id,
          reason: recovery.recovery_plan.pause_request?.reason ?? classification.summary,
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
      target_compiled_id: recoveryTargetNode.compiled_id,
      target_execution_id: causalContext.selected_target.target_prior_execution_id ?? options.attempt.execution_id,
      reason: `Supervisor cannot run action "${action}" because its budget is exhausted or the action is disabled.`,
      evidence: {
        ...classification.evidence,
        failure_fingerprint: failureFingerprint,
        repeated_fingerprint_count: repeatedFingerprintCount,
        symptom_compiled_id: options.node.compiled_id,
        symptom_execution_id: options.attempt.execution_id,
        recovery_target: causalContext.selected_target
      },
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
    target_compiled_id: recoveryTargetNode.compiled_id,
    target_execution_id: causalContext.selected_target.target_prior_execution_id ?? options.attempt.execution_id,
    action,
    reason: classification.summary,
    evidence: {
      ...classification.evidence,
      failure_fingerprint: failureFingerprint,
      repeated_fingerprint_count: repeatedFingerprintCount,
      symptom_compiled_id: options.node.compiled_id,
      symptom_execution_id: options.attempt.execution_id,
      recovery_target: causalContext.selected_target
    },
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
      target_compiled_id: recoveryTargetNode.compiled_id,
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

  const supervisorHarness = resolveSupervisorHarness(options.session, options.node, options.runOptions.harnesses);
  const recovery = await runSupervisorRecoveryCycle({
    action,
    run_id: options.session.run_id,
    graph_intent: options.session.graph.intent,
    node: options.node,
    attempt: options.attempt,
    result: options.result,
    decision_id: decisionId,
    intervention_id: interventionId,
    classification,
    causal_context: causalContext,
    failure_fingerprint: failureFingerprint,
    repeated_fingerprint_count: repeatedFingerprintCount,
    prior_interventions: await readSupervisorInterventions(options.writer.run_root).catch(() => []),
    workspace_path: options.session.manifest.repo_workspaces[recoveryTargetNode.repo]?.workspace_path ?? options.attempt.execution_dir,
    repo_workspaces: Object.fromEntries(
      Object.entries(options.session.manifest.repo_workspaces).map(([repoAlias, binding]) => [
        repoAlias,
        binding.workspace_path
      ])
    ),
    supervisor_policy: supervisorHarness.policy,
    ...(supervisorHarness.harness ? { harness: supervisorHarness.harness } : {}),
    ...(options.attempt.context_manifest_path ? { context_manifest_path: options.attempt.context_manifest_path } : {}),
    ...(options.runOptions.signal ? { signal: options.runOptions.signal } : {})
  });

  await options.writer.appendSupervisorIntervention(recovery.intervention);
  await emitEvent(
    options.session,
    options.writer,
    options.runOwner,
    options.events,
    options.runOptions.on_event,
    "supervisor.intervention.completed",
    {
      intervention_id: recovery.intervention.intervention_id,
      decision_id: recovery.intervention.decision_id,
      action: recovery.intervention.action,
      target_compiled_id: recovery.intervention.target_compiled_id ?? recoveryTargetNode.compiled_id,
      summary: recovery.intervention.reason,
      apply_action: recovery.recovery_plan.apply_action,
      artifacts: recovery.intervention.artifact_paths
    },
    {
      compiled_id: options.node.compiled_id,
      execution_id: options.attempt.execution_id,
      repeat_scope_id: options.attempt.repeat_scope_id,
      iteration_index: options.attempt.iteration_index,
      attempt_index: options.attempt.attempt_index
    }
  );

  if (recovery.recovery_plan.apply_action === "pause_for_authority") {
    options.session.supervisor.status = "paused";
    options.session.status = "paused";
    options.session.supervisor.pause = {
      decision_id: decisionId,
      reason: recovery.recovery_plan.pause_request?.reason ?? classification.summary,
      target_compiled_id: recoveryTargetNode.compiled_id,
      target_execution_id: causalContext.selected_target.target_prior_execution_id ?? options.attempt.execution_id,
      ...(recovery.intervention.artifact_paths.recovery_plan_markdown
        ? { brief_path: recovery.intervention.artifact_paths.recovery_plan_markdown }
        : {}),
      resume_options: ["retry_with_guidance", "fail", "add_context"]
    };
    return false;
  }

  if (recovery.recovery_plan.apply_action === "fail_terminal") {
    options.session.supervisor.status = "exhausted";
    return false;
  }

  if (recovery.recovery_plan.apply_action === "repair_artifact") {
    options.session.supervisor.status = "healthy";
    return false;
  }

  const workspacePath =
    options.session.manifest.repo_workspaces[recoveryTargetNode.repo]?.workspace_path ?? options.attempt.execution_dir;
  const retryableOverlayAction = [
    "repair_context",
    "repair_validation_strategy",
    "repair_workspace",
    "repair_environment",
    "retry_with_evidence"
  ].includes(recovery.recovery_plan.apply_action);
  const hasMaterialDelta = (recovery.recovery_plan.runtime_overlay?.material_delta.length ?? 0) > 0;
  if (!retryableOverlayAction || !recovery.recovery_envelope || !hasMaterialDelta) {
    options.session.supervisor.status = "exhausted";
    return false;
  }
  const overlayApplied = await applyRuntimeOverlayBeforeRetry({
    recovery,
    attempt: options.attempt,
    workspacePath
  });
  if (!overlayApplied) {
    options.session.supervisor.status = "exhausted";
    return false;
  }
  options.session.supervisor.active_recovery_envelopes[recovery.recovery_envelope.compiled_id] = recovery.recovery_envelope;

  const retryDelayMs = computeRetryDelayMs(repeatedFingerprintCount);
  options.session.supervisor.status = "healthy";
  await emitEvent(
    options.session,
    options.writer,
    options.runOwner,
    options.events,
    options.runOptions.on_event,
    "supervisor.retry_scheduled",
    {
      target_compiled_id: recovery.recovery_envelope.compiled_id,
      target_execution_id: recovery.recovery_envelope.prior_execution_id,
      symptom_compiled_id: options.node.compiled_id,
      symptom_execution_id: options.attempt.execution_id,
      action,
      failure_fingerprint: failureFingerprint,
      repeated_fingerprint_count: repeatedFingerprintCount,
      delay_ms: retryDelayMs
    },
    {
      compiled_id: options.node.compiled_id,
      execution_id: options.attempt.execution_id,
      repeat_scope_id: options.attempt.repeat_scope_id,
      iteration_index: options.attempt.iteration_index,
      attempt_index: options.attempt.attempt_index
    }
  );
  await sleepForRetryDelay(retryDelayMs, options.runOptions.signal);
  const recoveryTargetReadyNode: ReadyNode = recovery.recovery_envelope.compiled_id === options.node.compiled_id
    ? {
        ...options.readyNode,
        deps_satisfied: [...options.readyNode.deps_satisfied]
      }
    : {
        compiled_id: recovery.recovery_envelope.compiled_id,
        deps_satisfied: computeReadyDeps(
          options.session,
          options.topology,
          recoveryTargetNode,
          recoveryTargetNode.repeat_scope_id === options.attempt.repeat_scope_id
            ? options.attempt.iteration_index
            : undefined
        ) ?? [],
        repeat_scope_id: recoveryTargetNode.repeat_scope_id,
        iteration_index:
          recoveryTargetNode.repeat_scope_id === options.attempt.repeat_scope_id
            ? options.attempt.iteration_index
            : undefined
      };

  if (recovery.recovery_envelope.compiled_id !== options.node.compiled_id) {
    options.session.supervisor.active_recovery_chains[recovery.recovery_envelope.compiled_id] = {
      chain_id: `${interventionId}__chain`,
      intervention_id: recovery.intervention.intervention_id,
      decision_id: recovery.intervention.decision_id,
      status: "recovering",
      symptom_compiled_id: options.node.compiled_id,
      symptom_authored_id: options.node.authored_id,
      symptom_execution_id: options.attempt.execution_id,
      target_compiled_id: recovery.recovery_envelope.compiled_id,
      target_authored_id: recovery.recovery_envelope.authored_id,
      operation: recovery.recovery_plan.operation ?? "repair_upstream_node",
      resume_ready_node: {
        compiled_id: options.readyNode.compiled_id,
        deps_satisfied: [...options.readyNode.deps_satisfied],
        ...(options.readyNode.repeat_scope_id ? { repeat_scope_id: options.readyNode.repeat_scope_id } : {}),
        ...(options.readyNode.iteration_index !== undefined ? { iteration_index: options.readyNode.iteration_index } : {})
      },
      ...(recovery.intervention.artifact_paths.recovery_plan_json
        ? { recovery_plan_path: recovery.intervention.artifact_paths.recovery_plan_json }
        : {}),
      ...(recovery.intervention.artifact_paths.recovery_chain_json
        ? { recovery_chain_path: recovery.intervention.artifact_paths.recovery_chain_json }
        : {}),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
  }

  await queueReadyNode(
    options.readyQueue,
    options.session,
    options.writer,
    options.runOwner,
    options.events,
    options.runOptions.on_event,
    recoveryTargetReadyNode
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
    ...(context.runtime_env ?? {}),
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
    base_env: context.environment,
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
      base_env: context.environment,
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
    context.node.intent.acceptance_criteria,
    aiCheckPromptTokens
  );
  const renderedNodeConstraints = substituteOptionalTextArray(
    context.node.intent.constraints,
    aiCheckPromptTokens
  );

  const aiCheckResult = await runAiCheck({
    harness: harnesses[harnessName]!,
    run_id: context.run_id,
    execution_id: context.attempt.execution_id,
    repo_alias: context.node.repo,
    repo_path: context.workspace_path,
    model: context.node.effective_policy.model,
    base_env: context.environment,
    ...(context.node.effective_policy.reasoning_effort
      ? { reasoning_effort: context.node.effective_policy.reasoning_effort }
      : {}),
    ...(context.node.effective_policy.skip_git_repo_check ? { skip_git_repo_check: true } : {}),
    rubric: renderedAiCheckRubric,
    graph_goal: substituteAgentflowTokens(context.graph_intent.goal, aiCheckPromptTokens),
    ...(renderedGraphAcceptanceCriteria ? { graph_acceptance_criteria: renderedGraphAcceptanceCriteria } : {}),
    ...(renderedGraphConstraints ? { graph_constraints: renderedGraphConstraints } : {}),
    ...(context.node.intent.goal ? { node_goal: substituteAgentflowTokens(context.node.intent.goal, aiCheckPromptTokens) } : {}),
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

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function withSilentAgentHarnessFailureDiagnostic(
  node: CompiledExecutableNode,
  result: RuntimeNodeExecutionResult
): RuntimeNodeExecutionResult {
  if (
    node.kind !== "agent" ||
    result.status !== "failed" ||
    hasText(result.stdout) ||
    hasText(result.stderr) ||
    hasText(result.agent_response)
  ) {
    return result;
  }

  const error = "Agent harness failed without stdout, stderr, or a final response.";
  return {
    ...result,
    result: {
      ...(isRecord(result.result) ? result.result : {}),
      error
    },
    metadata: {
      ...(result.metadata ?? {}),
      error
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
    ...(context.supervisor_recovery_envelope
      ? { supervisor_recovery_envelope: context.supervisor_recovery_envelope }
      : {}),
    credential_specs: context.credential_specs ?? {}
  });
  const contextManifest = await readContextManifestContent(context.context_manifest_path);
  const promptTokens = buildNodeRuntimeEnv(context);
  const agentGraphAcceptanceCriteria = substituteOptionalTextArray(
    context.graph_intent.acceptance_criteria,
    promptTokens
  );
  const agentGraphConstraints = substituteOptionalTextArray(context.graph_intent.constraints, promptTokens);
  const agentNodeAcceptanceCriteria = substituteOptionalTextArray(context.node.intent.acceptance_criteria, promptTokens);
  const agentNodeConstraints = substituteOptionalTextArray(context.node.intent.constraints, promptTokens);
  const promptPath = join(context.execution_dir, "prompt.md");
  context.attempt.prompt_path = promptPath;
  const agentInvocation: AgentInvocation = {
    promptKind: "agent",
    runId: context.run_id,
    executionId: context.attempt.execution_id,
    repoAlias: context.node.repo,
    repoPath: context.workspace_path,
    runtimeDir,
    sandbox: context.node.effective_policy.sandbox ?? "workspace-write",
    ...(context.node.effective_policy.skip_git_repo_check ? { skipGitRepoCheck: true } : {}),
    model: context.node.effective_policy.model,
    baseEnv: context.environment,
    ...(context.node.effective_policy.reasoning_effort
      ? { reasoningEffort: context.node.effective_policy.reasoning_effort }
      : {}),
    graphGoal: substituteAgentflowTokens(context.graph_intent.goal, promptTokens),
    ...(agentGraphAcceptanceCriteria ? { graphAcceptanceCriteria: agentGraphAcceptanceCriteria } : {}),
    ...(agentGraphConstraints ? { graphConstraints: agentGraphConstraints } : {}),
    ...(context.node.intent.goal ? { nodeGoal: substituteAgentflowTokens(context.node.intent.goal, promptTokens) } : {}),
    ...(agentNodeAcceptanceCriteria ? { nodeAcceptanceCriteria: agentNodeAcceptanceCriteria } : {}),
    ...(agentNodeConstraints ? { nodeConstraints: agentNodeConstraints } : {}),
    contextPacketPath: context.context_packet_path,
    contextManifestPath: context.context_manifest_path,
    contextManifest,
    ...(context.supervisor_recovery_envelope ? { supervisorRecoveryEnvelope: context.supervisor_recovery_envelope } : {}),
    promptPath,
    outputDir,
    artifacts: context.node.declared_artifacts,
    timeoutSec: context.node.effective_policy.timeout_sec,
    signal: context.signal,
    ...(context.on_stdout_chunk ? { onStdoutChunk: context.on_stdout_chunk } : {}),
    ...(context.on_stderr_chunk ? { onStderrChunk: context.on_stderr_chunk } : {}),
    toolBinDir: toolSetup.bin_dir,
    toolEnv: toolSetup.env,
    tools: toolSetup.resolved_tools
  };
  const renderedPrompt = renderHarnessPrompt(agentInvocation);
  await mkdir(dirname(promptPath), { recursive: true });
  await writeFile(promptPath, `${renderedPrompt}\n`, "utf8");
  context.attempt.prompt_sha256 = createHash("sha256").update(`${renderedPrompt}\n`).digest("hex");

  const harnessResult = await harnesses[harnessName]!.run(agentInvocation);

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
      : `${missingAgentResponseMessage}\n`;

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

async function materializePresentDeclaredArtifacts(options: {
  node: CompiledExecutableNode;
  attempt: RuntimeNodeAttempt;
  workspacePath: string;
  automaticArtifacts: Record<string, string>;
}): Promise<Record<string, string>> {
  const artifactsRoot = resolveExecutionArtifactsDirectory(options.attempt.execution_dir);
  const artifacts: Record<string, string> = { ...options.automaticArtifacts };

  for (const [name, definition] of Object.entries(options.node.declared_artifacts)) {
    if (definition.from === "output_dir") {
      const outputPath = resolveSubpathWithinRoot(
        artifactsRoot,
        definition.path,
        `Artifact "${name}" path`
      );

      try {
        await access(outputPath);
        artifacts[name] = outputPath;
      } catch {
        // Failed attempts may not produce every declared artifact; preserve only what exists.
      }
      continue;
    }

    const sourcePath = resolveSubpathWithinRoot(
      options.workspacePath,
      definition.path,
      `Artifact "${name}" path`
    );
    const destinationPath = resolveSubpathWithinRoot(
      artifactsRoot,
      definition.path,
      `Materialized artifact "${name}" path`
    );

    try {
      await access(sourcePath);
      await mkdir(dirname(destinationPath), { recursive: true });
      await copyFile(sourcePath, destinationPath);
      artifacts[name] = destinationPath;
    } catch {
      // Failed attempts may leave workspace artifacts absent or partial.
    }
  }

  return artifacts;
}

async function hasUsableCapturedAgentResponse(
  automaticArtifacts: Record<string, string>
): Promise<boolean> {
  const agentResponsePath = automaticArtifacts.agent_response;
  if (!agentResponsePath) {
    return false;
  }

  try {
    const agentResponse = await readFile(agentResponsePath, "utf8");
    const trimmedResponse = agentResponse.trim();
    return trimmedResponse.length > 0 && trimmedResponse !== missingAgentResponseMessage;
  } catch {
    return false;
  }
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
    if (options.node.kind !== "agent" || options.attempt.status === "canceled") {
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

    if (!(await hasUsableCapturedAgentResponse(options.automaticArtifacts))) {
      throw new ArtifactMaterializationError(
        `Agent harness produced no final response while required declared artifacts are missing: ${missingArtifacts.map((artifact) => `${artifact.name} at ${artifact.path}`).join(", ")}. This is a harness/no-op failure, not an artifact repair candidate.`,
        {
          status: "failed",
          max_attempts: 0,
          attempt_count: 0,
          missing_artifacts: missingArtifacts.map((artifact) => artifact.name)
        }
      );
    }

    const maxAttempts = Math.min(
      options.node.effective_policy.artifact_repair?.max_attempts ?? 1,
      options.session.supervisor.budget_remaining.max_total_interventions
    );

    if (maxAttempts <= 0) {
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
      const interventionDir = resolveInterventionDirectory(options.attempt.execution_dir, interventionId);
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
        classification: "artifact_contract_failure",
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

      const supervisorHarness = resolveSupervisorHarness(options.session, options.node, options.harnesses);
      const intervention = await runRepairArtifactIntervention({
        node: options.node,
        attempt: options.attempt,
        missing_artifacts: missingArtifacts,
        session: options.session,
        workspace_path: options.workspacePath,
        context_packet_path: options.contextPacketPath,
        context_manifest_path: options.contextManifestPath,
        harnesses: options.harnesses,
        supervisor_policy: supervisorHarness.policy,
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

async function buildAndPersistAttemptCompletionPacket(options: {
  runRoot: string;
  session: RuntimeSession;
  node: CompiledExecutableNode;
  attempt: RuntimeNodeAttempt;
  workspacePath: string;
  artifacts: Record<string, string>;
  stdoutLogPath?: string;
  stderrLogPath?: string;
  resultPath?: string;
  supervisorRecoveryEnvelope?: SupervisorRecoveryEnvelope;
}): Promise<CompletionPacket> {
  const packetAttempt: RuntimeNodeAttempt = {
    ...options.attempt,
    artifacts: options.artifacts,
    ...(options.stdoutLogPath ? { stdout_log_path: options.stdoutLogPath } : {}),
    ...(options.stderrLogPath ? { stderr_log_path: options.stderrLogPath } : {}),
    ...(options.resultPath ? { result_path: options.resultPath } : {})
  };
  const priorAttempts = listAttemptsForCompiledNode(options.session.attempts, options.node.compiled_id)
    .filter((attempt) => attempt.execution_id !== options.attempt.execution_id);
  const managed = await buildManagedCompletionSummary({
    session: options.session,
    node: options.node,
    attempt: packetAttempt,
    artifacts: options.artifacts
  });
  const packet = await buildCompletionPacket({
    runRoot: options.runRoot,
    node: options.node,
    attempt: packetAttempt,
    priorAttempts,
    workspacePath: options.workspacePath,
    sandbox: options.node.effective_policy.sandbox ?? "workspace-write",
    observations: await readOperatorObservations(options.runRoot),
    ...(managed ? { managed } : {}),
    ...(options.supervisorRecoveryEnvelope ? { supervisorRecoveryEnvelope: options.supervisorRecoveryEnvelope } : {})
  });
  await persistCompletionPacket(packet);
  return packet;
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
  const runtimeEnvironment = options.environment ?? process.env;
  const runtimeEnv = options.runtime_env;

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
  const captureSnapshots = node.kind === "agent" || node.kind === "exec";
  let baselineSnapshot: Awaited<ReturnType<typeof snapshotWorkspaceForNode>> | undefined;
  let workspaceChangeArtifacts: NodeWorkspaceChangeArtifacts | undefined;

  try {
    executionPaths = await writer.writeExecutionStart(attempt);
    logSink = createStreamingLogSink(writer, executionPaths);

    await ensureNodeReadiness(node, options, readinessCache);

    if (captureSnapshots) {
      baselineSnapshot = await snapshotWorkspaceForNode(workspace.workspace_path);
      try {
        await persistNodeBaselineSnapshot(attempt.execution_dir, baselineSnapshot);
      } catch {
        // Persistence is best-effort; the in-memory snapshot remains authoritative.
      }
    }

    const activeRecoveryEnvelope = session.supervisor.active_recovery_envelopes[node.compiled_id];
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
      attempts: session.attempts,
      ...(activeRecoveryEnvelope ? { recovery_envelope: activeRecoveryEnvelope } : {})
    });

    let result: RuntimeNodeExecutionResult;
    const usedCustomAgentExecutor =
      node.kind === "agent" && Boolean(options.executors?.agent);

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
            ...(activeRecoveryEnvelope ? { supervisor_recovery_envelope: activeRecoveryEnvelope } : {}),
            environment: runtimeEnvironment,
            ...(runtimeEnv ? { runtime_env: runtimeEnv } : {}),
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
            ...(activeRecoveryEnvelope ? { supervisor_recovery_envelope: activeRecoveryEnvelope } : {}),
            environment: runtimeEnvironment,
            ...(runtimeEnv ? { runtime_env: runtimeEnv } : {}),
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
            ...(activeRecoveryEnvelope ? { supervisor_recovery_envelope: activeRecoveryEnvelope } : {}),
            environment: runtimeEnvironment,
            ...(runtimeEnv ? { runtime_env: runtimeEnv } : {}),
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
              ...(activeRecoveryEnvelope ? { supervisor_recovery_envelope: activeRecoveryEnvelope } : {}),
              environment: runtimeEnvironment,
              ...(runtimeEnv ? { runtime_env: runtimeEnv } : {}),
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
        ...(activeRecoveryEnvelope ? { supervisor_recovery_envelope: activeRecoveryEnvelope } : {}),
        environment: runtimeEnvironment,
        ...(runtimeEnv ? { runtime_env: runtimeEnv } : {}),
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
            ...(activeRecoveryEnvelope ? { supervisor_recovery_envelope: activeRecoveryEnvelope } : {}),
            environment: runtimeEnvironment,
            ...(runtimeEnv ? { runtime_env: runtimeEnv } : {}),
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
              ...(activeRecoveryEnvelope ? { supervisor_recovery_envelope: activeRecoveryEnvelope } : {}),
              environment: runtimeEnvironment,
              ...(runtimeEnv ? { runtime_env: runtimeEnv } : {}),
              signal,
              on_stdout_chunk: logSink.on_stdout_chunk,
              on_stderr_chunk: logSink.on_stderr_chunk
            },
            options.harnesses ?? {}
          );

    }

    await logSink.flush();
    result = withSilentAgentHarnessFailureDiagnostic(node, result);

    if (captureSnapshots && baselineSnapshot) {
      const afterSnapshot = await snapshotWorkspaceForNode(workspace.workspace_path);
      const diff = await diffNodeSnapshots(
        workspace.workspace_path,
        baselineSnapshot,
        afterSnapshot
      );
      try {
        workspaceChangeArtifacts = await persistNodeWorkspaceChanges(
          attempt.execution_dir,
          baselineSnapshot,
          afterSnapshot,
          diff
        );
      } catch {
        // Persistence is best-effort; failures here must not block node completion.
      }
    }

    await writer.writeExecutionCompletion(attempt, {
      result: result.result,
      ...(result.stdout !== undefined ? { stdout: result.stdout } : {}),
      ...(result.stderr !== undefined ? { stderr: result.stderr } : {})
    });

    await ensureCheckpointPassFeedbackArtifact(node, attempt, result);

    automaticArtifacts = await writeAutomaticArtifacts(node, attempt, result);
    const materialized =
      result.status !== "passed"
        ? {
            artifacts: await materializePresentDeclaredArtifacts({
              node,
              attempt,
              workspacePath: workspace.workspace_path,
              automaticArtifacts
            })
          }
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

    const completionPacket = await buildAndPersistAttemptCompletionPacket({
      runRoot: options.run_root,
      session,
      node,
      attempt,
      workspacePath: workspace.workspace_path,
      artifacts,
      stdoutLogPath: executionPaths.stdout_log_path,
      stderrLogPath: executionPaths.stderr_log_path,
      resultPath: executionPaths.result_path,
      ...(activeRecoveryEnvelope ? { supervisorRecoveryEnvelope: activeRecoveryEnvelope } : {})
    });

    if (
      node.kind === "agent"
      && result.status === "passed"
      && result.outcome === "passed"
      && completionPacket.completion_status !== "ready_for_verification"
    ) {
      const previousResult = isRecord(result.result) ? result.result : {};
      result = {
        ...result,
        status: "failed",
        outcome: "failed",
        result: {
          ...previousResult,
          completion: {
            completion_status: completionPacket.completion_status,
            blocking_reasons: completionPacket.blocking_reasons,
            packet_path: completionPacket.packet_path
          }
        }
      };
    }

    let outcomeVerification: OutcomeVerificationResult | undefined;
    if (
      node.kind === "agent"
      && result.status === "passed"
      && result.outcome === "passed"
      && !materialized.canceled
      && !usedCustomAgentExecutor
    ) {
      const supervisorHarness = resolveSupervisorHarness(session, node, options.harnesses);
      const harnessName = supervisorHarness.harnessName;
      const verifierHarness = supervisorHarness.harness;

      if (!verifierHarness) {
        const message = `Outcome verification requires harness "${harnessName ?? "unknown"}" but it is not available.`;
        outcomeVerification = {
          passed: false,
          summary: message,
          findings: [
            {
              severity: "blocker",
              category: "verifier_unavailable",
              evidence: message,
              recommendation: "Make the agent's harness available so the outcome verifier can run."
            }
          ],
          blockers: [
            {
              severity: "blocker",
              category: "verifier_unavailable",
              evidence: message,
              recommendation: "Make the agent's harness available so the outcome verifier can run."
            }
          ],
          verifier_metadata: {
            harness: harnessName ?? "unknown",
            duration_ms: 0,
            prompt_path: "",
            response_path: "",
            attempt_count: 0,
            truncated_artifacts: [],
            workspace_diff_status: workspaceChangeArtifacts ? workspaceChangeArtifacts.status : "absent",
            parse_status: "unparseable",
            parse_error: message
          }
        };
      } else {
        const contextManifestText = await readContextManifestContent(context.manifest_path);
        outcomeVerification = await runOutcomeVerification({
          graph: session.graph,
          node: node as CompiledAgentNode,
          attempt,
          workspacePath: workspace.workspace_path,
          outputDir: resolveExecutionArtifactsDirectory(attempt.execution_dir),
          contextPacketPath: context.packet_path,
          contextManifestPath: context.manifest_path,
          contextManifest: contextManifestText,
          ...(artifacts.agent_response ? { agentResponseArtifactPath: artifacts.agent_response } : {}),
          declaredArtifactPaths: artifacts,
          completionPacket,
          ...(workspaceChangeArtifacts ? { workspaceChangeArtifacts } : {}),
          harness: verifierHarness,
          supervisorPolicy: supervisorHarness.policy,
          runId: session.run_id,
          baseEnv: options.environment ?? process.env,
          ...(signal ? { signal } : {}),
          runtimeDir: join(options.run_root, "runtime")
        });
      }

      await emitEvent(
        session,
        writer,
        runOwner,
        events,
        options.on_event,
        "outcome.verified",
        {
          passed: outcomeVerification.passed,
          findings_count: outcomeVerification.findings.length,
          blockers_count: outcomeVerification.blockers.length,
          verify_outcome_path: join(attempt.execution_dir, "verify-outcome.json"),
          verifier_harness: outcomeVerification.verifier_metadata.harness,
          parse_status: outcomeVerification.verifier_metadata.parse_status,
          duration_ms: outcomeVerification.verifier_metadata.duration_ms
        },
        {
          compiled_id: node.compiled_id,
          execution_id: attempt.execution_id,
          repeat_scope_id: attempt.repeat_scope_id,
          iteration_index: attempt.iteration_index,
          attempt_index: attempt.attempt_index
        }
      );

      if (!outcomeVerification.passed) {
        const verifierPayload = {
          passed: false,
          summary: outcomeVerification.summary,
          blockers: outcomeVerification.blockers,
          findings: outcomeVerification.findings,
          verifier_metadata: outcomeVerification.verifier_metadata
        };
        const previousResult = isRecord(result.result) ? result.result : {};
        result = {
          ...result,
          status: "failed",
          outcome: "failed",
          result: {
            ...previousResult,
            outcome_verification: verifierPayload
          }
        };
      }
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
      ...((result.metadata || result.verification || artifactRepairMetadata || workspaceChangeArtifacts || outcomeVerification || completionPacket)
        ? {
            metadata: {
              ...(result.metadata ?? {}),
              ...(artifactRepairMetadata ? { artifact_repair: artifactRepairMetadata } : {}),
              completion: {
                completion_status: completionPacket.completion_status,
                ready_for_verification: completionPacket.ready_for_verification,
                blocking_reasons: completionPacket.blocking_reasons,
                packet_path: completionPacket.packet_path
              },
              ...(result.verification ? { verification: result.verification } : {}),
              ...(workspaceChangeArtifacts ? { node_workspace_changes: workspaceChangeArtifacts } : {}),
              ...(outcomeVerification ? { outcome_verification: outcomeVerification } : {})
            }
          }
        : {})
    });

    await writer.writeExecutionCompletion(completedAttempt, {
      result: result.result,
      ...(result.stdout !== undefined ? { stdout: result.stdout } : {}),
      ...(result.stderr !== undefined ? { stderr: result.stderr } : {})
    });

    if (result.status === "passed" && result.outcome === "passed") {
      delete session.supervisor.active_recovery_envelopes[node.compiled_id];
    }

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

    if (captureSnapshots && baselineSnapshot && executionPaths) {
      try {
        const afterSnapshot = await snapshotWorkspaceForNode(workspace.workspace_path);
        const diff = await diffNodeSnapshots(
          workspace.workspace_path,
          baselineSnapshot,
          afterSnapshot
        );
        workspaceChangeArtifacts = await persistNodeWorkspaceChanges(
          attempt.execution_dir,
          baselineSnapshot,
          afterSnapshot,
          diff
        );
      } catch {
        // Best-effort capture during the failure path.
      }
    }

    let failureCompletionPacket: CompletionPacket | undefined;
    if (executionPaths) {
      try {
        failureCompletionPacket = await buildAndPersistAttemptCompletionPacket({
          runRoot: options.run_root,
          session,
          node,
          attempt,
          workspacePath: workspace.workspace_path,
          artifacts: failureArtifacts ?? {},
          stdoutLogPath: executionPaths.stdout_log_path,
          stderrLogPath: executionPaths.stderr_log_path,
          resultPath: executionPaths.result_path,
          ...(session.supervisor.active_recovery_envelopes[node.compiled_id]
            ? { supervisorRecoveryEnvelope: session.supervisor.active_recovery_envelopes[node.compiled_id] }
            : {})
        });
      } catch {
        // Completion packet persistence is best-effort on failures that occur before enough runtime state exists.
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
        ...(failureCompletionPacket
          ? {
              completion: {
                completion_status: failureCompletionPacket.completion_status,
                ready_for_verification: failureCompletionPacket.ready_for_verification,
                blocking_reasons: failureCompletionPacket.blocking_reasons,
                packet_path: failureCompletionPacket.packet_path
              }
            }
          : {}),
        ...(repairMetadata ? { artifact_repair: repairMetadata } : {}),
        ...(workspaceChangeArtifacts ? { node_workspace_changes: workspaceChangeArtifacts } : {})
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
    await emitManagedNodeProgress({
      session,
      writer,
      runOwner,
      events,
      onEvent: options.on_event,
      node,
      attempt,
      outcome
    });

    if (outcome === "passed") {
      const recoveryChain = session.supervisor.active_recovery_chains[node.compiled_id];
      if (recoveryChain) {
        recoveryChain.status = "resuming";
        recoveryChain.updated_at = new Date().toISOString();
        await emitEvent(session, writer, runOwner, events, options.on_event, "supervisor.gate_rerun_scheduled", {
          chain_id: recoveryChain.chain_id,
          intervention_id: recoveryChain.intervention_id,
          symptom_compiled_id: recoveryChain.symptom_compiled_id,
          target_compiled_id: recoveryChain.target_compiled_id,
          operation: recoveryChain.operation
        }, {
          compiled_id: node.compiled_id,
          execution_id: attempt.execution_id,
          repeat_scope_id: attempt.repeat_scope_id,
          iteration_index: attempt.iteration_index,
          attempt_index: attempt.attempt_index
        });
        await queueReadyNode(
          readyQueue,
          session,
          writer,
          runOwner,
          events,
          options.on_event,
          {
            compiled_id: recoveryChain.resume_ready_node.compiled_id,
            deps_satisfied: recoveryChain.resume_ready_node.deps_satisfied,
            repeat_scope_id: recoveryChain.resume_ready_node.repeat_scope_id,
            iteration_index: recoveryChain.resume_ready_node.iteration_index
          }
        );
        recoveryChain.status = "completed";
        recoveryChain.updated_at = new Date().toISOString();
        delete session.supervisor.active_recovery_chains[node.compiled_id];
        continue;
      }
    }

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
          const managedStalled = await emitManagedRepeatStalledProgress({
            session,
            writer,
            runOwner,
            events,
            onEvent: options.on_event,
            repeatScopeId,
            repeatScopeAuthoredId: repeatScope.authored_id,
            node,
            attempt,
            outcome
          });

          if (managedStalled) {
            const retried = await handleFailedNodeWithSupervisor({
              runOptions: options,
              session,
              writer,
              runOwner,
              events,
              readyQueue,
              topology,
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

            completeRepeatIteration(session, repeatScopeId, "failed");
            session.status = "failed";
            await markPendingNodesBlocked(session, writer, runOwner, events, options.on_event, node);
            cancelActiveExecutions(activeExecutions);
            continue;
          }

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

        const managedExhausted = await emitManagedRepeatExhaustedProgress({
          session,
          writer,
          runOwner,
          events,
          onEvent: options.on_event,
          repeatScopeId,
          repeatScopeAuthoredId: repeatScope.authored_id,
          node,
          attempt,
          outcome
        });

        if (managedExhausted) {
          const retried = await handleFailedNodeWithSupervisor({
            runOptions: options,
            session,
            writer,
            runOwner,
            events,
            readyQueue,
            topology,
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
        topology,
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

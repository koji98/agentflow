import type { CompiledExecutableNode, CompiledGraph, CompiledRepeatScope } from "../graph/compiled.js";
import type { WorkspaceBackend } from "../graph/schema.js";
import type { AttemptRegistry, RuntimeNodeAttempt } from "./attempts.js";
import type { VerificationRecordedPayload } from "./events.js";

export type RuntimeNodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "passed"
  | "failed"
  | "blocked"
  | "canceled"
  | "skipped";

export type RuntimeRunStatus = "pending" | "running" | "passed" | "failed" | "canceled";
export type EvidenceStatus = "clean" | "warnings";

export interface WorkspaceBinding {
  repo_alias: string;
  source_path: string;
  workspace_path: string;
  backend: WorkspaceBackend;
}

export interface WorkspaceChangeArtifacts {
  repo_alias: string;
  workspace_path: string;
  status_file: string;
  diff_file: string;
  changed_files_file: string;
  changed_files: string[];
  capture_error_file?: string;
}

export interface ExecutionManifestEntry {
  compiled_id: string;
  authored_id: string;
  kind: CompiledExecutableNode["kind"];
  repo_alias: string;
  scope_stack: string[];
  repeat_scope_id?: string;
  effective_policy: CompiledExecutableNode["effective_policy"];
}

export interface ExecutionManifest {
  run_id: string;
  graph_id: string;
  launch_profile: string;
  workspace_backend: WorkspaceBackend;
  repo_workspaces: Record<string, WorkspaceBinding>;
  nodes: ExecutionManifestEntry[];
}

export interface ActiveExecutionSummary {
  execution_id: string;
  compiled_id: string;
  authored_id: string;
  repo_alias: string;
  kind: CompiledExecutableNode["kind"];
  attempt_index: number;
  repeat_scope_id?: string;
  iteration_index?: number;
  iteration_attempt_index?: number;
  started_at: string;
}

export interface LatestExecutionSummary {
  execution_id: string;
  compiled_id: string;
  authored_id: string;
  kind: CompiledExecutableNode["kind"];
  status: RuntimeNodeStatus;
  attempt_index: number;
  repeat_scope_id?: string;
  iteration_index?: number;
  iteration_attempt_index?: number;
  started_at: string;
  ended_at?: string;
  duration_ms?: number;
  verification?: VerificationRecordedPayload;
}

export interface RepeatScopeState {
  repeat_scope_id: string;
  authored_id: string;
  max_attempts: number;
  until_compiled_id: string;
  latest_iteration_index: number;
  active_iteration_index: number | undefined;
  status: "pending" | "running" | "passed" | "failed";
}

export interface RuntimeCounts {
  total: number;
  pending: number;
  ready: number;
  running: number;
  passed: number;
  failed: number;
  blocked: number;
  canceled: number;
  skipped: number;
}

export interface SoftVerificationCounts {
  passed: number;
  failed: number;
}

export interface FailedSoftVerificationSummary extends VerificationRecordedPayload {
  compiled_id: string;
  authored_id: string;
  execution_id: string;
}

export interface RuntimeStateSnapshot {
  run_id: string;
  graph_id: string;
  snapshot_seq: number;
  status: RuntimeRunStatus;
  evidence_status: EvidenceStatus;
  workspace_backend: WorkspaceBackend;
  repo_workspaces: Record<string, WorkspaceBinding>;
  workspace_change_artifacts: Record<string, WorkspaceChangeArtifacts>;
  counts: RuntimeCounts;
  soft_verification_counts: SoftVerificationCounts;
  failed_soft_verifications: FailedSoftVerificationSummary[];
  node_statuses: Record<string, RuntimeNodeStatus>;
  active_executions: Record<string, ActiveExecutionSummary>;
  latest_execution_by_compiled_id: Record<string, LatestExecutionSummary>;
  repeat_scopes: Record<string, RepeatScopeState>;
  started_at: string;
  ended_at?: string;
}

export interface RuntimeSession {
  run_id: string;
  run_root: string;
  graph_path?: string;
  graph: CompiledGraph;
  manifest: ExecutionManifest;
  status: RuntimeRunStatus;
  next_event_seq: number;
  attempts: AttemptRegistry;
  node_statuses: Map<string, RuntimeNodeStatus>;
  latest_execution_by_compiled_id: Map<string, LatestExecutionSummary>;
  active_executions: Map<string, ActiveExecutionSummary>;
  repeat_scopes: Map<string, RepeatScopeState>;
  workspace_change_artifacts: Record<string, WorkspaceChangeArtifacts>;
  started_at: string;
  ended_at?: string;
}

function createCounts(values: Iterable<RuntimeNodeStatus>): RuntimeCounts {
  const counts: RuntimeCounts = {
    total: 0,
    pending: 0,
    ready: 0,
    running: 0,
    passed: 0,
    failed: 0,
    blocked: 0,
    canceled: 0,
    skipped: 0
  };

  for (const status of values) {
    counts.total += 1;
    counts[status] += 1;
  }

  return counts;
}

export function summarizeSoftVerifications(
  latestExecutionByCompiledId: Iterable<LatestExecutionSummary>
): {
  evidence_status: EvidenceStatus;
  soft_verification_counts: SoftVerificationCounts;
  failed_soft_verifications: FailedSoftVerificationSummary[];
} {
  const verifications = [...latestExecutionByCompiledId]
    .filter((summary): summary is LatestExecutionSummary & { verification: VerificationRecordedPayload } =>
      summary.verification !== undefined
    );
  const failed_soft_verifications = verifications
    .filter((summary) => !summary.verification.passed)
    .map((summary) => ({
      ...summary.verification,
      compiled_id: summary.compiled_id,
      authored_id: summary.authored_id,
      execution_id: summary.execution_id
    }));

  return {
    evidence_status: failed_soft_verifications.length > 0 ? "warnings" : "clean",
    soft_verification_counts: {
      passed: verifications.filter((summary) => summary.verification.passed).length,
      failed: failed_soft_verifications.length
    },
    failed_soft_verifications
  };
}

export function buildExecutionManifest(
  runId: string,
  graph: CompiledGraph,
  repoWorkspaces: Record<string, WorkspaceBinding>
): ExecutionManifest {
  return {
    run_id: runId,
    graph_id: graph.graph_id,
    launch_profile: graph.launch.launch_profile,
    workspace_backend: graph.launch.workspace_backend,
    repo_workspaces: repoWorkspaces,
    nodes: graph.nodes.map((node) => ({
      compiled_id: node.compiled_id,
      authored_id: node.authored_id,
      kind: node.kind,
      repo_alias: node.repo,
      scope_stack: node.scope_stack,
      ...(node.repeat_scope_id ? { repeat_scope_id: node.repeat_scope_id } : {}),
      effective_policy: node.effective_policy
    }))
  };
}

export function createRuntimeSession(
  runId: string,
  runRoot: string,
  graph: CompiledGraph,
  attempts: AttemptRegistry,
  repoWorkspaces: Record<string, WorkspaceBinding>,
  graphPath?: string
): RuntimeSession {
  const started_at = new Date().toISOString();
  const repeat_scopes = new Map<string, RepeatScopeState>(
    graph.scopes
      .filter((scope): scope is CompiledRepeatScope => scope.kind === "repeat")
      .map((scope) => [
        scope.scope_id,
        {
          repeat_scope_id: scope.scope_id,
          authored_id: scope.authored_id,
          max_attempts: scope.max_attempts,
          until_compiled_id: scope.until_compiled_id,
          latest_iteration_index: 0,
          active_iteration_index: undefined,
          status: "pending"
        }
      ])
  );

  return {
    run_id: runId,
    run_root: runRoot,
    ...(graphPath ? { graph_path: graphPath } : {}),
    graph,
    manifest: buildExecutionManifest(runId, graph, repoWorkspaces),
    status: "pending",
    next_event_seq: 1,
    attempts,
    node_statuses: new Map(graph.nodes.map((node) => [node.compiled_id, "pending"])),
    latest_execution_by_compiled_id: new Map(),
    active_executions: new Map(),
    repeat_scopes,
    workspace_change_artifacts: {},
    started_at
  };
}

export function setNodeStatus(
  session: RuntimeSession,
  compiledId: string,
  status: RuntimeNodeStatus
): void {
  session.node_statuses.set(compiledId, status);
}

export function registerActiveExecution(
  session: RuntimeSession,
  attempt: RuntimeNodeAttempt
): void {
  setNodeStatus(session, attempt.compiled_id, "running");
  session.active_executions.set(attempt.execution_id, {
    execution_id: attempt.execution_id,
    compiled_id: attempt.compiled_id,
    authored_id: attempt.authored_id,
    repo_alias: attempt.repo_alias,
    kind: attempt.kind,
    attempt_index: attempt.attempt_index,
    ...(attempt.repeat_scope_id ? { repeat_scope_id: attempt.repeat_scope_id } : {}),
    ...(attempt.iteration_index !== undefined ? { iteration_index: attempt.iteration_index } : {}),
    ...(attempt.iteration_attempt_index !== undefined
      ? { iteration_attempt_index: attempt.iteration_attempt_index }
      : {}),
    started_at: attempt.started_at
  });
}

export function finalizeExecutionSummary(
  session: RuntimeSession,
  attempt: RuntimeNodeAttempt
): void {
  session.active_executions.delete(attempt.execution_id);
  const status =
    attempt.status === "canceled" ? "canceled" : (attempt.outcome ?? attempt.status) as RuntimeNodeStatus;

  setNodeStatus(session, attempt.compiled_id, status);
  session.latest_execution_by_compiled_id.set(attempt.compiled_id, {
    execution_id: attempt.execution_id,
    compiled_id: attempt.compiled_id,
    authored_id: attempt.authored_id,
    kind: attempt.kind,
    status,
    attempt_index: attempt.attempt_index,
    ...(attempt.repeat_scope_id ? { repeat_scope_id: attempt.repeat_scope_id } : {}),
    ...(attempt.iteration_index !== undefined ? { iteration_index: attempt.iteration_index } : {}),
    ...(attempt.iteration_attempt_index !== undefined
      ? { iteration_attempt_index: attempt.iteration_attempt_index }
      : {}),
    started_at: attempt.started_at,
    ...(attempt.ended_at ? { ended_at: attempt.ended_at } : {}),
    ...(attempt.duration_ms !== undefined ? { duration_ms: attempt.duration_ms } : {}),
    ...(attempt.metadata.verification &&
    typeof attempt.metadata.verification === "object" &&
    attempt.metadata.verification !== null
      ? { verification: attempt.metadata.verification as VerificationRecordedPayload }
      : {})
  });
}

export function openRepeatIteration(
  session: RuntimeSession,
  repeatScopeId: string
): RepeatScopeState {
  const repeatScope = session.repeat_scopes.get(repeatScopeId);

  if (!repeatScope) {
    throw new Error(`Unknown repeat scope "${repeatScopeId}".`);
  }

  repeatScope.latest_iteration_index += 1;
  repeatScope.active_iteration_index = repeatScope.latest_iteration_index;
  repeatScope.status = "running";
  return repeatScope;
}

export function completeRepeatIteration(
  session: RuntimeSession,
  repeatScopeId: string,
  outcome: "passed" | "failed"
): RepeatScopeState {
  const repeatScope = session.repeat_scopes.get(repeatScopeId);

  if (!repeatScope) {
    throw new Error(`Unknown repeat scope "${repeatScopeId}".`);
  }

  repeatScope.active_iteration_index = undefined;
  repeatScope.status = outcome;
  return repeatScope;
}

export function buildRuntimeStateSnapshot(session: RuntimeSession): RuntimeStateSnapshot {
  const snapshot_seq = Math.max(0, session.next_event_seq - 1);
  const softVerificationSummary = summarizeSoftVerifications(session.latest_execution_by_compiled_id.values());

  return {
    run_id: session.run_id,
    graph_id: session.graph.graph_id,
    snapshot_seq,
    status: session.status,
    evidence_status: softVerificationSummary.evidence_status,
    workspace_backend: session.manifest.workspace_backend,
    repo_workspaces: session.manifest.repo_workspaces,
    workspace_change_artifacts: session.workspace_change_artifacts,
    counts: createCounts(session.node_statuses.values()),
    soft_verification_counts: softVerificationSummary.soft_verification_counts,
    failed_soft_verifications: softVerificationSummary.failed_soft_verifications,
    node_statuses: Object.fromEntries(session.node_statuses),
    active_executions: Object.fromEntries(session.active_executions),
    latest_execution_by_compiled_id: Object.fromEntries(session.latest_execution_by_compiled_id),
    repeat_scopes: Object.fromEntries(session.repeat_scopes),
    started_at: session.started_at,
    ...(session.ended_at ? { ended_at: session.ended_at } : {})
  };
}

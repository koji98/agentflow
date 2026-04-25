import { basename, extname, relative, resolve } from "node:path";
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";

import type { AuthoredGraphDocument } from "../graph/authored.js";
import type {
  CompiledCheckNode,
  CompiledCheckpointNode,
  CompiledExecutableNode,
  CompiledGraph
} from "../graph/compiled.js";
import type { GraphOutcome } from "../graph/schema.js";
import type { RuntimeNodeAttempt } from "../runtime/attempts.js";
import type {
  RuntimeEventEnvelope,
  VerificationRecordedPayload
} from "../runtime/events.js";
import type {
  ExecutionManifest,
  RuntimeNodeStatus,
  RuntimeRunStatus,
  RuntimeStateSnapshot
} from "../runtime/session.js";
import {
  readAuthoredGraph,
  readBinaryFile,
  readCompiledGraph,
  readExecutionFiles,
  readExecutionManifest,
  readRunEvents,
  readRunExecutionAttempts,
  readRunState,
  readSupervisorInterventions
} from "./reader.js";
import { resolveRunArtifactPaths } from "./paths.js";
import { reconcileRunArtifacts } from "./reconcile.js";
import type { SupervisorInterventionRecord } from "../supervisor/types.js";

const defaultRecentEventLimit = 50;
const maxTextArtifactBytes = 262144;

export type ProjectionStatus =
  | "Pending"
  | "Ready"
  | "Running"
  | "Passed"
  | "Failed"
  | "Blocked"
  | "Canceled"
  | "Skipped";

export interface ProjectedRunSummary {
  run_id: string;
  graph_id: string;
  run_root: string;
  status: ProjectionStatus;
  evidence_status: RuntimeStateSnapshot["evidence_status"];
  launch_profile: string;
  workspace_backend: ExecutionManifest["workspace_backend"];
  snapshot_seq: number;
  active_nodes: number;
  passed_nodes: number;
  failed_nodes: number;
  current_repeat_depth: number;
  counts: RuntimeStateSnapshot["counts"];
  soft_verification_counts: RuntimeStateSnapshot["soft_verification_counts"];
  failed_soft_verifications: RuntimeStateSnapshot["failed_soft_verifications"];
  supervisor_status: RuntimeStateSnapshot["supervisor"]["status"];
  intervention_count: number;
  delivery_manifest: string;
  reviewer_guide: string;
  started_at: string;
  ended_at?: string;
}

export interface ProjectedRunNode {
  authored_id: string;
  compiled_id: string;
  label: string;
  kind: CompiledExecutableNode["kind"];
  repo_alias: string;
  scope_stack: string[];
  status: ProjectionStatus;
  repeat_scope_id?: string;
  active_execution_id?: string;
  latest_execution_id?: string;
  iteration_index?: number;
  attempt_index?: number;
  iteration_attempt_index?: number;
  badge?: string;
}

export interface ProjectedRunEvent {
  seq: number;
  ts: string;
  type: RuntimeEventEnvelope["type"];
  run_id: string;
  compiled_id?: string;
  authored_id?: string;
  execution_id?: string;
  repeat_scope_id?: string;
  iteration_index?: number;
  attempt_index?: number;
  node_label?: string;
  summary: string;
  payload: RuntimeEventEnvelope["payload"];
}

export interface ProjectedRunDiagnostic {
  seq: number;
  ts: string;
  severity: "warning" | "error";
  event_type: RuntimeEventEnvelope["type"];
  summary: string;
  compiled_id?: string;
  authored_id?: string;
  execution_id?: string;
  node_label?: string;
}

export interface ProjectedRunEventPage {
  run_id: string;
  after_seq: number;
  latest_seq: number;
  events: ProjectedRunEvent[];
}

export interface ProjectedNodeAttemptSummary {
  execution_id: string;
  authored_id: string;
  compiled_id: string;
  kind: CompiledExecutableNode["kind"];
  repo_alias: string;
  status: ProjectionStatus;
  outcome?: GraphOutcome;
  repeat_scope_id?: string;
  iteration_index?: number;
  attempt_index: number;
  iteration_attempt_index?: number;
  started_at: string;
  ended_at?: string;
  duration_ms?: number;
  artifact_count: number;
  artifacts: Record<string, string>;
}

export interface ProjectedArtifactItem {
  execution_id: string;
  relative_path: string;
  absolute_path: string;
  label: string;
  kind: "stdout" | "stderr" | "context" | "result" | "artifact";
  content_type: string;
  size_bytes: number;
}

export interface ProjectedCheckEvaluation {
  seq: number;
  execution_id?: string;
  check_kind: "deterministic" | "ai";
  passed: boolean;
  score?: number;
  summary?: string;
}

export interface ProjectedVerificationRecord extends VerificationRecordedPayload {
  seq: number;
  execution_id?: string;
  result_artifact_path?: string;
}

export interface ProjectedNodeDefinition {
  context: CompiledExecutableNode["context"];
  declared_artifacts: CompiledExecutableNode["declared_artifacts"];
  lowered_from?: CompiledExecutableNode["lowered_from"];
  prompt?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env_files?: string[];
  env?: Record<string, string>;
  check_kind?: CompiledCheckNode["check_kind"];
  on_failure?: "fail" | "continue";
  rubric?: string;
  review_from?: CompiledCheckpointNode["review_from"];
}

export interface ProjectedNodeDetail {
  run_id: string;
  graph_id: string;
  snapshot_seq: number;
  node: ProjectedRunNode;
  deps: string[];
  effective_policy: CompiledExecutableNode["effective_policy"];
  definition: ProjectedNodeDefinition;
  executions: ProjectedNodeAttemptSummary[];
  selected_execution_id?: string;
  artifacts: ProjectedArtifactItem[];
  check_evaluations: ProjectedCheckEvaluation[];
  soft_verifications: ProjectedVerificationRecord[];
  events: ProjectedRunEvent[];
}

export interface ProjectedTextArtifact {
  relative_path: string;
  absolute_path: string;
  content: string;
  truncated: boolean;
}

export interface ProjectedNodeLogPayload {
  run_id: string;
  compiled_id: string;
  selected_execution_id?: string;
  executions: ProjectedNodeAttemptSummary[];
  stdout?: ProjectedTextArtifact;
  stderr?: ProjectedTextArtifact;
  artifacts: ProjectedArtifactItem[];
}

export interface ProjectedArtifactRead {
  run_id: string;
  compiled_id: string;
  execution_id: string;
  artifact: ProjectedArtifactItem;
  content: string;
  truncated: boolean;
}

export interface ProjectedRunSnapshot {
  run: ProjectedRunSummary;
  authored_graph?: AuthoredGraphDocument;
  compiled_graph: CompiledGraph;
  execution_manifest: ExecutionManifest;
  snapshot_seq: number;
  overlay_nodes: ProjectedRunNode[];
  run_diagnostics: ProjectedRunDiagnostic[];
  recent_interventions: SupervisorInterventionRecord[];
  recent_events: ProjectedRunEvent[];
}

interface RunProjectionContext {
  run_root: string;
  authored_graph?: AuthoredGraphDocument;
  compiled_graph: CompiledGraph;
  execution_manifest: ExecutionManifest;
  state: RuntimeStateSnapshot;
  events: RuntimeEventEnvelope[];
  interventions: SupervisorInterventionRecord[];
}

function toProjectionStatus(status: RuntimeNodeStatus | RuntimeRunStatus): ProjectionStatus {
  switch (status) {
    case "pending":
      return "Pending";
    case "ready":
      return "Ready";
    case "running":
      return "Running";
    case "passed":
      return "Passed";
    case "failed":
      return "Failed";
    case "blocked":
      return "Blocked";
    case "canceled":
      return "Canceled";
    case "skipped":
      return "Skipped";
  }
}

function buildNodeLabel(node: Pick<CompiledExecutableNode, "authored_id" | "label">): string {
  return node.label ?? node.authored_id;
}

function countActiveRepeatScopes(state: RuntimeStateSnapshot): number {
  return Object.values(state.repeat_scopes).filter(
    (repeatScope) => repeatScope.active_iteration_index !== undefined
  ).length;
}

function buildRunSummary(
  runRoot: string,
  state: RuntimeStateSnapshot,
  manifest: ExecutionManifest
): ProjectedRunSummary {
  const deliveryDir = resolveRunArtifactPaths(runRoot).delivery_dir;

  return {
    run_id: state.run_id,
    graph_id: state.graph_id,
    run_root: runRoot,
    status: toProjectionStatus(state.status),
    evidence_status: state.evidence_status,
    launch_profile: manifest.launch_profile,
    workspace_backend: state.workspace_backend,
    snapshot_seq: state.snapshot_seq,
    active_nodes: state.counts.running,
    passed_nodes: state.counts.passed,
    failed_nodes: state.counts.failed,
    current_repeat_depth: countActiveRepeatScopes(state),
    counts: state.counts,
    soft_verification_counts: state.soft_verification_counts,
    failed_soft_verifications: state.failed_soft_verifications,
    supervisor_status: state.supervisor.status,
    intervention_count: state.supervisor.intervention_count,
    delivery_manifest: `${deliveryDir}/manifest.json`,
    reviewer_guide: `${deliveryDir}/reviewer-guide.md`,
    started_at: state.started_at,
    ...(state.ended_at ? { ended_at: state.ended_at } : {})
  };
}

function buildNodeBadge(
  node: CompiledExecutableNode,
  state: RuntimeStateSnapshot
): string | undefined {
  const activeExecution = Object.values(state.active_executions).find(
    (execution) => execution.compiled_id === node.compiled_id
  );
  const latestExecution = state.latest_execution_by_compiled_id[node.compiled_id];
  const iterationIndex = activeExecution?.iteration_index ?? latestExecution?.iteration_index;
  const attemptIndex = activeExecution?.attempt_index ?? latestExecution?.attempt_index;
  const iterationAttemptIndex =
    activeExecution?.iteration_attempt_index ?? latestExecution?.iteration_attempt_index;

  if (iterationIndex !== undefined) {
    return `i${iterationIndex}/a${iterationAttemptIndex ?? attemptIndex ?? "?"}`;
  }

  if (attemptIndex !== undefined) {
    return `a${attemptIndex}`;
  }

  if (node.kind === "agent") {
    return node.effective_policy.harness ?? "agent";
  }

  if (node.kind === "check") {
    return node.check_kind;
  }

  if (node.kind === "checkpoint") {
    return "checkpoint";
  }

  return basename(node.command);
}

function buildRunNode(
  node: CompiledExecutableNode,
  state: RuntimeStateSnapshot
): ProjectedRunNode {
  const activeExecution = Object.values(state.active_executions).find(
    (execution) => execution.compiled_id === node.compiled_id
  );
  const latestExecution = state.latest_execution_by_compiled_id[node.compiled_id];
  const badge = buildNodeBadge(node, state);

  return {
    authored_id: node.authored_id,
    compiled_id: node.compiled_id,
    label: buildNodeLabel(node),
    kind: node.kind,
    repo_alias: node.repo,
    scope_stack: node.scope_stack,
    status: toProjectionStatus(state.node_statuses[node.compiled_id] ?? "pending"),
    ...(node.repeat_scope_id ? { repeat_scope_id: node.repeat_scope_id } : {}),
    ...(activeExecution ? { active_execution_id: activeExecution.execution_id } : {}),
    ...(latestExecution ? { latest_execution_id: latestExecution.execution_id } : {}),
    ...(activeExecution?.iteration_index !== undefined
      ? { iteration_index: activeExecution.iteration_index }
      : latestExecution?.iteration_index !== undefined
        ? { iteration_index: latestExecution.iteration_index }
        : {}),
    ...(activeExecution?.attempt_index !== undefined
      ? { attempt_index: activeExecution.attempt_index }
      : latestExecution?.attempt_index !== undefined
        ? { attempt_index: latestExecution.attempt_index }
        : {}),
    ...(activeExecution?.iteration_attempt_index !== undefined
      ? { iteration_attempt_index: activeExecution.iteration_attempt_index }
      : latestExecution?.iteration_attempt_index !== undefined
        ? { iteration_attempt_index: latestExecution.iteration_attempt_index }
        : {}),
    ...(badge ? { badge } : {})
  };
}

function formatDuration(durationMs: unknown): string {
  return typeof durationMs === "number" ? `${durationMs}ms` : "unknown duration";
}

function formatPayloadList(value: unknown, fallback: string): string {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const items = value
    .map((item) => typeof item === "string" ? item : undefined)
    .filter((item): item is string => item !== undefined && item.trim().length > 0);

  return items.length > 0 ? items.join(", ") : fallback;
}

function buildEventSummary(
  event: RuntimeEventEnvelope,
  graph: CompiledGraph
): {
  authored_id?: string;
  node_label?: string;
  summary: string;
} {
  const node = event.compiled_id
    ? graph.nodes.find((candidate) => candidate.compiled_id === event.compiled_id)
    : undefined;
  const repeatScope = event.repeat_scope_id
    ? graph.scopes.find((candidate) => candidate.scope_id === event.repeat_scope_id)
    : undefined;
  const payload = typeof event.payload === "object" && event.payload !== null
    ? event.payload as Record<string, unknown>
    : {};
  const nodeLabel = node ? buildNodeLabel(node) : repeatScope?.authored_id;
  const authored_id = node?.authored_id ?? repeatScope?.authored_id;

  switch (event.type) {
    case "graph.compiled":
      return {
        summary: `${payload.compiled_node_count ?? "?"} executable nodes across ${payload.scope_count ?? "?"} scopes.`
      };
    case "run.preflight_failed":
      return {
        summary: String(payload.message ?? payload.reason ?? "Run preflight failed.")
      };
    case "run.started":
      return {
        summary: `Run started with ${String(payload.workspace_backend ?? "workspace backend")} workspaces.`
      };
    case "node.ready":
      return {
        ...(authored_id ? { authored_id } : {}),
        ...(nodeLabel ? { node_label: nodeLabel } : {}),
        summary: "Dependencies satisfied."
      };
    case "repeat.iteration.started":
      return {
        ...(authored_id ? { authored_id } : {}),
        ...(nodeLabel ? { node_label: nodeLabel } : {}),
        summary: `Iteration ${event.iteration_index ?? "?"} of ${payload.max_attempts ?? "?"} started.`
      };
    case "node.started":
      return {
        ...(authored_id ? { authored_id } : {}),
        ...(nodeLabel ? { node_label: nodeLabel } : {}),
        summary: `${String(payload.kind ?? "node")} started in repo ${String(payload.repo_alias ?? "unknown")}.`
      };
    case "supervisor.decision":
      return {
        ...(authored_id ? { authored_id } : {}),
        ...(nodeLabel ? { node_label: nodeLabel } : {}),
        summary: `Supervisor ${String(payload.kind ?? "decision")}${payload.action ? `: ${String(payload.action)}` : ""} - ${String(payload.reason ?? "no reason recorded")}.`
      };
    case "supervisor.intervention.started":
      return {
        ...(authored_id ? { authored_id } : {}),
        ...(nodeLabel ? { node_label: nodeLabel } : {}),
        summary: String(payload.summary ?? `Supervisor intervention ${String(payload.intervention_id ?? "?")} started.`)
      };
    case "supervisor.intervention.completed":
      return {
        ...(authored_id ? { authored_id } : {}),
        ...(nodeLabel ? { node_label: nodeLabel } : {}),
        summary: String(payload.summary ?? `Supervisor intervention ${String(payload.intervention_id ?? "?")} completed.`)
      };
    case "supervisor.intervention.failed":
      return {
        ...(authored_id ? { authored_id } : {}),
        ...(nodeLabel ? { node_label: nodeLabel } : {}),
        summary: String(payload.summary ?? `Supervisor intervention ${String(payload.intervention_id ?? "?")} failed.`)
      };
    case "supervisor.escalated":
      return {
        ...(authored_id ? { authored_id } : {}),
        ...(nodeLabel ? { node_label: nodeLabel } : {}),
        summary: String(payload.summary ?? payload.reason ?? "Supervisor escalated.")
      };
    case "check.evaluated":
      return {
        ...(authored_id ? { authored_id } : {}),
        ...(nodeLabel ? { node_label: nodeLabel } : {}),
        summary: payload.passed === true
          ? String(payload.summary ?? "Check passed.")
          : String(payload.summary ?? "Check failed.")
      };
    case "verification.recorded":
      return {
        ...(authored_id ? { authored_id } : {}),
        ...(nodeLabel ? { node_label: nodeLabel } : {}),
        summary: payload.passed === true
          ? String(payload.summary ?? "Soft verification passed.")
          : String(payload.summary ?? "Soft verification failed.")
      };
    case "node.completed":
      return {
        ...(authored_id ? { authored_id } : {}),
        ...(nodeLabel ? { node_label: nodeLabel } : {}),
        summary: `${String(payload.outcome ?? "completed")} in ${formatDuration(payload.duration_ms)}.`
      };
    case "node.blocked":
      return {
        ...(authored_id ? { authored_id } : {}),
        ...(nodeLabel ? { node_label: nodeLabel } : {}),
        summary: `Blocked by ${String(payload.upstream_compiled_id ?? "upstream failure")}.`
      };
    case "node.skipped":
    case "node.canceled":
      return {
        ...(authored_id ? { authored_id } : {}),
        ...(nodeLabel ? { node_label: nodeLabel } : {}),
        summary: String(payload.reason ?? event.type)
      };
    case "repeat.iteration.completed":
      return {
        ...(authored_id ? { authored_id } : {}),
        ...(nodeLabel ? { node_label: nodeLabel } : {}),
        summary: `Iteration ${payload.iteration_index ?? event.iteration_index ?? "?"} ${String(payload.outcome ?? "completed")}.`
      };
    case "sequence.cleanup.started":
      return {
        summary: `Cleanup started for sequence "${String(payload.sequence_authored_id ?? "?")}" (${payload.cleanup_step_count ?? "?"} steps after body ${String(payload.body_outcome ?? "?")}).`
      };
    case "sequence.cleanup.step_failed":
      return {
        ...(event.compiled_id ? { authored_id: event.compiled_id } : {}),
        summary: `Cleanup step failed: ${String(payload.message ?? "unknown error")}.`
      };
    case "sequence.cleanup.completed":
      return {
        summary: `Cleanup completed for sequence "${String(payload.sequence_authored_id ?? "?")}" (passed ${payload.steps_passed ?? 0}, failed ${payload.steps_failed ?? 0}, skipped ${payload.steps_skipped ?? 0}).`
      };
    case "sequence.cleanup.canceled":
      return {
        summary: `Cleanup canceled for sequence "${String(payload.sequence_authored_id ?? "?")}": ${String(payload.reason ?? "operator_cancel")}.`
      };
    case "delivery.package.completed":
      return {
        summary: `Delivery package completed at ${String(payload.manifest_path ?? "delivery/manifest.json")}.`
      };
    case "run.canceled":
      return {
        summary: String(payload.reason ?? "Run canceled.")
      };
    case "run.completed":
      return {
        summary:
          payload.outcome === "failed" && typeof payload.reason === "string"
            ? `Run failed: ${payload.reason}`
            : `Run ${String(payload.outcome ?? "completed")} in ${formatDuration(payload.duration_ms)}.`
      };
  }
}

function buildProjectedEvent(
  graph: CompiledGraph,
  event: RuntimeEventEnvelope
): ProjectedRunEvent {
  const summary = buildEventSummary(event, graph);

  return {
    seq: event.seq,
    ts: event.ts,
    type: event.type,
    run_id: event.run_id,
    ...(event.compiled_id ? { compiled_id: event.compiled_id } : {}),
    ...(summary.authored_id ? { authored_id: summary.authored_id } : {}),
    ...(event.execution_id ? { execution_id: event.execution_id } : {}),
    ...(event.repeat_scope_id ? { repeat_scope_id: event.repeat_scope_id } : {}),
    ...(event.iteration_index !== undefined ? { iteration_index: event.iteration_index } : {}),
    ...(event.attempt_index !== undefined ? { attempt_index: event.attempt_index } : {}),
    ...(summary.node_label ? { node_label: summary.node_label } : {}),
    summary: summary.summary,
    payload: event.payload
  };
}

function buildRunDiagnostic(
  event: ProjectedRunEvent
): ProjectedRunDiagnostic | undefined {
  const payload =
    typeof event.payload === "object" && event.payload !== null
      ? event.payload as Record<string, unknown>
      : {};

  switch (event.type) {
    case "run.preflight_failed":
      return {
        seq: event.seq,
        ts: event.ts,
        severity: "error",
        event_type: event.type,
        summary: event.summary
      };
    case "run.canceled":
      return {
        seq: event.seq,
        ts: event.ts,
        severity: "warning",
        event_type: event.type,
        summary: event.summary
      };
    case "run.completed":
      return payload.outcome === "failed"
        ? {
            seq: event.seq,
            ts: event.ts,
            severity: "error",
            event_type: event.type,
            summary: event.summary
          }
        : undefined;
    case "node.completed":
      return payload.outcome === "failed"
        ? {
            seq: event.seq,
            ts: event.ts,
            severity: "error",
            event_type: event.type,
            summary: event.summary,
            ...(event.compiled_id ? { compiled_id: event.compiled_id } : {}),
            ...(event.authored_id ? { authored_id: event.authored_id } : {}),
            ...(event.execution_id ? { execution_id: event.execution_id } : {}),
            ...(event.node_label ? { node_label: event.node_label } : {})
          }
        : undefined;
    case "node.blocked":
    case "node.canceled":
    case "supervisor.intervention.failed":
      return {
        seq: event.seq,
        ts: event.ts,
        severity: "warning",
        event_type: event.type,
        summary: event.summary,
        ...(event.compiled_id ? { compiled_id: event.compiled_id } : {}),
        ...(event.authored_id ? { authored_id: event.authored_id } : {}),
        ...(event.execution_id ? { execution_id: event.execution_id } : {}),
        ...(event.node_label ? { node_label: event.node_label } : {})
      };
    case "supervisor.escalated":
      return {
        seq: event.seq,
        ts: event.ts,
        severity: "error",
        event_type: event.type,
        summary: event.summary,
        ...(event.compiled_id ? { compiled_id: event.compiled_id } : {}),
        ...(event.authored_id ? { authored_id: event.authored_id } : {}),
        ...(event.execution_id ? { execution_id: event.execution_id } : {}),
        ...(event.node_label ? { node_label: event.node_label } : {})
      };
    case "check.evaluated":
      return payload.passed === false
        ? {
            seq: event.seq,
            ts: event.ts,
            severity: "warning",
            event_type: event.type,
            summary: event.summary,
            ...(event.compiled_id ? { compiled_id: event.compiled_id } : {}),
            ...(event.authored_id ? { authored_id: event.authored_id } : {}),
            ...(event.execution_id ? { execution_id: event.execution_id } : {}),
            ...(event.node_label ? { node_label: event.node_label } : {})
          }
        : undefined;
    case "verification.recorded":
      return payload.passed === false
        ? {
            seq: event.seq,
            ts: event.ts,
            severity: "warning",
            event_type: event.type,
            summary: event.summary,
            ...(event.compiled_id ? { compiled_id: event.compiled_id } : {}),
            ...(event.authored_id ? { authored_id: event.authored_id } : {}),
            ...(event.execution_id ? { execution_id: event.execution_id } : {}),
            ...(event.node_label ? { node_label: event.node_label } : {})
          }
        : undefined;
    default:
      return undefined;
  }
}

function buildRunDiagnostics(context: RunProjectionContext): ProjectedRunDiagnostic[] {
  if (context.state.status === "passed" && context.state.evidence_status === "clean") {
    return [];
  }

  const diagnostics: ProjectedRunDiagnostic[] = [];
  const seen = new Set<string>();

  for (let index = context.events.length - 1; index >= 0; index -= 1) {
    const projectedEvent = buildProjectedEvent(context.compiled_graph, context.events[index]!);
    const diagnostic = buildRunDiagnostic(projectedEvent);
    const nodeStatus = diagnostic?.compiled_id
      ? context.state.node_statuses[diagnostic.compiled_id]
      : undefined;

    if (!diagnostic) {
      continue;
    }

    if (
      diagnostic.compiled_id
      && nodeStatus
      && !["failed", "blocked", "canceled"].includes(nodeStatus)
      && !["check.evaluated", "verification.recorded"].includes(diagnostic.event_type)
    ) {
      continue;
    }

    if (
      diagnostic.event_type === "check.evaluated"
      && diagnostic.compiled_id
      && nodeStatus
      && !["failed", "blocked", "canceled", "running"].includes(nodeStatus)
    ) {
      continue;
    }

    if (
      diagnostic.event_type === "verification.recorded"
      && diagnostic.compiled_id
      && nodeStatus
      && !["passed", "failed", "blocked", "canceled", "running"].includes(nodeStatus)
    ) {
      continue;
    }

    const key = [
      diagnostic.event_type,
      diagnostic.compiled_id ?? "",
      diagnostic.execution_id ?? "",
      diagnostic.summary
    ].join(":");

    if (seen.has(key)) {
      continue;
    }

    diagnostics.push(diagnostic);
    seen.add(key);

    if (diagnostics.length >= 4) {
      break;
    }
  }

  return diagnostics;
}

function classifyArtifactKind(relativePath: string): ProjectedArtifactItem["kind"] {
  if (relativePath === "logs/stdout.log" || relativePath === "stdout.log") {
    return "stdout";
  }

  if (relativePath === "logs/stderr.log" || relativePath === "stderr.log") {
    return "stderr";
  }

  if (
    relativePath === "context/packet.json" ||
    relativePath === "context/manifest.md" ||
    relativePath === "context/provenance.json" ||
    relativePath === "context_packet.json" ||
    relativePath === "context-manifest.md" ||
    relativePath === "context_provenance.json"
  ) {
    return "context";
  }

  if (
    relativePath === "result.json"
    || relativePath === "artifacts/verification.json"
    || relativePath === "verification.json"
  ) {
    return "result";
  }

  return "artifact";
}

function guessContentType(relativePath: string): string {
  const extension = extname(relativePath).toLowerCase();

  if (extension === ".json") {
    return "application/json";
  }

  if (extension === ".md") {
    return "text/markdown";
  }

  if (extension === ".log" || extension === ".txt") {
    return "text/plain";
  }

  return "text/plain";
}

async function indexExecutionArtifacts(execution: RuntimeNodeAttempt): Promise<ProjectedArtifactItem[]> {
  const filePaths = await readExecutionFiles(execution.execution_dir);
  const artifactPaths = filePaths.filter((filePath) => basename(filePath) !== "execution.json");
  const artifacts = await Promise.all(
    artifactPaths.map(async (filePath) => {
      const fileStat = await stat(filePath);
      const relativePath = relative(execution.execution_dir, filePath).split("\\").join("/");

      return {
        execution_id: execution.execution_id,
        relative_path: relativePath,
        absolute_path: resolve(filePath),
        label: basename(filePath),
        kind: classifyArtifactKind(relativePath),
        content_type: guessContentType(relativePath),
        size_bytes: fileStat.size
      } satisfies ProjectedArtifactItem;
    })
  );

  return artifacts.sort((left, right) => left.relative_path.localeCompare(right.relative_path));
}

function buildAttemptStatus(attempt: RuntimeNodeAttempt): ProjectionStatus {
  if (attempt.status === "running") {
    return "Running";
  }

  if (attempt.status === "canceled") {
    return "Canceled";
  }

  return toProjectionStatus(attempt.outcome ?? attempt.status);
}

async function buildAttemptSummary(
  attempt: RuntimeNodeAttempt
): Promise<ProjectedNodeAttemptSummary> {
  const artifacts = await indexExecutionArtifacts(attempt);

  return {
    execution_id: attempt.execution_id,
    authored_id: attempt.authored_id,
    compiled_id: attempt.compiled_id,
    kind: attempt.kind,
    repo_alias: attempt.repo_alias,
    status: buildAttemptStatus(attempt),
    ...(attempt.outcome ? { outcome: attempt.outcome } : {}),
    ...(attempt.repeat_scope_id ? { repeat_scope_id: attempt.repeat_scope_id } : {}),
    ...(attempt.iteration_index !== undefined ? { iteration_index: attempt.iteration_index } : {}),
    attempt_index: attempt.attempt_index,
    ...(attempt.iteration_attempt_index !== undefined
      ? { iteration_attempt_index: attempt.iteration_attempt_index }
      : {}),
    started_at: attempt.started_at,
    ...(attempt.ended_at ? { ended_at: attempt.ended_at } : {}),
    ...(attempt.duration_ms !== undefined ? { duration_ms: attempt.duration_ms } : {}),
    artifact_count: artifacts.length,
    artifacts: attempt.artifacts
  };
}

function sortAttempts(left: RuntimeNodeAttempt, right: RuntimeNodeAttempt): number {
  const leftIteration = left.iteration_index ?? 0;
  const rightIteration = right.iteration_index ?? 0;

  if (leftIteration !== rightIteration) {
    return leftIteration - rightIteration;
  }

  const leftIterationAttempt = left.iteration_attempt_index ?? left.attempt_index;
  const rightIterationAttempt = right.iteration_attempt_index ?? right.attempt_index;

  if (leftIterationAttempt !== rightIterationAttempt) {
    return leftIterationAttempt - rightIterationAttempt;
  }

  return left.attempt_index - right.attempt_index;
}

function selectExecutionId(
  compiledId: string,
  executions: RuntimeNodeAttempt[],
  state: RuntimeStateSnapshot,
  requestedExecutionId?: string
): string | undefined {
  if (requestedExecutionId) {
    return executions.find((execution) => execution.execution_id === requestedExecutionId)?.execution_id;
  }

  const activeExecution = Object.values(state.active_executions).find(
    (execution) => execution.compiled_id === compiledId
  );

  if (activeExecution) {
    return activeExecution.execution_id;
  }

  return state.latest_execution_by_compiled_id[compiledId]?.execution_id ?? executions.at(-1)?.execution_id;
}

function buildNodeDefinition(node: CompiledExecutableNode): ProjectedNodeDefinition {
  if (node.kind === "agent") {
    return {
      context: node.context,
      declared_artifacts: node.declared_artifacts,
      ...(node.lowered_from ? { lowered_from: node.lowered_from } : {}),
      prompt: node.prompt
    };
  }

  if (node.kind === "exec") {
    return {
      context: node.context,
      declared_artifacts: node.declared_artifacts,
      ...(node.lowered_from ? { lowered_from: node.lowered_from } : {}),
      command: node.command,
      args: node.args,
      on_failure: node.on_failure,
      ...(node.cwd ? { cwd: node.cwd } : {}),
      ...(node.env_files !== undefined ? { env_files: node.env_files } : {}),
      ...(node.env ? { env: node.env } : {})
    };
  }

  if (node.kind === "checkpoint") {
    return {
      context: node.context,
      declared_artifacts: node.declared_artifacts,
      ...(node.lowered_from ? { lowered_from: node.lowered_from } : {}),
      prompt: node.prompt,
      review_from: node.review_from
    };
  }

  return {
    context: node.context,
    declared_artifacts: node.declared_artifacts,
    ...(node.lowered_from ? { lowered_from: node.lowered_from } : {}),
    ...(node.command ? { command: node.command } : {}),
    ...(node.args ? { args: node.args } : {}),
    ...(node.cwd ? { cwd: node.cwd } : {}),
    ...(node.env_files !== undefined ? { env_files: node.env_files } : {}),
    ...(node.env ? { env: node.env } : {}),
    on_failure: node.on_failure,
    check_kind: node.check_kind,
    ...(node.prompt ? { prompt: node.prompt } : {}),
    ...(node.rubric ? { rubric: node.rubric } : {})
  };
}

async function loadRunProjectionContext(runRoot: string): Promise<RunProjectionContext> {
  await reconcileRunArtifacts(runRoot);
  const [
    compiled_graph,
    execution_manifest,
    state,
    events,
    interventions,
    authored_graph_result
  ] = await Promise.all([
    readCompiledGraph(runRoot),
    readExecutionManifest(runRoot),
    readRunState(runRoot),
    readRunEvents(runRoot),
    readSupervisorInterventions(runRoot),
    readAuthoredGraph(runRoot).then((authored_graph) => ({ authored_graph })).catch(() => ({}))
  ]);
  const authored_graph =
    "authored_graph" in authored_graph_result ? authored_graph_result.authored_graph : undefined;

  return {
    run_root: runRoot,
    ...(authored_graph ? { authored_graph } : {}),
    compiled_graph,
    execution_manifest,
    state,
    events,
    interventions
  };
}

function buildEventPage(
  context: RunProjectionContext,
  options: {
    after_seq?: number;
    compiled_id?: string;
    limit?: number;
  } = {}
): ProjectedRunEventPage {
  const after_seq = options.after_seq ?? 0;
  const filtered = context.events.filter((event) => event.seq > after_seq);
  const byNode = options.compiled_id
    ? filtered.filter((event) => event.compiled_id === options.compiled_id)
    : filtered;
  const limited = byNode.slice(0, options.limit ?? byNode.length);

  return {
    run_id: context.state.run_id,
    after_seq,
    latest_seq: context.state.snapshot_seq,
    events: limited.map((event) => buildProjectedEvent(context.compiled_graph, event))
  };
}

export async function listProjectedRuns(runsRoot: string): Promise<ProjectedRunSummary[]> {
  let runEntries: Dirent[];

  try {
    runEntries = await readdir(runsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const runs = await Promise.all(
    runEntries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const runRoot = resolve(runsRoot, entry.name);

        try {
          await reconcileRunArtifacts(runRoot);
          const [state, manifest] = await Promise.all([
            readRunState(runRoot),
            readExecutionManifest(runRoot)
          ]);

          return buildRunSummary(runRoot, state, manifest);
        } catch {
          return undefined;
        }
      })
  );

  return runs
    .filter((run): run is ProjectedRunSummary => run !== undefined)
    .sort((left, right) => Date.parse(right.started_at) - Date.parse(left.started_at));
}

export async function projectRunSnapshot(runRoot: string): Promise<ProjectedRunSnapshot> {
  const context = await loadRunProjectionContext(runRoot);
  const recentEvents = buildEventPage(context, {
    after_seq: Math.max(0, context.state.snapshot_seq - defaultRecentEventLimit)
  });

  return {
    run: buildRunSummary(runRoot, context.state, context.execution_manifest),
    ...(context.authored_graph ? { authored_graph: context.authored_graph } : {}),
    compiled_graph: context.compiled_graph,
    execution_manifest: context.execution_manifest,
    snapshot_seq: context.state.snapshot_seq,
    overlay_nodes: context.compiled_graph.nodes.map((node) => buildRunNode(node, context.state)),
    run_diagnostics: buildRunDiagnostics(context),
    recent_interventions: context.interventions.slice(-5),
    recent_events: recentEvents.events
  };
}

export async function projectRunEvents(
  runRoot: string,
  options: {
    after_seq?: number;
    compiled_id?: string;
    limit?: number;
  } = {}
): Promise<ProjectedRunEventPage> {
  const context = await loadRunProjectionContext(runRoot);
  return buildEventPage(context, options);
}

export async function projectNodeDetail(
  runRoot: string,
  compiledId: string
): Promise<ProjectedNodeDetail> {
  const context = await loadRunProjectionContext(runRoot);
  const node = context.compiled_graph.nodes.find((candidate) => candidate.compiled_id === compiledId);

  if (!node) {
    throw new Error(`Unknown compiled node "${compiledId}".`);
  }

  const attempts = (await readRunExecutionAttempts(runRoot))
    .filter((attempt) => attempt.compiled_id === compiledId)
    .sort(sortAttempts);
  const selectedExecutionId = selectExecutionId(compiledId, attempts, context.state);
  const selectedExecution = selectedExecutionId
    ? attempts.find((attempt) => attempt.execution_id === selectedExecutionId)
    : undefined;
  const [executions, artifacts] = await Promise.all([
    Promise.all(attempts.map((attempt) => buildAttemptSummary(attempt))),
    selectedExecution ? indexExecutionArtifacts(selectedExecution) : Promise.resolve([])
  ]);
  const events = buildEventPage(context, {
    after_seq: 0,
    compiled_id: compiledId
  }).events;
  const attemptsByExecutionId = new Map(
    attempts.map((attempt) => [attempt.execution_id, attempt])
  );
  const check_evaluations = context.events
    .filter(
      (event) => event.type === "check.evaluated" && event.compiled_id === compiledId
    )
    .map((event) => {
      const payload = event.payload as {
        check_kind: "deterministic" | "ai";
        passed: boolean;
        score?: number;
        summary?: string;
      };

      return {
        seq: event.seq,
        ...(event.execution_id ? { execution_id: event.execution_id } : {}),
        check_kind: payload.check_kind,
        passed: payload.passed,
        ...(payload.score !== undefined ? { score: payload.score } : {}),
        ...(payload.summary ? { summary: payload.summary } : {})
      } satisfies ProjectedCheckEvaluation;
    });
  const soft_verifications = context.events
    .filter(
      (event) => event.type === "verification.recorded" && event.compiled_id === compiledId
    )
    .map((event) => {
      const payload = event.payload as VerificationRecordedPayload;
      const attempt = event.execution_id ? attemptsByExecutionId.get(event.execution_id) : undefined;

      return {
        seq: event.seq,
        verifier_kind: payload.verifier_kind,
        passed: payload.passed,
        summary: payload.summary,
        ...(event.execution_id ? { execution_id: event.execution_id } : {}),
        ...(payload.check_kind ? { check_kind: payload.check_kind } : {}),
        ...(payload.exit_code !== undefined ? { exit_code: payload.exit_code } : {}),
        ...(attempt?.result_path ? { result_artifact_path: attempt.result_path } : {})
      } satisfies ProjectedVerificationRecord;
    });

  return {
    run_id: context.state.run_id,
    graph_id: context.state.graph_id,
    snapshot_seq: context.state.snapshot_seq,
    node: buildRunNode(node, context.state),
    deps: context.compiled_graph.edges
      .filter((edge) => edge.to === compiledId)
      .map((edge) => edge.from),
    effective_policy: node.effective_policy,
    definition: buildNodeDefinition(node),
    executions,
    ...(selectedExecutionId ? { selected_execution_id: selectedExecutionId } : {}),
    artifacts,
    check_evaluations,
    soft_verifications,
    events
  };
}

async function readTextArtifact(
  absolutePath: string,
  executionDir: string
): Promise<ProjectedTextArtifact> {
  const buffer = await readBinaryFile(absolutePath);
  const truncated = buffer.byteLength > maxTextArtifactBytes;
  const contentBuffer = truncated ? buffer.subarray(0, maxTextArtifactBytes) : buffer;

  return {
    relative_path: relative(executionDir, absolutePath).split("\\").join("/"),
    absolute_path: absolutePath,
    content: contentBuffer.toString("utf8"),
    truncated
  };
}

export async function projectNodeLogs(
  runRoot: string,
  compiledId: string,
  executionId?: string
): Promise<ProjectedNodeLogPayload> {
  const context = await loadRunProjectionContext(runRoot);
  const node = context.compiled_graph.nodes.find((candidate) => candidate.compiled_id === compiledId);

  if (!node) {
    throw new Error(`Unknown compiled node "${compiledId}".`);
  }

  const attempts = (await readRunExecutionAttempts(runRoot))
    .filter((attempt) => attempt.compiled_id === compiledId)
    .sort(sortAttempts);
  const selectedExecutionId = selectExecutionId(compiledId, attempts, context.state, executionId);
  const selectedExecution = selectedExecutionId
    ? attempts.find((attempt) => attempt.execution_id === selectedExecutionId)
    : undefined;
  const [executions, artifacts] = await Promise.all([
    Promise.all(attempts.map((attempt) => buildAttemptSummary(attempt))),
    selectedExecution ? indexExecutionArtifacts(selectedExecution) : Promise.resolve([])
  ]);
  const stdoutArtifact = artifacts.find((artifact) =>
    artifact.relative_path === "logs/stdout.log" || artifact.relative_path === "stdout.log"
  );
  const stderrArtifact = artifacts.find((artifact) =>
    artifact.relative_path === "logs/stderr.log" || artifact.relative_path === "stderr.log"
  );

  return {
    run_id: context.state.run_id,
    compiled_id: compiledId,
    ...(selectedExecutionId ? { selected_execution_id: selectedExecutionId } : {}),
    executions,
    ...(stdoutArtifact
      ? { stdout: await readTextArtifact(stdoutArtifact.absolute_path, selectedExecution!.execution_dir) }
      : {}),
    ...(stderrArtifact
      ? { stderr: await readTextArtifact(stderrArtifact.absolute_path, selectedExecution!.execution_dir) }
      : {}),
    artifacts
  };
}

export async function readProjectedArtifact(
  runRoot: string,
  compiledId: string,
  executionId: string,
  relativePath: string
): Promise<ProjectedArtifactRead> {
  const state = await readRunState(runRoot);
  const attempts = await readRunExecutionAttempts(runRoot);
  const execution = attempts.find(
    (attempt) => attempt.compiled_id === compiledId && attempt.execution_id === executionId
  );

  if (!execution) {
    throw new Error(`Unknown execution "${executionId}" for node "${compiledId}".`);
  }

  const normalizedRelativePath = relativePath.replace(/^\/+/, "");
  const artifacts = await indexExecutionArtifacts(execution);
  const artifact = artifacts.find((candidate) => candidate.relative_path === normalizedRelativePath);

  if (!artifact) {
    throw new Error(`Unknown artifact "${relativePath}" for execution "${executionId}".`);
  }

  const buffer = await readBinaryFile(artifact.absolute_path);
  const truncated = buffer.byteLength > maxTextArtifactBytes;
  const contentBuffer = truncated ? buffer.subarray(0, maxTextArtifactBytes) : buffer;

  return {
    run_id: state.run_id,
    compiled_id: execution.compiled_id,
    execution_id: executionId,
    artifact,
    content: contentBuffer.toString("utf8"),
    truncated
  };
}

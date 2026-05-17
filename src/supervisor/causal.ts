import type { CompiledExecutableNode, CompiledGraph } from "../graph/compiled.js";
import type { ContextItem } from "../graph/authored.js";
import { listAttemptsForCompiledNode, type AttemptRegistry, type RuntimeNodeAttempt } from "../runtime/attempts.js";
import type { RuntimeNodeExecutionResult } from "../runtime/core/engine.js";
import type { RuntimeNodeStatus } from "../runtime/session.js";
import type { SchedulerTopology } from "../runtime/core/scheduler.js";
import { getIncomingEdges, getOutgoingEdges } from "../runtime/core/scheduler.js";
import type { FailureClassification } from "./classifier.js";
import type { SupervisorRecoveryOperation } from "./types.js";

export interface SupervisorCausalConeNode {
  compiled_id: string;
  authored_id: string;
  kind: CompiledExecutableNode["kind"];
  distance: number;
  status?: RuntimeNodeStatus;
  latest_execution_id?: string;
  latest_outcome?: string;
  repo_alias: string;
  artifact_names: string[];
  context_artifact_refs: Array<{
    node: string;
    artifact: string;
  }>;
}

export interface SupervisorRecoveryTarget {
  operation: SupervisorRecoveryOperation;
  target_compiled_id: string;
  target_authored_id: string;
  target_kind: CompiledExecutableNode["kind"];
  confidence: "low" | "medium" | "high";
  reason: string;
  evidence: string[];
  resume_compiled_id: string;
  resume_authored_id: string;
  target_prior_execution_id?: string;
  symptom_compiled_id: string;
  symptom_authored_id: string;
  symptom_execution_id: string;
  requires_investigation: boolean;
}

export interface SupervisorCausalContext {
  symptom: {
    compiled_id: string;
    authored_id: string;
    kind: CompiledExecutableNode["kind"];
    execution_id: string;
    failure_class: string;
    summary: string;
  };
  upstream_cone: SupervisorCausalConeNode[];
  target_candidates: SupervisorRecoveryTarget[];
  selected_target: SupervisorRecoveryTarget;
}

function latestAttempt(attempts: AttemptRegistry, compiledId: string): RuntimeNodeAttempt | undefined {
  return listAttemptsForCompiledNode(attempts, compiledId).at(-1);
}

function contextArtifactRefs(items: ContextItem[]): Array<{ node: string; artifact: string }> {
  return items.flatMap((item) => {
    if ("node" in item && "artifact" in item) {
      return [{ node: item.node, artifact: item.artifact }];
    }
    return [];
  });
}

function nodeSummary(options: {
  graph: CompiledGraph;
  attempts: AttemptRegistry;
  node: CompiledExecutableNode;
  distance: number;
  nodeStatuses: Map<string, RuntimeNodeStatus>;
}): SupervisorCausalConeNode {
  const attempt = latestAttempt(options.attempts, options.node.compiled_id);
  return {
    compiled_id: options.node.compiled_id,
    authored_id: options.node.authored_id,
    kind: options.node.kind,
    distance: options.distance,
    ...(attempt ? { latest_execution_id: attempt.execution_id } : {}),
    ...(attempt?.outcome ? { latest_outcome: attempt.outcome } : {}),
    ...(options.nodeStatuses.get(options.node.compiled_id)
      ? { status: options.nodeStatuses.get(options.node.compiled_id)! }
      : {}),
    repo_alias: options.node.repo,
    artifact_names: Object.keys(options.node.declared_artifacts),
    context_artifact_refs: contextArtifactRefs(options.node.context)
  };
}

function collectUpstreamCone(options: {
  graph: CompiledGraph;
  topology: SchedulerTopology;
  attempts: AttemptRegistry;
  nodeStatuses: Map<string, RuntimeNodeStatus>;
  symptom: CompiledExecutableNode;
}): SupervisorCausalConeNode[] {
  const visited = new Set<string>([options.symptom.compiled_id]);
  const queue: Array<{ compiled_id: string; distance: number }> = getIncomingEdges(
    options.topology,
    options.symptom.compiled_id
  ).map((edge) => ({ compiled_id: edge.from, distance: 1 }));
  const cone: SupervisorCausalConeNode[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.compiled_id)) {
      continue;
    }
    visited.add(current.compiled_id);

    const node = options.topology.nodes_by_id.get(current.compiled_id);
    if (!node) {
      continue;
    }

    cone.push(nodeSummary({
      graph: options.graph,
      attempts: options.attempts,
      node,
      distance: current.distance,
      nodeStatuses: options.nodeStatuses
    }));

    for (const edge of getIncomingEdges(options.topology, current.compiled_id)) {
      queue.push({ compiled_id: edge.from, distance: current.distance + 1 });
    }
  }

  return cone.sort((left, right) => left.distance - right.distance || left.compiled_id.localeCompare(right.compiled_id));
}

function nearestUpstreamWorker(
  cone: SupervisorCausalConeNode[],
  topology: SchedulerTopology
): CompiledExecutableNode | undefined {
  const worker = cone.find((candidate) => candidate.kind === "agent" || candidate.kind === "exec");
  return worker ? topology.nodes_by_id.get(worker.compiled_id) : undefined;
}

function artifactProducerFromContext(options: {
  symptom: CompiledExecutableNode;
  graph: CompiledGraph;
  topology: SchedulerTopology;
}): CompiledExecutableNode | undefined {
  const ref = contextArtifactRefs(options.symptom.context)[0];
  if (!ref) {
    return undefined;
  }
  const compiledId = options.graph.authored_to_compiled[ref.node]?.[0];
  return compiledId ? options.topology.nodes_by_id.get(compiledId) : undefined;
}

function resultTimedOut(result: RuntimeNodeExecutionResult | undefined): boolean {
  const payload = result?.result;
  return typeof payload === "object" && payload !== null && "timed_out" in payload && payload.timed_out === true;
}

function makeTarget(options: {
  operation: SupervisorRecoveryOperation;
  target: CompiledExecutableNode;
  symptom: CompiledExecutableNode;
  attempt: RuntimeNodeAttempt;
  attempts: AttemptRegistry;
  confidence: "low" | "medium" | "high";
  reason: string;
  evidence: string[];
  requiresInvestigation?: boolean;
}): SupervisorRecoveryTarget {
  const targetAttempt = latestAttempt(options.attempts, options.target.compiled_id);
  return {
    operation: options.operation,
    target_compiled_id: options.target.compiled_id,
    target_authored_id: options.target.authored_id,
    target_kind: options.target.kind,
    confidence: options.confidence,
    reason: options.reason,
    evidence: options.evidence,
    resume_compiled_id: options.symptom.compiled_id,
    resume_authored_id: options.symptom.authored_id,
    ...(targetAttempt ? { target_prior_execution_id: targetAttempt.execution_id } : {}),
    symptom_compiled_id: options.symptom.compiled_id,
    symptom_authored_id: options.symptom.authored_id,
    symptom_execution_id: options.attempt.execution_id,
    requires_investigation: options.requiresInvestigation ?? false
  };
}

function classifyCurrentNodeOperation(classification: FailureClassification): SupervisorRecoveryOperation {
  if (classification.class === "graph_context_gap" || classification.class === "unprovable_requirement") {
    return "fail_contract_gap";
  }
  if (classification.class === "context_contract_failure" || classification.class === "missing_context") {
    return "repair_context";
  }
  if (classification.class === "artifact_contract_failure") {
    return "repair_artifact";
  }
  if (classification.evidence.workspace_repair_candidate === true) {
    return "repair_workspace";
  }
  if (classification.evidence.environment_repair_candidate === true) {
    return "repair_environment";
  }
  if (classification.class === "authority_required") {
    return "pause_for_authority";
  }
  if (classification.class === "policy_or_scope_risk") {
    return "fail_contract_gap";
  }
  return "repair_current_node";
}

function shouldConsiderArtifactProducer(options: {
  symptomNode: CompiledExecutableNode;
  classification: FailureClassification;
}): boolean {
  if (options.symptomNode.kind === "check") {
    return true;
  }

  return options.classification.class === "artifact_contract_failure"
    && options.symptomNode.kind !== "agent";
}

export function buildSupervisorCausalContext(options: {
  graph: CompiledGraph;
  topology: SchedulerTopology;
  attempts: AttemptRegistry;
  nodeStatuses: Map<string, RuntimeNodeStatus>;
  symptomNode: CompiledExecutableNode;
  symptomAttempt: RuntimeNodeAttempt;
  result?: RuntimeNodeExecutionResult;
  classification: FailureClassification;
  repeatedFingerprintCount: number;
}): SupervisorCausalContext {
  const upstreamCone = collectUpstreamCone({
    graph: options.graph,
    topology: options.topology,
    attempts: options.attempts,
    nodeStatuses: options.nodeStatuses,
    symptom: options.symptomNode
  });
  const candidates: SupervisorRecoveryTarget[] = [];
  const currentOperation = classifyCurrentNodeOperation(options.classification);

  candidates.push(makeTarget({
    operation: currentOperation,
    target: options.symptomNode,
    symptom: options.symptomNode,
    attempt: options.symptomAttempt,
    attempts: options.attempts,
    confidence: currentOperation === "pause_for_authority" ? "high" : "medium",
    reason: "The failed node remains a valid recovery target because it owns the immediate failed attempt.",
    evidence: [
      `Failure class: ${options.classification.class}`,
      `Failure summary: ${options.classification.summary}`
    ],
    requiresInvestigation: options.repeatedFingerprintCount >= 2
  }));

  const artifactProducer = shouldConsiderArtifactProducer({
    symptomNode: options.symptomNode,
    classification: options.classification
  })
    ? artifactProducerFromContext({
        symptom: options.symptomNode,
        graph: options.graph,
        topology: options.topology
      })
    : undefined;
  if (artifactProducer) {
    candidates.push(makeTarget({
      operation: "repair_artifact",
      target: artifactProducer,
      symptom: options.symptomNode,
      attempt: options.symptomAttempt,
      attempts: options.attempts,
      confidence: "medium",
      reason: "The failed node consumed an upstream artifact, so the producer may be the causal source.",
      evidence: contextArtifactRefs(options.symptomNode.context).map((ref) => `Context artifact ref: ${ref.node}.${ref.artifact}`),
      requiresInvestigation: options.repeatedFingerprintCount >= 2
    }));
  }

  if (
    options.symptomNode.kind === "check"
    && !resultTimedOut(options.result)
    && options.classification.class !== "policy_or_scope_risk"
  ) {
    const upstreamWorker = nearestUpstreamWorker(upstreamCone, options.topology);
    if (upstreamWorker) {
      candidates.push(makeTarget({
        operation: "repair_upstream_node",
        target: upstreamWorker,
        symptom: options.symptomNode,
        attempt: options.symptomAttempt,
        attempts: options.attempts,
        confidence: "high",
        reason: "The check is a detector. Its failure most likely points to the nearest upstream worker that produced the checked state.",
        evidence: [
          `Failed check goal: ${options.symptomNode.intent.goal}`,
          `Nearest upstream worker: ${upstreamWorker.authored_id}`
        ],
        requiresInvestigation: options.repeatedFingerprintCount >= 2
      }));
    }
  }

  const selected =
    candidates.find((candidate) => candidate.operation === "repair_upstream_node")
    ?? candidates.find((candidate) => candidate.operation === "repair_artifact" && candidate.target_compiled_id !== options.symptomNode.compiled_id)
    ?? candidates[0]!;

  if (options.repeatedFingerprintCount >= 2 && selected.operation !== "pause_for_authority") {
    selected.requires_investigation = true;
    selected.evidence = [
      ...selected.evidence,
      "Repeated fingerprint: widen causal search and change tactic before another repair."
    ];
  }

  return {
    symptom: {
      compiled_id: options.symptomNode.compiled_id,
      authored_id: options.symptomNode.authored_id,
      kind: options.symptomNode.kind,
      execution_id: options.symptomAttempt.execution_id,
      failure_class: options.classification.class,
      summary: options.classification.summary
    },
    upstream_cone: upstreamCone,
    target_candidates: candidates,
    selected_target: selected
  };
}

export function collectDownstreamCone(options: {
  topology: SchedulerTopology;
  startCompiledId: string;
}): string[] {
  const visited = new Set<string>();
  const queue = [options.startCompiledId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of getOutgoingEdges(options.topology, current)) {
      if (visited.has(edge.to)) {
        continue;
      }
      visited.add(edge.to);
      queue.push(edge.to);
    }
  }

  return [...visited];
}

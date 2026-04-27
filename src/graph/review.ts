import type {
  AuthoredGraphDocument,
  AuthoredGraphNode,
  ContainerGraphNode,
  ExecutableGraphNode
} from "./authored.js";
import type {
  CompiledAgentNode,
  CompiledExecutableNode,
  CompiledGraph,
  CompiledScope
} from "./compiled.js";
import { reservedArtifactNames } from "./schema.js";

export type GraphReviewMode = "standard" | "review" | "strict-review";
export type GraphReviewSeverity = "info" | "warning" | "serious";

export interface GraphReviewFinding {
  severity: GraphReviewSeverity;
  category:
    | "artifact_contract"
    | "context"
    | "handoff"
    | "intent"
    | "node_purpose"
    | "parallel"
    | "repeat"
    | "supervision"
    | "tool_policy"
    | "verification";
  message: string;
  recommendation: string;
  path?: string;
  node_id?: string;
  compiled_id?: string;
}

export interface GraphReviewArtifactConsumer {
  node_id: string;
  context_name: string;
  path?: string;
}

export interface GraphReviewArtifactHandoff {
  producer_node_id: string;
  artifact: string;
  automatic_artifact: boolean;
  consumers: GraphReviewArtifactConsumer[];
}

export interface GraphReviewReport {
  mode: GraphReviewMode;
  status: "passed" | "warnings" | "serious_findings";
  summary: {
    finding_count: number;
    serious_count: number;
    warning_count: number;
    info_count: number;
    reviewed_node_count: number;
    artifact_handoff_count: number;
  };
  findings: GraphReviewFinding[];
  artifact_handoffs: GraphReviewArtifactHandoff[];
}

interface AuthoredNodeMetadata {
  node: AuthoredGraphNode;
  path: string;
  parent_scope_ids: string[];
  nearest_repeat_id?: string;
}

const implementationIntentPattern =
  /\b(implement|ship|fix|change|update|refactor|build|generate|patch|feature|bug|release)\b/i;
const credentialToolDescription = "credential-backed";
const automaticArtifactNames = new Set<string>(reservedArtifactNames);

function isExecutableNode(node: AuthoredGraphNode): node is ExecutableGraphNode {
  return node.type === "agent" || node.type === "exec" || node.type === "check" || node.type === "checkpoint";
}

function visitAuthoredNodes(
  node: AuthoredGraphNode,
  visit: (node: AuthoredGraphNode, metadata: AuthoredNodeMetadata) => void,
  path: string,
  parent_scope_ids: string[] = [],
  nearest_repeat_id?: string
): void {
  visit(node, {
    node,
    path,
    parent_scope_ids,
    ...(nearest_repeat_id ? { nearest_repeat_id } : {})
  });

  if (node.type === "sequence" || node.type === "parallel") {
    node.steps.forEach((child, index) => {
      visitAuthoredNodes(
        child,
        visit,
        `${path}.steps[${index}]`,
        [...parent_scope_ids, node.id],
        nearest_repeat_id
      );
    });

    if (node.type === "sequence") {
      node.cleanup?.forEach((child, index) => {
        visitAuthoredNodes(
          child,
          visit,
          `${path}.cleanup[${index}]`,
          [...parent_scope_ids, node.id],
          nearest_repeat_id
        );
      });
    }
    return;
  }

  if (node.type === "repeat") {
    visitAuthoredNodes(
      node.body,
      visit,
      `${path}.body`,
      [...parent_scope_ids, node.id],
      node.id
    );
  }
}

function collectAuthoredMetadata(root: ContainerGraphNode): Map<string, AuthoredNodeMetadata> {
  const metadataById = new Map<string, AuthoredNodeMetadata>();

  visitAuthoredNodes(root, (node, metadata) => {
    metadataById.set(node.id, metadata);
  }, "$.graph");

  return metadataById;
}

function hasText(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function hasAnyText(values: string[] | undefined): boolean {
  return (values ?? []).some((value) => value.trim().length > 0);
}

function pathForNode(
  authoredMetadata: Map<string, AuthoredNodeMetadata>,
  node: CompiledExecutableNode
): string | undefined {
  return authoredMetadata.get(node.authored_id)?.path;
}

function isHighImpactTool(tool: CompiledAgentNode["tools"][number]): boolean {
  return (tool.credentials ?? []).length > 0;
}

function nodeHasExplicitConstraint(document: AuthoredGraphDocument, node: CompiledExecutableNode): boolean {
  return hasAnyText(document.intent.constraints) || hasAnyText(node.constraints);
}

function isWriteCapable(node: CompiledExecutableNode): boolean {
  return node.effective_policy.sandbox === "workspace-write" || node.effective_policy.sandbox === "danger-full-access";
}

function isImplementationGraph(document: AuthoredGraphDocument, graph: CompiledGraph): boolean {
  const text = [
    document.intent.goal,
    ...(document.intent.acceptance_criteria ?? []),
    ...graph.nodes.map((node) => node.goal ?? "")
  ].join("\n");

  return implementationIntentPattern.test(text);
}

function pushFinding(
  findings: GraphReviewFinding[],
  finding: GraphReviewFinding
): void {
  findings.push(finding);
}

function reviewIntent(document: AuthoredGraphDocument, findings: GraphReviewFinding[]): void {
  if (document.intent.goal.trim().split(/\s+/).length < 5) {
    pushFinding(findings, {
      severity: "warning",
      category: "intent",
      path: "$.intent.goal",
      message: "Graph intent goal is very short.",
      recommendation: "State the concrete outcome and review boundary the run should produce."
    });
  }

  if (!hasAnyText(document.intent.acceptance_criteria)) {
    pushFinding(findings, {
      severity: "serious",
      category: "intent",
      path: "$.intent.acceptance_criteria",
      message: "Graph intent has no acceptance criteria.",
      recommendation: "Add top-level acceptance criteria so validation, supervision, and reviewers share the same success bar."
    });
  }

  if (!hasAnyText(document.intent.constraints)) {
    pushFinding(findings, {
      severity: "warning",
      category: "intent",
      path: "$.intent.constraints",
      message: "Graph intent has no explicit constraints.",
      recommendation: "Add scope, authority, and out-of-scope constraints before launching substantial work."
    });
  }
}

function reviewExecutableNode(
  document: AuthoredGraphDocument,
  node: CompiledExecutableNode,
  authoredMetadata: Map<string, AuthoredNodeMetadata>,
  findings: GraphReviewFinding[],
  options: { fullReview: boolean }
): void {
  const path = pathForNode(authoredMetadata, node);
  const declaredArtifactCount = Object.keys(node.declared_artifacts).length;

  if (node.kind === "agent" && declaredArtifactCount === 0) {
    pushFinding(findings, {
      severity: "serious",
      category: "artifact_contract",
      ...(path ? { path: `${path}.artifacts` } : {}),
      node_id: node.authored_id,
      compiled_id: node.compiled_id,
      message: `Agent node "${node.authored_id}" does not declare a durable artifact.`,
      recommendation: "Declare at least one named handoff artifact from the output directory or workspace."
    });
  }

  if (
    (node.kind === "agent" || (node.kind === "check" && node.check_kind === "ai")) &&
    !hasAnyText(node.acceptance_criteria)
  ) {
    pushFinding(findings, {
      severity: "warning",
      category: "node_purpose",
      ...(path ? { path: `${path}.acceptance_criteria` } : {}),
      node_id: node.authored_id,
      compiled_id: node.compiled_id,
      message: `${node.kind === "agent" ? "Agent" : "AI check"} node "${node.authored_id}" has no node-level acceptance criteria.`,
      recommendation: "Add node acceptance criteria that define the artifact quality or evaluation bar for this node."
    });
  }

  if (node.kind === "agent") {
    const highImpactTools = node.tools.filter(isHighImpactTool);
    if (highImpactTools.length > 0 && !nodeHasExplicitConstraint(document, node)) {
      pushFinding(findings, {
        severity: "serious",
        category: "tool_policy",
        ...(path ? { path: `${path}.tools` } : {}),
        node_id: node.authored_id,
        compiled_id: node.compiled_id,
        message: `Agent node "${node.authored_id}" grants ${credentialToolDescription} tools without explicit constraints.`,
        recommendation: "Add graph or node constraints that bound the approved credential use and any external or mutating behavior described by the tool."
      });
    }
  }

  if (!options.fullReview) {
    return;
  }

  if ((node.kind === "agent" || node.kind === "check") && !hasText(node.goal)) {
    pushFinding(findings, {
      severity: "warning",
      category: "node_purpose",
      ...(path ? { path: `${path}.goal` } : {}),
      node_id: node.authored_id,
      compiled_id: node.compiled_id,
      message: `Node "${node.authored_id}" has no explicit goal.`,
      recommendation: "Give each agent or semantic check node a concrete outcome-oriented goal."
    });
  }

  if (node.context.length > 12) {
    pushFinding(findings, {
      severity: "warning",
      category: "context",
      ...(path ? { path: `${path}.context` } : {}),
      node_id: node.authored_id,
      compiled_id: node.compiled_id,
      message: `Node "${node.authored_id}" receives ${node.context.length} context items.`,
      recommendation: "Trim context to the files, prior artifacts, and short text needed for the node outcome."
    });
  }

  node.context.forEach((item, index) => {
    if ("from" in item && item.from === "workspace_glob" && item.max_files === undefined) {
      pushFinding(findings, {
        severity: "warning",
        category: "context",
        ...(path ? { path: `${path}.context[${index}].max_files` } : {}),
        node_id: node.authored_id,
        compiled_id: node.compiled_id,
        message: `Node "${node.authored_id}" uses workspace_glob "${item.path}" without max_files.`,
        recommendation: "Add max_files or replace the glob with narrower file context."
      });
    }

    if ("from" in item && item.from === "workspace_glob" && item.max_files !== undefined && item.max_files > 100) {
      pushFinding(findings, {
        severity: "warning",
        category: "context",
        ...(path ? { path: `${path}.context[${index}].max_files` } : {}),
        node_id: node.authored_id,
        compiled_id: node.compiled_id,
        message: `Node "${node.authored_id}" allows ${item.max_files} files from workspace_glob "${item.path}".`,
        recommendation: "Lower max_files or split the work so the node receives focused context."
      });
    }

    if ("from" in item && item.from === "text" && item.text.length > 8000) {
      pushFinding(findings, {
        severity: "warning",
        category: "context",
        ...(path ? { path: `${path}.context[${index}].text` } : {}),
        node_id: node.authored_id,
        compiled_id: node.compiled_id,
        message: `Node "${node.authored_id}" has a long inline text context item.`,
        recommendation: "Move large context into a named file or artifact so provenance stays readable."
      });
    }

    if ("ref" in item && automaticArtifactNames.has(item.artifact)) {
      pushFinding(findings, {
        severity: "warning",
        category: "handoff",
        ...(path ? { path: `${path}.context[${index}].ref` } : {}),
        node_id: node.authored_id,
        compiled_id: node.compiled_id,
        message: `Node "${node.authored_id}" consumes automatic artifact "${item.node}.${item.artifact}".`,
        recommendation: "Prefer a named declared artifact for durable downstream handoffs."
      });
    }
  });
}

function reviewVerification(
  document: AuthoredGraphDocument,
  graph: CompiledGraph,
  findings: GraphReviewFinding[],
  options: { fullReview: boolean }
): void {
  const checkNodes = graph.nodes.filter((node) => node.kind === "check");
  const hasAgent = graph.nodes.some((node) => node.kind === "agent");
  const implementationGraph = isImplementationGraph(document, graph);

  if (hasAgent && checkNodes.length === 0) {
    pushFinding(findings, {
      severity: implementationGraph ? "serious" : "warning",
      category: "verification",
      path: "$.graph",
      message: implementationGraph
        ? "Implementation-oriented graph has no check node."
        : "Graph has agent work but no check node.",
      recommendation: "Add deterministic checks for hard facts and AI checks only when semantic judgment is needed."
    });
  }

  if (!options.fullReview || checkNodes.length === 0) {
    return;
  }

  if (checkNodes.every((node) => node.on_failure === "continue")) {
    pushFinding(findings, {
      severity: implementationGraph ? "serious" : "warning",
      category: "verification",
      path: "$.graph",
      message: "Every check node is configured with on_failure = continue.",
      recommendation: "Keep at least one hard verification gate for implementation graphs."
    });
  }
}

function reviewRepeatAndParallel(
  graph: CompiledGraph,
  authoredMetadata: Map<string, AuthoredNodeMetadata>,
  findings: GraphReviewFinding[]
): void {
  const nodesById = new Map(graph.nodes.map((node) => [node.compiled_id, node]));

  graph.scopes.forEach((scope) => {
    if (scope.kind === "repeat") {
      const path = authoredMetadata.get(scope.authored_id)?.path;

      if (scope.max_attempts <= 1) {
        pushFinding(findings, {
          severity: "warning",
          category: "repeat",
          ...(path ? { path: `${path}.max_attempts` } : {}),
          node_id: scope.authored_id,
          message: `Repeat scope "${scope.authored_id}" has max_attempts = ${scope.max_attempts}.`,
          recommendation: "Use a sequence when no retry loop is intended, or allow at least two attempts."
        });
      }

      if (scope.max_attempts > 10) {
        pushFinding(findings, {
          severity: "warning",
          category: "repeat",
          ...(path ? { path: `${path}.max_attempts` } : {}),
          node_id: scope.authored_id,
          message: `Repeat scope "${scope.authored_id}" allows ${scope.max_attempts} attempts.`,
          recommendation: "Keep retry loops tightly bounded and use checkpoints when human judgment is expected."
        });
      }
    }

    if (scope.kind === "parallel") {
      reviewParallelScope(scope, nodesById, authoredMetadata, findings);
    }
  });
}

function reviewParallelScope(
  scope: CompiledScope,
  nodesById: Map<string, CompiledExecutableNode>,
  authoredMetadata: Map<string, AuthoredNodeMetadata>,
  findings: GraphReviewFinding[]
): void {
  if (scope.kind !== "parallel") {
    return;
  }

  const writeCapableNodes = scope.compiled_node_ids
    .map((compiledId) => nodesById.get(compiledId))
    .filter((node): node is CompiledExecutableNode => Boolean(node))
    .filter((node) => isWriteCapable(node) && node.kind !== "check");
  const nodesWithoutArtifacts = writeCapableNodes.filter(
    (node) => Object.keys(node.declared_artifacts).length === 0
  );

  if (writeCapableNodes.length >= 2 && nodesWithoutArtifacts.length > 0) {
    const path = authoredMetadata.get(scope.authored_id)?.path;
    pushFinding(findings, {
      severity: "warning",
      category: "parallel",
      ...(path ? { path } : {}),
      node_id: scope.authored_id,
      message: `Parallel scope "${scope.authored_id}" has multiple write-capable nodes and ${nodesWithoutArtifacts.length} node(s) without artifact boundaries.`,
      recommendation: "Declare handoff artifacts on parallel write branches so downstream review can see branch ownership."
    });
  }
}

function reviewSupervision(
  graph: CompiledGraph,
  findings: GraphReviewFinding[]
): void {
  const { supervision } = graph;

  if (supervision.max_total_interventions === 0) {
    pushFinding(findings, {
      severity: "warning",
      category: "supervision",
      path: "$.supervision.max_total_interventions",
      message: "Supervisor total intervention budget is zero.",
      recommendation: "Keep at least one bounded intervention available unless this graph intentionally forbids recovery."
    });
  }

  if (supervision.max_total_interventions > 15) {
    pushFinding(findings, {
      severity: "warning",
      category: "supervision",
      path: "$.supervision.max_total_interventions",
      message: `Supervisor total intervention budget is unusually high (${supervision.max_total_interventions}).`,
      recommendation: "Lower the budget or add checkpoints so repeated recovery does not mask task drift."
    });
  }

  Object.entries(supervision.actions).forEach(([action, policy]) => {
    if (!policy) {
      return;
    }

    if (policy.max_uses > 5) {
      pushFinding(findings, {
        severity: "warning",
        category: "supervision",
        path: `$.supervision.actions.${action}.max_uses`,
        message: `Supervisor action "${action}" allows ${policy.max_uses} uses.`,
        recommendation: "Keep individual recovery actions tightly bounded and prefer explicit graph checkpoints for major decisions."
      });
    }
  });
}

function buildArtifactHandoffs(graph: CompiledGraph): GraphReviewArtifactHandoff[] {
  const handoffs = new Map<string, GraphReviewArtifactHandoff>();

  function key(nodeId: string, artifact: string): string {
    return `${nodeId}.${artifact}`;
  }

  function ensureHandoff(nodeId: string, artifact: string): GraphReviewArtifactHandoff {
    const handoffKey = key(nodeId, artifact);
    const existing = handoffs.get(handoffKey);
    if (existing) {
      return existing;
    }

    const handoff: GraphReviewArtifactHandoff = {
      producer_node_id: nodeId,
      artifact,
      automatic_artifact: automaticArtifactNames.has(artifact),
      consumers: []
    };
    handoffs.set(handoffKey, handoff);
    return handoff;
  }

  graph.nodes.forEach((node) => {
    Object.keys(node.declared_artifacts).forEach((artifact) => {
      ensureHandoff(node.authored_id, artifact);
    });
  });

  graph.nodes.forEach((consumerNode) => {
    consumerNode.context.forEach((item, index) => {
      if (!("ref" in item)) {
        return;
      }

      ensureHandoff(item.node, item.artifact).consumers.push({
        node_id: consumerNode.authored_id,
        context_name: item.name,
        path: `${consumerNode.authored_id}.context[${index}]`
      });
    });
  });

  return [...handoffs.values()].sort((left, right) => {
    const leftKey = `${left.producer_node_id}.${left.artifact}`;
    const rightKey = `${right.producer_node_id}.${right.artifact}`;
    return leftKey.localeCompare(rightKey);
  });
}

export function reviewCompiledGraph(
  document: AuthoredGraphDocument,
  graph: CompiledGraph,
  options: { mode?: GraphReviewMode } = {}
): GraphReviewReport {
  const mode = options.mode ?? "standard";
  const fullReview = mode === "review" || mode === "strict-review";
  const findings: GraphReviewFinding[] = [];
  const authoredMetadata = collectAuthoredMetadata(document.graph);

  reviewIntent(document, findings);

  graph.nodes.forEach((node) => {
    reviewExecutableNode(document, node, authoredMetadata, findings, { fullReview });
  });
  reviewVerification(document, graph, findings, { fullReview });
  reviewRepeatAndParallel(graph, authoredMetadata, findings);
  reviewSupervision(graph, findings);

  const artifactHandoffs = buildArtifactHandoffs(graph);
  const seriousCount = findings.filter((finding) => finding.severity === "serious").length;
  const warningCount = findings.filter((finding) => finding.severity === "warning").length;
  const infoCount = findings.filter((finding) => finding.severity === "info").length;

  return {
    mode,
    status: seriousCount > 0 ? "serious_findings" : warningCount > 0 ? "warnings" : "passed",
    summary: {
      finding_count: findings.length,
      serious_count: seriousCount,
      warning_count: warningCount,
      info_count: infoCount,
      reviewed_node_count: graph.nodes.length,
      artifact_handoff_count: artifactHandoffs.length
    },
    findings,
    artifact_handoffs: artifactHandoffs
  };
}

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
import { managedPatternKinds, reservedArtifactNames } from "./schema.js";

export type GraphReviewMode = "review" | "strict";
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
    | "prompt_surface"
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
const managedPhaseNames = ["plan", "execute", "verify", "publish"] as const;

function managedRootFromInternalAuthoredId(authoredId: string): string | undefined {
  for (const managedKind of managedPatternKinds) {
    const marker = `__managed__${managedKind}__`;
    const markerIndex = authoredId.indexOf(marker);
    if (markerIndex !== -1) {
      return authoredId.slice(0, markerIndex);
    }
  }
  return undefined;
}

function isSameManagedInternalHandoff(consumerNode: CompiledExecutableNode, producerNodeId: string): boolean {
  const producerRoot = managedRootFromInternalAuthoredId(producerNodeId);
  if (!producerRoot) {
    return false;
  }

  const consumerInternalRoot = managedRootFromInternalAuthoredId(consumerNode.authored_id);
  if (consumerInternalRoot) {
    return consumerInternalRoot === producerRoot;
  }

  return consumerNode.lowered_from !== undefined && consumerNode.authored_id === producerRoot;
}

interface PromptSurfaceField {
  path: string;
  text: string;
  severity: "serious" | "warning";
  audience: string;
}

const promptSurfaceLeakPatterns: Array<{ label: string; pattern: RegExp }> = [
  { label: "this graph", pattern: /\bthis graph\b/iu },
  { label: "the graph should", pattern: /\bthe graph should\b/iu },
  { label: "downstream node", pattern: /\bdownstream nodes?\b/iu },
  { label: "compiled prompt", pattern: /\bcompiled prompts?\b/iu },
  { label: "graph topology", pattern: /\bgraph topology\b/iu },
  { label: "pattern_deep_research", pattern: /\bpattern_deep_research\b/iu },
  { label: "pattern_deep_work", pattern: /\bpattern_deep_work\b/iu },
  { label: "pattern_work_list", pattern: /\bpattern_work_list\b/iu },
  { label: "pattern_map_reduce", pattern: /\bpattern_map_reduce\b/iu },
  { label: "pattern_candidate_selection", pattern: /\bpattern_candidate_selection\b/iu },
  { label: "managed pattern mechanics", pattern: /\b(?:this|the|a)\s+managed pattern\b/iu },
  { label: "private angle report", pattern: /\bprivate angle report\b/iu },
  { label: "synthesis node", pattern: /\bsynthesis node\b/iu },
  { label: "as public", pattern: /\bas public\b/iu },
  { label: "af artifact write", pattern: /\baf artifact write\b/iu },
  { label: "af complete check", pattern: /\baf complete check\b/iu },
  { label: "graph-addressable artifact", pattern: /\bgraph-addressable artifacts?\b/iu },
  { label: "use this node to", pattern: /\buse this node to\b/iu },
  { label: "this prompt will", pattern: /\bthis prompt will\b/iu }
];

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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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
  return hasAnyText(document.intent.constraints) || hasAnyText(node.intent.constraints);
}

function isWriteCapable(node: CompiledExecutableNode): boolean {
  return node.effective_policy.sandbox === "workspace-write" || node.effective_policy.sandbox === "danger-full-access";
}

function isImplementationGraph(document: AuthoredGraphDocument, graph: CompiledGraph): boolean {
  const text = [
    document.intent.goal,
    ...(document.intent.acceptance_criteria ?? []),
    ...graph.nodes.map((node) => node.intent.goal ?? "")
  ].join("\n");

  return implementationIntentPattern.test(text);
}

function pushFinding(
  findings: GraphReviewFinding[],
  finding: GraphReviewFinding
): void {
  findings.push(finding);
}

function addPromptSurfaceString(
  fields: PromptSurfaceField[],
  value: unknown,
  path: string,
  options: {
    severity: "serious" | "warning";
    audience: string;
  }
): void {
  if (typeof value === "string" && value.trim().length > 0) {
    fields.push({
      path,
      text: value,
      severity: options.severity,
      audience: options.audience
    });
  }
}

function addPromptSurfaceStringArray(
  fields: PromptSurfaceField[],
  value: unknown,
  path: string,
  options: {
    severity: "serious" | "warning";
    audience: string;
  }
): void {
  if (!Array.isArray(value)) {
    return;
  }

  value.forEach((item, index) => {
    addPromptSurfaceString(fields, item, `${path}[${index}]`, options);
  });
}

function addPromptSurfaceIntentFields(
  fields: PromptSurfaceField[],
  value: unknown,
  path: string,
  options: {
    goalSeverity: "serious" | "warning";
    detailSeverity: "serious" | "warning";
    audience: string;
  }
): void {
  const intent = asRecord(value);
  if (!intent) {
    return;
  }

  addPromptSurfaceString(fields, intent.goal, `${path}.goal`, {
    severity: options.goalSeverity,
    audience: options.audience
  });
  addPromptSurfaceStringArray(fields, intent.acceptance_criteria, `${path}.acceptance_criteria`, {
    severity: options.detailSeverity,
    audience: options.audience
  });
  addPromptSurfaceStringArray(fields, intent.constraints, `${path}.constraints`, {
    severity: options.detailSeverity,
    audience: options.audience
  });
}

function addPromptSurfaceArtifacts(
  fields: PromptSurfaceField[],
  value: unknown,
  path: string
): void {
  const artifacts = asRecord(value);
  if (!artifacts) {
    return;
  }

  Object.entries(artifacts).forEach(([artifactName, artifactValue]) => {
    const artifact = asRecord(artifactValue);
    if (!artifact) {
      return;
    }
    addPromptSurfaceString(fields, artifact.description, `${path}.${artifactName}.description`, {
      severity: "warning",
      audience: "artifact publisher, verifier, and reviewer"
    });
  });
}

function addPromptSurfaceSupport(
  fields: PromptSurfaceField[],
  value: unknown,
  path: string
): void {
  const support = asRecord(value);
  const context = Array.isArray(support?.context) ? support.context : [];

  context.forEach((item, index) => {
    const contextItem = asRecord(item);
    if (!contextItem) {
      return;
    }
    addPromptSurfaceString(fields, contextItem.what, `${path}.context[${index}].what`, {
      severity: "warning",
      audience: "context reader"
    });
    addPromptSurfaceString(fields, contextItem.why, `${path}.context[${index}].why`, {
      severity: "warning",
      audience: "context reader"
    });
  });
}

function addPromptSurfaceCriteriaRubrics(
  fields: PromptSurfaceField[],
  value: unknown,
  path: string,
  audience: string
): void {
  if (!Array.isArray(value)) {
    return;
  }

  value.forEach((item, index) => {
    const criterion = asRecord(item);
    if (!criterion) {
      return;
    }
    addPromptSurfaceString(fields, criterion.rubric, `${path}[${index}].rubric`, {
      severity: "serious",
      audience
    });
  });
}

function collectPromptSurfaceFieldsFromNode(
  fields: PromptSurfaceField[],
  value: unknown,
  path: string
): void {
  const node = asRecord(value);
  if (!node) {
    return;
  }

  addPromptSurfaceString(fields, node.label, `${path}.label`, {
    severity: "warning",
    audience: "operator-facing node label"
  });

  const type = typeof node.type === "string" ? node.type : "";
  if (type === "sequence" || type === "parallel") {
    const steps = Array.isArray(node.steps) ? node.steps : [];
    steps.forEach((child, index) => collectPromptSurfaceFieldsFromNode(fields, child, `${path}.steps[${index}]`));

    if (type === "sequence" && Array.isArray(node.cleanup)) {
      node.cleanup.forEach((child, index) =>
        collectPromptSurfaceFieldsFromNode(fields, child, `${path}.cleanup[${index}]`)
      );
    }
    return;
  }

  if (type === "repeat") {
    collectPromptSurfaceFieldsFromNode(fields, node.body, `${path}.body`);
    return;
  }

  addPromptSurfaceIntentFields(fields, node.intent, `${path}.intent`, {
    goalSeverity: "serious",
    detailSeverity: "warning",
    audience: "executing node"
  });
  addPromptSurfaceSupport(fields, node.support, `${path}.support`);
  addPromptSurfaceArtifacts(fields, node.artifacts, `${path}.artifacts`);

  addPromptSurfaceString(fields, node.rubric, `${path}.rubric`, {
    severity: "serious",
    audience: "AI check evaluator"
  });

  if (type === "pattern_deep_research") {
    const research = asRecord(node.research);
    const angles = Array.isArray(research?.angles) ? research.angles : [];
    angles.forEach((angle, index) => {
      if (typeof angle === "string") {
        addPromptSurfaceString(fields, angle, `${path}.research.angles[${index}]`, {
          severity: "serious",
          audience: "research angle worker"
        });
        return;
      }

      const angleRecord = asRecord(angle);
      if (!angleRecord) {
        return;
      }
      addPromptSurfaceString(fields, angleRecord.prompt, `${path}.research.angles[${index}].prompt`, {
        severity: "serious",
        audience: "research angle worker"
      });
    });
  }

  if (type === "pattern_deep_work") {
    const completion = asRecord(node.completion);
    addPromptSurfaceCriteriaRubrics(
      fields,
      completion?.criteria,
      `${path}.completion.criteria`,
      "deep-work criterion evaluator"
    );

    const phases = asRecord(node.phases);
    if (phases) {
      for (const phase of managedPhaseNames) {
        const phaseRecord = asRecord(phases[phase]);
        if (!phaseRecord) {
          continue;
        }
        addPromptSurfaceIntentFields(fields, phaseRecord.intent, `${path}.phases.${phase}.intent`, {
          goalSeverity: "serious",
          detailSeverity: "serious",
          audience: `deep-work ${phase} phase`
        });
        addPromptSurfaceSupport(fields, phaseRecord.support, `${path}.phases.${phase}.support`);
      }
    }
  }

  if (type === "pattern_work_list") {
    const workList = asRecord(node.work_list);
    addPromptSurfaceString(fields, workList?.planning_goal, `${path}.work_list.planning_goal`, {
      severity: "serious",
      audience: "work-list planner"
    });

    const itemGuidance = asRecord(workList?.item_guidance);
    addPromptSurfaceString(
      fields,
      itemGuidance?.what_counts_as_one_item,
      `${path}.work_list.item_guidance.what_counts_as_one_item`,
      {
        severity: "serious",
        audience: "work-list planner and item worker"
      }
    );
    addPromptSurfaceStringArray(fields, itemGuidance?.done_when, `${path}.work_list.item_guidance.done_when`, {
      severity: "serious",
      audience: "work-list item worker and verifier"
    });

    const itemWorker = asRecord(workList?.item_worker);
    const itemCompletion = asRecord(itemWorker?.completion);
    addPromptSurfaceCriteriaRubrics(
      fields,
      itemCompletion?.criteria,
      `${path}.work_list.item_worker.completion.criteria`,
      "work-list item criterion evaluator"
    );
    const itemPhases = asRecord(itemWorker?.phases);
    if (itemPhases) {
      for (const phase of managedPhaseNames) {
        const phaseRecord = asRecord(itemPhases[phase]);
        if (!phaseRecord) {
          continue;
        }
        addPromptSurfaceIntentFields(fields, phaseRecord.intent, `${path}.work_list.item_worker.phases.${phase}.intent`, {
          goalSeverity: "serious",
          detailSeverity: "serious",
          audience: `work-list item ${phase} phase`
        });
        addPromptSurfaceSupport(fields, phaseRecord.support, `${path}.work_list.item_worker.phases.${phase}.support`);
      }
    }
  }

  if (type === "pattern_map_reduce") {
    const mapReduce = asRecord(node.map_reduce);
    const items = asRecord(mapReduce?.items);
    const map = asRecord(mapReduce?.map);
    const reduce = asRecord(mapReduce?.reduce);

    addPromptSurfaceIntentFields(fields, items?.intent, `${path}.map_reduce.items.intent`, {
      goalSeverity: "serious",
      detailSeverity: "serious",
      audience: "map-reduce item planner"
    });
    addPromptSurfaceIntentFields(fields, map?.intent, `${path}.map_reduce.map.intent`, {
      goalSeverity: "serious",
      detailSeverity: "serious",
      audience: "map-reduce item worker"
    });
    addPromptSurfaceIntentFields(fields, reduce?.intent, `${path}.map_reduce.reduce.intent`, {
      goalSeverity: "serious",
      detailSeverity: "serious",
      audience: "map-reduce reducer"
    });
  }

  if (type === "pattern_candidate_selection") {
    const selection = asRecord(node.selection);
    const candidates = Array.isArray(selection?.candidates) ? selection.candidates : [];
    candidates.forEach((candidate, index) => {
      const candidateRecord = asRecord(candidate);
      if (!candidateRecord) {
        return;
      }
      addPromptSurfaceIntentFields(fields, candidateRecord.intent, `${path}.selection.candidates[${index}].intent`, {
        goalSeverity: "serious",
        detailSeverity: "serious",
        audience: "candidate strategy worker"
      });
    });

    const criteria = Array.isArray(selection?.criteria) ? selection.criteria : [];
    criteria.forEach((criterion, index) => {
      const criterionRecord = asRecord(criterion);
      if (!criterionRecord) {
        return;
      }
      addPromptSurfaceString(fields, criterionRecord.rubric, `${path}.selection.criteria[${index}].rubric`, {
        severity: "serious",
        audience: "candidate criterion evaluator"
      });
    });
  }
}

function collectPromptSurfaceFields(value: unknown): PromptSurfaceField[] {
  const document = asRecord(value);
  if (!document) {
    return [];
  }

  const fields: PromptSurfaceField[] = [];
  addPromptSurfaceIntentFields(fields, document.intent, "$.intent", {
    goalSeverity: "serious",
    detailSeverity: "warning",
    audience: "all executable nodes"
  });
  collectPromptSurfaceFieldsFromNode(fields, document.graph, "$.graph");
  return fields;
}

function findPromptSurfaceLeak(text: string): { label: string } | undefined {
  for (const { label, pattern } of promptSurfaceLeakPatterns) {
    if (pattern.test(text)) {
      return { label };
    }
  }
  return undefined;
}

function reviewPromptSurface(
  value: unknown,
  findings: GraphReviewFinding[]
): void {
  for (const field of collectPromptSurfaceFields(value)) {
    const leak = findPromptSurfaceLeak(field.text);
    if (!leak) {
      continue;
    }

    pushFinding(findings, {
      severity: field.severity,
      category: "prompt_surface",
      path: field.path,
      message: `Prompt-facing field for the ${field.audience} contains graph-authoring language (${leak.label}).`,
      recommendation: "Rewrite this field for the runtime reader: state the outcome, evidence, or boundary only; keep graph shape, pattern choice, and authoring rationale outside graph JSON."
    });
  }

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
    !hasAnyText(node.intent.acceptance_criteria)
  ) {
    pushFinding(findings, {
      severity: "warning",
      category: "node_purpose",
      ...(path ? { path: `${path}.intent.acceptance_criteria` } : {}),
      node_id: node.authored_id,
      compiled_id: node.compiled_id,
      message: `${node.kind === "agent" ? "Agent" : "AI check"} node "${node.authored_id}" has no node intent acceptance criteria.`,
      recommendation: "Add node intent acceptance criteria that define the artifact quality or evaluation bar for this node."
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
        recommendation: "Add graph or node intent constraints that bound the approved credential use and any external or mutating behavior described by the tool."
      });
    }
  }

  if (!options.fullReview) {
    return;
  }

  if ((node.kind === "agent" || node.kind === "check") && !hasText(node.intent.goal)) {
    pushFinding(findings, {
      severity: "warning",
      category: "node_purpose",
      ...(path ? { path: `${path}.intent.goal` } : {}),
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
      recommendation: "Trim context to the workspace files, plugin files, and prior artifacts needed for the node outcome."
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

    if (
      "ref" in item &&
      automaticArtifactNames.has(item.artifact) &&
      !isSameManagedInternalHandoff(node, item.node)
    ) {
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
  options: { mode?: GraphReviewMode; authored_document?: unknown } = {}
): GraphReviewReport {
  const mode = options.mode ?? "review";
  const findings: GraphReviewFinding[] = [];
  const authoredMetadata = collectAuthoredMetadata(document.graph);

  reviewIntent(document, findings);
  reviewPromptSurface(options.authored_document ?? document, findings);

  graph.nodes.forEach((node) => {
    reviewExecutableNode(document, node, authoredMetadata, findings, { fullReview: true });
  });
  reviewVerification(document, graph, findings, { fullReview: true });
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

import type {
  AuthoredGraphDocument,
  AuthoredGraphNode,
  ContextReference,
  ExecutableGraphNode,
  InputItem,
  OutputDefinition
} from "../../../../src/graph/authored.js";
import type { CompiledExecutableNode, CompiledGraph, CompiledScope } from "../../../../src/graph/compiled.js";
import type { GraphDiagnostic } from "../../../../src/graph/schema.js";
import type { GraphInspectionPayload, GraphNodeView, GraphViewMode } from "../../../shared/contracts/graph";
import type { NodeDetail, RunEvent, RunNodeOverlay, RunSnapshot } from "../../../shared/contracts/runs";

export type GraphFilterKey = "active" | "failed" | "checks" | "repeats";

export interface GraphCanvasNode {
  id: string;
  authored_id: string;
  label: string;
  kind: CompiledExecutableNode["kind"];
  x: number;
  y: number;
  width: number;
  height: number;
  badge?: string;
  status?: RunNodeOverlay["status"];
  repo_alias: string;
  scope_stack: string[];
  repeat_scope_id?: string;
  iteration_index?: number;
  attempt_index?: number;
}

export interface GraphCanvasEdge {
  id: string;
  from: string;
  to: string;
  kind: "flow" | "repeat-back";
  outcome: "passed" | "failed";
  path: string;
  active: boolean;
  muted: boolean;
}

export interface GraphCanvasScope {
  id: string;
  label: string;
  kind: CompiledScope["kind"];
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GraphCanvasModel {
  width: number;
  height: number;
  nodes: GraphCanvasNode[];
  edges: GraphCanvasEdge[];
  scopes: GraphCanvasScope[];
  empty_label?: string;
}

export interface InspectorSection {
  title: string;
  empty_label: string;
  rows: Array<{
    label: string;
    value: string;
  }>;
}

export interface StaticInspectorModel {
  label: string;
  kind: string;
  status?: string;
  authored_id: string;
  compiled_id?: string;
  repo_alias?: string;
  profile_name?: string;
  repeat_scope_id?: string;
  iteration_label?: string;
  sections: InspectorSection[];
}

const compiledNodeWidth = 248;
const compiledNodeHeight = 112;
const compiledColumnGap = 92;
const compiledRowGap = 44;
const compiledPadding = 32;

function isExecutableNode(node: AuthoredGraphNode): node is ExecutableGraphNode {
  return node.type === "agent" || node.type === "exec" || node.type === "check";
}

function authoredNodeLabel(node: Pick<AuthoredGraphNode, "id" | "label">): string {
  return node.label ?? node.id;
}

function formatDiagnostic(diagnostic: GraphDiagnostic): string {
  return `${diagnostic.path}: ${diagnostic.message}`;
}

function formatInputItem(input: InputItem): string {
  switch (input.kind) {
    case "file":
      return `file:${input.path}`;
    case "glob":
      return `glob:${input.path}${input.max_files ? ` (max ${input.max_files})` : ""}`;
    case "text":
      return `text:${input.name}`;
  }
}

function formatContextReference(reference: ContextReference): string {
  const parts = [`${reference.node}.${reference.include}`];

  if (reference.output) {
    parts.push(`output:${reference.output}`);
  }

  if (reference.iteration !== undefined) {
    parts.push(`iteration:${String(reference.iteration)}`);
  }

  if (reference.attempt !== undefined) {
    parts.push(`attempt:${String(reference.attempt)}`);
  }

  if (reference.optional) {
    parts.push("optional");
  }

  return parts.join(" · ");
}

function formatOutput(output: OutputDefinition): string {
  const required = output.required === false ? "optional" : "required";
  return `${output.name} <= ${output.from}:${output.path} (${required})`;
}

function formatDuration(durationMs: number | undefined): string {
  if (!durationMs || durationMs <= 0) {
    return "0ms";
  }

  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  const seconds = durationMs / 1000;

  if (seconds < 60) {
    return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

function joinValues(values: string[]): string {
  return values.length > 0 ? values.join("\n") : "";
}

export function pickDefaultAuthoredId(document: AuthoredGraphDocument | undefined): string | null {
  if (!document) {
    return null;
  }

  const stack: AuthoredGraphNode[] = [document.graph];

  while (stack.length > 0) {
    const current = stack.shift();

    if (!current) {
      continue;
    }

    if (isExecutableNode(current)) {
      return current.id;
    }

    if (current.type === "repeat") {
      stack.unshift(current.body);
      continue;
    }

    if (current.type === "sequence" || current.type === "parallel") {
      stack.unshift(...current.steps);
    }
  }

  return document.graph.id;
}

export function resolveCompiledId(compiledGraph: CompiledGraph | undefined, authoredId: string | null | undefined): string | null {
  if (!compiledGraph || !authoredId) {
    return null;
  }

  const candidates = compiledGraph.authored_to_compiled[authoredId];
  return candidates?.[0] ?? null;
}

export function resolveAuthoredId(
  compiledGraph: CompiledGraph | undefined,
  compiledId: string | null | undefined
): string | null {
  if (!compiledGraph || !compiledId) {
    return null;
  }

  return compiledGraph.nodes.find((node) => node.compiled_id === compiledId)?.authored_id ?? null;
}

export function pickDefaultCompiledId(
  compiledGraph: CompiledGraph | undefined,
  overlayNodes: RunNodeOverlay[] = []
): string | null {
  if (!compiledGraph || compiledGraph.nodes.length === 0) {
    return null;
  }

  const preferred = overlayNodes.find((node) => node.status === "Running")
    ?? overlayNodes.find((node) => node.status === "Failed")
    ?? overlayNodes.find((node) => node.status === "Blocked")
    ?? overlayNodes[0];

  return preferred?.compiled_id ?? compiledGraph.nodes[0]?.compiled_id ?? null;
}

export function selectNodeView(
  graph: GraphInspectionPayload,
  mode: GraphViewMode,
  selection: {
    authored_id?: string | null;
    compiled_id?: string | null;
  }
): GraphNodeView | undefined {
  if (mode === "Authored") {
    return graph.authored_nodes.find((node) => node.authored_id === selection.authored_id)
      ?? graph.authored_nodes.find((node) => node.authored_id === pickDefaultAuthoredId(graph.authored_graph))
      ?? graph.authored_nodes[0];
  }

  return graph.compiled_nodes.find((node) => node.compiled_id === selection.compiled_id)
    ?? graph.compiled_nodes.find((node) => node.compiled_id === resolveCompiledId(graph.compiled_graph, selection.authored_id))
    ?? graph.compiled_nodes[0];
}

function findAuthoredNode(node: AuthoredGraphNode, authoredId: string): AuthoredGraphNode | null {
  if (node.id === authoredId) {
    return node;
  }

  if (node.type === "repeat") {
    return findAuthoredNode(node.body, authoredId);
  }

  if (node.type === "sequence" || node.type === "parallel") {
    for (const child of node.steps) {
      const found = findAuthoredNode(child, authoredId);

      if (found) {
        return found;
      }
    }
  }

  return null;
}

function findCompiledNode(compiledGraph: CompiledGraph | undefined, compiledId: string | undefined): CompiledExecutableNode | undefined {
  if (!compiledGraph || !compiledId) {
    return undefined;
  }

  return compiledGraph.nodes.find((node) => node.compiled_id === compiledId);
}

function buildStaticDefinitionRows(
  authoredNode: AuthoredGraphNode | null,
  compiledNode: CompiledExecutableNode | undefined
): InspectorSection {
  const rows: InspectorSection["rows"] = [];

  if (authoredNode?.type === "agent") {
    rows.push({
      label: "Prompt",
      value: authoredNode.prompt
    });
  }

  if (authoredNode?.type === "exec") {
    rows.push({
      label: "Command",
      value: [authoredNode.command, ...(authoredNode.args ?? [])].join(" ")
    });
  }

  if (authoredNode?.type === "check") {
    rows.push({
      label: "Check Kind",
      value: authoredNode.check_kind
    });

    if (authoredNode.command) {
      rows.push({
        label: "Command",
        value: [authoredNode.command, ...(authoredNode.args ?? [])].join(" ")
      });
    }

    if (authoredNode.prompt) {
      rows.push({
        label: "Prompt",
        value: authoredNode.prompt
      });
    }

    if (authoredNode.rubric) {
      rows.push({
        label: "Rubric",
        value: authoredNode.rubric
      });
    }
  }

  if (compiledNode) {
    rows.push({
      label: "Dependencies",
      value: compiledNode.deps.length > 0 ? compiledNode.deps.join(", ") : "none"
    });
    rows.push({
      label: "Scope Stack",
      value: compiledNode.scope_stack.length > 0 ? compiledNode.scope_stack.join(" / ") : "root"
    });

    if (compiledNode.lowered_from) {
      rows.push({
        label: "Lowered From",
        value: compiledNode.lowered_from
      });
    }
  }

  return {
    title: "Definition",
    empty_label: "No authored definition available.",
    rows
  };
}

function buildStaticProfileRows(
  graph: GraphInspectionPayload,
  authoredNode: AuthoredGraphNode | null,
  compiledNode: CompiledExecutableNode | undefined
): InspectorSection {
  const rows: InspectorSection["rows"] = [];
  const policy = compiledNode?.effective_policy;

  rows.push({
    label: "Launch Profile",
    value: graph.launch_profile
  });

  rows.push({
    label: "Workspace Backend",
    value: graph.workspace_backend
  });

  if (policy?.profile_name || (authoredNode && isExecutableNode(authoredNode) && authoredNode.profile)) {
    rows.push({
      label: "Effective Profile",
      value: policy?.profile_name ?? (authoredNode && isExecutableNode(authoredNode) ? authoredNode.profile ?? graph.launch_profile : graph.launch_profile)
    });
  }

  if (policy?.harness) {
    rows.push({
      label: "Harness",
      value: policy.harness
    });
  }

  if (policy?.model) {
    rows.push({
      label: "Model",
      value: policy.model
    });
  }

  if (policy?.sandbox) {
    rows.push({
      label: "Sandbox",
      value: policy.sandbox
    });
  }

  if (policy?.timeout_sec) {
    rows.push({
      label: "Timeout",
      value: `${policy.timeout_sec}s`
    });
  }

  if (policy) {
    rows.push({
      label: "Input Rules",
      value: [
        `files:${policy.input_rules.max_files}`,
        `total:${policy.input_rules.max_total_bytes}`,
        `item:${policy.input_rules.max_bytes_per_item}`
      ].join(" · ")
    });
  }

  return {
    title: "Profile",
    empty_label: "No profile resolution available.",
    rows
  };
}

function buildStaticInputsRows(authoredNode: AuthoredGraphNode | null): InspectorSection {
  const rows: InspectorSection["rows"] = [];

  if (authoredNode && isExecutableNode(authoredNode) && authoredNode.inputs && authoredNode.inputs.length > 0) {
    rows.push({
      label: "Inputs",
      value: joinValues(authoredNode.inputs.map(formatInputItem))
    });
  }

  if (authoredNode && isExecutableNode(authoredNode) && authoredNode.context_from && authoredNode.context_from.length > 0) {
    rows.push({
      label: "Context From",
      value: joinValues(authoredNode.context_from.map(formatContextReference))
    });
  }

  if (authoredNode && isExecutableNode(authoredNode) && authoredNode.outputs && authoredNode.outputs.length > 0) {
    rows.push({
      label: "Declared Outputs",
      value: joinValues(authoredNode.outputs.map(formatOutput))
    });
  }

  return {
    title: "Inputs",
    empty_label: "No inputs or context references declared.",
    rows
  };
}

function buildStaticChecksRows(authoredNode: AuthoredGraphNode | null): InspectorSection {
  const rows: InspectorSection["rows"] = [];

  if (authoredNode?.type === "check") {
    rows.push({
      label: "Evaluator",
      value: authoredNode.check_kind
    });

    if (authoredNode.pass_if) {
      rows.push({
        label: "Pass If",
        value: JSON.stringify(authoredNode.pass_if)
      });
    }
  }

  return {
    title: "Checks",
    empty_label: "No check evidence exists until a run executes this node.",
    rows
  };
}

function buildStaticEmptySection(title: string, emptyLabel: string): InspectorSection {
  return {
    title,
    empty_label: emptyLabel,
    rows: []
  };
}

export function buildStaticInspectorModel(
  graph: GraphInspectionPayload,
  mode: GraphViewMode,
  selection: {
    authored_id?: string | null;
    compiled_id?: string | null;
  }
): StaticInspectorModel | null {
  const nodeView = selectNodeView(graph, mode, selection);

  if (!nodeView) {
    return null;
  }

  const authoredNode = graph.authored_graph ? findAuthoredNode(graph.authored_graph.graph, nodeView.authored_id) : null;
  const compiledNode = graph.compiled_graph ? findCompiledNode(graph.compiled_graph, nodeView.compiled_id) : undefined;

  return {
    label: nodeView.label,
    kind: nodeView.kind,
    ...(nodeView.status ? { status: nodeView.status } : {}),
    authored_id: nodeView.authored_id,
    ...(nodeView.compiled_id ? { compiled_id: nodeView.compiled_id } : {}),
    ...(nodeView.repo_alias ? { repo_alias: nodeView.repo_alias } : {}),
    ...(compiledNode?.effective_policy.profile_name ? { profile_name: compiledNode.effective_policy.profile_name } : {}),
    ...(nodeView.repeat_scope_id ? { repeat_scope_id: nodeView.repeat_scope_id } : {}),
    ...(nodeView.iteration_index !== undefined || nodeView.attempt_index !== undefined
      ? {
          iteration_label: [
            nodeView.iteration_index !== undefined ? `i${nodeView.iteration_index}` : null,
            nodeView.attempt_index !== undefined ? `a${nodeView.attempt_index}` : null
          ].filter(Boolean).join("/")
        }
      : {}),
    sections: [
      buildStaticDefinitionRows(authoredNode, compiledNode),
      buildStaticProfileRows(graph, authoredNode, compiledNode),
      buildStaticInputsRows(authoredNode),
      buildStaticEmptySection("Executions", "Executions appear after a run materializes attempts."),
      buildStaticChecksRows(authoredNode),
      buildStaticEmptySection("Artifacts", "Artifacts appear after a run produces execution files."),
      buildStaticEmptySection("Events", "Events appear after runtime execution starts.")
    ]
  };
}

export function buildRunInspectorSections(detail: NodeDetail): InspectorSection[] {
  const definitionRows: InspectorSection["rows"] = [];
  const profileRows: InspectorSection["rows"] = [];
  const inputRows: InspectorSection["rows"] = [];
  const executionRows: InspectorSection["rows"] = [];
  const checkRows: InspectorSection["rows"] = [];
  const artifactRows: InspectorSection["rows"] = [];
  const eventRows: InspectorSection["rows"] = [];

  if (detail.definition.prompt) {
    definitionRows.push({
      label: "Prompt",
      value: detail.definition.prompt
    });
  }

  if (detail.definition.command) {
    definitionRows.push({
      label: "Command",
      value: [detail.definition.command, ...(detail.definition.args ?? [])].join(" ")
    });
  }

  if (detail.definition.check_kind) {
    definitionRows.push({
      label: "Check Kind",
      value: detail.definition.check_kind
    });
  }

  if (detail.definition.rubric) {
    definitionRows.push({
      label: "Rubric",
      value: detail.definition.rubric
    });
  }

  definitionRows.push({
    label: "Dependencies",
    value: detail.deps.length > 0 ? detail.deps.join(", ") : "none"
  });
  definitionRows.push({
    label: "Scope Stack",
    value: detail.node.scope_stack.length > 0 ? detail.node.scope_stack.join(" / ") : "root"
  });

  if (detail.definition.lowered_from) {
    definitionRows.push({
      label: "Lowered From",
      value: detail.definition.lowered_from
    });
  }

  profileRows.push({
    label: "Effective Profile",
    value: detail.effective_policy.profile_name
  });
  profileRows.push({
    label: "Workspace Backend",
    value: detail.effective_policy.workspace_backend
  });

  if (detail.effective_policy.harness) {
    profileRows.push({
      label: "Harness",
      value: detail.effective_policy.harness
    });
  }

  if (detail.effective_policy.model) {
    profileRows.push({
      label: "Model",
      value: detail.effective_policy.model
    });
  }

  if (detail.effective_policy.sandbox) {
    profileRows.push({
      label: "Sandbox",
      value: detail.effective_policy.sandbox
    });
  }

  profileRows.push({
    label: "Timeout",
    value: `${detail.effective_policy.timeout_sec}s`
  });
  profileRows.push({
    label: "Input Rules",
    value: [
      `files:${detail.effective_policy.input_rules.max_files}`,
      `total:${detail.effective_policy.input_rules.max_total_bytes}`,
      `item:${detail.effective_policy.input_rules.max_bytes_per_item}`
    ].join(" · ")
  });

  if (detail.definition.inputs.length > 0) {
    inputRows.push({
      label: "Inputs",
      value: joinValues(detail.definition.inputs.map(formatInputItem))
    });
  }

  if (detail.definition.context_from.length > 0) {
    inputRows.push({
      label: "Context From",
      value: joinValues(detail.definition.context_from.map(formatContextReference))
    });
  }

  if (detail.definition.declared_outputs.length > 0) {
    inputRows.push({
      label: "Declared Outputs",
      value: joinValues(detail.definition.declared_outputs.map(formatOutput))
    });
  }

  for (const execution of detail.executions) {
    executionRows.push({
      label: execution.execution_id,
      value: [
        execution.status,
        execution.outcome ? `outcome:${execution.outcome}` : null,
        execution.iteration_index !== undefined ? `i${execution.iteration_index}` : null,
        `a${execution.attempt_index}`,
        formatDuration(execution.duration_ms)
      ].filter(Boolean).join(" · ")
    });
  }

  for (const evaluation of detail.check_evaluations) {
    checkRows.push({
      label: `${evaluation.check_kind} @ ${evaluation.seq}`,
      value: [
        evaluation.passed ? "Passed" : "Failed",
        evaluation.score !== undefined ? `score:${evaluation.score}` : null,
        evaluation.summary ?? null
      ].filter(Boolean).join(" · ")
    });
  }

  for (const artifact of detail.artifacts) {
    artifactRows.push({
      label: artifact.relative_path,
      value: `${artifact.kind} · ${artifact.size_bytes} bytes`
    });
  }

  for (const event of detail.events) {
    eventRows.push({
      label: `${event.seq} · ${event.type}`,
      value: event.summary
    });
  }

  return [
    {
      title: "Definition",
      empty_label: "No definition captured.",
      rows: definitionRows
    },
    {
      title: "Profile",
      empty_label: "No profile resolution captured.",
      rows: profileRows
    },
    {
      title: "Inputs",
      empty_label: "No inputs or context references resolved.",
      rows: inputRows
    },
    {
      title: "Executions",
      empty_label: "No executions recorded for this node.",
      rows: executionRows
    },
    {
      title: "Checks",
      empty_label: "No evaluator output recorded.",
      rows: checkRows
    },
    {
      title: "Artifacts",
      empty_label: "No artifacts recorded.",
      rows: artifactRows
    },
    {
      title: "Events",
      empty_label: "No node-scoped events recorded.",
      rows: eventRows
    }
  ];
}

function matchesFilter(node: GraphCanvasNode, filters: Set<GraphFilterKey>): boolean {
  if (filters.size === 0) {
    return true;
  }

  const candidates: boolean[] = [];

  if (filters.has("active")) {
    candidates.push(node.status === "Ready" || node.status === "Running");
  }

  if (filters.has("failed")) {
    candidates.push(node.status === "Failed" || node.status === "Blocked");
  }

  if (filters.has("checks")) {
    candidates.push(node.kind === "check");
  }

  if (filters.has("repeats")) {
    candidates.push(Boolean(node.repeat_scope_id));
  }

  return candidates.some(Boolean);
}

function computeDepths(
  graph: CompiledGraph,
  visibleNodeIds: Set<string>
): Map<string, number> {
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  const depths = new Map<string, number>();

  for (const node of graph.nodes) {
    if (!visibleNodeIds.has(node.compiled_id)) {
      continue;
    }

    indegree.set(node.compiled_id, 0);
    outgoing.set(node.compiled_id, []);
    depths.set(node.compiled_id, 0);
  }

  for (const edge of graph.edges) {
    if (edge.kind === "repeat-back" || !visibleNodeIds.has(edge.from) || !visibleNodeIds.has(edge.to)) {
      continue;
    }

    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }

  const queue = Array.from(indegree.entries())
    .filter(([, count]) => count === 0)
    .map(([nodeId]) => nodeId);

  while (queue.length > 0) {
    const nodeId = queue.shift();

    if (!nodeId) {
      continue;
    }

    for (const target of outgoing.get(nodeId) ?? []) {
      const nextDepth = Math.max(depths.get(target) ?? 0, (depths.get(nodeId) ?? 0) + 1);
      depths.set(target, nextDepth);
      const remaining = (indegree.get(target) ?? 1) - 1;
      indegree.set(target, remaining);

      if (remaining === 0) {
        queue.push(target);
      }
    }
  }

  return depths;
}

function buildScopeLabel(scope: CompiledScope): string {
  switch (scope.kind) {
    case "parallel":
      return `parallel · ${scope.authored_id}`;
    case "repeat":
      return `repeat · ${scope.authored_id}`;
    default:
      return `sequence · ${scope.authored_id}`;
  }
}

function buildEdgePath(
  source: GraphCanvasNode,
  target: GraphCanvasNode,
  kind: "flow" | "repeat-back"
): string {
  if (kind === "repeat-back") {
    const sourceX = source.x + source.width / 2;
    const sourceY = source.y + source.height;
    const targetX = target.x + target.width / 2;
    const targetY = target.y;
    const controlY = Math.max(sourceY, targetY) + 52;

    return `M ${sourceX} ${sourceY} C ${sourceX} ${controlY} ${targetX} ${controlY} ${targetX} ${targetY}`;
  }

  const sourceX = source.x + source.width;
  const sourceY = source.y + source.height / 2;
  const targetX = target.x;
  const targetY = target.y + target.height / 2;
  const controlX = sourceX + (targetX - sourceX) / 2;

  return `M ${sourceX} ${sourceY} C ${controlX} ${sourceY} ${controlX} ${targetY} ${targetX} ${targetY}`;
}

function isEdgeActive(
  edge: CompiledGraph["edges"][number],
  overlayById: Map<string, RunNodeOverlay>
): boolean {
  const source = overlayById.get(edge.from);
  const target = overlayById.get(edge.to);

  if (!source || !target) {
    return false;
  }

  return target.status === "Running" || (source.status === "Passed" && target.status === "Ready");
}

export function buildCompiledGraphCanvas(
  graph: CompiledGraph | undefined,
  overlayNodes: RunNodeOverlay[] = [],
  filters: GraphFilterKey[] = []
): GraphCanvasModel {
  if (!graph) {
    return {
      width: 0,
      height: 0,
      nodes: [],
      edges: [],
      scopes: [],
      empty_label: "Compiled graph data is unavailable."
    };
  }

  const overlayById = new Map(overlayNodes.map((node) => [node.compiled_id, node]));
  const filterSet = new Set(filters);
  const baseNodes = graph.nodes.map<GraphCanvasNode>((node) => {
    const overlay = overlayById.get(node.compiled_id);

    const badge = overlay?.badge
      ?? (node.kind === "agent"
        ? node.effective_policy.harness
        : node.kind === "check"
          ? node.check_kind
          : node.command);

    return {
      id: node.compiled_id,
      authored_id: node.authored_id,
      label: node.label ?? node.authored_id,
      kind: node.kind,
      x: 0,
      y: 0,
      width: compiledNodeWidth,
      height: compiledNodeHeight,
      ...(badge ? { badge } : {}),
      ...(overlay?.status ? { status: overlay.status } : {}),
      repo_alias: node.repo,
      scope_stack: node.scope_stack,
      ...(overlay?.repeat_scope_id ? { repeat_scope_id: overlay.repeat_scope_id } : node.repeat_scope_id ? { repeat_scope_id: node.repeat_scope_id } : {}),
      ...(overlay?.iteration_index !== undefined ? { iteration_index: overlay.iteration_index } : {}),
      ...(overlay?.attempt_index !== undefined ? { attempt_index: overlay.attempt_index } : {})
    };
  });
  const visibleNodes = baseNodes.filter((node) => matchesFilter(node, filterSet));

  if (visibleNodes.length === 0) {
    return {
      width: 0,
      height: 0,
      nodes: [],
      edges: [],
      scopes: [],
      empty_label: "No compiled nodes match the active filters."
    };
  }

  const visibleNodeIds = new Set(visibleNodes.map((node) => node.id));
  const depths = computeDepths(graph, visibleNodeIds);
  const rowsByDepth = new Map<number, number>();
  const positionedNodes = visibleNodes.map((node) => {
    const depth = depths.get(node.id) ?? 0;
    const row = rowsByDepth.get(depth) ?? 0;
    rowsByDepth.set(depth, row + 1);

    return {
      ...node,
      x: compiledPadding + depth * (compiledNodeWidth + compiledColumnGap),
      y: compiledPadding + row * (compiledNodeHeight + compiledRowGap)
    };
  });
  const nodesById = new Map(positionedNodes.map((node) => [node.id, node]));
  const scopes = graph.scopes
    .map<GraphCanvasScope | null>((scope) => {
      const members = scope.compiled_node_ids
        .map((compiledId) => nodesById.get(compiledId))
        .filter((value): value is GraphCanvasNode => Boolean(value));

      if (members.length === 0) {
        return null;
      }

      const minX = Math.min(...members.map((node) => node.x));
      const maxX = Math.max(...members.map((node) => node.x + node.width));
      const minY = Math.min(...members.map((node) => node.y));
      const maxY = Math.max(...members.map((node) => node.y + node.height));

      return {
        id: scope.scope_id,
        label: buildScopeLabel(scope),
        kind: scope.kind,
        x: minX - 16,
        y: minY - 18,
        width: maxX - minX + 32,
        height: maxY - minY + 36
      };
    })
    .filter((scope): scope is GraphCanvasScope => Boolean(scope))
    .sort((left, right) => (left.width * left.height) - (right.width * right.height));
  const edges = graph.edges
    .filter((edge) => visibleNodeIds.has(edge.from) && visibleNodeIds.has(edge.to))
    .map<GraphCanvasEdge>((edge) => {
      const source = nodesById.get(edge.from)!;
      const target = nodesById.get(edge.to)!;
      const active = isEdgeActive(edge, overlayById);
      const muted = target.status === "Blocked" || target.status === "Skipped";

      return {
        id: edge.edge_id,
        from: edge.from,
        to: edge.to,
        kind: edge.kind,
        outcome: edge.on,
        path: buildEdgePath(source, target, edge.kind),
        active,
        muted
      };
    });
  const width = Math.max(...positionedNodes.map((node) => node.x + node.width), 0) + compiledPadding;
  const height = Math.max(
    Math.max(...positionedNodes.map((node) => node.y + node.height), 0),
    Math.max(...scopes.map((scope) => scope.y + scope.height), 0)
  ) + compiledPadding;

  return {
    width,
    height,
    nodes: positionedNodes,
    edges,
    scopes
  };
}

export function createGraphKpis(runSnapshot: RunSnapshot | null): Array<{
  label: string;
  value: string;
}> {
  if (!runSnapshot) {
    return [
      { label: "Run Status", value: "Pending" },
      { label: "Active Nodes", value: "0" },
      { label: "Passed / Failed", value: "0 / 0" },
      { label: "Repeat Depth", value: "0" }
    ];
  }

  return [
    { label: "Run Status", value: runSnapshot.run.status },
    { label: "Active Nodes", value: String(runSnapshot.run.active_nodes) },
    { label: "Passed / Failed", value: `${runSnapshot.run.passed_nodes} / ${runSnapshot.run.failed_nodes}` },
    { label: "Repeat Depth", value: String(runSnapshot.run.current_repeat_depth) }
  ];
}

export function createLaunchpadKpis(graph: GraphInspectionPayload | null): Array<{
  label: string;
  value: string;
}> {
  if (!graph) {
    return [
      { label: "Graph Id", value: "Not selected" },
      { label: "Node Count", value: "0" },
      { label: "Profiles", value: "0" },
      { label: "Compile", value: "Pending" }
    ];
  }

  return graph.kpis;
}

export function createDiagnosticsList(graph: GraphInspectionPayload | null): string[] {
  if (!graph) {
    return [];
  }

  return [
    ...graph.validation_diagnostics.map(formatDiagnostic),
    ...graph.launch_resolution.diagnostics.map(formatDiagnostic),
    ...graph.compile_diagnostics.map(formatDiagnostic)
  ];
}

export function mergeRunEvents(current: RunEvent[], incoming: RunEvent[]): RunEvent[] {
  const bySeq = new Map<number, RunEvent>();

  for (const event of [...current, ...incoming]) {
    bySeq.set(event.seq, event);
  }

  return Array.from(bySeq.values()).sort((left, right) => right.seq - left.seq);
}

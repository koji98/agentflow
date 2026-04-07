import type {
  CompiledEdge,
  CompiledExecutableNode,
  CompiledGraph,
  CompiledParallelScope,
  CompiledRepeatScope
} from "../../graph/compiled.js";

export interface ReadyNode {
  compiled_id: string;
  deps_satisfied: string[];
  repeat_scope_id: string | undefined;
  iteration_index: number | undefined;
}

export interface SchedulerTopology {
  incoming_edges_by_node: Map<string, CompiledEdge[]>;
  outgoing_edges_by_node: Map<string, CompiledEdge[]>;
  nodes_by_id: Map<string, CompiledExecutableNode>;
  repeat_scopes_by_id: Map<string, CompiledRepeatScope>;
  repeat_scope_by_body_entry_node: Map<string, string>;
  parallel_scopes_by_node: Map<string, CompiledParallelScope[]>;
}

function buildEdgeIndex(
  edges: CompiledEdge[],
  direction: "from" | "to"
): Map<string, CompiledEdge[]> {
  const index = new Map<string, CompiledEdge[]>();

  for (const edge of edges) {
    const key = edge[direction];
    const current = index.get(key) ?? [];
    current.push(edge);
    index.set(key, current);
  }

  return index;
}

export function buildSchedulerTopology(graph: CompiledGraph): SchedulerTopology {
  const repeat_scopes_by_id = new Map<string, CompiledRepeatScope>(
    graph.scopes
      .filter((scope): scope is CompiledRepeatScope => scope.kind === "repeat")
      .map((scope) => [scope.scope_id, scope])
  );
  const parallel_scope_map = new Map<string, CompiledParallelScope>(
    graph.scopes
      .filter((scope): scope is CompiledParallelScope => scope.kind === "parallel")
      .map((scope) => [scope.scope_id, scope])
  );

  return {
    incoming_edges_by_node: buildEdgeIndex(graph.edges, "to"),
    outgoing_edges_by_node: buildEdgeIndex(graph.edges, "from"),
    nodes_by_id: new Map(graph.nodes.map((node) => [node.compiled_id, node])),
    repeat_scopes_by_id,
    repeat_scope_by_body_entry_node: new Map(
      [...repeat_scopes_by_id.values()].flatMap((scope) =>
        scope.body_entry_node_ids.map((compiledId) => [compiledId, scope.scope_id] as const)
      )
    ),
    parallel_scopes_by_node: new Map(
      graph.nodes.map((node) => [
        node.compiled_id,
        node.scope_stack
          .map((scopeId) => parallel_scope_map.get(scopeId))
          .filter((scope): scope is CompiledParallelScope => Boolean(scope))
      ])
    )
  };
}

export function createReadyNodeKey(readyNode: ReadyNode): string {
  return `${readyNode.compiled_id}::${readyNode.iteration_index ?? 0}`;
}

export function getIncomingEdges(
  topology: SchedulerTopology,
  compiledId: string
): CompiledEdge[] {
  return topology.incoming_edges_by_node.get(compiledId) ?? [];
}

export function getOutgoingEdges(
  topology: SchedulerTopology,
  compiledId: string
): CompiledEdge[] {
  return topology.outgoing_edges_by_node.get(compiledId) ?? [];
}

export function getNodeParallelScopes(
  topology: SchedulerTopology,
  compiledId: string
): CompiledParallelScope[] {
  return topology.parallel_scopes_by_node.get(compiledId) ?? [];
}

export function getRepeatScopeForBodyEntryNode(
  topology: SchedulerTopology,
  compiledId: string
): string | undefined {
  return topology.repeat_scope_by_body_entry_node.get(compiledId);
}

export function isRepeatBodyEntryNode(
  topology: SchedulerTopology,
  compiledId: string,
  repeatScopeId: string
): boolean {
  return topology.repeat_scope_by_body_entry_node.get(compiledId) === repeatScopeId;
}

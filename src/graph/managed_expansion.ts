import type { ArtifactDefinition } from "./authored.js";
import type { CompiledGraph, CompiledRepeatScope } from "./compiled.js";
import type { LoweredManagedNode } from "./normalize.js";

export interface ManagedExpansionRepeatLoop {
  authored_id: string;
  until: string;
  max_attempts: number;
}

export interface ManagedExpansionSummary {
  authored_id: string;
  managed_kind: LoweredManagedNode["managed_kind"];
  plugin?: NonNullable<LoweredManagedNode["plugin"]>;
  lowered_to: LoweredManagedNode["lowered_to"];
  ordered_internal_step_ids: string[];
  internal_hard_gates: string[];
  repeat_loops: ManagedExpansionRepeatLoop[];
  published_artifacts: Record<string, ArtifactDefinition>;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function matchesManagedInternalNode(
  authoredId: string,
  loweredNode: LoweredManagedNode
): boolean {
  if (loweredNode.internal_id_prefix) {
    return authoredId.startsWith(loweredNode.internal_id_prefix);
  }

  return authoredId.startsWith(`${loweredNode.authored_id}__managed__${loweredNode.managed_kind}__`);
}

function summarizeRepeatLoop(graph: CompiledGraph, scope: CompiledRepeatScope): ManagedExpansionRepeatLoop {
  const untilNode = graph.nodes.find((node) => node.compiled_id === scope.until_compiled_id);

  return {
    authored_id: scope.authored_id,
    until: untilNode?.authored_id ?? scope.until_compiled_id,
    max_attempts: scope.max_attempts
  };
}

export function buildManagedExpansionSummaries(
  graph: CompiledGraph,
  loweredManagedNodes: LoweredManagedNode[]
): ManagedExpansionSummary[] {
  return loweredManagedNodes.map((loweredNode) => {
    const internalNodes = graph.nodes.filter((node) => matchesManagedInternalNode(node.authored_id, loweredNode));
    const publishedNode = graph.nodes.find((node) => node.authored_id === loweredNode.authored_id);
    const repeatLoops = graph.scopes
      .filter((scope): scope is CompiledRepeatScope => scope.kind === "repeat")
      .filter((scope) => matchesManagedInternalNode(scope.authored_id, loweredNode))
      .map((scope) => summarizeRepeatLoop(graph, scope));

    return {
      authored_id: loweredNode.authored_id,
      managed_kind: loweredNode.managed_kind,
      ...(loweredNode.plugin ? { plugin: loweredNode.plugin } : {}),
      lowered_to: loweredNode.lowered_to,
      ordered_internal_step_ids: unique(internalNodes.map((node) => node.authored_id)),
      internal_hard_gates: unique(
        internalNodes
          .filter((node) => node.kind === "checkpoint" || (node.kind === "check" && node.on_failure !== "continue"))
          .map((node) => node.authored_id)
      ),
      repeat_loops: repeatLoops,
      published_artifacts: publishedNode?.declared_artifacts ?? {}
    };
  });
}

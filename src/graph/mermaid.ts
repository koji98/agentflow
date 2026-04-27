import type { ArtifactContextRef } from "./authored.js";
import type { CompiledExecutableNode, CompiledGraph } from "./compiled.js";

function mermaidId(prefix: string, value: string): string {
  return `${prefix}_${value.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

function escapeLabel(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\r?\n/g, " ");
}

function nodeId(node: CompiledExecutableNode): string {
  return mermaidId("node", node.compiled_id);
}

function artifactId(nodeAuthoredId: string, artifactName: string): string {
  return mermaidId("artifact", `${nodeAuthoredId}_${artifactName}`);
}

function scopeId(scopeIdValue: string): string {
  return mermaidId("scope", scopeIdValue);
}

function nodeLabel(node: CompiledExecutableNode): string {
  const artifactNames = Object.keys(node.declared_artifacts);
  const details = [
    `${node.kind}: ${node.authored_id}`,
    `repo: ${node.repo}`,
    `profile: ${node.effective_policy.profile_name}`,
    node.effective_policy.harness ? `harness: ${node.effective_policy.harness}` : undefined,
    node.effective_policy.sandbox ? `sandbox: ${node.effective_policy.sandbox}` : undefined,
    artifactNames.length > 0 ? `artifacts: ${artifactNames.join(", ")}` : undefined
  ].filter((value): value is string => Boolean(value));

  return details.map(escapeLabel).join("<br/>");
}

function scopeLabel(kind: string, authoredId: string, detail?: string): string {
  return [`${kind}: ${authoredId}`, detail].filter((value): value is string => Boolean(value)).map(escapeLabel).join("<br/>");
}

function isArtifactContextRef(value: unknown): value is ArtifactContextRef {
  return typeof value === "object" && value !== null && "ref" in value && "node" in value && "artifact" in value;
}

export function renderCompiledGraphMermaid(graph: CompiledGraph): string {
  const declaredOrReferencedArtifacts = new Set<string>();
  const nodesByAuthoredId = new Map(graph.nodes.map((node) => [node.authored_id, node]));
  const lines = [
    "flowchart TD",
    "  classDef agent fill:#eef6ff,stroke:#3678c2,color:#111;",
    "  classDef exec fill:#f7f7f7,stroke:#666,color:#111;",
    "  classDef check fill:#effaf0,stroke:#2e7d32,color:#111;",
    "  classDef checkpoint fill:#fff7e6,stroke:#b26a00,color:#111;",
    "  classDef scope fill:#f8f0ff,stroke:#7b3fb2,stroke-dasharray: 4 3,color:#111;",
    "  classDef artifact fill:#fffde7,stroke:#9e8a00,color:#111;",
    "  classDef note fill:#ffffff,stroke:#999,stroke-dasharray: 3 3,color:#111;"
  ];

  graph.nodes.forEach((node) => {
    Object.keys(node.declared_artifacts).forEach((artifactName) => {
      declaredOrReferencedArtifacts.add(`${node.authored_id}.${artifactName}`);
    });
    node.context.forEach((item) => {
      if (isArtifactContextRef(item)) {
        declaredOrReferencedArtifacts.add(`${item.node}.${item.artifact}`);
      }
    });
    lines.push(`  ${nodeId(node)}["${nodeLabel(node)}"]:::${node.kind};`);
  });

  graph.scopes.forEach((scope) => {
    const detail =
      scope.kind === "parallel"
        ? `max_concurrency: ${scope.max_concurrency ?? "unbounded"}`
        : scope.kind === "repeat"
          ? `max_attempts: ${scope.max_attempts}`
          : undefined;
    lines.push(`  ${scopeId(scope.scope_id)}["${scopeLabel(scope.kind, scope.authored_id, detail)}"]:::scope;`);
    scope.compiled_node_ids.forEach((compiledNodeId) => {
      lines.push(`  ${scopeId(scope.scope_id)} -. contains .-> ${mermaidId("node", compiledNodeId)};`);
    });
  });

  graph.edges.forEach((edge) => {
    const arrow = edge.kind === "repeat-back" ? "-.->" : "-->";
    const label = edge.kind === "repeat-back" ? `${edge.on} repeat` : edge.on;
    lines.push(`  ${mermaidId("node", edge.from)} ${arrow}|${escapeLabel(label)}| ${mermaidId("node", edge.to)};`);
  });

  [...declaredOrReferencedArtifacts].sort().forEach((artifactRef) => {
    const separatorIndex = artifactRef.lastIndexOf(".");
    const producerNodeId = artifactRef.slice(0, separatorIndex);
    const artifactName = artifactRef.slice(separatorIndex + 1);
    const producerNode = nodesByAuthoredId.get(producerNodeId);
    const id = artifactId(producerNodeId, artifactName);
    lines.push(`  ${id}[/"${escapeLabel(artifactRef)}"/]:::artifact;`);
    if (producerNode) {
      lines.push(`  ${nodeId(producerNode)} -. produces .-> ${id};`);
    }
  });

  graph.nodes.forEach((node) => {
    node.context.forEach((item) => {
      if (!isArtifactContextRef(item)) {
        return;
      }

      lines.push(
        `  ${artifactId(item.node, item.artifact)} -. context .-> ${nodeId(node)};`
      );
    });
  });

  const terminalNodeIds = graph.nodes
    .filter((node) => !graph.edges.some((edge) => edge.from === node.compiled_id))
    .map((node) => nodeId(node));
  const actionSummary = Object.entries(graph.supervision.actions)
    .filter(([, policy]) => policy !== undefined)
    .map(([action, policy]) => `${action}: ${policy?.max_uses}`)
    .join(", ");
  lines.push(
    `  supervision["${[
      `supervision budget: ${graph.supervision.max_total_interventions}`,
      actionSummary
    ].filter((value): value is string => Boolean(value)).map(escapeLabel).join("<br/>")}"]:::note;`
  );
  lines.push(`  delivery["${["delivery package", "review artifacts"].map(escapeLabel).join("<br/>")}"]:::note;`);

  graph.entry_node_ids.forEach((entryNodeId) => {
    lines.push(`  supervision -. observes .-> ${mermaidId("node", entryNodeId)};`);
  });
  terminalNodeIds.forEach((terminalNodeId) => {
    lines.push(`  ${terminalNodeId} -. terminal evidence .-> delivery;`);
  });

  return `${lines.join("\n")}\n`;
}

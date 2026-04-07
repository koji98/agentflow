import type { CheckNode, ExecutableGraphNode, AuthoredGraphNode, ContainerGraphNode } from "./authored.js";
import type {
  CompileGraphResult,
  CompiledEdge,
  CompiledExecutableNode,
  CompiledGraph,
  CompiledScope
} from "./compiled.js";
import type { LoweredManagedNode } from "./normalize.js";
import {
  resolveExecutableRepoAlias,
  resolveNodePolicy
} from "./profiles.js";
import type { LaunchResolution } from "./profiles.js";
import type { GraphDiagnostic, LoweredManagedKind } from "./schema.js";
import type { AuthoredGraphDocument } from "./authored.js";

interface ScopeFrame {
  authored_id: string;
  kind: ContainerGraphNode["type"];
  authored_stack: string[];
  scope_id: string;
  scope_stack: string[];
  parent_scope_id: string | null;
  nearest_repeat_scope_id?: string;
}

interface CompiledRegion {
  entry_node_ids: string[];
  exit_node_ids: string[];
  compiled_node_ids: string[];
}

interface CompileContext {
  document: AuthoredGraphDocument;
  launch: LaunchResolution;
  diagnostics: GraphDiagnostic[];
  nodes: CompiledExecutableNode[];
  edges: CompiledEdge[];
  scopes: CompiledScope[];
  authored_to_compiled: Map<string, string[]>;
  compiled_node_by_id: Map<string, CompiledExecutableNode>;
  authored_paths: Map<string, string>;
  lowered_managed_kind_by_id: Map<string, LoweredManagedKind>;
  edge_counter: number;
}

function isExecutableNode(node: AuthoredGraphNode): node is ExecutableGraphNode {
  return node.type === "agent" || node.type === "exec" || node.type === "check" || node.type === "checkpoint";
}

function isAiCheck(node: ExecutableGraphNode): node is CheckNode & { check_kind: "ai" } {
  return node.type === "check" && node.check_kind === "ai";
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function createScopeId(authoredStack: string[]): string {
  return `scope__${authoredStack.join("__")}`;
}

function createCompiledId(scopeFrame: ScopeFrame, nodeId: string): string {
  return [...scopeFrame.authored_stack, nodeId].join("__");
}

function recordAuthoredMapping(
  context: CompileContext,
  authoredId: string,
  compiledId: string
): void {
  const current = context.authored_to_compiled.get(authoredId) ?? [];
  current.push(compiledId);
  context.authored_to_compiled.set(authoredId, current);
}

function addEdge(
  context: CompileContext,
  edge: Omit<CompiledEdge, "edge_id">
): void {
  const edge_id = `edge__${++context.edge_counter}`;
  context.edges.push({
    edge_id,
    ...edge
  });
}

function createScopeFrame(
  parentScopeFrame: ScopeFrame | undefined,
  node: ContainerGraphNode
): ScopeFrame {
  const authored_stack = [...(parentScopeFrame?.authored_stack ?? []), node.id];
  const scope_id = createScopeId(authored_stack);
  const scope_stack = [...(parentScopeFrame?.scope_stack ?? []), scope_id];

  return {
    authored_id: node.id,
    kind: node.type,
    authored_stack,
    scope_id,
    scope_stack,
    parent_scope_id: parentScopeFrame?.scope_id ?? null,
    ...(node.type === "repeat"
      ? { nearest_repeat_scope_id: scope_id }
      : parentScopeFrame?.nearest_repeat_scope_id
        ? { nearest_repeat_scope_id: parentScopeFrame.nearest_repeat_scope_id }
        : {})
  };
}

function resolveCheckFields(
  node: CheckNode,
  nodePolicyResolution: ReturnType<typeof resolveNodePolicy>
): Pick<CompiledExecutableNode, never> & {
  env?: CheckNode["env"];
  pass_if?: CheckNode["pass_if"];
  rubric?: string;
} {
  if (node.check_kind === "deterministic") {
    return {
      ...(node.env ? { env: node.env } : {}),
      pass_if:
        node.pass_if ??
        nodePolicyResolution.node_profile?.deterministic_check_defaults?.pass_if ??
        nodePolicyResolution.launch_profile?.deterministic_check_defaults?.pass_if ??
        { exit_code: 0 }
    };
  }

  return {
    ...(node.rubric
      ? { rubric: node.rubric }
      : nodePolicyResolution.node_profile?.ai_check_defaults?.rubric
        ? { rubric: nodePolicyResolution.node_profile.ai_check_defaults.rubric }
        : nodePolicyResolution.launch_profile?.ai_check_defaults?.rubric
          ? { rubric: nodePolicyResolution.launch_profile.ai_check_defaults.rubric }
          : {})
  };
}

function compileExecutableNode(
  context: CompileContext,
  scopeFrame: ScopeFrame,
  node: ExecutableGraphNode,
  path: string
): CompiledRegion {
  const repo = resolveExecutableRepoAlias(context.document, node.repo);
  const nodePolicyResolution = resolveNodePolicy(context.document, context.launch, node);
  context.diagnostics.push(...nodePolicyResolution.diagnostics);
  context.authored_paths.set(node.id, path);

  if (!repo) {
    context.diagnostics.push({
      path: `${path}.repo`,
      message: "Executable node could not resolve a repo alias."
    });
  }

  const compiled_id = createCompiledId(scopeFrame, node.id);
  const lowered_from = context.lowered_managed_kind_by_id.get(node.id);

  const compiledBase = {
    compiled_id,
    authored_id: node.id,
    kind: node.type,
    ...(node.label ? { label: node.label } : {}),
    repo: repo ?? "unknown",
    deps: [],
    scope_stack: scopeFrame.scope_stack,
    ...(scopeFrame.nearest_repeat_scope_id
      ? { repeat_scope_id: scopeFrame.nearest_repeat_scope_id }
      : {}),
    effective_policy: nodePolicyResolution.policy,
    inputs: node.inputs ?? [],
    context_from: node.context_from ?? [],
    declared_outputs: node.outputs ?? [],
    ...(lowered_from ? { lowered_from } : {})
  };

  let compiledNode: CompiledExecutableNode;

  if (node.type === "agent") {
    compiledNode = {
      ...compiledBase,
      kind: "agent",
      prompt: node.prompt
    };
  } else if (node.type === "exec") {
    compiledNode = {
      ...compiledBase,
      kind: "exec",
      command: node.command,
      args: node.args ?? [],
      ...(node.cwd ? { cwd: node.cwd } : {}),
      ...(node.env ? { env: node.env } : {})
    };
  } else if (node.type === "checkpoint") {
    compiledNode = {
      ...compiledBase,
      kind: "checkpoint",
      prompt: node.prompt,
      review_from: node.review_from
    };
  } else {
    const resolvedCheckFields = resolveCheckFields(node, nodePolicyResolution);
    compiledNode = {
      ...compiledBase,
      kind: "check",
      check_kind: node.check_kind,
      ...(node.command ? { command: node.command } : {}),
      ...(node.args ? { args: node.args } : {}),
      ...(node.cwd ? { cwd: node.cwd } : {}),
      ...(resolvedCheckFields.env ? { env: resolvedCheckFields.env } : {}),
      ...(resolvedCheckFields.pass_if ? { pass_if: resolvedCheckFields.pass_if } : {}),
      ...(node.prompt ? { prompt: node.prompt } : {}),
      ...(resolvedCheckFields.rubric ? { rubric: resolvedCheckFields.rubric } : {})
    };
  }

  context.nodes.push(compiledNode);
  context.compiled_node_by_id.set(compiled_id, compiledNode);
  recordAuthoredMapping(context, node.id, compiled_id);

  return {
    entry_node_ids: [compiled_id],
    exit_node_ids: [compiled_id],
    compiled_node_ids: [compiled_id]
  };
}

function compileSequenceNode(
  context: CompileContext,
  parentScopeFrame: ScopeFrame | undefined,
  node: Extract<ContainerGraphNode, { type: "sequence" }>,
  path: string
): CompiledRegion {
  const scopeFrame = createScopeFrame(parentScopeFrame, node);
  context.authored_paths.set(node.id, path);

  const childRegions = node.steps.map((child, index) =>
    compileGraphNode(context, scopeFrame, child, `${path}.steps[${index}]`)
  );

  const entry_node_ids: string[] = [];
  let priorExitNodeIds: string[] = [];
  const compiled_node_ids: string[] = [];

  childRegions.forEach((childRegion) => {
    compiled_node_ids.push(...childRegion.compiled_node_ids);

    if (childRegion.entry_node_ids.length === 0) {
      return;
    }

    if (entry_node_ids.length === 0) {
      entry_node_ids.push(...childRegion.entry_node_ids);
    }

    if (priorExitNodeIds.length > 0) {
      priorExitNodeIds.forEach((from) => {
        childRegion.entry_node_ids.forEach((to) => {
          addEdge(context, {
            from,
            to,
            on: "passed",
            kind: "flow"
          });
        });
      });
    }

    priorExitNodeIds = childRegion.exit_node_ids;
  });

  const region: CompiledRegion = {
    entry_node_ids,
    exit_node_ids: priorExitNodeIds,
    compiled_node_ids: dedupe(compiled_node_ids)
  };

  context.scopes.push({
    scope_id: scopeFrame.scope_id,
    authored_id: node.id,
    kind: "sequence",
    parent_scope_id: scopeFrame.parent_scope_id,
    scope_stack: scopeFrame.scope_stack,
    entry_node_ids: region.entry_node_ids,
    exit_node_ids: region.exit_node_ids,
    compiled_node_ids: region.compiled_node_ids
  });

  return region;
}

function compileParallelNode(
  context: CompileContext,
  parentScopeFrame: ScopeFrame | undefined,
  node: Extract<ContainerGraphNode, { type: "parallel" }>,
  path: string
): CompiledRegion {
  const scopeFrame = createScopeFrame(parentScopeFrame, node);
  context.authored_paths.set(node.id, path);

  const childRegions = node.steps.map((child, index) =>
    compileGraphNode(context, scopeFrame, child, `${path}.steps[${index}]`)
  );

  const region: CompiledRegion = {
    entry_node_ids: dedupe(childRegions.flatMap((child) => child.entry_node_ids)),
    exit_node_ids: dedupe(childRegions.flatMap((child) => child.exit_node_ids)),
    compiled_node_ids: dedupe(childRegions.flatMap((child) => child.compiled_node_ids))
  };

  context.scopes.push({
    scope_id: scopeFrame.scope_id,
    authored_id: node.id,
    kind: "parallel",
    parent_scope_id: scopeFrame.parent_scope_id,
    scope_stack: scopeFrame.scope_stack,
    entry_node_ids: region.entry_node_ids,
    exit_node_ids: region.exit_node_ids,
    compiled_node_ids: region.compiled_node_ids,
    ...(node.max_concurrency !== undefined ? { max_concurrency: node.max_concurrency } : {})
  });

  return region;
}

function compileRepeatNode(
  context: CompileContext,
  parentScopeFrame: ScopeFrame | undefined,
  node: Extract<ContainerGraphNode, { type: "repeat" }>,
  path: string
): CompiledRegion {
  const scopeFrame = createScopeFrame(parentScopeFrame, node);
  context.authored_paths.set(node.id, path);

  const bodyRegion = compileGraphNode(context, scopeFrame, node.body, `${path}.body`);
  const untilCompiledIds = context.authored_to_compiled.get(node.until.node) ?? [];
  const until_compiled_id = untilCompiledIds[0];

  if (bodyRegion.entry_node_ids.length !== 1) {
    context.diagnostics.push({
      path: `${path}.body`,
      message: "repeat.body must compile to a single entry region."
    });
  }

  if (bodyRegion.exit_node_ids.length !== 1) {
    context.diagnostics.push({
      path: `${path}.body`,
      message: "repeat.body must compile to a single exit region."
    });
  }

  if (!until_compiled_id) {
    context.diagnostics.push({
      path: `${path}.until.node`,
      message: `repeat.until.node "${node.until.node}" did not compile to an executable node.`
    });
  } else {
    const compiledUntilNode = context.compiled_node_by_id.get(until_compiled_id);

    if (!bodyRegion.compiled_node_ids.includes(until_compiled_id)) {
      context.diagnostics.push({
        path: `${path}.until.node`,
        message: `repeat.until.node "${node.until.node}" must resolve inside the repeat body.`
      });
    } else if (!compiledUntilNode || (compiledUntilNode.kind !== "check" && compiledUntilNode.kind !== "checkpoint")) {
      context.diagnostics.push({
        path: `${path}.until.node`,
        message: `repeat.until.node "${node.until.node}" must resolve to a compiled check or checkpoint node.`
      });
    }

    if (bodyRegion.exit_node_ids[0] && bodyRegion.exit_node_ids[0] !== until_compiled_id) {
      context.diagnostics.push({
        path: `${path}.until.node`,
        message: "repeat.until.node must resolve to the body exit node in this release."
      });
    }

    if (bodyRegion.entry_node_ids[0]) {
      addEdge(context, {
        from: until_compiled_id,
        to: bodyRegion.entry_node_ids[0],
        on: "failed",
        kind: "repeat-back",
        repeat_scope_id: scopeFrame.scope_id
      });
    }
  }

  const exit_node_ids = until_compiled_id ? [until_compiled_id] : bodyRegion.exit_node_ids;

  context.scopes.push({
    scope_id: scopeFrame.scope_id,
    authored_id: node.id,
    kind: "repeat",
    parent_scope_id: scopeFrame.parent_scope_id,
    scope_stack: scopeFrame.scope_stack,
    entry_node_ids: bodyRegion.entry_node_ids,
    exit_node_ids,
    compiled_node_ids: bodyRegion.compiled_node_ids,
    max_attempts: node.max_attempts,
    until_compiled_id: until_compiled_id ?? "missing",
    body_entry_node_ids: bodyRegion.entry_node_ids,
    body_exit_node_ids: bodyRegion.exit_node_ids
  });

  return {
    entry_node_ids: bodyRegion.entry_node_ids,
    exit_node_ids,
    compiled_node_ids: bodyRegion.compiled_node_ids
  };
}

function compileGraphNode(
  context: CompileContext,
  parentScopeFrame: ScopeFrame | undefined,
  node: AuthoredGraphNode,
  path: string
): CompiledRegion {
  if (isExecutableNode(node)) {
    if (!parentScopeFrame) {
      context.diagnostics.push({
        path,
        message: "Executable nodes must compile inside a container scope."
      });
      return {
        entry_node_ids: [],
        exit_node_ids: [],
        compiled_node_ids: []
      };
    }

    return compileExecutableNode(context, parentScopeFrame, node, path);
  }

  if (node.type === "sequence") {
    return compileSequenceNode(context, parentScopeFrame, node, path);
  }

  if (node.type === "parallel") {
    return compileParallelNode(context, parentScopeFrame, node, path);
  }

  return compileRepeatNode(context, parentScopeFrame, node, path);
}

function finalizeNodeDependencies(context: CompileContext): void {
  const incomingByNode = new Map<string, string[]>();

  context.edges.forEach((edge) => {
    const incoming = incomingByNode.get(edge.to) ?? [];
    incoming.push(edge.from);
    incomingByNode.set(edge.to, incoming);
  });

  context.nodes.forEach((node) => {
    node.deps = dedupe(incomingByNode.get(node.compiled_id) ?? []);
  });
}

function buildAdjacency(
  edges: CompiledEdge[],
  options: {
    includeRepeatBackEdges: boolean;
  }
): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();

  edges
    .filter((edge) => options.includeRepeatBackEdges || edge.kind !== "repeat-back")
    .forEach((edge) => {
      const current = adjacency.get(edge.from) ?? [];
      current.push(edge.to);
      adjacency.set(edge.from, current);
    });

  return adjacency;
}

function isReachable(
  adjacency: Map<string, string[]>,
  from: string,
  target: string
): boolean {
  if (from === target) {
    return true;
  }

  const queue = [...(adjacency.get(from) ?? [])];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift();

    if (!current || visited.has(current)) {
      continue;
    }

    if (current === target) {
      return true;
    }

    visited.add(current);
    queue.push(...(adjacency.get(current) ?? []));
  }

  return false;
}

function validateCompiledContextReferences(
  context: CompileContext,
  compiledGraph: CompiledGraph
): void {
  const forwardAdjacency = buildAdjacency(compiledGraph.edges, {
    includeRepeatBackEdges: false
  });

  compiledGraph.nodes.forEach((node) => {
    node.inputs.forEach((input) => {
      if (input.kind !== "glob" || input.max_files === undefined) {
        return;
      }

      if (input.max_files > node.effective_policy.input_rules.max_files) {
        const path = context.authored_paths.get(node.authored_id) ?? `$.graph.${node.authored_id}`;
        context.diagnostics.push({
          path: `${path}.inputs`,
          message: `glob.max_files ${input.max_files} exceeds effective input_rules.max_files ${node.effective_policy.input_rules.max_files}.`
        });
      }
    });

    const references = [
      ...node.context_from.map((reference, index) => ({
        reference,
        path_suffix: `context_from[${index}]`
      })),
      ...(node.kind === "checkpoint"
        ? [
            {
              reference: node.review_from,
              path_suffix: "review_from"
            }
          ]
        : [])
    ];

    references.forEach(({ reference, path_suffix }) => {
      const path = context.authored_paths.get(node.authored_id) ?? `$.graph.${node.authored_id}`;
      const targetCompiledIds = compiledGraph.authored_to_compiled[reference.node] ?? [];

      if (targetCompiledIds.length === 0) {
        return;
      }

      const allTargetsArePriorIterationReferences =
        reference.iteration !== undefined &&
        targetCompiledIds.every((targetCompiledId) => {
          const targetNode = context.compiled_node_by_id.get(targetCompiledId);

          return (
            targetNode?.repeat_scope_id !== undefined &&
            targetNode.repeat_scope_id === node.repeat_scope_id
          );
        });
      const orderedTargetIds = targetCompiledIds.filter((targetCompiledId) =>
        isReachable(forwardAdjacency, targetCompiledId, node.compiled_id)
      );

      if (!allTargetsArePriorIterationReferences && orderedTargetIds.length !== targetCompiledIds.length) {
        context.diagnostics.push({
          path: `${path}.${path_suffix}.node`,
          message: `${path_suffix === "review_from" ? "review_from" : "context_from"} node "${reference.node}" is not guaranteed to execute before "${node.authored_id}".`
        });
      }

      targetCompiledIds.forEach((targetCompiledId) => {
        const targetNode = context.compiled_node_by_id.get(targetCompiledId);

        if (
          targetNode?.repeat_scope_id &&
          targetNode.repeat_scope_id !== node.repeat_scope_id &&
          reference.iteration === undefined
        ) {
          context.diagnostics.push({
            path: `${path}.${path_suffix}.iteration`,
            message: `${path_suffix === "review_from" ? "review_from" : "context_from"} node "${reference.node}" requires an iteration selector outside repeat scope "${targetNode.repeat_scope_id}".`
          });
        }
      });
    });
  });
}

export function compileAuthoredGraph(
  document: AuthoredGraphDocument,
  launch: LaunchResolution,
  loweredManagedNodes: LoweredManagedNode[] = []
): CompileGraphResult {
  const lowered_managed_kind_by_id = new Map<string, LoweredManagedKind>(
    loweredManagedNodes.map((item) => [item.authored_id, item.managed_kind])
  );

  const context: CompileContext = {
    document,
    launch,
    diagnostics: [...launch.diagnostics],
    nodes: [],
    edges: [],
    scopes: [],
    authored_to_compiled: new Map<string, string[]>(),
    compiled_node_by_id: new Map<string, CompiledExecutableNode>(),
    authored_paths: new Map<string, string>(),
    lowered_managed_kind_by_id,
    edge_counter: 0
  };

  const rootRegion = compileGraphNode(context, undefined, document.graph, "$.graph");
  finalizeNodeDependencies(context);

  const compiled_graph: CompiledGraph = {
    graph_id: document.graph_id,
    launch: {
      launch_profile: launch.launch_profile,
      workspace_backend: launch.workspace_backend
    },
    entry_node_ids: rootRegion.entry_node_ids,
    nodes: context.nodes,
    edges: context.edges,
    scopes: context.scopes,
    authored_to_compiled: Object.fromEntries(
      [...context.authored_to_compiled.entries()].map(([authoredId, compiledIds]) => [
        authoredId,
        dedupe(compiledIds)
      ])
    )
  };

  validateCompiledContextReferences(context, compiled_graph);

  return {
    ...(compiled_graph ? { compiled_graph } : {}),
    diagnostics: context.diagnostics
  };
}

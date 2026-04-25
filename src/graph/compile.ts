import { resolveSubpathWithinRoot } from "../path_rules.js";
import type { ResolvedPlugin } from "../plugins/workflows.js";
import type {
  AgentNode,
  CheckNode,
  ExecutableGraphNode,
  AuthoredGraphNode,
  ContainerGraphNode,
  ToolDeclaration
} from "./authored.js";
import type {
  CompileGraphResult,
  CompiledEdge,
  CompiledExecutableNode,
  CompiledGraph,
  CompiledScope,
  ResolvedTool,
  ResolvedToolSource
} from "./compiled.js";
import type { LoweredManagedNode } from "./normalize.js";
import {
  resolveExecutableRepoAlias,
  resolveNodePolicy
} from "./profiles.js";
import type { LaunchResolution } from "./profiles.js";
import type { GraphDiagnostic, LoweredManagedKind } from "./schema.js";
import type { AuthoredGraphDocument } from "./authored.js";
import type { CredentialSpecMap } from "../auth/types.js";

interface ScopeFrame {
  authored_id: string;
  kind: ContainerGraphNode["type"];
  authored_stack: string[];
  scope_id: string;
  scope_stack: string[];
  parent_scope_id: string | null;
  nearest_repeat_scope_id?: string;
  cleanup_scope_id?: string;
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
  plugins_by_alias: Map<string, ResolvedPlugin>;
  graph_dir: string | undefined;
  graph_scope_tools: ResolvedTool[];
  credential_specs: Map<string, CredentialSpecMap[string]>;
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
        : {}),
    ...(parentScopeFrame?.cleanup_scope_id
      ? { cleanup_scope_id: parentScopeFrame.cleanup_scope_id }
      : {})
  };
}

function callableNameForToolDeclaration(declaration: ToolDeclaration): string {
  return declaration.alias ?? `${declaration.from_plugin}-${declaration.tool}`;
}

function resolveToolDeclaration(
  declaration: ToolDeclaration,
  options: {
    declared_at: "graph" | "agent";
    declaration_path: string;
    plugins_by_alias: Map<string, ResolvedPlugin>;
    credential_specs: Map<string, CredentialSpecMap[string]>;
    diagnostics: GraphDiagnostic[];
  }
): ResolvedTool | undefined {
  const plugin = options.plugins_by_alias.get(declaration.from_plugin);
  if (!plugin) {
    options.diagnostics.push({
      path: `${options.declaration_path}.from_plugin`,
      message: `Plugin "${declaration.from_plugin}" is not declared or resolved.`
    });
    return undefined;
  }

  const exported = plugin.manifest.tools[declaration.tool];
  if (!exported) {
    options.diagnostics.push({
      path: `${options.declaration_path}.tool`,
      message: `Plugin "${declaration.from_plugin}" does not export tool "${declaration.tool}".`
    });
    return undefined;
  }

  const callable = callableNameForToolDeclaration(declaration);
  for (const credentialScope of exported.credentials ?? []) {
    const spec = plugin.manifest.credentials[credentialScope];
    if (!spec) {
      options.diagnostics.push({
        path: `${options.declaration_path}.tool`,
        message: `Plugin tool "${declaration.from_plugin}/${declaration.tool}" references unknown credential scope "${credentialScope}".`
      });
      return undefined;
    }

    const existing = options.credential_specs.get(credentialScope);
    if (existing && JSON.stringify(existing) !== JSON.stringify(spec)) {
      options.diagnostics.push({
        path: `${options.declaration_path}.tool`,
        message: `Credential scope "${credentialScope}" is declared by multiple plugins with different field contracts.`
      });
      return undefined;
    }
    options.credential_specs.set(credentialScope, spec);
  }

  let executablePath: string;
  try {
    executablePath = resolveSubpathWithinRoot(
      plugin.root,
      exported.executable,
      "Plugin tool executable path"
    );
  } catch (error) {
    options.diagnostics.push({
      path: options.declaration_path,
      message:
        error instanceof Error
          ? error.message
          : "Plugin tool executable path is invalid."
    });
    return undefined;
  }

  const source: ResolvedToolSource = {
    kind: "plugin",
    alias: declaration.from_plugin,
    tool: declaration.tool,
    plugin_root: plugin.root,
    declared_at: options.declared_at,
    declaration_path: options.declaration_path
  };

  return {
    callable_name: callable,
    capability: exported.capability,
    impact: exported.impact,
    ...(exported.description ? { description: exported.description } : {}),
    ...(exported.usage ? { usage: exported.usage } : {}),
    executable_path: executablePath,
    args: [...(exported.args ?? [])],
    config: {},
    ...(exported.config_schema ? { config_schema: exported.config_schema } : {}),
    ...(exported.credentials && exported.credentials.length > 0 ? { credentials: [...exported.credentials] } : {}),
    source
  };
}

function buildGraphScopeTools(
  document: AuthoredGraphDocument,
  options: {
    plugins_by_alias: Map<string, ResolvedPlugin>;
    credential_specs: Map<string, CredentialSpecMap[string]>;
    diagnostics: GraphDiagnostic[];
  }
): ResolvedTool[] {
  const tools: ResolvedTool[] = [];
  const seenNames = new Set<string>();

  (document.tools ?? []).forEach((declaration, index) => {
    const declarationPath = `$.tools[${index}]`;
    const resolved = resolveToolDeclaration(declaration, {
      declared_at: "graph",
      declaration_path: declarationPath,
      plugins_by_alias: options.plugins_by_alias,
      credential_specs: options.credential_specs,
      diagnostics: options.diagnostics
    });

    if (!resolved) {
      return;
    }

    if (seenNames.has(resolved.callable_name)) {
      options.diagnostics.push({
        path: declarationPath,
        message: `Tool name "${resolved.callable_name}" is already declared in the graph scope.`
      });
      return;
    }

    seenNames.add(resolved.callable_name);
    tools.push(resolved);
  });

  return tools;
}

function applyToolConfigOverrides(
  tools: ResolvedTool[],
  overrides: Record<string, Record<string, string>> | undefined
): ResolvedTool[] {
  if (!overrides) {
    return tools;
  }
  return tools.map((tool) => {
    const override = overrides[tool.callable_name];
    if (!override) {
      return tool;
    }
    return {
      ...tool,
      config: { ...tool.config, ...override }
    };
  });
}

function buildAgentResolvedTools(
  context: CompileContext,
  agentNode: AgentNode,
  agentPath: string
): ResolvedTool[] {
  const baseTools = applyToolConfigOverrides(
    context.graph_scope_tools,
    context.document.tool_config
  );

  const baseNames = new Set<string>(baseTools.map((tool) => tool.callable_name));
  const effectiveTools: ResolvedTool[] = [...baseTools];

  (agentNode.tools ?? []).forEach((declaration, index) => {
    const declarationPath = `${agentPath}.tools[${index}]`;
    const resolved = resolveToolDeclaration(declaration, {
      declared_at: "agent",
      declaration_path: declarationPath,
      plugins_by_alias: context.plugins_by_alias,
      credential_specs: context.credential_specs,
      diagnostics: context.diagnostics
    });

    if (!resolved) {
      return;
    }

    if (baseNames.has(resolved.callable_name)) {
      context.diagnostics.push({
        path: declarationPath,
        message: `Tool name "${resolved.callable_name}" conflicts with a graph-level tool of the same name.`
      });
      return;
    }

    if (effectiveTools.some((existing) => existing.callable_name === resolved.callable_name)) {
      context.diagnostics.push({
        path: declarationPath,
        message: `Tool name "${resolved.callable_name}" is already declared on this agent.`
      });
      return;
    }

    effectiveTools.push(resolved);
  });

  return applyToolConfigOverrides(effectiveTools, agentNode.tool_config);
}

function resolveCheckFields(
  node: CheckNode,
  nodePolicyResolution: ReturnType<typeof resolveNodePolicy>
): Pick<CompiledExecutableNode, never> & {
  env_files?: CheckNode["env_files"];
  env?: CheckNode["env"];
  pass_if?: CheckNode["pass_if"];
  rubric?: string;
} {
  if (node.check_kind === "deterministic") {
    return {
      ...(node.env_files !== undefined
        ? { env_files: node.env_files }
        : nodePolicyResolution.node_profile?.env_files !== undefined
          ? { env_files: nodePolicyResolution.node_profile.env_files }
          : nodePolicyResolution.launch_profile?.env_files !== undefined
            ? { env_files: nodePolicyResolution.launch_profile.env_files }
            : {}),
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
    ...(node.goal ? { goal: node.goal } : {}),
    ...(node.acceptance_criteria ? { acceptance_criteria: node.acceptance_criteria } : {}),
    repo: repo ?? "unknown",
    deps: [],
    scope_stack: scopeFrame.scope_stack,
    ...(scopeFrame.nearest_repeat_scope_id
      ? { repeat_scope_id: scopeFrame.nearest_repeat_scope_id }
      : {}),
    effective_policy: nodePolicyResolution.policy,
    context: node.context ?? [],
    declared_artifacts: node.artifacts ?? {},
    ...(lowered_from ? { lowered_from } : {}),
    ...(scopeFrame.cleanup_scope_id
      ? { is_cleanup: true as const, cleanup_scope_id: scopeFrame.cleanup_scope_id }
      : {})
  };

  let compiledNode: CompiledExecutableNode;

  if (node.type === "agent") {
    const resolvedTools = buildAgentResolvedTools(context, node, path);
    compiledNode = {
      ...compiledBase,
      kind: "agent",
      prompt: node.prompt ?? node.goal ?? "",
      tools: resolvedTools
    };
  } else if (node.type === "exec") {
    const env_files =
      node.env_files !== undefined
        ? node.env_files
        : nodePolicyResolution.node_profile?.env_files !== undefined
          ? nodePolicyResolution.node_profile.env_files
          : nodePolicyResolution.launch_profile?.env_files;

    compiledNode = {
      ...compiledBase,
      kind: "exec",
      command: node.command,
      args: node.args ?? [],
      on_failure: node.on_failure ?? "fail",
      ...(node.cwd ? { cwd: node.cwd } : {}),
      ...(env_files !== undefined ? { env_files } : {}),
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
      on_failure: node.on_failure ?? "fail",
      ...(node.command ? { command: node.command } : {}),
      ...(node.args ? { args: node.args } : {}),
      ...(node.cwd ? { cwd: node.cwd } : {}),
      ...(resolvedCheckFields.env_files !== undefined ? { env_files: resolvedCheckFields.env_files } : {}),
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

  let cleanupRegion: CompiledRegion | undefined;
  if (node.cleanup && node.cleanup.length > 0) {
    cleanupRegion = compileCleanupSteps(context, scopeFrame, node.cleanup, path);
  }

  context.scopes.push({
    scope_id: scopeFrame.scope_id,
    authored_id: node.id,
    kind: "sequence",
    parent_scope_id: scopeFrame.parent_scope_id,
    scope_stack: scopeFrame.scope_stack,
    entry_node_ids: region.entry_node_ids,
    exit_node_ids: region.exit_node_ids,
    compiled_node_ids: dedupe([
      ...region.compiled_node_ids,
      ...(cleanupRegion?.compiled_node_ids ?? [])
    ]),
    ...(cleanupRegion
      ? {
          cleanup_entry_node_ids: cleanupRegion.entry_node_ids,
          cleanup_exit_node_ids: cleanupRegion.exit_node_ids,
          cleanup_compiled_node_ids: cleanupRegion.compiled_node_ids
        }
      : {})
  });

  return region;
}

function compileCleanupSteps(
  context: CompileContext,
  parentScopeFrame: ScopeFrame,
  cleanupSteps: AuthoredGraphNode[],
  path: string
): CompiledRegion {
  const cleanupScopeFrame: ScopeFrame = {
    ...parentScopeFrame,
    cleanup_scope_id: parentScopeFrame.scope_id
  };

  const childRegions = cleanupSteps.map((child, index) =>
    compileGraphNode(context, cleanupScopeFrame, child, `${path}.cleanup[${index}]`)
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
            kind: "flow",
            is_cleanup: true,
            cleanup_scope_id: parentScopeFrame.scope_id
          });
        });
      });
    }

    priorExitNodeIds = childRegion.exit_node_ids;
  });

  return {
    entry_node_ids,
    exit_node_ids: priorExitNodeIds,
    compiled_node_ids: dedupe(compiled_node_ids)
  };
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
      const actualExitNode = context.compiled_node_by_id.get(bodyRegion.exit_node_ids[0]);
      context.diagnostics.push({
        path: `${path}.until.node`,
        message:
          `repeat.until.node must resolve to the body exit node in this release. ` +
          `The body currently exits through "${actualExitNode?.authored_id ?? bodyRegion.exit_node_ids[0]}".`
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

function validateCompiledArtifactReferences(
  context: CompileContext,
  compiledGraph: CompiledGraph
): void {
  const forwardAdjacency = buildAdjacency(compiledGraph.edges, {
    includeRepeatBackEdges: false
  });

  compiledGraph.nodes.forEach((node) => {
    const references = [
      ...node.context
        .map((item, index) => "ref" in item
          ? {
              reference: item,
              path_suffix: `context[${index}]`
            }
          : undefined)
        .filter((item): item is { reference: Extract<CompiledExecutableNode["context"][number], { ref: string }>; path_suffix: string } => item !== undefined),
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
          message: `${path_suffix === "review_from" ? "review_from" : "context"} node "${reference.node}" is not guaranteed to execute before "${node.authored_id}".`
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
            message:
              `${path_suffix === "review_from" ? "review_from" : "context"} node "${reference.node}" ` +
              `requires an iteration selector outside repeat scope "${targetNode.repeat_scope_id}". ` +
              `Use "latest_failed" or "latest_passed" when you want the most recent failed or passed iteration.`
          });
        }
      });
    });
  });
}

function validateManagedSoftFailureRules(
  context: CompileContext,
  compiledGraph: CompiledGraph
): void {
  compiledGraph.nodes.forEach((node) => {
    if ((node.kind !== "exec" && node.kind !== "check") || node.on_failure !== "continue") {
      return;
    }

    if (!node.authored_id.includes("__managed__")) {
      return;
    }

    const path = context.authored_paths.get(node.authored_id) ?? `$.graph.${node.authored_id}`;
    const allowedManagedSoftVerifier =
      node.authored_id.includes("__managed__pattern_generate_evaluate_fix__evaluate_");

    if (!allowedManagedSoftVerifier) {
      context.diagnostics.push({
        path,
        message: `Managed pattern node "${node.authored_id}" cannot use on_failure = "continue".`
      });
    }
  });
}

export interface CompileAuthoredGraphOptions {
  resolved_plugins?: ResolvedPlugin[];
  graph_dir?: string;
}

export function compileAuthoredGraph(
  document: AuthoredGraphDocument,
  launch: LaunchResolution,
  loweredManagedNodes: LoweredManagedNode[] = [],
  options: CompileAuthoredGraphOptions = {}
): CompileGraphResult {
  const lowered_managed_kind_by_id = new Map<string, LoweredManagedKind>(
    loweredManagedNodes.map((item) => [item.authored_id, item.managed_kind])
  );

  const plugins_by_alias = new Map<string, ResolvedPlugin>(
    (options.resolved_plugins ?? []).map((plugin) => [plugin.alias, plugin])
  );
  const compileDiagnostics: GraphDiagnostic[] = [...launch.diagnostics];
  const credential_specs = new Map<string, CredentialSpecMap[string]>();
  const graph_scope_tools = buildGraphScopeTools(document, {
    plugins_by_alias,
    credential_specs,
    diagnostics: compileDiagnostics
  });

  const context: CompileContext = {
    document,
    launch,
    diagnostics: compileDiagnostics,
    nodes: [],
    edges: [],
    scopes: [],
    authored_to_compiled: new Map<string, string[]>(),
    compiled_node_by_id: new Map<string, CompiledExecutableNode>(),
    authored_paths: new Map<string, string>(),
    lowered_managed_kind_by_id,
    edge_counter: 0,
    plugins_by_alias,
    graph_dir: options.graph_dir,
    graph_scope_tools,
    credential_specs
  };

  const rootRegion = compileGraphNode(context, undefined, document.graph, "$.graph");
  finalizeNodeDependencies(context);

  const compiled_graph: CompiledGraph = {
    graph_id: document.graph_id,
    intent: document.intent,
    supervision: document.supervision,
    delivery: document.delivery,
    launch: {
      launch_profile: launch.launch_profile,
      workspace_backend: launch.workspace_backend
    },
    entry_node_ids: rootRegion.entry_node_ids,
    nodes: context.nodes,
    edges: context.edges,
    scopes: context.scopes,
    prerequisites: document.prerequisites ?? { checks: [] },
    credential_specs: Object.fromEntries(
      [...context.credential_specs.entries()].sort(([left], [right]) => left.localeCompare(right))
    ),
    authored_to_compiled: Object.fromEntries(
      [...context.authored_to_compiled.entries()].map(([authoredId, compiledIds]) => [
        authoredId,
        dedupe(compiledIds)
      ])
    )
  };

  validateCompiledArtifactReferences(context, compiled_graph);
  validateManagedSoftFailureRules(context, compiled_graph);

  return {
    ...(compiled_graph ? { compiled_graph } : {}),
    diagnostics: context.diagnostics
  };
}

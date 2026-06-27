import { resolveSubpathWithinRoot } from "../path_rules.js";
import type { ResolvedPlugin } from "../plugins/workflows.js";
import type {
  AgentNode,
  CheckNode,
  ExecutableGraphNode,
  AuthoredGraphNode,
  ContainerGraphNode,
  CliHint,
  ManagedRuntimeMetadata,
  ManagedToolDefinition,
  NodeSupport,
  SupportReference
} from "./authored.js";
import type {
  CompileGraphResult,
  CompiledEdge,
  CompiledExecutableNode,
  CompiledGraph,
  CompiledScope,
  ResolvedSkill,
  ResolvedTool,
  ResolvedToolSource
} from "./compiled.js";
import type { LoweredManagedNode } from "./normalize.js";
import {
  resolveExecutableRepoAlias,
  resolveNodePolicy,
  resolveSupervisorPolicy
} from "./profiles.js";
import type { LaunchResolution } from "./profiles.js";
import type { GraphDiagnostic, LoweredManagedKind } from "./schema.js";
import type { AuthoredGraphDocument } from "./authored.js";
import type { CredentialSpecMap } from "../auth/types.js";
import type { ResolvedSkillSource } from "../skills/sources.js";

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
  skill_sources_by_alias: Map<string, ResolvedSkillSource>;
  graph_dir: string | undefined;
  tool_registry: Map<string, ResolvedTool>;
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

function splitManagedToolRef(ref: string): { pluginAlias: string; toolName: string } | undefined {
  const slashIndex = ref.indexOf("/");
  if (slashIndex <= 0 || slashIndex === ref.length - 1 || ref.indexOf("/", slashIndex + 1) !== -1) {
    return undefined;
  }
  return {
    pluginAlias: ref.slice(0, slashIndex),
    toolName: ref.slice(slashIndex + 1)
  };
}

function callableNameForToolDeclaration(declaration: ManagedToolDefinition): string {
  const split = splitManagedToolRef(declaration.ref);
  return declaration.alias ?? (split ? `${split.pluginAlias}-${split.toolName}` : declaration.ref);
}

function resolveToolDeclaration(
  declaration: ManagedToolDefinition,
  options: {
    declaration_path: string;
    plugins_by_alias: Map<string, ResolvedPlugin>;
    credential_specs: Map<string, CredentialSpecMap[string]>;
    diagnostics: GraphDiagnostic[];
  }
): ResolvedTool | undefined {
  const split = splitManagedToolRef(declaration.ref);
  if (!split) {
    options.diagnostics.push({
      path: `${options.declaration_path}.ref`,
      message: 'Managed tool refs must use "pluginAlias/toolName" form.'
    });
    return undefined;
  }

  const plugin = options.plugins_by_alias.get(split.pluginAlias);
  if (!plugin) {
    options.diagnostics.push({
      path: `${options.declaration_path}.ref`,
      message: `Plugin "${split.pluginAlias}" is not declared or resolved.`
    });
    return undefined;
  }

  const exported = plugin.manifest.tools[split.toolName];
  if (!exported) {
    options.diagnostics.push({
      path: `${options.declaration_path}.ref`,
      message: `Plugin "${split.pluginAlias}" does not export tool "${split.toolName}".`
    });
    return undefined;
  }

  const callable = callableNameForToolDeclaration(declaration);
  for (const credentialScope of exported.credentials ?? []) {
    const spec = plugin.manifest.credentials[credentialScope];
    if (!spec) {
      options.diagnostics.push({
        path: `${options.declaration_path}.tool`,
        message: `Plugin tool "${split.pluginAlias}/${split.toolName}" references unknown credential scope "${credentialScope}".`
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
    alias: split.pluginAlias,
    tool: split.toolName,
    plugin_root: plugin.root,
    declared_at: "registry",
    declaration_path: options.declaration_path
  };

  return {
    callable_name: callable,
    ...(exported.description ? { description: exported.description } : {}),
    executable_path: executablePath,
    config: { ...(declaration.config ?? {}) },
    ...(exported.config_schema ? { config_schema: exported.config_schema } : {}),
    ...(exported.credentials && exported.credentials.length > 0 ? { credentials: [...exported.credentials] } : {}),
    source
  };
}

function buildToolRegistry(
  document: AuthoredGraphDocument,
  options: {
    plugins_by_alias: Map<string, ResolvedPlugin>;
    credential_specs: Map<string, CredentialSpecMap[string]>;
    diagnostics: GraphDiagnostic[];
  }
): Map<string, ResolvedTool> {
  const tools = new Map<string, ResolvedTool>();
  const seenNames = new Set<string>();

  Object.entries(document.tools ?? {}).forEach(([toolId, declaration]) => {
    const declarationPath = `$.tools.${toolId}`;
    const resolved = resolveToolDeclaration(declaration, {
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
        message: `Tool callable name "${resolved.callable_name}" is already declared by another managed tool registry entry.`
      });
      return;
    }

    seenNames.add(resolved.callable_name);
    tools.set(toolId, resolved);
  });

  return tools;
}

interface ExpandedSupport {
  skills: string[];
  toolRefs: SupportReference[];
  cli: CliHint[];
}

function mergeCliHints(
  target: CliHint[],
  next: CliHint[],
  path: string,
  diagnostics: GraphDiagnostic[]
): void {
  for (const hint of next) {
    const existing = target.find((item) => item.cmd === hint.cmd);
    if (!existing) {
      target.push(hint);
      continue;
    }
    if ((existing.description ?? "") !== (hint.description ?? "")) {
      diagnostics.push({
        path,
        message: `CLI hint "${hint.cmd}" is declared with conflicting descriptions.`
      });
    }
  }
}

function expandSupport(
  document: AuthoredGraphDocument,
  support: NodeSupport | undefined,
  path: string,
  diagnostics: GraphDiagnostic[]
): ExpandedSupport {
  const skills: string[] = [];
  const toolRefs: SupportReference[] = [];
  const cli: CliHint[] = [];

  for (const [index, capabilityRef] of (support?.capabilities ?? []).entries()) {
    const capability = document.capabilities?.[capabilityRef.ref];
    if (!capability) {
      diagnostics.push({
        path: `${path}.support.capabilities[${index}].ref`,
        message: `Capability "${capabilityRef.ref}" is not declared.`
      });
      continue;
    }

    skills.push(...(capability.skills ?? []));
    toolRefs.push(...(capability.tools ?? []));
    mergeCliHints(cli, capability.cli ?? [], `$.capabilities.${capabilityRef.ref}.cli`, diagnostics);
  }

  skills.push(...(support?.skills ?? []));
  toolRefs.push(...(support?.tools ?? []));
  mergeCliHints(cli, support?.cli ?? [], `${path}.support.cli`, diagnostics);

  return {
    skills: dedupe(skills),
    toolRefs,
    cli
  };
}

function splitSkillRef(ref: string): { sourceAlias: string; skillPath: string } | undefined {
  const slashIndex = ref.indexOf("/");
  if (slashIndex <= 0 || slashIndex === ref.length - 1) {
    return undefined;
  }
  return {
    sourceAlias: ref.slice(0, slashIndex),
    skillPath: ref.slice(slashIndex + 1)
  };
}

function buildResolvedSkills(
  context: CompileContext,
  skillRefs: string[],
  nodePath: string
): ResolvedSkill[] {
  const resolved: ResolvedSkill[] = [];

  skillRefs.forEach((ref, index) => {
    const split = splitSkillRef(ref);
    if (!split) {
      context.diagnostics.push({
        path: `${nodePath}.support.skills[${index}]`,
        message: 'Skill refs must use "sourceAlias/skillName" form.'
      });
      return;
    }

    const source = context.skill_sources_by_alias.get(split.sourceAlias);
    if (!source) {
      context.diagnostics.push({
        path: `${nodePath}.support.skills[${index}]`,
        message: `Skill source "${split.sourceAlias}" is not declared or resolved.`
      });
      return;
    }

    const skill = source.skills.get(split.skillPath);
    if (!skill) {
      context.diagnostics.push({
        path: `${nodePath}.support.skills[${index}]`,
        message: `Skill "${ref}" is not installed in source "${split.sourceAlias}".`
      });
      return;
    }

    resolved.push({
      ref,
      source_alias: split.sourceAlias,
      name: skill.name,
      description: skill.description,
      path: skill.path
    });
  });

  return resolved;
}

function buildAgentResolvedTools(
  context: CompileContext,
  toolRefs: SupportReference[],
  agentPath: string
): ResolvedTool[] {
  const effectiveTools: ResolvedTool[] = [];
  const seenNames = new Set<string>();
  const seenRefs = new Set<string>();

  toolRefs.forEach((reference, index) => {
    const declarationPath = `${agentPath}.support.tools[${index}]`;
    if (seenRefs.has(reference.ref)) {
      return;
    }

    const resolved = context.tool_registry.get(reference.ref);
    if (!resolved) {
      context.diagnostics.push({
        path: `${declarationPath}.ref`,
        message: `Managed tool "${reference.ref}" is not declared in top-level tools.`
      });
      return;
    }

    seenRefs.add(reference.ref);

    if (seenNames.has(resolved.callable_name)) {
      context.diagnostics.push({
        path: declarationPath,
        message: `Tool callable name "${resolved.callable_name}" is already granted to this node.`
      });
      return;
    }

    seenNames.add(resolved.callable_name);
    effectiveTools.push(resolved);
  });

  return effectiveTools;
}

const workListDeepWorkPhaseNames = ["plan", "execute", "verify", "publish"] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function mergeNodeSupport(base: NodeSupport | undefined, override: NodeSupport | undefined): NodeSupport | undefined {
  if (!base && !override) {
    return undefined;
  }
  const merged: NodeSupport = {
    ...(base ?? {}),
    ...(override ?? {})
  };
  const capabilities = [...(base?.capabilities ?? []), ...(override?.capabilities ?? [])];
  const skills = [...(base?.skills ?? []), ...(override?.skills ?? [])];
  const tools = [...(base?.tools ?? []), ...(override?.tools ?? [])];
  const cli = [...(base?.cli ?? []), ...(override?.cli ?? [])];
  const contextItems = [...(base?.context ?? []), ...(override?.context ?? [])];
  if (capabilities.length > 0) {
    merged.capabilities = capabilities;
  }
  if (skills.length > 0) {
    merged.skills = skills;
  }
  if (tools.length > 0) {
    merged.tools = tools;
  }
  if (cli.length > 0) {
    merged.cli = cli;
  }
  if (contextItems.length > 0) {
    merged.context = contextItems;
  }
  return merged;
}

function resolveWorkListDeepWorkPhaseTemplates(
  context: CompileContext,
  node: ExecutableGraphNode,
  path: string
): ManagedRuntimeMetadata | undefined {
  const managedRuntime = node.managed_runtime;
  if (
    !managedRuntime ||
    managedRuntime.kind !== "pattern_work_list" ||
    managedRuntime.phase !== "run_items" ||
    node.type !== "agent"
  ) {
    return managedRuntime;
  }

  const config = asRecord(managedRuntime.config);
  const itemWorker = asRecord(config?.item_worker);
  const phases = asRecord(itemWorker?.phases);
  if (itemWorker?.kind !== "deep_work" || !phases) {
    return managedRuntime;
  }

  const templates: Record<string, unknown> = {};
  for (const phase of workListDeepWorkPhaseNames) {
    const phaseRecord = asRecord(phases[phase]);
    if (!phaseRecord) {
      continue;
    }

    const phaseSupport = asRecord(phaseRecord.support) as NodeSupport | undefined;
    const phaseRuntime = asRecord(phaseRecord.runtime);
    const phaseReasoningEffort = typeof phaseRecord.reasoning_effort === "string"
      ? phaseRecord.reasoning_effort as AgentNode["reasoning_effort"]
      : undefined;
    const phaseSandbox = typeof phaseRecord.sandbox === "string"
      ? phaseRecord.sandbox as AgentNode["sandbox"]
      : undefined;
    const mergedPhaseSupport = phaseSupport ? mergeNodeSupport(node.support, phaseSupport) : undefined;
    const syntheticNode: AgentNode = {
      ...node,
      id: `${node.id}__item_${phase}`,
      runtime: {
        ...(node.runtime ?? {}),
        ...(typeof phaseRuntime?.profile === "string" ? { profile: phaseRuntime.profile } : {})
      },
      ...(typeof phaseRecord.model === "string" ? { model: phaseRecord.model } : {}),
      ...(phaseReasoningEffort ? { reasoning_effort: phaseReasoningEffort } : {}),
      ...(phaseSandbox ? { sandbox: phaseSandbox } : {}),
      ...(mergedPhaseSupport ? { support: mergedPhaseSupport } : {})
    };

    const phasePolicyResolution = resolveNodePolicy(context.document, context.launch, syntheticNode);
    context.diagnostics.push(...phasePolicyResolution.diagnostics);
    const expandedPhaseSupport = expandSupport(
      context.document,
      syntheticNode.support,
      `${path}.managed_runtime.config.item_worker.phases.${phase}`,
      context.diagnostics
    );
    templates[phase] = {
      effective_policy: phasePolicyResolution.policy,
      context: syntheticNode.support?.context ?? [],
      skills: buildResolvedSkills(context, expandedPhaseSupport.skills, `${path}.managed_runtime.config.item_worker.phases.${phase}`),
      cli: expandedPhaseSupport.cli,
      tools: phase === "verify"
        ? []
        : buildAgentResolvedTools(context, expandedPhaseSupport.toolRefs, `${path}.managed_runtime.config.item_worker.phases.${phase}`)
    };
  }

  if (Object.keys(templates).length === 0) {
    return managedRuntime;
  }

  return {
    ...managedRuntime,
    config: {
      ...(config ?? {}),
      item_worker: {
        ...(itemWorker ?? {}),
        phase_templates: templates
      }
    }
  };
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
  const repo = resolveExecutableRepoAlias(context.document, node.runtime?.repo);
  const nodePolicyResolution = resolveNodePolicy(context.document, context.launch, node);
  context.diagnostics.push(...nodePolicyResolution.diagnostics);
  context.authored_paths.set(node.id, path);

  if (!repo) {
    context.diagnostics.push({
      path: `${path}.runtime.repo`,
      message: "Executable node could not resolve a repo alias."
    });
    return {
      entry_node_ids: [],
      exit_node_ids: [],
      compiled_node_ids: []
    };
  }

  const compiled_id = createCompiledId(scopeFrame, node.id);
  const lowered_from = context.lowered_managed_kind_by_id.get(node.id);
  const expandedSupport = expandSupport(context.document, node.support, path, context.diagnostics);
  const resolvedSkills = buildResolvedSkills(context, expandedSupport.skills, path);
  const isPromptBackedNode = node.type === "agent" || (node.type === "check" && node.check_kind === "ai");
  const managedRuntime = resolveWorkListDeepWorkPhaseTemplates(context, node, path);

  if (node.type !== "agent" && expandedSupport.toolRefs.length > 0) {
    context.diagnostics.push({
      path: `${path}.support`,
      message: "Managed plugin tools can only be granted to agent nodes."
    });
  }

  if (!isPromptBackedNode && expandedSupport.skills.length > 0) {
    context.diagnostics.push({
      path: `${path}.support.skills`,
      message: "Skills can only be attached to prompt-backed agent or AI check nodes."
    });
  }

  if (!isPromptBackedNode && expandedSupport.cli.length > 0) {
    context.diagnostics.push({
      path: `${path}.support.cli`,
      message: "CLI hints can only be attached to prompt-backed agent or AI check nodes."
    });
  }

  const compiledBase = {
    compiled_id,
    authored_id: node.id,
    kind: node.type,
    ...(node.label ? { label: node.label } : {}),
    intent: node.intent,
    repo,
    deps: [],
    scope_stack: scopeFrame.scope_stack,
    ...(scopeFrame.nearest_repeat_scope_id
      ? { repeat_scope_id: scopeFrame.nearest_repeat_scope_id }
      : {}),
    effective_policy: nodePolicyResolution.policy,
    context: node.support?.context ?? [],
    declared_artifacts: node.artifacts ?? {},
    ...(node.managed_artifact_forwards ? { managed_artifact_forwards: node.managed_artifact_forwards } : {}),
    ...(managedRuntime ? { managed_runtime: managedRuntime } : {}),
    ...(node.managed_prompt ? { managed_prompt: node.managed_prompt } : {}),
    skills: resolvedSkills,
    cli: expandedSupport.cli,
    ...(lowered_from ? { lowered_from } : {}),
    ...(scopeFrame.cleanup_scope_id
      ? { is_cleanup: true as const, cleanup_scope_id: scopeFrame.cleanup_scope_id }
      : {})
  };

  let compiledNode: CompiledExecutableNode;

  if (node.type === "agent") {
    const resolvedTools = buildAgentResolvedTools(context, expandedSupport.toolRefs, path);
    compiledNode = {
      ...compiledBase,
      kind: "agent",
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
      node.authored_id.includes("__managed__pattern_deep_work__criterion_") ||
      node.authored_id.includes("__managed__pattern_work_list__criterion_");

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
  resolved_skill_sources?: ResolvedSkillSource[];
  graph_dir?: string;
}

export function compileAuthoredGraph(
  document: AuthoredGraphDocument,
  launch: LaunchResolution,
  loweredManagedNodes: LoweredManagedNode[] = [],
  options: CompileAuthoredGraphOptions = {}
): CompileGraphResult {
  if (launch.diagnostics.length > 0) {
    return {
      diagnostics: [...launch.diagnostics]
    };
  }

  const lowered_managed_kind_by_id = new Map<string, LoweredManagedKind>(
    loweredManagedNodes.map((item) => [item.authored_id, item.managed_kind])
  );

  const plugins_by_alias = new Map<string, ResolvedPlugin>(
    (options.resolved_plugins ?? []).map((plugin) => [plugin.alias, plugin])
  );
  const skill_sources_by_alias = new Map<string, ResolvedSkillSource>(
    (options.resolved_skill_sources ?? []).map((source) => [source.alias, source])
  );
  const compileDiagnostics: GraphDiagnostic[] = [...launch.diagnostics];
  const credential_specs = new Map<string, CredentialSpecMap[string]>();
  const tool_registry = buildToolRegistry(document, {
    plugins_by_alias,
    credential_specs,
    diagnostics: compileDiagnostics
  });
  const supervisorPolicyResolution = resolveSupervisorPolicy(document, launch);
  compileDiagnostics.push(...supervisorPolicyResolution.diagnostics);

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
    skill_sources_by_alias,
    graph_dir: options.graph_dir,
    tool_registry,
    credential_specs
  };

  const rootRegion = compileGraphNode(context, undefined, document.graph, "$.graph");
  finalizeNodeDependencies(context);

  const compiled_graph: CompiledGraph = {
    graph_id: document.graph_id,
    intent: document.intent,
    supervision: document.supervision,
    ...(supervisorPolicyResolution.policy
      ? { supervisor_effective_policy: supervisorPolicyResolution.policy }
      : {}),
    launch: {
      launch_profile: launch.launch_profile,
      workspace_backend: launch.workspace_backend
    },
    entry_node_ids: rootRegion.entry_node_ids,
    nodes: context.nodes,
    edges: context.edges,
    scopes: context.scopes,
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

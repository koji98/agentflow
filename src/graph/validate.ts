import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { isRelativeSubpath } from "../path_rules.js";
import type {
  AgentNode,
  AuthoredGraphDocument,
  AuthoredGraphNode,
  AuthoredGraphSummary,
  ContainerGraphNode,
  ArtifactReference,
  CliHint,
  ContextItem,
  ExecutableGraphNode,
  ResolvedArtifactContextRef,
  ManagedToolDefinition,
  SupportReference,
  GraphProfile,
  HarnessConfig
} from "./authored.js";
import { normalizeAuthoredGraphDocument } from "./normalize.js";
import type { LoweredManagedNode } from "./normalize.js";
import { resolveLaunchConfig, resolveNodePolicy, resolveSupervisorPolicy } from "./profiles.js";
import {
  reservedArtifactNames,
  reservedToolNames,
  toolNamePattern
} from "./schema.js";
import type { GraphDiagnostic } from "./schema.js";
import type { HarnessName } from "./schema.js";
import { expandPluginWorkflows, type PluginToolExport, type ResolvedPlugin } from "../plugins/workflows.js";
import {
  loadResolvedSkillSources,
  readSkillSourceDeclarations,
  type ResolvedSkillSource
} from "../skills/sources.js";
import {
  interpolateGraphConfig,
  mergeConfig,
  validateConfigAgainstSchema,
  type GraphConfig
} from "./config.js";

export type ValidationDiagnostic = GraphDiagnostic;

export interface LoadedGraphDocument {
  document?: AuthoredGraphDocument;
  diagnostics: ValidationDiagnostic[];
  absolute_path: string;
  lowered_managed_nodes: LoweredManagedNode[];
  resolved_plugins?: ResolvedPlugin[];
  resolved_skill_sources?: ResolvedSkillSource[];
}

interface NodeMetadata {
  node: AuthoredGraphNode;
  path: string;
  parent_scope_ids: string[];
  nearest_repeat_id?: string;
  in_cleanup?: boolean;
}

function isExecutableNode(node: AuthoredGraphNode): node is ExecutableGraphNode {
  return node.type === "agent" || node.type === "exec" || node.type === "check" || node.type === "checkpoint";
}

function visitNodes(
  node: AuthoredGraphNode,
  visit: (node: AuthoredGraphNode, metadata: NodeMetadata) => void,
  path: string,
  parent_scope_ids: string[] = [],
  nearest_repeat_id?: string,
  in_cleanup = false
): void {
  const metadata: NodeMetadata = {
    node,
    path,
    parent_scope_ids,
    ...(nearest_repeat_id ? { nearest_repeat_id } : {}),
    ...(in_cleanup ? { in_cleanup: true } : {})
  };

  visit(node, metadata);

  if (node.type === "sequence" || node.type === "parallel") {
    node.steps.forEach((child, index) =>
      visitNodes(
        child,
        visit,
        `${path}.steps[${index}]`,
        [...parent_scope_ids, node.id],
        nearest_repeat_id,
        in_cleanup
      )
    );

    if (node.type === "sequence" && node.cleanup) {
      node.cleanup.forEach((child, index) =>
        visitNodes(
          child,
          visit,
          `${path}.cleanup[${index}]`,
          [...parent_scope_ids, node.id],
          nearest_repeat_id,
          true
        )
      );
    }
    return;
  }

  if (node.type === "repeat") {
    visitNodes(
      node.body,
      visit,
      `${path}.body`,
      [...parent_scope_ids, node.id],
      node.id,
      in_cleanup
    );
  }
}

function collectDescendantNodes(root: AuthoredGraphNode): AuthoredGraphNode[] {
  const descendants: AuthoredGraphNode[] = [];
  visitNodes(
    root,
    (node) => {
      descendants.push(node);
    },
    "$"
  );
  return descendants;
}

function readQualifiedRepoAlias(pathValue: string): string | undefined {
  const separatorIndex = pathValue.indexOf(":");

  if (separatorIndex <= 0) {
    return undefined;
  }

  return pathValue.slice(0, separatorIndex);
}

function readQualifiedRepoPath(pathValue: string): string {
  const separatorIndex = pathValue.indexOf(":");
  return separatorIndex <= 0 ? pathValue : pathValue.slice(separatorIndex + 1);
}

function validateWorkspaceContextPath(
  item: Extract<ContextItem, { from: "workspace_file" | "workspace_glob" }>,
  path: string,
  repoAliases: Set<string>,
  diagnostics: ValidationDiagnostic[]
): void {
  const repoAlias = readQualifiedRepoAlias(item.path);
  if (repoAlias && !repoAliases.has(repoAlias)) {
    diagnostics.push({
      path,
      message: `Unknown repo alias "${repoAlias}" in context path "${item.path}".`
    });
  }

  if (!isRelativeSubpath(readQualifiedRepoPath(item.path))) {
    diagnostics.push({
      path,
      message: `Context path "${item.path}" must stay within the selected repo root.`
    });
  }
}

function validateArtifactPath(
  artifactName: string,
  artifactPath: string,
  path: string,
  diagnostics: ValidationDiagnostic[]
): void {
  if (artifactPath.includes(":") || !isRelativeSubpath(artifactPath)) {
    diagnostics.push({
      path,
      message: `Artifact "${artifactName}" path "${artifactPath}" must stay within its source root.`
    });
  }
}

function validateNodeCwd(
  cwd: string | undefined,
  path: string,
  diagnostics: ValidationDiagnostic[]
): void {
  if (cwd === undefined) {
    return;
  }

  if (cwd.includes(":") || !isRelativeSubpath(cwd)) {
    diagnostics.push({
      path,
      message: `cwd "${cwd}" must stay within the node workspace root.`
    });
  }
}

function validateEnvFiles(
  envFiles: string[] | undefined,
  path: string,
  diagnostics: ValidationDiagnostic[]
): void {
  (envFiles ?? []).forEach((envFile, index) => {
    if (envFile.includes(":") || !isRelativeSubpath(envFile)) {
      diagnostics.push({
        path: `${path}[${index}]`,
        message: `env_files entry "${envFile}" must stay within the node workspace root.`
      });
    }
  });
}

function pushUniqueDiagnostic(
  diagnostics: ValidationDiagnostic[],
  seen: Set<string>,
  diagnostic: ValidationDiagnostic
): void {
  const key = `${diagnostic.path}\n${diagnostic.message}`;
  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  diagnostics.push(diagnostic);
}

function validateHarnessConfigForHarness(
  profileName: string,
  profile: GraphProfile | undefined,
  harness: HarnessName | undefined,
  path: string,
  diagnostics: ValidationDiagnostic[],
  seen: Set<string>
): void {
  const harnessConfig: HarnessConfig | undefined = profile?.harness_config;
  if (!harnessConfig || !harness) {
    return;
  }

  if (harness === "codex-cli" && harnessConfig.cursor) {
    pushUniqueDiagnostic(diagnostics, seen, {
      path: `${path}.cursor`,
      message: `Profile "${profileName}" resolves to harness "codex-cli" and cannot declare cursor harness config.`
    });
  }

  if (harness === "cursor-cli" && harnessConfig.codex) {
    pushUniqueDiagnostic(diagnostics, seen, {
      path: `${path}.codex`,
      message: `Profile "${profileName}" resolves to harness "cursor-cli" and cannot declare codex harness config.`
    });
  }

  if (
    harness === "cursor-cli" &&
    harnessConfig.isolation === "inherit_user" &&
    (harnessConfig.cursor?.config || harnessConfig.cursor?.permissions)
  ) {
    pushUniqueDiagnostic(diagnostics, seen, {
      path,
      message:
        `Profile "${profileName}" uses cursor-cli with isolation "inherit_user"; ` +
        "declared cursor.config and cursor.permissions require isolated generated config."
    });
  }
}

function validateArtifactReference(
  reference: ArtifactReference | ResolvedArtifactContextRef,
  path: string,
  currentNodeId: string,
  nodeIndex: Map<string, NodeMetadata>,
  diagnostics: ValidationDiagnostic[]
): void {
  const targetMetadata = nodeIndex.get(reference.node);

  if (!targetMetadata) {
    diagnostics.push({
      path: `${path}.node`,
      message: `Artifact reference points to unknown node "${reference.node}".`
    });
    return;
  }

  if (!isExecutableNode(targetMetadata.node)) {
    diagnostics.push({
      path: `${path}.node`,
      message: `Artifact reference points to "${reference.node}", but only executable nodes can provide artifacts.`
    });
    return;
  }

  if (reference.node === currentNodeId) {
    diagnostics.push({
      path: `${path}.node`,
      message: "Artifact references cannot reference the current node."
    });
  }

  const declaredArtifacts = new Set([
    ...Object.keys(targetMetadata.node.artifacts ?? {}),
    ...reservedArtifactNames
  ]);

  if (!declaredArtifacts.has(reference.artifact)) {
    diagnostics.push({
      path: `${path}.artifact`,
      message: `Artifact reference must name a declared or reserved artifact on node "${reference.node}".`
    });
  }
}

interface ValidateNormalizedDocumentOptions {
  resolved_plugins?: ResolvedPlugin[];
  resolved_skill_sources?: ResolvedSkillSource[];
  graph_dir?: string;
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

interface ValidatedToolDeclaration {
  exported: PluginToolExport;
  declaration: ManagedToolDefinition;
}

interface ToolDeclarationValidationResult {
  callable_names: Set<string>;
  tools_by_callable: Map<string, ValidatedToolDeclaration>;
}

function validateToolDeclarations(
  tools: Record<string, ManagedToolDefinition>,
  basePath: string,
  pluginsByAlias: Map<string, ResolvedPlugin>,
  diagnostics: ValidationDiagnostic[],
  options: {
    sandbox?: string;
  } = {}
): ToolDeclarationValidationResult {
  const callableNames = new Set<string>();
  const toolsByCallable = new Map<string, ValidatedToolDeclaration>();

  Object.entries(tools).forEach(([toolId, declaration]) => {
    const declarationPath = `${basePath}.${toolId}`;
    const split = splitManagedToolRef(declaration.ref);
    if (!split) {
      diagnostics.push({
        path: `${declarationPath}.ref`,
        message: 'Managed tool refs must use "pluginAlias/toolName" form.'
      });
      return;
    }

    const plugin = pluginsByAlias.get(split.pluginAlias);
    if (!plugin) {
      diagnostics.push({
        path: `${declarationPath}.ref`,
        message: `Plugin "${split.pluginAlias}" is not declared or resolved.`
      });
      return;
    }

    const exported = plugin.manifest.tools[split.toolName];
    if (!exported) {
      diagnostics.push({
        path: `${declarationPath}.ref`,
        message: `Plugin "${split.pluginAlias}" does not export tool "${split.toolName}".`
      });
      return;
    }

    const callable = callableNameForToolDeclaration(declaration);

    if (!toolNamePattern.test(callable)) {
      diagnostics.push({
        path: declarationPath,
        message: `Plugin tool callable name "${callable}" must match /^[a-z0-9][a-z0-9-]*$/.`
      });
      return;
    }

    if ((reservedToolNames as readonly string[]).includes(callable)) {
      diagnostics.push({
        path: declarationPath,
        message: `Plugin tool callable name "${callable}" is reserved for Agentflow runtime commands.`
      });
      return;
    }

    if (callableNames.has(callable)) {
      diagnostics.push({
        path: declarationPath,
        message: `Tool name "${callable}" is already declared in this scope.`
      });
      return;
    }

    validateToolConfig(declaration.config, `${declarationPath}.config`, exported, diagnostics);

    callableNames.add(callable);
    toolsByCallable.set(callable, { exported, declaration });
  });

  return {
    callable_names: callableNames,
    tools_by_callable: toolsByCallable
  };
}

const sensitiveToolConfigKeyPattern =
  /(^|[_-])(token|secret|password|passwd|api[_-]?key|credential|authorization|bearer)([_-]|$)/i;

function asToolSchemaRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function validateToolConfigSchema(
  config: Record<string, string>,
  schema: Record<string, unknown>,
  basePath: string,
  diagnostics: ValidationDiagnostic[]
): void {
  if (schema.type !== undefined && schema.type !== "object") {
    diagnostics.push({
      path: `${basePath}.config_schema.type`,
      message: "Only object tool config schemas are supported."
    });
    return;
  }

  const properties = asToolSchemaRecord(schema.properties) ?? {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];

  required.forEach((key) => {
    if (config[key] === undefined) {
      diagnostics.push({
        path: `${basePath}.${key}`,
        message: `Tool config is missing required property "${key}".`
      });
    }
  });

  if (schema.additionalProperties === false) {
    Object.keys(config)
      .filter((key) => properties[key] === undefined)
      .forEach((key) => {
        diagnostics.push({
          path: `${basePath}.${key}`,
          message: `Tool config does not allow property "${key}".`
        });
      });
  }

  Object.entries(properties).forEach(([key, propertySchema]) => {
    if (config[key] === undefined) {
      return;
    }

    const expectedType = asToolSchemaRecord(propertySchema)?.type;
    if (expectedType !== undefined && expectedType !== "string") {
      diagnostics.push({
        path: `${basePath}.${key}`,
        message: `Tool config property "${key}" must be ${String(expectedType)}, but tool config values are strings.`
      });
    }
  });
}

function validateToolConfig(
  config: Record<string, string> | undefined,
  basePath: string,
  exported: PluginToolExport,
  diagnostics: ValidationDiagnostic[]
): void {
  if (!config) {
    return;
  }

  for (const key of Object.keys(config)) {
    if (sensitiveToolConfigKeyPattern.test(key)) {
      diagnostics.push({
        path: `${basePath}.${key}`,
        message: `Tool config key "${key}" looks secret-bearing. Put secret values in plugin credentials and configure them with agentflow auth instead.`
      });
    }
  }

  if (exported.config_schema) {
    validateToolConfigSchema(config, exported.config_schema, basePath, diagnostics);
  }
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

function validateSkillRefs(
  refs: string[],
  path: string,
  skillSourcesByAlias: Map<string, ResolvedSkillSource>,
  diagnostics: ValidationDiagnostic[]
): void {
  refs.forEach((ref, index) => {
    const refPath = `${path}[${index}]`;
    const split = splitSkillRef(ref);
    if (!split) {
      diagnostics.push({
        path: refPath,
        message: 'Skill refs must use "sourceAlias/skillName" form.'
      });
      return;
    }
    const source = skillSourcesByAlias.get(split.sourceAlias);
    if (!source) {
      diagnostics.push({
        path: refPath,
        message: `Skill source "${split.sourceAlias}" is not declared or resolved.`
      });
      return;
    }
    if (!source.skills.has(split.skillPath)) {
      diagnostics.push({
        path: refPath,
        message: `Skill "${ref}" is not installed in source "${split.sourceAlias}".`
      });
    }
  });
}

function validateToolRefs(
  refs: SupportReference[],
  path: string,
  toolIds: Set<string>,
  diagnostics: ValidationDiagnostic[]
): void {
  refs.forEach((ref, index) => {
    if (!toolIds.has(ref.ref)) {
      diagnostics.push({
        path: `${path}[${index}].ref`,
        message: `Managed tool "${ref.ref}" is not declared in top-level tools.`
      });
    }
  });
}

function validateCliHints(
  cli: CliHint[],
  path: string,
  diagnostics: ValidationDiagnostic[]
): void {
  const descriptions = new Map<string, string>();
  cli.forEach((hint, index) => {
    const existing = descriptions.get(hint.cmd);
    if (existing !== undefined && existing !== (hint.description ?? "")) {
      diagnostics.push({
        path: `${path}[${index}].cmd`,
        message: `CLI hint "${hint.cmd}" is declared with conflicting descriptions.`
      });
    }
    descriptions.set(hint.cmd, hint.description ?? "");
  });
}

function validateExecutableSupportSurface(
  node: ExecutableGraphNode,
  metadata: NodeMetadata,
  document: AuthoredGraphDocument,
  diagnostics: ValidationDiagnostic[]
): void {
  const isPromptBacked = node.type === "agent" || (node.type === "check" && node.check_kind === "ai");

  if (node.type !== "agent") {
    (node.support?.tools ?? []).forEach((_, index) => {
      diagnostics.push({
        path: `${metadata.path}.support.tools[${index}]`,
        message: "Managed plugin tools can only be granted to agent nodes."
      });
    });

    (node.support?.capabilities ?? []).forEach((capability, index) => {
      const definition = document.capabilities?.[capability.ref];
      if ((definition?.tools ?? []).length === 0) {
        return;
      }
      diagnostics.push({
        path: `${metadata.path}.support.capabilities[${index}].ref`,
        message: `Capability "${capability.ref}" grants managed plugin tools, but managed plugin tools can only be granted to agent nodes.`
      });
    });
  }

  if (isPromptBacked) {
    return;
  }

  (node.support?.skills ?? []).forEach((_, index) => {
    diagnostics.push({
      path: `${metadata.path}.support.skills[${index}]`,
      message: "Skills can only be attached to prompt-backed agent or AI check nodes."
    });
  });

  (node.support?.cli ?? []).forEach((_, index) => {
    diagnostics.push({
      path: `${metadata.path}.support.cli[${index}]`,
      message: "CLI hints can only be attached to prompt-backed agent or AI check nodes."
    });
  });

  (node.support?.capabilities ?? []).forEach((capability, index) => {
    const definition = document.capabilities?.[capability.ref];
    if ((definition?.skills ?? []).length === 0 && (definition?.cli ?? []).length === 0) {
      return;
    }
    diagnostics.push({
      path: `${metadata.path}.support.capabilities[${index}].ref`,
      message: `Capability "${capability.ref}" grants prompt support, but skills and CLI hints can only be attached to prompt-backed agent or AI check nodes.`
    });
  });
}

async function validateNormalizedDocument(
  document: AuthoredGraphDocument,
  options: ValidateNormalizedDocumentOptions = {}
): Promise<ValidationDiagnostic[]> {
  const diagnostics: ValidationDiagnostic[] = [];
  const repoAliases = new Set(Object.keys(document.repos));
  const repoCount = repoAliases.size;
  const seenNodeIds = new Set<string>();
  const nodeIndex = new Map<string, NodeMetadata>();
  const pluginsByAlias = new Map<string, ResolvedPlugin>(
    (options.resolved_plugins ?? []).map((plugin) => [plugin.alias, plugin])
  );
  const skillSourcesByAlias = new Map<string, ResolvedSkillSource>(
    (options.resolved_skill_sources ?? []).map((source) => [source.alias, source])
  );
  const harnessConfigDiagnostics = new Set<string>();

  const graphToolValidation = validateToolDeclarations(
    document.tools ?? {},
    "$.tools",
    pluginsByAlias,
    diagnostics
  );

  Object.entries(document.profiles ?? {}).forEach(([profileName, profile]) => {
    validateEnvFiles(profile.env_files, `$.profiles.${profileName}.env_files`, diagnostics);
    validateHarnessConfigForHarness(
      profileName,
      profile,
      profile.harness,
      `$.profiles.${profileName}.harness_config`,
      diagnostics,
      harnessConfigDiagnostics
    );

    if (profile.harness === "cursor-cli" && profile.reasoning_effort !== undefined) {
      diagnostics.push({
        path: `$.profiles.${profileName}.reasoning_effort`,
        message:
          `Cursor profile "${profileName}" cannot set reasoning_effort because Cursor model ids encode reasoning effort. ` +
          "Choose the appropriate Cursor model id instead."
      });
    }

    if (profile.harness === "cursor-cli" && profile.ai_check_defaults?.reasoning_effort !== undefined) {
      diagnostics.push({
        path: `$.profiles.${profileName}.ai_check_defaults.reasoning_effort`,
        message:
          `Cursor profile "${profileName}" cannot set ai_check_defaults.reasoning_effort because Cursor model ids encode reasoning effort. ` +
          "Choose the appropriate Cursor model id instead."
      });
    }
  });

  if (document.config_schema) {
    validateConfigAgainstSchema(
      document.config ?? {},
      document.config_schema,
      "$.config_schema",
      diagnostics
    );
  }

  const topLevelToolIds = new Set(Object.keys(document.tools ?? {}));
  Object.entries(document.capabilities ?? {}).forEach(([capabilityName, capability]) => {
    validateSkillRefs(
      capability.skills ?? [],
      `$.capabilities.${capabilityName}.skills`,
      skillSourcesByAlias,
      diagnostics
    );
    validateToolRefs(
      capability.tools ?? [],
      `$.capabilities.${capabilityName}.tools`,
      topLevelToolIds,
      diagnostics
    );
    validateCliHints(capability.cli ?? [], `$.capabilities.${capabilityName}.cli`, diagnostics);
  });

  const launch = resolveLaunchConfig(document);
  const supervisorResolution = resolveSupervisorPolicy(document, launch);
  if (supervisorResolution.supervisor_profile && !supervisorResolution.supervisor_profile.harness) {
    validateHarnessConfigForHarness(
      supervisorResolution.profile_name ?? document.supervision.profile,
      supervisorResolution.supervisor_profile,
      supervisorResolution.policy?.harness,
      `$.profiles.${supervisorResolution.profile_name ?? document.supervision.profile}.harness_config`,
      diagnostics,
      harnessConfigDiagnostics
    );
  }

  visitNodes(document.graph, (node, metadata) => {
    if (node.type === "agent" || (node.type === "check" && node.check_kind === "ai")) {
      const resolution = resolveNodePolicy(document, launch, node);
      for (const diagnostic of resolution.diagnostics) {
        diagnostics.push(diagnostic);
      }

      const runtimeProfile = node.runtime?.profile;
      const effectiveProfileName = runtimeProfile ?? launch.launch_profile;
      const effectiveProfile = runtimeProfile ? resolution.node_profile : resolution.launch_profile;
      if (effectiveProfile && !effectiveProfile.harness) {
        validateHarnessConfigForHarness(
          effectiveProfileName,
          effectiveProfile,
          resolution.policy.harness,
          `$.profiles.${effectiveProfileName}.harness_config`,
          diagnostics,
          harnessConfigDiagnostics
        );
      }

      if (resolution.policy?.harness === "cursor-cli" && node.reasoning_effort !== undefined) {
        diagnostics.push({
          path: `${metadata.path}.reasoning_effort`,
          message:
            `Cursor node "${node.id}" cannot set reasoning_effort because Cursor model ids encode reasoning effort. ` +
            "Choose the appropriate Cursor model id instead."
        });
      }

      if (
        resolution.policy?.harness === "cursor-cli" &&
        runtimeProfile &&
        resolution.node_profile?.harness !== "cursor-cli" &&
        resolution.node_profile?.reasoning_effort !== undefined
      ) {
        diagnostics.push({
          path: `$.profiles.${runtimeProfile}.reasoning_effort`,
          message:
            `Cursor profile "${runtimeProfile}" cannot set reasoning_effort because Cursor model ids encode reasoning effort. ` +
            "Choose the appropriate Cursor model id instead."
        });
      }

      if (
        resolution.policy?.harness === "cursor-cli" &&
        node.type === "check" &&
        node.check_kind === "ai" &&
        runtimeProfile &&
        resolution.node_profile?.harness !== "cursor-cli" &&
        resolution.node_profile?.ai_check_defaults?.reasoning_effort !== undefined
      ) {
        diagnostics.push({
          path: `$.profiles.${runtimeProfile}.ai_check_defaults.reasoning_effort`,
          message:
            `Cursor profile "${runtimeProfile}" cannot set ai_check_defaults.reasoning_effort because Cursor model ids encode reasoning effort. ` +
            "Choose the appropriate Cursor model id instead."
        });
      }

      if (
        resolution.policy?.sandbox === "read-only" &&
        node.artifacts &&
        Object.keys(node.artifacts).length > 0
      ) {
        const artifactNames = Object.keys(node.artifacts).sort().map((name) => `"${name}"`).join(", ");
        const nodeKind = node.type === "agent" ? "Agent" : "AI check";
        diagnostics.push({
          path: `${metadata.path}.artifacts`,
          message:
            `${nodeKind} node "${node.id}" runs in the read-only sandbox but declares artifacts (${artifactNames}); ` +
            "the sandbox blocks every file write so the artifact contract cannot be satisfied. " +
            (node.type === "agent"
              ? "Remove the artifact declarations or raise the sandbox to workspace-write."
              : "AI checks emit verification_json automatically; remove the declared artifacts.")
        });
      }
    }
  }, "$.graph");

  visitNodes(document.graph, (node, metadata) => {
    if (
      metadata.in_cleanup &&
      node.type === "sequence" &&
      node.cleanup &&
      node.cleanup.length > 0
    ) {
      diagnostics.push({
        path: `${metadata.path}.cleanup`,
        message: "sequence.cleanup is not allowed inside another cleanup chain."
      });
    }

    if (seenNodeIds.has(node.id)) {
      diagnostics.push({
        path: `${metadata.path}.id`,
        message: `Node id "${node.id}" is duplicated.`
      });
    } else {
      seenNodeIds.add(node.id);
      nodeIndex.set(node.id, metadata);
    }

    if (isExecutableNode(node)) {
      const runtimeRepo = node.runtime?.repo;
      const runtimeProfile = node.runtime?.profile;

      if (repoCount > 1 && !runtimeRepo) {
        diagnostics.push({
          path: `${metadata.path}.runtime.repo`,
          message: "Executable nodes must declare repo when multiple repos exist."
        });
      }

      if (runtimeRepo && !repoAliases.has(runtimeRepo)) {
        diagnostics.push({
          path: `${metadata.path}.runtime.repo`,
          message: `Unknown repo alias "${runtimeRepo}".`
        });
      }

      if (runtimeProfile && !document.profiles?.[runtimeProfile]) {
        diagnostics.push({
          path: `${metadata.path}.runtime.profile`,
          message: `Node references unknown profile "${runtimeProfile}".`
        });
      }

      for (const [index, capability] of (node.support?.capabilities ?? []).entries()) {
        if (!document.capabilities?.[capability.ref]) {
          diagnostics.push({
            path: `${metadata.path}.support.capabilities[${index}].ref`,
            message: `Capability "${capability.ref}" is not declared.`
          });
        }
      }
      validateSkillRefs(node.support?.skills ?? [], `${metadata.path}.support.skills`, skillSourcesByAlias, diagnostics);
      validateToolRefs(node.support?.tools ?? [], `${metadata.path}.support.tools`, topLevelToolIds, diagnostics);
      validateCliHints(node.support?.cli ?? [], `${metadata.path}.support.cli`, diagnostics);

      const contextNames = new Set<string>();
      (node.support?.context ?? []).forEach((item, index) => {
        if (contextNames.has(item.name)) {
          diagnostics.push({
            path: `${metadata.path}.support.context[${index}].name`,
            message: `Context item name "${item.name}" is duplicated on node "${node.id}".`
          });
        }

        contextNames.add(item.name);

        if ("ref" in item) {
          return;
        }

        if (item.from === "workspace_file" || item.from === "workspace_glob") {
          validateWorkspaceContextPath(
            item,
            `${metadata.path}.support.context[${index}].path`,
            repoAliases,
            diagnostics
          );
        }
      });

      if (node.type === "exec" || (node.type === "check" && node.check_kind === "deterministic")) {
        validateNodeCwd(node.cwd, `${metadata.path}.cwd`, diagnostics);
        validateEnvFiles(node.env_files, `${metadata.path}.env_files`, diagnostics);
      }

      validateExecutableSupportSurface(node, metadata, document, diagnostics);

      Object.entries(node.artifacts ?? {}).forEach(([name, artifact]) => {
        validateArtifactPath(name, artifact.path, `${metadata.path}.artifacts.${name}.path`, diagnostics);
      });
    }
  }, "$.graph");

  visitNodes(document.graph, (node, metadata) => {
    if (node.type === "repeat") {
      if (metadata.nearest_repeat_id) {
        diagnostics.push({
          path: metadata.path,
          message:
            `Nested repeat nodes are not supported in this release; repeat "${node.id}" is inside repeat "${metadata.nearest_repeat_id}". ` +
            "pattern_deep_work lowers to an internal repeat, so do not place pattern_deep_work inside an authored repeat."
        });
      }

      const descendants = collectDescendantNodes(node.body);
      const untilTarget = descendants.find((descendant) => descendant.id === node.until.node);

      if (!untilTarget) {
        diagnostics.push({
          path: `${metadata.path}.until.node`,
          message: `repeat.until.node "${node.until.node}" must reference a descendant node.`
        });
      } else if (untilTarget.type !== "check" && untilTarget.type !== "checkpoint") {
        diagnostics.push({
          path: `${metadata.path}.until.node`,
          message: `repeat.until.node "${node.until.node}" must reference a descendant check or checkpoint node.`
        });
      } else if (untilTarget.type === "check" && untilTarget.on_failure === "continue") {
        diagnostics.push({
          path: `${metadata.path}.until.node`,
          message: `repeat.until.node "${node.until.node}" cannot use on_failure = "continue".`
        });
      }
    }

    if (isExecutableNode(node)) {
      (node.support?.context ?? []).forEach((item, index) => {
        if (!("ref" in item)) {
          return;
        }

        validateArtifactReference(
          item,
          `${metadata.path}.support.context[${index}]`,
          node.id,
          nodeIndex,
          diagnostics
        );
      });

      if (node.type === "checkpoint") {
        if (!metadata.nearest_repeat_id) {
          diagnostics.push({
            path: metadata.path,
            message:
              "checkpoint nodes are planned human gates and are only valid inside a repeat body in this release; supervisor authority pauses are runtime-owned and require typed AuthorityRequests."
          });
        }

        validateArtifactReference(
          node.review_from,
          `${metadata.path}.review_from`,
          node.id,
          nodeIndex,
          diagnostics
        );

      }
    }
  }, "$.graph");

  return diagnostics;
}

export interface LoadAuthoredGraphDocumentOptions {
  config_overrides?: GraphConfig;
}

function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export async function loadAuthoredGraphDocument(
  currentWorkingDirectory: string,
  graphPath: string,
  options: LoadAuthoredGraphDocumentOptions = {}
): Promise<LoadedGraphDocument> {
  const absolute_path = resolve(currentWorkingDirectory, graphPath);

  try {
    const fileContents = await readFile(absolute_path, "utf8");
    const parsed = JSON.parse(fileContents) as unknown;
    const configDiagnostics: ValidationDiagnostic[] = [];
    const documentRecord = asPlainRecord(parsed);
    let interpolated: unknown = parsed;

    if (documentRecord) {
      const declaredConfig = asPlainRecord(documentRecord.config) ?? {};
      const declaredConfigSchema = asPlainRecord(documentRecord.config_schema);
      const overrides = options.config_overrides ?? {};
      const mergedConfig = mergeConfig(declaredConfig, overrides);

      if (declaredConfigSchema) {
        validateConfigAgainstSchema(
          mergedConfig,
          declaredConfigSchema,
          "$.config_schema",
          configDiagnostics
        );
      }

      const documentForInterpolation: Record<string, unknown> = {
        ...documentRecord,
        config: mergedConfig
      };

      const interpolation = interpolateGraphConfig(documentForInterpolation, mergedConfig);
      configDiagnostics.push(...interpolation.diagnostics);
      interpolated = interpolation.document;
    }

    const skillSourceDiagnostics: ValidationDiagnostic[] = [];
    const skillSourceDeclarations = readSkillSourceDeclarations(interpolated, skillSourceDiagnostics);
    const resolvedSkillSources = await loadResolvedSkillSources(
      absolute_path,
      skillSourceDeclarations,
      skillSourceDiagnostics
    );
    const pluginExpansion = await expandPluginWorkflows(absolute_path, interpolated);
    const normalized = normalizeAuthoredGraphDocument(pluginExpansion.document);
    const documentDiagnostics = normalized.document
      ? await validateNormalizedDocument(normalized.document, {
          resolved_plugins: pluginExpansion.resolved_plugins,
          resolved_skill_sources: resolvedSkillSources,
          graph_dir: dirname(absolute_path)
        })
      : [];
    const diagnostics = [
      ...configDiagnostics,
      ...skillSourceDiagnostics,
      ...pluginExpansion.diagnostics,
      ...normalized.diagnostics,
      ...documentDiagnostics
    ];
    const loweredManagedNodes = [
      ...pluginExpansion.lowered_managed_nodes,
      ...normalized.lowered_managed_nodes
    ];

    if (!normalized.document || diagnostics.length > 0) {
      return {
        diagnostics,
        absolute_path,
        lowered_managed_nodes: loweredManagedNodes,
        resolved_plugins: pluginExpansion.resolved_plugins,
        resolved_skill_sources: resolvedSkillSources
      };
    }

    return {
      document: normalized.document,
      diagnostics: [],
      absolute_path,
      lowered_managed_nodes: loweredManagedNodes,
      resolved_plugins: pluginExpansion.resolved_plugins,
      resolved_skill_sources: resolvedSkillSources
    };
  } catch (error) {
    return {
      absolute_path,
      lowered_managed_nodes: [],
      resolved_skill_sources: [],
      diagnostics: [
        {
          path: graphPath,
          message: error instanceof Error ? error.message : "Failed to read graph file."
        }
      ]
    };
  }
}

export async function validateAuthoredGraphDocument(
  value: unknown,
  options: ValidateNormalizedDocumentOptions = {}
): Promise<ValidationDiagnostic[]> {
  const normalized = normalizeAuthoredGraphDocument(value);

  return [
    ...normalized.diagnostics,
    ...(normalized.document ? await validateNormalizedDocument(normalized.document, options) : [])
  ];
}

export function summarizeAuthoredGraph(document: AuthoredGraphDocument): AuthoredGraphSummary {
  const node_kind_counts: AuthoredGraphSummary["node_kind_counts"] = {
    agent: 0,
    exec: 0,
    check: 0,
    checkpoint: 0,
    sequence: 0,
    parallel: 0,
    repeat: 0
  };

  let node_count = 0;
  let executable_node_count = 0;
  let container_node_count = 0;
  let repeat_count = 0;

  visitNodes(
    document.graph,
    (node) => {
      node_count += 1;
      node_kind_counts[node.type] += 1;

      if (isExecutableNode(node)) {
        executable_node_count += 1;
        return;
      }

      container_node_count += 1;

      if (node.type === "repeat") {
        repeat_count += 1;
      }
    },
    "$.graph"
  );

  return {
    graph_id: document.graph_id,
    node_count,
    executable_node_count,
    container_node_count,
    profile_count: Object.keys(document.profiles ?? {}).length,
    repo_count: Object.keys(document.repos).length,
    repeat_count,
    node_kind_counts
  };
}

export function collectExecutableNodes(root: ContainerGraphNode): Array<{
  node: ExecutableGraphNode;
  scope_stack: string[];
  nearest_repeat_id?: string;
}> {
  const executableNodes: Array<{
    node: ExecutableGraphNode;
    scope_stack: string[];
    nearest_repeat_id?: string;
  }> = [];

  visitNodes(
    root,
    (node, metadata) => {
      if (!isExecutableNode(node)) {
        return;
      }

      executableNodes.push({
        node,
        scope_stack: metadata.parent_scope_ids,
        ...(metadata.nearest_repeat_id ? { nearest_repeat_id: metadata.nearest_repeat_id } : {})
      });
    },
    "$.graph"
  );

  return executableNodes;
}

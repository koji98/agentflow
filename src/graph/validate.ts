import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { isRelativeSubpath } from "../path_rules.js";
import type {
  AgentNode,
  AuthoredGraphDocument,
  AuthoredGraphNode,
  AuthoredGraphSummary,
  ContainerGraphNode,
  ArtifactContextRef,
  ArtifactReference,
  ContextItem,
  ExecutableGraphNode,
  GraphPrerequisiteCheck,
  ToolDeclaration
} from "./authored.js";
import { normalizeAuthoredGraphDocument } from "./normalize.js";
import type { LoweredManagedNode } from "./normalize.js";
import { resolveLaunchConfig, resolveNodePolicy } from "./profiles.js";
import {
  reservedArtifactNames,
  toolNamePattern
} from "./schema.js";
import type { GraphDiagnostic } from "./schema.js";
import { expandPluginWorkflows, type ResolvedPlugin } from "../plugins/workflows.js";
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

function validatePrerequisiteCheck(
  check: GraphPrerequisiteCheck,
  path: string,
  repoAliases: Set<string>,
  repoCount: number,
  diagnostics: ValidationDiagnostic[]
): void {
  if (check.kind === "file") {
    const repoAlias = readQualifiedRepoAlias(check.path);

    if (repoAlias && !repoAliases.has(repoAlias)) {
      diagnostics.push({
        path: `${path}.path`,
        message: `Unknown repo alias "${repoAlias}" in prerequisite path "${check.path}".`
      });
    }

    if (!repoAlias && repoCount > 1) {
      diagnostics.push({
        path: `${path}.path`,
        message: `Prerequisite path "${check.path}" must be repo-qualified when multiple repos exist.`
      });
    }

    if (!isRelativeSubpath(readQualifiedRepoPath(check.path))) {
      diagnostics.push({
        path: `${path}.path`,
        message: `Prerequisite path "${check.path}" must stay within the selected repo root.`
      });
    }

    return;
  }

  if (check.kind === "repo" && !repoAliases.has(check.repo)) {
    diagnostics.push({
      path: `${path}.repo`,
      message: `Unknown repo alias "${check.repo}".`
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

function validateArtifactReference(
  reference: ArtifactReference | ArtifactContextRef,
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
  graph_dir?: string;
}

function callableNameForToolDeclaration(declaration: ToolDeclaration): string {
  return declaration.alias ?? `${declaration.from_plugin}-${declaration.tool}`;
}

function validateToolDeclarations(
  tools: ToolDeclaration[],
  basePath: string,
  pluginsByAlias: Map<string, ResolvedPlugin>,
  diagnostics: ValidationDiagnostic[]
): { callable_names: Set<string> } {
  const callableNames = new Set<string>();

  tools.forEach((declaration, index) => {
    const declarationPath = `${basePath}[${index}]`;

    const plugin = pluginsByAlias.get(declaration.from_plugin);
    if (!plugin) {
      diagnostics.push({
        path: `${declarationPath}.from_plugin`,
        message: `Plugin "${declaration.from_plugin}" is not declared or resolved.`
      });
      return;
    }

    if (!plugin.manifest.tools[declaration.tool]) {
      diagnostics.push({
        path: `${declarationPath}.tool`,
        message: `Plugin "${declaration.from_plugin}" does not export tool "${declaration.tool}".`
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

    if (callableNames.has(callable)) {
      diagnostics.push({
        path: declarationPath,
        message: `Tool name "${callable}" is already declared in this scope.`
      });
      return;
    }

    callableNames.add(callable);
  });

  return { callable_names: callableNames };
}

function validateToolConfigKeys(
  config: Record<string, Record<string, string>> | undefined,
  basePath: string,
  scopeNames: ReadonlySet<string>,
  diagnostics: ValidationDiagnostic[]
): void {
  if (!config) {
    return;
  }

  for (const toolName of Object.keys(config)) {
    if (!scopeNames.has(toolName)) {
      diagnostics.push({
        path: `${basePath}.${toolName}`,
        message: `tool_config references unknown tool "${toolName}". Declare it in tools or via a plugin first.`
      });
    }
  }
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

  const graphToolValidation = validateToolDeclarations(
    document.tools ?? [],
    "$.tools",
    pluginsByAlias,
    diagnostics
  );
  const graphScopeToolNames = new Set<string>(graphToolValidation.callable_names);
  validateToolConfigKeys(document.tool_config, "$.tool_config", graphScopeToolNames, diagnostics);

  (document.prerequisites?.checks ?? []).forEach((check, index) => {
    validatePrerequisiteCheck(check, `$.prerequisites.checks[${index}]`, repoAliases, repoCount, diagnostics);
  });

  Object.entries(document.profiles ?? {}).forEach(([profileName, profile]) => {
    validateEnvFiles(profile.env_files, `$.profiles.${profileName}.env_files`, diagnostics);
  });

  if (document.config_schema) {
    validateConfigAgainstSchema(
      document.config ?? {},
      document.config_schema,
      "$.config_schema",
      diagnostics
    );
  }

  const launch = resolveLaunchConfig(document);

  visitNodes(document.graph, (node, metadata) => {
    if (node.type === "agent" || (node.type === "check" && node.check_kind === "ai")) {
      const resolution = resolveNodePolicy(document, launch, node);
      for (const diagnostic of resolution.diagnostics) {
        diagnostics.push(diagnostic);
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
      if (repoCount > 1 && !node.repo) {
        diagnostics.push({
          path: `${metadata.path}.repo`,
          message: "Executable nodes must declare repo when multiple repos exist."
        });
      }

      if (node.repo && !repoAliases.has(node.repo)) {
        diagnostics.push({
          path: `${metadata.path}.repo`,
          message: `Unknown repo alias "${node.repo}".`
        });
      }

      if (node.profile && !document.profiles?.[node.profile]) {
        diagnostics.push({
          path: `${metadata.path}.profile`,
          message: `Node references unknown profile "${node.profile}".`
        });
      }

      const contextNames = new Set<string>();
      (node.context ?? []).forEach((item, index) => {
        if (contextNames.has(item.name)) {
          diagnostics.push({
            path: `${metadata.path}.context[${index}].name`,
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
            `${metadata.path}.context[${index}].path`,
            repoAliases,
            diagnostics
          );
        }
      });

      if (node.type === "exec" || (node.type === "check" && node.check_kind === "deterministic")) {
        validateNodeCwd(node.cwd, `${metadata.path}.cwd`, diagnostics);
        validateEnvFiles(node.env_files, `${metadata.path}.env_files`, diagnostics);
      }

      Object.entries(node.artifacts ?? {}).forEach(([name, artifact]) => {
        validateArtifactPath(name, artifact.path, `${metadata.path}.artifacts.${name}.path`, diagnostics);
      });
    }
  }, "$.graph");

  visitNodes(document.graph, (node, metadata) => {
    if (node.type !== "agent") {
      return;
    }

    const agentNode = node as AgentNode;
    if (!agentNode.tools && !agentNode.tool_config) {
      return;
    }

    const agentToolValidation = validateToolDeclarations(
      agentNode.tools ?? [],
      `${metadata.path}.tools`,
      pluginsByAlias,
      diagnostics
    );

    const conflictingNames = [...agentToolValidation.callable_names].filter((name) =>
      graphToolValidation.callable_names.has(name)
    );
    for (const name of conflictingNames) {
      diagnostics.push({
        path: `${metadata.path}.tools`,
        message: `Tool name "${name}" conflicts with a graph-level tool of the same name.`
      });
    }

    const agentScopeToolNames = new Set<string>([
      ...graphScopeToolNames,
      ...agentToolValidation.callable_names
    ]);
    validateToolConfigKeys(agentNode.tool_config, `${metadata.path}.tool_config`, agentScopeToolNames, diagnostics);
  }, "$.graph");

  visitNodes(document.graph, (node, metadata) => {
    if (node.type === "repeat") {
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
      (node.context ?? []).forEach((item, index) => {
        if (!("ref" in item)) {
          return;
        }

        validateArtifactReference(
          item,
          `${metadata.path}.context[${index}]`,
          node.id,
          nodeIndex,
          diagnostics
        );
      });

      if (node.type === "checkpoint") {
        if (!metadata.nearest_repeat_id) {
          diagnostics.push({
            path: metadata.path,
            message: "checkpoint nodes are only valid inside a repeat body in this release."
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

    const pluginExpansion = await expandPluginWorkflows(absolute_path, interpolated);
    const normalized = normalizeAuthoredGraphDocument(pluginExpansion.document);
    const documentDiagnostics = normalized.document
      ? await validateNormalizedDocument(normalized.document, {
          resolved_plugins: pluginExpansion.resolved_plugins,
          graph_dir: dirname(absolute_path)
        })
      : [];
    const diagnostics = [
      ...configDiagnostics,
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
        resolved_plugins: pluginExpansion.resolved_plugins
      };
    }

    return {
      document: normalized.document,
      diagnostics: [],
      absolute_path,
      lowered_managed_nodes: loweredManagedNodes,
      resolved_plugins: pluginExpansion.resolved_plugins
    };
  } catch (error) {
    return {
      absolute_path,
      lowered_managed_nodes: [],
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

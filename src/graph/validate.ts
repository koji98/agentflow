import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { isRelativeSubpath } from "../path_rules.js";
import type {
  AuthoredGraphDocument,
  AuthoredGraphNode,
  AuthoredGraphSummary,
  ContainerGraphNode,
  ArtifactReference,
  ContextItem,
  ExecutableGraphNode,
  GraphPrerequisiteCheck
} from "./authored.js";
import { normalizeAuthoredGraphDocument } from "./normalize.js";
import type { LoweredManagedNode } from "./normalize.js";
import { reservedArtifactNames } from "./schema.js";
import type { GraphDiagnostic } from "./schema.js";

export type ValidationDiagnostic = GraphDiagnostic;

export interface LoadedGraphDocument {
  document?: AuthoredGraphDocument;
  diagnostics: ValidationDiagnostic[];
  absolute_path: string;
  lowered_managed_nodes: LoweredManagedNode[];
}

interface NodeMetadata {
  node: AuthoredGraphNode;
  path: string;
  parent_scope_ids: string[];
  nearest_repeat_id?: string;
}

function isExecutableNode(node: AuthoredGraphNode): node is ExecutableGraphNode {
  return node.type === "agent" || node.type === "exec" || node.type === "check" || node.type === "checkpoint";
}

function visitNodes(
  node: AuthoredGraphNode,
  visit: (node: AuthoredGraphNode, metadata: NodeMetadata) => void,
  path: string,
  parent_scope_ids: string[] = [],
  nearest_repeat_id?: string
): void {
  const metadata: NodeMetadata = {
    node,
    path,
    parent_scope_ids,
    ...(nearest_repeat_id ? { nearest_repeat_id } : {})
  };

  visit(node, metadata);

  if (node.type === "sequence" || node.type === "parallel") {
    node.steps.forEach((child, index) =>
      visitNodes(child, visit, `${path}.steps[${index}]`, [...parent_scope_ids, node.id], nearest_repeat_id)
    );
    return;
  }

  if (node.type === "repeat") {
    visitNodes(
      node.body,
      visit,
      `${path}.body`,
      [...parent_scope_ids, node.id],
      node.id
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
  reference: ArtifactReference,
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

function validateNormalizedDocument(document: AuthoredGraphDocument): ValidationDiagnostic[] {
  const diagnostics: ValidationDiagnostic[] = [];
  const repoAliases = new Set(Object.keys(document.repos));
  const repoCount = repoAliases.size;
  const seenNodeIds = new Set<string>();
  const nodeIndex = new Map<string, NodeMetadata>();

  (document.prerequisites?.checks ?? []).forEach((check, index) => {
    validatePrerequisiteCheck(check, `$.prerequisites.checks[${index}]`, repoAliases, repoCount, diagnostics);
  });

  Object.entries(document.profiles ?? {}).forEach(([profileName, profile]) => {
    validateEnvFiles(profile.env_files, `$.profiles.${profileName}.env_files`, diagnostics);
  });

  visitNodes(document.graph, (node, metadata) => {
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
        if (item.from !== "artifact") {
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

export async function loadAuthoredGraphDocument(
  currentWorkingDirectory: string,
  graphPath: string
): Promise<LoadedGraphDocument> {
  const absolute_path = resolve(currentWorkingDirectory, graphPath);

  try {
    const fileContents = await readFile(absolute_path, "utf8");
    const parsed = JSON.parse(fileContents) as unknown;
    const normalized = normalizeAuthoredGraphDocument(parsed);
    const diagnostics = [
      ...normalized.diagnostics,
      ...(normalized.document ? validateNormalizedDocument(normalized.document) : [])
    ];

    if (!normalized.document || diagnostics.length > 0) {
      return {
        diagnostics,
        absolute_path,
        lowered_managed_nodes: normalized.lowered_managed_nodes
      };
    }

    return {
      document: normalized.document,
      diagnostics: [],
      absolute_path,
      lowered_managed_nodes: normalized.lowered_managed_nodes
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

export function validateAuthoredGraphDocument(value: unknown): ValidationDiagnostic[] {
  const normalized = normalizeAuthoredGraphDocument(value);

  return [
    ...normalized.diagnostics,
    ...(normalized.document ? validateNormalizedDocument(normalized.document) : [])
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

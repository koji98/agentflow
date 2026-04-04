import { basename, dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";

import type {
  AuthoredGraphDocument,
  AuthoredGraphNode,
  ExecutableGraphNode
} from "../../../src/graph/authored.js";
import { compileAuthoredGraph } from "../../../src/graph/compile.js";
import { normalizeAuthoredGraphDocument } from "../../../src/graph/normalize.js";
import { resolveLaunchConfig } from "../../../src/graph/profiles.js";
import type { GraphDiagnostic, WorkspaceBackend } from "../../../src/graph/schema.js";
import { workspaceBackends } from "../../../src/graph/schema.js";
import { validateAuthoredGraphDocument, summarizeAuthoredGraph } from "../../../src/graph/validate.js";
import type { GraphInspectionPayload, GraphNodeView } from "../../shared/contracts/graph.js";

export const graphInspectionRoutePath = "/api/graphs/inspect";

function isExecutableNode(node: AuthoredGraphNode): node is ExecutableGraphNode {
  return node.type === "agent" || node.type === "exec" || node.type === "check";
}

function visitAuthoredGraph(
  node: AuthoredGraphNode,
  scopeStack: string[],
  visit: (node: AuthoredGraphNode, scopeStack: string[]) => void
): void {
  visit(node, scopeStack);

  if (node.type === "sequence" || node.type === "parallel") {
    node.steps.forEach((child) => visitAuthoredGraph(child, [...scopeStack, node.id], visit));
    return;
  }

  if (node.type === "repeat") {
    visitAuthoredGraph(node.body, [...scopeStack, node.id], visit);
  }
}

function buildAuthoredBadge(node: AuthoredGraphNode): string | undefined {
  if (node.type === "repeat") {
    return `max ${node.max_attempts}`;
  }

  if (node.type === "parallel") {
    return node.max_concurrency ? `max ${node.max_concurrency}` : "parallel";
  }

  if (node.type === "check") {
    return node.check_kind;
  }

  if (node.type === "exec") {
    return basename(node.command);
  }

  if (node.type === "agent") {
    return node.profile;
  }

  return undefined;
}

function buildAuthoredNodes(document: AuthoredGraphDocument): GraphNodeView[] {
  const nodes: GraphNodeView[] = [];

  visitAuthoredGraph(document.graph, [], (node, scopeStack) => {
    const badge = buildAuthoredBadge(node);

    nodes.push({
      authored_id: node.id,
      label: node.label ?? node.id,
      kind: node.type,
      scope_stack: scopeStack,
      ...(isExecutableNode(node) && node.repo ? { repo_alias: node.repo } : {}),
      ...(badge ? { badge } : {})
    });
  });

  return nodes;
}

function buildCompiledNodes(payload: NonNullable<GraphInspectionPayload["compiled_graph"]>): GraphNodeView[] {
  return payload.nodes.map((node) => ({
    authored_id: node.authored_id,
    compiled_id: node.compiled_id,
    label: node.label ?? node.authored_id,
    kind: node.kind,
    scope_stack: node.scope_stack,
    repo_alias: node.repo,
    ...(node.repeat_scope_id ? { repeat_scope_id: node.repeat_scope_id } : {}),
    ...(node.kind === "agent"
      ? { badge: node.effective_policy.harness ?? "agent" }
      : node.kind === "check"
        ? { badge: node.check_kind }
        : { badge: basename(node.command) })
  }));
}

function resolveInspectionLaunch(options: {
  launch_profile?: string;
  workspace_backend?: string;
}) {
  const diagnostics: GraphDiagnostic[] = [];
  const requestedBackend = options.workspace_backend ?? "worktree";
  const workspace_backend = workspaceBackends.includes(requestedBackend as WorkspaceBackend)
    ? requestedBackend as WorkspaceBackend
    : "worktree";

  if (!workspaceBackends.includes(requestedBackend as WorkspaceBackend)) {
    diagnostics.push({
      path: "$.defaults.workspace_backend",
      message: `Unsupported workspace backend "${requestedBackend}".`
    });
  }

  return {
    launch_profile: options.launch_profile ?? "default",
    workspace_backend,
    diagnostics
  };
}

export async function inspectGraph(options: {
  current_working_directory: string;
  graph_path: string;
  launch_profile?: string;
  workspace_backend?: string;
  include_compiled?: boolean;
}): Promise<GraphInspectionPayload> {
  const absoluteGraphPath = resolve(options.current_working_directory, options.graph_path);
  let parsed: unknown;

  try {
    const fileContents = await readFile(absoluteGraphPath, "utf8");
    parsed = JSON.parse(fileContents) as unknown;
  } catch (error) {
    const launch = resolveInspectionLaunch(options);
    const validation_diagnostics: GraphDiagnostic[] = [
      {
        path: options.graph_path,
        message: error instanceof Error ? error.message : "Failed to read graph file."
      }
    ];

    return {
      graph_path: absoluteGraphPath,
      graph_id: basename(absoluteGraphPath),
      launch_profile: launch.launch_profile,
      workspace_backend: launch.workspace_backend,
      compile_status: "Failed",
      validation_diagnostics,
      compile_diagnostics: [],
      launch_resolution: {
        launch_profile: launch.launch_profile,
        workspace_backend: launch.workspace_backend,
        available_profiles: [],
        diagnostics: launch.diagnostics
      },
      repos: [],
      kpis: [
        { label: "Graph Id", value: basename(absoluteGraphPath) },
        { label: "Node Count", value: "0" },
        { label: "Profiles", value: "0" },
        { label: "Compile", value: "Failed" }
      ],
      modes: ["Authored"],
      authored_nodes: [],
      compiled_nodes: [],
      nodes: []
    };
  }

  const normalized = normalizeAuthoredGraphDocument(parsed);
  const validation_diagnostics = validateAuthoredGraphDocument(parsed);
  const document = normalized.document;
  const graphDirectory = dirname(absoluteGraphPath);
  const launch = document
    ? resolveLaunchConfig(document, {
        ...(options.launch_profile ? { launchProfile: options.launch_profile } : {}),
        ...(options.workspace_backend ? { workspaceBackend: options.workspace_backend } : {})
      })
    : resolveInspectionLaunch(options);
  const compilation = document && launch.diagnostics.length === 0 && options.include_compiled
    ? compileAuthoredGraph(document, launch, normalized.lowered_managed_nodes)
    : {
        diagnostics: [],
        compiled_graph: undefined
      };
  const compile_status = document
    ? validation_diagnostics.length === 0 &&
      launch.diagnostics.length === 0 &&
      compilation.diagnostics.length === 0 &&
      compilation.compiled_graph
      ? "Ready"
      : validation_diagnostics.length === 0 && launch.diagnostics.length === 0
        ? "Pending"
        : "Failed"
    : validation_diagnostics.length > 0 || launch.diagnostics.length > 0
      ? "Failed"
      : "Pending";
  const authored_nodes = document ? buildAuthoredNodes(document) : [];
  const compiled_nodes = compilation.compiled_graph ? buildCompiledNodes(compilation.compiled_graph) : [];
  const repos = document
    ? Object.entries(document.repos).map(([alias, repo]) => {
        const source_path = resolve(graphDirectory, repo.path);

        return {
          alias,
          authored_path: repo.path,
          source_path,
          ...(repo.default_branch ? { default_branch: repo.default_branch } : {}),
          ...(launch.workspace_backend === "inplace"
            ? { workspace_path: source_path }
            : { workspace_path_preview: `<run-root>/workspaces/${alias}` })
        };
      })
    : [];

  return {
    graph_path: absoluteGraphPath,
    graph_id: document?.graph_id ?? basename(absoluteGraphPath),
    launch_profile: launch.launch_profile,
    workspace_backend: launch.workspace_backend,
    compile_status,
    validation_diagnostics,
    compile_diagnostics: compilation.diagnostics,
    launch_resolution: {
      launch_profile: launch.launch_profile,
      workspace_backend: launch.workspace_backend,
      available_profiles: Object.keys(document?.profiles ?? {}),
      diagnostics: launch.diagnostics
    },
    repos,
    ...(document ? { authored_summary: summarizeAuthoredGraph(document) } : {}),
    ...(document ? { authored_graph: document } : {}),
    ...(compilation.compiled_graph ? { compiled_graph: compilation.compiled_graph } : {}),
    kpis: [
      { label: "Graph Id", value: document?.graph_id ?? basename(absoluteGraphPath) },
      { label: "Node Count", value: String(document ? summarizeAuthoredGraph(document).node_count : 0) },
      { label: "Profiles", value: String(Object.keys(document?.profiles ?? {}).length) },
      { label: "Compile", value: compile_status }
    ],
    modes: document
      ? ["Authored", ...(compilation.compiled_graph ? (["Compiled"] as const) : [])]
      : ["Authored"],
    authored_nodes,
    compiled_nodes,
    nodes: compiled_nodes.length > 0 ? compiled_nodes : authored_nodes
  };
}

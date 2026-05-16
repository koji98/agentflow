import { stat } from "node:fs/promises";

import { resolveSubpathWithinRoot } from "../../path_rules.js";
import type { ContextItem } from "../../graph/authored.js";
import type { CompiledExecutableNode, CompiledGraph } from "../../graph/compiled.js";
import {
  globPatternToRegExp,
  normalizeRelativePath,
  splitQualifiedPath
} from "./common.js";
import {
  defaultContextIgnoredRoots,
  listRepoFilesDetailed
} from "./repo_files.js";

export interface ContextAnalysisFileMatch {
  path: string;
  size_bytes: number;
}

export interface ContextAnalysisItem {
  key: string;
  name: string;
  kind: "workspace_file" | "workspace_glob" | "plugin_file" | "artifact";
  path?: string;
  repo_alias?: string;
  match_count: number;
  total_size_bytes: number;
  sample_matches: string[];
  largest_matches: ContextAnalysisFileMatch[];
  default_ignored_roots: string[];
  explicit_ignored_root_opt_in?: string;
  warnings: string[];
}

export interface ContextAnalysisNode {
  compiled_id: string;
  authored_id: string;
  repo_alias: string;
  pointer_count: number;
  total_size_bytes: number;
  items: ContextAnalysisItem[];
  warnings: string[];
}

export interface ContextAnalysisReport {
  status: "passed" | "warnings";
  nodes: ContextAnalysisNode[];
  diagnostics: Array<{
    severity: "warning" | "error";
    compiled_id: string;
    authored_id: string;
    path: string;
    message: string;
  }>;
}

function isArtifactContextItem(item: ContextItem): item is Extract<ContextItem, { ref: string }> {
  return "ref" in item;
}

function contextItemKind(item: ContextItem): ContextAnalysisItem["kind"] {
  if (isArtifactContextItem(item)) {
    return "artifact";
  }
  return item.from;
}

function firstPathSegment(path: string): string | undefined {
  const normalized = normalizeRelativePath(path).replace(/^\/+/u, "");
  const [first] = normalized.split("/");
  return first && first.length > 0 ? first : undefined;
}

function explicitIgnoredRootOptIn(pattern: string): string | undefined {
  const segment = firstPathSegment(pattern);
  return segment && defaultContextIgnoredRoots.includes(segment as (typeof defaultContextIgnoredRoots)[number])
    ? segment
    : undefined;
}

async function readFilePointerMatch(
  root: string,
  relativePath: string
): Promise<ContextAnalysisFileMatch> {
  const absolutePath = resolveSubpathWithinRoot(
    root,
    relativePath,
    `Context analysis file "${relativePath}"`
  );
  const fileStat = await stat(absolutePath);
  return {
    path: relativePath,
    size_bytes: fileStat.size
  };
}

async function analyzeWorkspaceFile(options: {
  item: Extract<ContextItem, { from: "workspace_file" }>;
  key: string;
  repoAlias: string;
  repoRoot: string;
  repoRelativePath: string;
}): Promise<ContextAnalysisItem> {
  const normalizedPath = normalizeRelativePath(options.repoRelativePath);
  try {
    const match = await readFilePointerMatch(options.repoRoot, normalizedPath);
    return {
      key: options.key,
      name: options.item.name,
      kind: "workspace_file",
      path: normalizedPath,
      repo_alias: options.repoAlias,
      match_count: 1,
      total_size_bytes: match.size_bytes,
      sample_matches: [match.path],
      largest_matches: [match],
      default_ignored_roots: [...defaultContextIgnoredRoots],
      warnings: []
    };
  } catch {
    return {
      key: options.key,
      name: options.item.name,
      kind: "workspace_file",
      path: normalizedPath,
      repo_alias: options.repoAlias,
      match_count: 0,
      total_size_bytes: 0,
      sample_matches: [],
      largest_matches: [],
      default_ignored_roots: [...defaultContextIgnoredRoots],
      warnings: [`Workspace file "${options.item.path}" was not found during context analysis.`]
    };
  }
}

async function analyzeWorkspaceGlob(options: {
  item: Extract<ContextItem, { from: "workspace_glob" }>;
  key: string;
  repoAlias: string;
  repoRoot: string;
  repoRelativePattern: string;
}): Promise<ContextAnalysisItem> {
  const normalizedPattern = normalizeRelativePath(options.repoRelativePattern);
  const ignoredRootOptIn = explicitIgnoredRootOptIn(normalizedPattern);
  const repoFiles = await listRepoFilesDetailed(options.repoRoot, {
    ...(ignoredRootOptIn ? { include_ignored_root: ignoredRootOptIn } : {})
  });
  const matcher = globPatternToRegExp(normalizedPattern);
  const matchedPaths = repoFiles.files
    .filter((filePath) => matcher.test(filePath))
    .slice(0, options.item.max_files ?? Number.MAX_SAFE_INTEGER);
  const matches = await Promise.all(
    matchedPaths.map((relativePath) => readFilePointerMatch(options.repoRoot, relativePath))
  );
  const warnings: string[] = [];

  if (options.item.max_files === undefined) {
    warnings.push(`workspace_glob "${options.item.path}" has no max_files cap.`);
  }

  return {
    key: options.key,
    name: options.item.name,
    kind: "workspace_glob",
    path: options.item.path,
    repo_alias: options.repoAlias,
    match_count: matchedPaths.length,
    total_size_bytes: matches.reduce((sum, match) => sum + match.size_bytes, 0),
    sample_matches: matchedPaths.slice(0, 10),
    largest_matches: matches
      .slice()
      .sort((left, right) => right.size_bytes - left.size_bytes)
      .slice(0, 10),
    default_ignored_roots: repoFiles.ignored_roots,
    ...(ignoredRootOptIn ? { explicit_ignored_root_opt_in: ignoredRootOptIn } : {}),
    warnings
  };
}

async function analyzePluginFile(options: {
  item: Extract<ContextItem, { from: "plugin_file" }>;
  key: string;
}): Promise<ContextAnalysisItem> {
  try {
    const fileStat = await stat(options.item.path);
    return {
      key: options.key,
      name: options.item.name,
      kind: "plugin_file",
      path: options.item.path,
      match_count: 1,
      total_size_bytes: fileStat.size,
      sample_matches: [options.item.path],
      largest_matches: [{ path: options.item.path, size_bytes: fileStat.size }],
      default_ignored_roots: [],
      warnings: []
    };
  } catch {
    return {
      key: options.key,
      name: options.item.name,
      kind: "plugin_file",
      path: options.item.path,
      match_count: 0,
      total_size_bytes: 0,
      sample_matches: [],
      largest_matches: [],
      default_ignored_roots: [],
      warnings: [`Plugin file "${options.item.path}" was not found during context analysis.`]
    };
  }
}

async function analyzeContextItem(options: {
  item: ContextItem;
  index: number;
  node: CompiledExecutableNode;
  repo_workspaces: Record<string, string>;
}): Promise<ContextAnalysisItem> {
  const key = options.item.name || `context_${options.index + 1}`;

  if (isArtifactContextItem(options.item)) {
    return {
      key,
      name: options.item.name,
      kind: "artifact",
      match_count: 0,
      total_size_bytes: 0,
      sample_matches: [],
      largest_matches: [],
      default_ignored_roots: [],
      warnings: ["Artifact context is runtime-dependent and cannot be resolved before launch."]
    };
  }

  if (options.item.from === "plugin_file") {
    return analyzePluginFile({
      item: options.item,
      key
    });
  }

  const split = splitQualifiedPath(options.item.path, options.node.repo);
  const repoRoot = options.repo_workspaces[split.repo_alias];
  if (!repoRoot) {
    return {
      key,
      name: options.item.name,
      kind: contextItemKind(options.item),
      path: options.item.path,
      repo_alias: split.repo_alias,
      match_count: 0,
      total_size_bytes: 0,
      sample_matches: [],
      largest_matches: [],
      default_ignored_roots: [...defaultContextIgnoredRoots],
      warnings: [`Repo alias "${split.repo_alias}" is not bound for context analysis.`]
    };
  }

  if (options.item.from === "workspace_file") {
    return analyzeWorkspaceFile({
      item: options.item,
      key,
      repoAlias: split.repo_alias,
      repoRoot,
      repoRelativePath: split.repo_relative_path
    });
  }

  return analyzeWorkspaceGlob({
    item: options.item,
    key,
    repoAlias: split.repo_alias,
    repoRoot,
    repoRelativePattern: split.repo_relative_path
  });
}

export async function analyzeNodeContext(options: {
  node: CompiledExecutableNode;
  repo_workspaces: Record<string, string>;
}): Promise<ContextAnalysisNode> {
  const items = await Promise.all(
    (options.node.context ?? []).map((item, index) =>
      analyzeContextItem({
        item,
        index,
        node: options.node,
        repo_workspaces: options.repo_workspaces
      })
    )
  );
  const warnings = items.flatMap((item) => item.warnings);

  return {
    compiled_id: options.node.compiled_id,
    authored_id: options.node.authored_id,
    repo_alias: options.node.repo,
    pointer_count: items.reduce((sum, item) => sum + item.match_count, 0),
    total_size_bytes: items.reduce((sum, item) => sum + item.total_size_bytes, 0),
    items,
    warnings
  };
}

export async function analyzeGraphContext(options: {
  graph: CompiledGraph;
  repo_workspaces: Record<string, string>;
}): Promise<ContextAnalysisReport> {
  const nodes = await Promise.all(
    options.graph.nodes.map((node) =>
      analyzeNodeContext({
        node,
        repo_workspaces: options.repo_workspaces
      })
    )
  );
  const diagnostics = nodes.flatMap((node) =>
    node.warnings.map((warning) => ({
      severity: "warning" as const,
      compiled_id: node.compiled_id,
      authored_id: node.authored_id,
      path: `${node.authored_id}.context`,
      message: warning
    }))
  );

  return {
    status: diagnostics.length > 0 ? "warnings" : "passed",
    nodes,
    diagnostics
  };
}

export function renderContextAnalysisMarkdown(report: ContextAnalysisReport): string {
  const lines = [
    "# Context Analysis",
    "",
    `- Status: \`${report.status}\``,
    `- Nodes: \`${report.nodes.length}\``
  ];

  for (const node of report.nodes) {
    lines.push(
      "",
      `## ${node.authored_id}`,
      "",
      `- Context pointers: \`${node.pointer_count}\``,
      `- Total pointer target bytes: \`${node.total_size_bytes}\``
    );
    for (const item of node.items) {
      lines.push(
        "",
        `### ${item.name}`,
        "",
        `- Kind: \`${item.kind}\``,
        ...(item.path ? [`- Path: \`${item.path}\``] : []),
        `- Matches: \`${item.match_count}\``,
        `- Total bytes: \`${item.total_size_bytes}\``,
        ...(item.default_ignored_roots.length > 0
          ? [`- Default ignored roots: \`${item.default_ignored_roots.join("`, `")}\``]
          : []),
        ...(item.explicit_ignored_root_opt_in
          ? [`- Explicit ignored-root opt-in: \`${item.explicit_ignored_root_opt_in}\``]
          : []),
        ...(item.warnings.length > 0
          ? ["- Warnings:", ...item.warnings.map((warning) => `  - ${warning}`)]
          : []),
        ...(item.sample_matches.length > 0
          ? ["- Sample matches:", ...item.sample_matches.map((match) => `  - \`${match}\``)]
          : []),
        ...(item.largest_matches.length > 0
          ? ["- Largest matches:", ...item.largest_matches.map((match) => `  - \`${match.path}\` (${match.size_bytes} bytes)`)]
          : [])
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

export function createCompactContextIndex(report: ContextAnalysisNode): string {
  const lines = [
    "# Supervisor context pointer index",
    "",
    "The authored context package is represented as source pointers.",
    "Graph intent, node intent, repo authority, sandbox, and declared artifacts are unchanged.",
    "",
    `Context pointers: ${report.pointer_count}.`,
    "",
    "## Context items"
  ];

  for (const item of report.items) {
    lines.push(
      "",
      `### ${item.name}`,
      `- Kind: ${item.kind}`,
      ...(item.path ? [`- Path: ${item.path}`] : []),
      `- Matches: ${item.match_count}`,
      `- Total bytes: ${item.total_size_bytes}`,
      ...(item.default_ignored_roots.length > 0
        ? [`- Default ignored roots skipped: ${item.default_ignored_roots.join(", ")}`]
        : []),
      ...(item.explicit_ignored_root_opt_in
        ? [`- Explicit ignored-root opt-in: ${item.explicit_ignored_root_opt_in}`]
        : []),
      ...(item.sample_matches.length > 0
        ? ["- Sample matches:", ...item.sample_matches.slice(0, 20).map((match) => `  - ${match}`)]
        : []),
      ...(item.largest_matches.length > 0
        ? ["- Largest matches:", ...item.largest_matches.slice(0, 10).map((match) => `  - ${match.path} (${match.size_bytes} bytes)`)]
        : [])
    );
  }

  return `${lines.join("\n")}\n`;
}

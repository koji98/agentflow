import { readFile } from "node:fs/promises";

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
import { countContextTokens } from "./tokenizer.js";

export interface ContextAnalysisFileMatch {
  path: string;
  tokens: number;
  materialized_tokens: number;
  truncated: boolean;
}

export interface ContextAnalysisItem {
  key: string;
  name: string;
  kind: "text" | "workspace_file" | "workspace_glob" | "artifact";
  path?: string;
  repo_alias?: string;
  match_count: number;
  projected_tokens: number;
  actual_tokens: number;
  truncated_count: number;
  non_tokenizable_count: number;
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
  max_total_tokens: number;
  max_tokens_per_item: number;
  projected_total_tokens: number;
  would_exceed_total: boolean;
  items: ContextAnalysisItem[];
  warnings: string[];
}

export interface ContextAnalysisReport {
  status: "passed" | "warnings" | "blocked";
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

function materializedTokenEstimate(actualTokens: number, maxTokensPerItem: number): number {
  return Math.min(actualTokens, maxTokensPerItem);
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

function tryDecodeUtf8(buffer: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return undefined;
  }
}

async function readFileTokenMatch(
  root: string,
  relativePath: string,
  maxTokensPerItem: number
): Promise<ContextAnalysisFileMatch | undefined> {
  const absolutePath = resolveSubpathWithinRoot(
    root,
    relativePath,
    `Context analysis file "${relativePath}"`
  );
  const text = tryDecodeUtf8(await readFile(absolutePath));
  if (text === undefined) {
    return undefined;
  }
  const tokens = countContextTokens(text);
  return {
    path: relativePath,
    tokens,
    materialized_tokens: materializedTokenEstimate(tokens, maxTokensPerItem),
    truncated: tokens > maxTokensPerItem
  };
}

async function analyzeWorkspaceFile(options: {
  item: Extract<ContextItem, { from: "workspace_file" }>;
  key: string;
  repoAlias: string;
  repoRoot: string;
  maxTokensPerItem: number;
}): Promise<ContextAnalysisItem> {
  const normalizedPath = normalizeRelativePath(options.item.path);
  const match = await readFileTokenMatch(options.repoRoot, normalizedPath, options.maxTokensPerItem);
  return {
    key: options.key,
    name: options.item.name,
    kind: "workspace_file",
    path: normalizedPath,
    repo_alias: options.repoAlias,
    match_count: match ? 1 : 0,
    projected_tokens: match?.materialized_tokens ?? 0,
    actual_tokens: match?.tokens ?? 0,
    truncated_count: match?.truncated ? 1 : 0,
    non_tokenizable_count: match ? 0 : 1,
    sample_matches: match ? [match.path] : [],
    largest_matches: match ? [match] : [],
    default_ignored_roots: [...defaultContextIgnoredRoots],
    warnings: match?.truncated ? [`${normalizedPath} will be truncated by max_tokens_per_item.`] : []
  };
}

async function analyzeWorkspaceGlob(options: {
  item: Extract<ContextItem, { from: "workspace_glob" }>;
  key: string;
  repoAlias: string;
  repoRoot: string;
  repoRelativePattern: string;
  maxTokensPerItem: number;
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
  const matches: ContextAnalysisFileMatch[] = [];
  let nonTokenizableCount = 0;

  for (const relativePath of matchedPaths) {
    const match = await readFileTokenMatch(options.repoRoot, relativePath, options.maxTokensPerItem);
    if (match) {
      matches.push(match);
    } else {
      nonTokenizableCount += 1;
    }
  }

  const warnings: string[] = [];
  if (options.item.max_files === undefined) {
    warnings.push(`workspace_glob "${options.item.path}" has no max_files cap.`);
  }
  if (matches.some((match) => match.truncated)) {
    warnings.push("One or more glob matches will be truncated by max_tokens_per_item.");
  }

  return {
    key: options.key,
    name: options.item.name,
    kind: "workspace_glob",
    path: options.item.path,
    repo_alias: options.repoAlias,
    match_count: matchedPaths.length,
    projected_tokens: matches.reduce((sum, match) => sum + match.materialized_tokens, 0),
    actual_tokens: matches.reduce((sum, match) => sum + match.tokens, 0),
    truncated_count: matches.filter((match) => match.truncated).length,
    non_tokenizable_count: nonTokenizableCount,
    sample_matches: matchedPaths.slice(0, 10),
    largest_matches: matches
      .slice()
      .sort((left, right) => right.tokens - left.tokens)
      .slice(0, 10),
    default_ignored_roots: repoFiles.ignored_roots,
    ...(ignoredRootOptIn ? { explicit_ignored_root_opt_in: ignoredRootOptIn } : {}),
    warnings
  };
}

async function analyzeContextItem(options: {
  item: ContextItem;
  index: number;
  node: CompiledExecutableNode;
  repo_workspaces: Record<string, string>;
}): Promise<ContextAnalysisItem> {
  const key = options.item.name || `context_${options.index + 1}`;
  const maxTokensPerItem = options.node.effective_policy.input_rules.max_tokens_per_item;

  if (isArtifactContextItem(options.item)) {
    return {
      key,
      name: options.item.name,
      kind: "artifact",
      match_count: 0,
      projected_tokens: 0,
      actual_tokens: 0,
      truncated_count: 0,
      non_tokenizable_count: 0,
      sample_matches: [],
      largest_matches: [],
      default_ignored_roots: [],
      warnings: ["Artifact context is runtime-dependent and cannot be token-costed before launch."]
    };
  }

  if (options.item.from === "text") {
    const tokens = countContextTokens(options.item.text);
    return {
      key,
      name: options.item.name,
      kind: "text",
      match_count: 1,
      projected_tokens: materializedTokenEstimate(tokens, maxTokensPerItem),
      actual_tokens: tokens,
      truncated_count: tokens > maxTokensPerItem ? 1 : 0,
      non_tokenizable_count: 0,
      sample_matches: [],
      largest_matches: [],
      default_ignored_roots: [],
      warnings: tokens > maxTokensPerItem ? ["Inline text context will be truncated by max_tokens_per_item."] : []
    };
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
      projected_tokens: 0,
      actual_tokens: 0,
      truncated_count: 0,
      non_tokenizable_count: 0,
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
      maxTokensPerItem
    });
  }

  return analyzeWorkspaceGlob({
    item: options.item,
    key,
    repoAlias: split.repo_alias,
    repoRoot,
    repoRelativePattern: split.repo_relative_path,
    maxTokensPerItem
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
  const projectedTotal = items.reduce((sum, item) => sum + item.projected_tokens, 0);
  const maxTotal = options.node.effective_policy.input_rules.max_total_tokens;
  const warnings = items.flatMap((item) => item.warnings);

  return {
    compiled_id: options.node.compiled_id,
    authored_id: options.node.authored_id,
    repo_alias: options.node.repo,
    max_total_tokens: maxTotal,
    max_tokens_per_item: options.node.effective_policy.input_rules.max_tokens_per_item,
    projected_total_tokens: projectedTotal,
    would_exceed_total: projectedTotal > maxTotal,
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
  const diagnostics = nodes.flatMap((node) => {
    const warnings = node.warnings.map((warning) => ({
      severity: "warning" as const,
      compiled_id: node.compiled_id,
      authored_id: node.authored_id,
      path: `${node.authored_id}.context`,
      message: warning
    }));
    const blocked = node.would_exceed_total
      ? [
          {
            severity: "error" as const,
            compiled_id: node.compiled_id,
            authored_id: node.authored_id,
            path: `${node.authored_id}.context`,
            message: `Projected context materialization uses ${node.projected_total_tokens} tokens, exceeding max_total_tokens ${node.max_total_tokens}.`
          }
        ]
      : [];
    return [...blocked, ...warnings];
  });

  return {
    status: diagnostics.some((diagnostic) => diagnostic.severity === "error")
      ? "blocked"
      : diagnostics.length > 0 ? "warnings" : "passed",
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
      `- Projected total tokens: \`${node.projected_total_tokens}\` / \`${node.max_total_tokens}\``,
      `- Would exceed total: \`${node.would_exceed_total}\``
    );
    for (const item of node.items) {
      lines.push(
        "",
        `### ${item.name}`,
        "",
        `- Kind: \`${item.kind}\``,
        ...(item.path ? [`- Path: \`${item.path}\``] : []),
        `- Matches: \`${item.match_count}\``,
        `- Projected tokens: \`${item.projected_tokens}\``,
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
          ? ["- Largest matches:", ...item.largest_matches.map((match) => `  - \`${match.path}\` (${match.tokens} tokens)`)]
          : [])
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

export function createCompactContextIndex(report: ContextAnalysisNode): string {
  const lines = [
    "# Supervisor context repair",
    "",
    "The authored context package could not be materialized within the node token budget.",
    "Graph intent, node goal, acceptance criteria, constraints, repo authority, sandbox, and declared artifacts are unchanged.",
    "",
    `Projected authored context tokens: ${report.projected_total_tokens} / ${report.max_total_tokens}.`,
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
      `- Projected tokens: ${item.projected_tokens}`,
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
        ? ["- Largest matches:", ...item.largest_matches.slice(0, 10).map((match) => `  - ${match.path} (${match.tokens} tokens)`)]
        : [])
    );
  }

  return `${lines.join("\n")}\n`;
}

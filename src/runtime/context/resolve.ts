import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { resolveSubpathWithinRoot } from "../../path_rules.js";
import type { ContextItem } from "../../graph/authored.js";
import type { CompiledExecutableNode, CompiledGraph } from "../../graph/compiled.js";
import type { AttemptRegistry, AttemptSelector, RuntimeNodeAttempt } from "../attempts.js";
import { listAttemptsForCompiledNode, selectAttempt } from "../attempts.js";
import type {
  ContextInputProvenance,
  ContextPacket,
  ContextPacketMaterializedItem,
  ContextPacketOmittedItem,
  ContextPacketSource,
  ContextProvenance,
  WorkspaceFileContextProvenance,
  WorkspaceGlobContextProvenance
} from "./packet.js";
import {
  aggregateDigest,
  createDigest
} from "./digests.js";
import {
  createContextDiscoveryCache,
  computeHarnessInstructionProvenance,
  type ContextDiscoveryCache
} from "./provenance.js";
import {
  globPatternToRegExp,
  normalizeRelativePath,
  splitQualifiedPath
} from "./common.js";
import { listRepoFiles } from "./repo_files.js";
import {
  contextTokenizerName,
  countContextTokens,
  decodeContextTokens,
  encodeContextText
} from "./tokenizer.js";
import { buildRepeatHistory } from "./repeat_history.js";

interface PreparedMaterialization {
  text: string;
  tokens: number;
  truncated: boolean;
}

interface MaterializationAccumulator {
  materials: ContextPacketMaterializedItem[];
  omitted: ContextPacketOmittedItem[];
  total_tokens: number;
  max_total_tokens: number;
}

export interface ResolveContextOptions {
  compiled_graph: CompiledGraph;
  node: CompiledExecutableNode;
  execution_id: string;
  execution_dir: string;
  workspace_path: string;
  repo_workspaces: Record<string, string>;
  attempts: AttemptRegistry;
}

const truncatedTextNotice =
  "[Truncated by Agentflow. Read the original file for full context.]\n";

function tryDecodeUtf8(buffer: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return undefined;
  }
}

function buildTruncatedTextCandidate(tokens: number[], prefixTokenCount: number): string {
  const selected = decodeContextTokens(tokens.slice(0, prefixTokenCount));
  const trimmed = selected.replace(/\s+$/u, "");
  const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : "";
  return `${prefix}${truncatedTextNotice}`;
}

function truncateTextToTokenLimit(text: string, maxTokens: number): PreparedMaterialization {
  const sourceTokens = encodeContextText(text);

  if (sourceTokens.length <= maxTokens) {
    return {
      text,
      tokens: sourceTokens.length,
      truncated: false
    };
  }

  let low = 0;
  let high = Math.min(sourceTokens.length, maxTokens);

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = buildTruncatedTextCandidate(sourceTokens, mid);

    if (countContextTokens(candidate) <= maxTokens) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  let materializedText = buildTruncatedTextCandidate(sourceTokens, low);
  let tokens = countContextTokens(materializedText);

  if (tokens > maxTokens) {
    materializedText = decodeContextTokens(encodeContextText(truncatedTextNotice).slice(0, maxTokens));
    tokens = countContextTokens(materializedText);
  }

  return {
    text: materializedText,
    tokens,
    truncated: true
  };
}

function prepareTextMaterialization(
  contents: string,
  maxTokensPerItem: number
): PreparedMaterialization {
  return truncateTextToTokenLimit(contents, maxTokensPerItem);
}

function prepareBufferMaterialization(
  contents: Buffer,
  maxTokensPerItem: number
): PreparedMaterialization | undefined {
  const text = tryDecodeUtf8(contents);
  return text === undefined ? undefined : prepareTextMaterialization(text, maxTokensPerItem);
}

async function writePreparedMaterialization(
  destinationPath: string,
  materialized: PreparedMaterialization
): Promise<void> {
  await mkdir(dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, materialized.text, "utf8");
}

type ArtifactContextItem = Extract<ContextItem, { ref: string }>;

function isArtifactContextItem(item: ContextItem): item is ArtifactContextItem {
  return "ref" in item;
}

function describeReservedArtifact(artifact: string): string | undefined {
  if (artifact === "agent_response") {
    return "Final response captured from the producer node.";
  }

  if (artifact === "result_json") {
    return "Normalized result.json captured from the producer node.";
  }

  if (artifact === "stdout") {
    return "Captured stdout log from the producer node.";
  }

  if (artifact === "stderr") {
    return "Captured stderr log from the producer node.";
  }

  return undefined;
}

function describeArtifactReference(
  graph: CompiledGraph,
  compiledIds: string[],
  reference: ArtifactContextItem
): string | undefined {
  const declaredDescription = compiledIds
    .map((compiledId) => graph.nodes.find((node) => node.compiled_id === compiledId))
    .map((node) => node?.declared_artifacts[reference.artifact]?.description)
    .find((description): description is string => typeof description === "string");

  return declaredDescription ?? describeReservedArtifact(reference.artifact);
}

function describeContextItem(item: ContextItem, index: number): string {
  const key = `context_${index + 1}`;

  if (isArtifactContextItem(item)) {
    return `${key} (artifact "${item.ref}")`;
  }

  if (item.from === "text") {
    return `${key} (text "${item.name}")`;
  }

  if (item.from === "workspace_file") {
    return `${key} (workspace file "${item.path}")`;
  }

  return `${key} (workspace glob "${item.path}")`;
}

function createBudgetOverflowError(
  descriptor: string,
  currentTokens: number,
  nextTokens: number,
  maxTotalTokens: number
): Error {
  return new Error(
    `Materializing ${descriptor} would exceed max_total_tokens ${maxTotalTokens}. Current tokens: ${currentTokens}. Next item tokens: ${nextTokens}.`
  );
}

async function appendMaterializedItem(
  accumulator: MaterializationAccumulator,
  item: ContextPacketMaterializedItem,
  materialized: PreparedMaterialization,
  descriptor: string
): Promise<void> {
  if (accumulator.total_tokens + materialized.tokens > accumulator.max_total_tokens) {
    throw createBudgetOverflowError(
      descriptor,
      accumulator.total_tokens,
      materialized.tokens,
      accumulator.max_total_tokens
    );
  }

  await writePreparedMaterialization(item.materialized_path, materialized);
  accumulator.materials.push(item);
  accumulator.total_tokens += materialized.tokens;
}

function appendNonTokenizableOmission(
  accumulator: MaterializationAccumulator,
  key: string,
  source: ContextPacketSource,
  ifAvailable: boolean
): void {
  accumulator.omitted.push({
    key,
    source,
    reason: "Material is not valid UTF-8 text and cannot be tokenized.",
    if_available: ifAvailable
  });
}

async function materializeRepeatHistoryContext(
  options: ResolveContextOptions,
  accumulator: MaterializationAccumulator,
  maxTokensPerItem: number
): Promise<void> {
  const history = await buildRepeatHistory({
    compiled_graph: options.compiled_graph,
    node: options.node,
    execution_id: options.execution_id,
    attempts: options.attempts
  });

  if (!history) {
    return;
  }

  if ("reason" in history) {
    accumulator.omitted.push({
      key: history.source.name,
      source: history.source,
      description: history.description,
      reason: history.reason,
      if_available: true
    });
    return;
  }

  const remainingTokens = accumulator.max_total_tokens - accumulator.total_tokens;

  if (remainingTokens <= 0) {
    accumulator.omitted.push({
      key: history.source.name,
      source: history.source,
      description: history.description,
      reason: "Repeat history was omitted because authored context consumed the available token budget.",
      if_available: true
    });
    return;
  }

  const materialized = prepareTextMaterialization(history.text, Math.min(maxTokensPerItem, remainingTokens));

  await appendMaterializedItem(
    accumulator,
    {
      key: history.source.name,
      source: history.source,
      description: history.description,
      materialized_path: join(
        options.execution_dir,
        "context",
        "materialized",
        history.source.name,
        "repeat-history.md"
      ),
      tokens: materialized.tokens,
      truncated: materialized.truncated
    },
    materialized,
    "runtime repeat history"
  );
}

interface SelectAttemptsContext {
  consumer_node: CompiledExecutableNode;
  consumer_execution_id: string;
}

function resolveConsumerIteration(
  registry: AttemptRegistry,
  context: SelectAttemptsContext
): number | undefined {
  const active = registry.active_by_execution_id.get(context.consumer_execution_id);

  if (active?.iteration_index !== undefined) {
    return active.iteration_index;
  }

  const consumerAttempts = listAttemptsForCompiledNode(registry, context.consumer_node.compiled_id);
  const matched = consumerAttempts.find(
    (attempt) => attempt.execution_id === context.consumer_execution_id
  );

  return matched?.iteration_index;
}

function selectAttemptsForReference(
  registry: AttemptRegistry,
  graph: CompiledGraph,
  compiledIds: string[],
  reference: ArtifactContextItem,
  context: SelectAttemptsContext
): RuntimeNodeAttempt[] {
  const attempts = compiledIds.flatMap((compiledId) => listAttemptsForCompiledNode(registry, compiledId));

  if (attempts.length === 0) {
    return [];
  }

  const iterationSelector = reference.iteration as AttemptSelector | undefined;
  const attemptSelector = (reference.attempt ?? "latest") as AttemptSelector;

  const filteredByIteration =
    iterationSelector === undefined
      ? attempts
      : typeof iterationSelector === "number"
        ? attempts.filter((attempt) => attempt.iteration_index === iterationSelector)
        : iterationSelector === "previous"
          ? (() => {
              const consumerIteration = resolveConsumerIteration(registry, context);

              if (consumerIteration === undefined || consumerIteration <= 1) {
                return [];
              }

              return attempts.filter((attempt) => attempt.iteration_index === consumerIteration - 1);
            })()
          : (() => {
              const repeatScopeId = compiledIds
                .map((compiledId) => graph.nodes.find((node) => node.compiled_id === compiledId)?.repeat_scope_id)
                .find((scopeId): scopeId is string => scopeId !== undefined);
              const repeatScope =
                repeatScopeId === undefined
                  ? undefined
                  : graph.scopes.find(
                      (scope) => scope.kind === "repeat" && scope.scope_id === repeatScopeId
                    );
              const repeatSelectorAttempts =
                repeatScope?.kind === "repeat"
                  ? listAttemptsForCompiledNode(registry, repeatScope.until_compiled_id).filter(
                      (attempt) => attempt.iteration_index !== undefined
                    )
                  : [];
              const selectorAttempts =
                repeatSelectorAttempts.length > 0
                  ? repeatSelectorAttempts
                  : attempts.filter((attempt) => attempt.iteration_index !== undefined);
              const candidate = selectAttempt(selectorAttempts, iterationSelector);

              return candidate ? attempts.filter((attempt) => attempt.iteration_index === candidate.iteration_index) : [];
            })();

  const selected = selectAttempt(filteredByIteration, attemptSelector);
  return selected ? [selected] : [];
}

async function materializeTextContext(
  item: Extract<ContextItem, { from: "text" }>,
  index: number,
  options: ResolveContextOptions,
  accumulator: MaterializationAccumulator,
  maxTokensPerItem: number
): Promise<void> {
  const descriptor = describeContextItem(item, index);
  const key = item.name;
  const materialized = prepareTextMaterialization(item.text, maxTokensPerItem);

  await appendMaterializedItem(
    accumulator,
    {
      key,
      source: item,
      materialized_path: join(
        options.execution_dir,
        "context",
        "materialized",
        key,
        `${item.name}.txt`
      ),
      tokens: materialized.tokens,
      truncated: materialized.truncated
    },
    materialized,
    descriptor
  );
}

async function materializeWorkspaceFileContext(
  item: Extract<ContextItem, { from: "workspace_file" }>,
  index: number,
  options: ResolveContextOptions,
  cache: ContextDiscoveryCache,
  accumulator: MaterializationAccumulator,
  contextProvenance: ContextInputProvenance[],
  maxTokensPerItem: number
): Promise<void> {
  const descriptor = describeContextItem(item, index);
  const key = item.name;
  const { repo_alias, repo_relative_path } = splitQualifiedPath(item.path, options.node.repo);
  const repoRoot = options.repo_workspaces[repo_alias];

  if (!repoRoot) {
    throw new Error(`Unknown repo alias "${repo_alias}" while resolving ${descriptor}.`);
  }

  const normalizedPath = normalizeRelativePath(repo_relative_path);
  const sourcePath = resolveSubpathWithinRoot(
    repoRoot,
    repo_relative_path,
    `Context path "${item.path}"`
  );

  let contents: Buffer;

  try {
    contents = await readFile(sourcePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      accumulator.omitted.push({
        key,
        source: item,
        reason: `Requested context workspace file "${item.path}" was not found at execution time.`,
        if_available: false
      });
      return;
    }

    throw error;
  }

  const materialized = prepareBufferMaterialization(contents, maxTokensPerItem);

  if (!materialized) {
    appendNonTokenizableOmission(accumulator, key, item, false);
    return;
  }

  await appendMaterializedItem(
    accumulator,
    {
      key,
      source: item,
      materialized_path: join(
        options.execution_dir,
        "context",
        "materialized",
        key,
        basename(normalizedPath)
      ),
      tokens: materialized.tokens,
      truncated: materialized.truncated,
      binding: {
        kind: "live_workspace_input",
        requested_path: normalizedPath,
        resolved_path: sourcePath
      }
    },
    materialized,
    descriptor
  );

  const digest = createDigest(contents);
  cache.file_digests.set(sourcePath, digest);
  contextProvenance.push({
    from: "workspace_file",
    key,
    repo_alias,
    path: normalizedPath,
    resolved_path: sourcePath,
    digest
  } satisfies WorkspaceFileContextProvenance);
}

async function materializeWorkspaceGlobContext(
  item: Extract<ContextItem, { from: "workspace_glob" }>,
  index: number,
  options: ResolveContextOptions,
  cache: ContextDiscoveryCache,
  accumulator: MaterializationAccumulator,
  contextProvenance: ContextInputProvenance[],
  maxTokensPerItem: number
): Promise<void> {
  const descriptor = describeContextItem(item, index);
  const key = item.name;
  const { repo_alias, repo_relative_path } = splitQualifiedPath(item.path, options.node.repo);
  const repoRoot = options.repo_workspaces[repo_alias];

  if (!repoRoot) {
    throw new Error(`Unknown repo alias "${repo_alias}" while resolving ${descriptor}.`);
  }

  const normalizedPattern = normalizeRelativePath(repo_relative_path);
  const matcher = globPatternToRegExp(normalizedPattern);
  const repoFiles = await listRepoFiles(repoRoot, cache.repo_files);
  const matchedPaths = repoFiles
    .filter((filePath) => matcher.test(filePath))
    .slice(0, item.max_files ?? Number.MAX_SAFE_INTEGER);

  if (matchedPaths.length === 0) {
    accumulator.omitted.push({
      key,
      source: item,
      reason: `Requested context workspace glob "${item.path}" matched no files after ignore filtering at execution time.`,
      if_available: false
    });
    return;
  }

  const files: WorkspaceGlobContextProvenance["files"] = [];

  for (const [matchIndex, relativePath] of matchedPaths.entries()) {
    const sourcePath = resolveSubpathWithinRoot(
      repoRoot,
      relativePath,
      `Glob match "${relativePath}" from "${item.path}"`
    );
    const contents = await readFile(sourcePath);
    const digest = createDigest(contents);
    cache.file_digests.set(sourcePath, digest);
    const materialized = prepareBufferMaterialization(contents, maxTokensPerItem);
    const materializedKey = `${key}_${matchIndex + 1}`;

    if (!materialized) {
      appendNonTokenizableOmission(accumulator, materializedKey, item, false);
      continue;
    }

    await appendMaterializedItem(
      accumulator,
      {
        key: materializedKey,
        source: item,
        materialized_path: join(
          options.execution_dir,
          "context",
          "materialized",
          key,
          `${matchIndex + 1}-${basename(relativePath)}`
        ),
        tokens: materialized.tokens,
        truncated: materialized.truncated,
        binding: {
          kind: "live_workspace_input",
          requested_path: relativePath,
          resolved_path: sourcePath
        }
      },
      materialized,
      `${descriptor} match "${relativePath}"`
    );

    files.push({
      path: relativePath,
      resolved_path: sourcePath,
      digest
    });
  }

  contextProvenance.push({
    from: "workspace_glob",
    key,
    repo_alias,
    pattern: normalizedPattern,
    files,
    digest: aggregateDigest(files)
  } satisfies WorkspaceGlobContextProvenance);
}

async function materializeContextItem(
  item: ContextItem,
  index: number,
  options: ResolveContextOptions,
  cache: ContextDiscoveryCache,
  accumulator: MaterializationAccumulator,
  contextProvenance: ContextInputProvenance[],
  maxTokensPerItem: number
): Promise<void> {
  if (isArtifactContextItem(item)) {
    await materializeArtifactContext(
      item,
      index,
      options,
      accumulator,
      maxTokensPerItem
    );
    return;
  }

  if (item.from === "text") {
    await materializeTextContext(item, index, options, accumulator, maxTokensPerItem);
    return;
  }

  if (item.from === "workspace_file") {
    await materializeWorkspaceFileContext(
      item,
      index,
      options,
      cache,
      accumulator,
      contextProvenance,
      maxTokensPerItem
    );
    return;
  }

  await materializeWorkspaceGlobContext(
    item,
    index,
    options,
    cache,
    accumulator,
    contextProvenance,
    maxTokensPerItem
  );
}

async function materializeArtifactContext(
  reference: ArtifactContextItem,
  index: number,
  options: ResolveContextOptions,
  accumulator: MaterializationAccumulator,
  maxTokensPerItem: number
): Promise<void> {
  const compiledIds = options.compiled_graph.authored_to_compiled[reference.node] ?? [];
  const description = describeArtifactReference(options.compiled_graph, compiledIds, reference);
  const attempts = selectAttemptsForReference(
    options.attempts,
    options.compiled_graph,
    compiledIds,
    reference,
    {
      consumer_node: options.node,
      consumer_execution_id: options.execution_id
    }
  );

  if (attempts.length === 0) {
    if (reference.if_available) {
      accumulator.omitted.push({
        key: reference.name,
        source: reference,
        ...(description ? { description } : {}),
        reason: `No execution matched "${reference.node}".`,
        if_available: true
      });
      return;
    }

    throw new Error(`No execution matched required context reference "${reference.node}".`);
  }

  const selected = attempts[0];

  if (!selected) {
    throw new Error(`No execution matched required context reference "${reference.node}".`);
  }

  const sourcePath = selected.artifacts[reference.artifact];

  if (!sourcePath) {
    if (reference.if_available) {
      accumulator.omitted.push({
        key: reference.name,
        source: reference,
        ...(description ? { description } : {}),
        reason: `Selected execution for "${reference.node}" did not produce the requested artifact.`,
        if_available: true
      });
      return;
    }

    throw new Error(`Required context artifact is missing for "${reference.node}".`);
  }

  const materialized = prepareBufferMaterialization(await readFile(sourcePath), maxTokensPerItem);
  const key = reference.name;

  if (!materialized) {
    appendNonTokenizableOmission(accumulator, key, reference, reference.if_available ?? false);
    return;
  }

  await appendMaterializedItem(
    accumulator,
    {
      key,
      source: reference,
      ...(description ? { description } : {}),
      materialized_path: join(
        options.execution_dir,
        "context",
        "materialized",
        key,
        basename(sourcePath)
      ),
      tokens: materialized.tokens,
      truncated: materialized.truncated
    },
    materialized,
    describeContextItem(reference, index)
  );
}

function renderContextManifest(packet: ContextPacket): string {
  const truncatedCount = packet.materials.filter((item) => item.truncated).length;
  const liveWorkspaceItems = packet.materials.filter((item) => item.binding?.kind === "live_workspace_input");
  const lines = [
    `# Context Manifest: ${packet.execution_id}`,
    "",
    `- Compiled node: \`${packet.compiled_id}\``,
    `- Repo: \`${packet.repo_alias}\``,
    `- Workspace: \`${packet.workspace_path}\``,
    `- Tokenizer: \`${packet.tokenizer}\``,
    `- Materialized items: \`${packet.totals.material_count}\``,
    `- Total files: \`${packet.totals.file_count}\``,
    `- Total tokens: \`${packet.totals.total_tokens}\``,
    `- Truncated items: \`${truncatedCount}\``,
    `- Live workspace context items: \`${liveWorkspaceItems.length}\``,
    `- Omitted items: \`${packet.omitted.length}\``,
    ""
  ];

  if (packet.materials.length > 0) {
    lines.push("## Materials", "");

    for (const item of packet.materials) {
      const bindingSuffix =
        item.binding?.kind === "live_workspace_input"
          ? `, requested "${item.binding.requested_path ?? "inline text"}", resolved "${item.binding.resolved_path}"`
          : "";
      lines.push(
        `- \`${item.key}\` -> \`${item.materialized_path}\` (${item.tokens} tokens${item.truncated ? ", truncated" : ""}${bindingSuffix})${item.description ? `: ${item.description}` : ""}`
      );
    }

    lines.push("");
  }

  if (packet.omitted.length > 0) {
    lines.push("## Omitted", "");

    for (const item of packet.omitted) {
      lines.push(`- \`${item.key}\`: ${item.reason}${item.description ? ` Expected content: ${item.description}` : ""}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function resolveExecutionContext(
  options: ResolveContextOptions
): Promise<{
  packet: ContextPacket;
  packet_path: string;
  manifest_path: string;
  provenance: ContextProvenance;
  provenance_path: string;
}> {
  const cache = createContextDiscoveryCache();
  const contextProvenance: ContextInputProvenance[] = [];
  const accumulator: MaterializationAccumulator = {
    materials: [],
    omitted: [],
    total_tokens: 0,
    max_total_tokens: options.node.effective_policy.input_rules.max_total_tokens
  };

  for (const [index, item] of (options.node.context ?? []).entries()) {
    await materializeContextItem(
      item,
      index,
      options,
      cache,
      accumulator,
      contextProvenance,
      options.node.effective_policy.input_rules.max_tokens_per_item
    );
  }

  await materializeRepeatHistoryContext(
    options,
    accumulator,
    options.node.effective_policy.input_rules.max_tokens_per_item
  );

  const harness_instructions = await computeHarnessInstructionProvenance({
    node: options.node,
    repo_workspaces: options.repo_workspaces,
    cache
  });
  const provenance: ContextProvenance = {
    compiled_id: options.node.compiled_id,
    authored_id: options.node.authored_id,
    repo_alias: options.node.repo,
    workspace_context: contextProvenance,
    ...(harness_instructions ? { harness_instructions } : {})
  };

  const packet: ContextPacket = {
    execution_id: options.execution_id,
    compiled_id: options.node.compiled_id,
    authored_id: options.node.authored_id,
    repo_alias: options.node.repo,
    workspace_path: options.workspace_path,
    tokenizer: contextTokenizerName,
    materials: accumulator.materials,
    omitted: accumulator.omitted,
    totals: {
      material_count: accumulator.materials.length,
      file_count: accumulator.materials.length,
      total_tokens: accumulator.total_tokens
    }
  };

  const packet_path = join(options.execution_dir, "context", "packet.json");
  const manifest_path = join(options.execution_dir, "context", "manifest.md");
  const provenance_path = join(options.execution_dir, "context", "provenance.json");
  await mkdir(dirname(packet_path), { recursive: true });
  await writeFile(packet_path, `${JSON.stringify(packet, null, 2)}\n`);
  await writeFile(manifest_path, renderContextManifest(packet));
  await writeFile(provenance_path, `${JSON.stringify(provenance, null, 2)}\n`);

  return {
    packet,
    packet_path,
    manifest_path,
    provenance,
    provenance_path
  };
}

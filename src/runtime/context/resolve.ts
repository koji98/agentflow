import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { resolveSubpathWithinRoot } from "../../path_rules.js";
import type { ContextReference, InputItem } from "../../graph/authored.js";
import type { CompiledExecutableNode, CompiledGraph } from "../../graph/compiled.js";
import type { AttemptRegistry, AttemptSelector, RuntimeNodeAttempt } from "../attempts.js";
import { listAttemptsForCompiledNode, selectAttempt } from "../attempts.js";
import type {
  ContextFileInputProvenance,
  ContextGlobInputProvenance,
  ContextInputProvenance,
  ContextPacket,
  ContextPacketMaterializedItem,
  ContextPacketOmittedItem,
  ContextProvenance
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

interface PreparedMaterialization {
  buffer: Buffer;
  bytes: number;
  truncated: boolean;
}

interface MaterializationAccumulator {
  materials: ContextPacketMaterializedItem[];
  omitted: ContextPacketOmittedItem[];
  total_bytes: number;
  max_total_bytes: number;
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

function sliceTextToByteLimit(text: string, maxBytes: number): string {
  let low = 0;
  let high = text.length;

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = text.slice(0, mid);

    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  return text.slice(0, low);
}

function truncateTextBuffer(buffer: Buffer, maxBytes: number): Buffer | undefined {
  const decoded = tryDecodeUtf8(buffer);

  if (decoded === undefined) {
    return undefined;
  }

  const noticeBytes = Buffer.byteLength(truncatedTextNotice, "utf8");

  if (maxBytes <= noticeBytes + 1) {
    return undefined;
  }

  const availableBytes = maxBytes - noticeBytes;
  const lines = decoded.split(/(?<=\n)/u);
  let selected = "";
  let usedBytes = 0;

  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, "utf8");

    if (usedBytes + lineBytes > availableBytes) {
      const remainingBytes = availableBytes - usedBytes;

      if (remainingBytes > 0) {
        selected += sliceTextToByteLimit(line, remainingBytes);
      }

      break;
    }

    selected += line;
    usedBytes += lineBytes;
  }

  if (selected.length === 0) {
    selected = sliceTextToByteLimit(decoded, availableBytes);
  }

  const trimmed = selected.replace(/\s+$/u, "");
  const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : "";
  return Buffer.from(`${prefix}${truncatedTextNotice}`, "utf8");
}

function truncateMaterializedBuffer(buffer: Buffer, maxBytes: number): Buffer {
  return truncateTextBuffer(buffer, maxBytes) ?? buffer.subarray(0, maxBytes);
}

function prepareMaterialization(
  contents: string | Buffer,
  maxBytesPerItem: number
): PreparedMaterialization {
  const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  const materializedBuffer =
    buffer.byteLength > maxBytesPerItem ? truncateMaterializedBuffer(buffer, maxBytesPerItem) : buffer;

  return {
    buffer: materializedBuffer,
    bytes: materializedBuffer.byteLength,
    truncated: materializedBuffer.byteLength !== buffer.byteLength
  };
}

async function writePreparedMaterialization(
  destinationPath: string,
  materialized: PreparedMaterialization
): Promise<void> {
  await mkdir(dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, materialized.buffer);
}

function describeInput(input: InputItem, index: number): string {
  const key = `input_${index + 1}`;

  if (input.kind === "text") {
    return `${key} (text "${input.name}")`;
  }

  if (input.kind === "file") {
    return `${key} (file "${input.path}")`;
  }

  return `${key} (glob "${input.path}")`;
}

function describeContextReference(reference: ContextReference, index: number): string {
  const key = `context_${index + 1}`;
  const detail =
    reference.include === "output"
      ? `"${reference.node}" output "${reference.output ?? "unknown"}"`
      : `"${reference.node}" ${reference.include}`;

  return `${key} (from ${detail})`;
}

function createBudgetOverflowError(
  descriptor: string,
  currentBytes: number,
  nextBytes: number,
  maxTotalBytes: number
): Error {
  return new Error(
    `Materializing ${descriptor} would exceed max_total_bytes ${maxTotalBytes}. Current bytes: ${currentBytes}. Next item bytes: ${nextBytes}.`
  );
}

async function appendMaterializedItem(
  accumulator: MaterializationAccumulator,
  item: ContextPacketMaterializedItem,
  materialized: PreparedMaterialization,
  descriptor: string
): Promise<void> {
  if (accumulator.total_bytes + materialized.bytes > accumulator.max_total_bytes) {
    throw createBudgetOverflowError(
      descriptor,
      accumulator.total_bytes,
      materialized.bytes,
      accumulator.max_total_bytes
    );
  }

  await writePreparedMaterialization(item.materialized_path, materialized);
  accumulator.materials.push(item);
  accumulator.total_bytes += materialized.bytes;
}

function selectAttemptsForReference(
  registry: AttemptRegistry,
  graph: CompiledGraph,
  compiledIds: string[],
  reference: ContextReference
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

async function materializeTextInput(
  input: InputItem & { kind: "text" },
  index: number,
  options: ResolveContextOptions,
  accumulator: MaterializationAccumulator,
  maxBytesPerItem: number
): Promise<void> {
  const descriptor = describeInput(input, index);
  const materialized = prepareMaterialization(input.text, maxBytesPerItem);

  await appendMaterializedItem(
    accumulator,
    {
      key: `input_${index + 1}`,
      kind: "input",
      source: input,
      materialized_path: join(
        options.execution_dir,
        "context_materialized",
        `input_${index + 1}`,
        `${input.name}.txt`
      ),
      bytes: materialized.bytes,
      truncated: materialized.truncated
    },
    materialized,
    descriptor
  );
}

async function materializeFileInput(
  input: InputItem & { kind: "file" },
  index: number,
  options: ResolveContextOptions,
  cache: ContextDiscoveryCache,
  accumulator: MaterializationAccumulator,
  inputProvenance: ContextInputProvenance[],
  maxBytesPerItem: number
): Promise<void> {
  const descriptor = describeInput(input, index);
  const key = `input_${index + 1}`;
  const { repo_alias, repo_relative_path } = splitQualifiedPath(input.path, options.node.repo);
  const repoRoot = options.repo_workspaces[repo_alias];

  if (!repoRoot) {
    throw new Error(`Unknown repo alias "${repo_alias}" while resolving ${descriptor}.`);
  }

  const normalizedPath = normalizeRelativePath(repo_relative_path);
  const sourcePath = resolveSubpathWithinRoot(
    repoRoot,
    repo_relative_path,
    `Input path "${input.path}"`
  );

  let contents: Buffer;

  try {
    contents = await readFile(sourcePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      accumulator.omitted.push({
        key,
        source: input,
        reason: `Requested input file "${input.path}" was not found at execution time.`,
        optional: false
      });
      return;
    }

    throw error;
  }

  const materialized = prepareMaterialization(contents, maxBytesPerItem);

  await appendMaterializedItem(
    accumulator,
    {
      key,
      kind: "input",
      source: input,
      materialized_path: join(
        options.execution_dir,
        "context_materialized",
        key,
        basename(normalizedPath)
      ),
      bytes: materialized.bytes,
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
  inputProvenance.push({
    kind: "file",
    key,
    repo_alias,
    path: normalizedPath,
    resolved_path: sourcePath,
    digest
  } satisfies ContextFileInputProvenance);
}

async function materializeGlobInput(
  input: InputItem & { kind: "glob" },
  index: number,
  options: ResolveContextOptions,
  cache: ContextDiscoveryCache,
  accumulator: MaterializationAccumulator,
  inputProvenance: ContextInputProvenance[],
  maxBytesPerItem: number
): Promise<void> {
  const descriptor = describeInput(input, index);
  const key = `input_${index + 1}`;
  const { repo_alias, repo_relative_path } = splitQualifiedPath(input.path, options.node.repo);
  const repoRoot = options.repo_workspaces[repo_alias];

  if (!repoRoot) {
    throw new Error(`Unknown repo alias "${repo_alias}" while resolving ${descriptor}.`);
  }

  const normalizedPattern = normalizeRelativePath(repo_relative_path);
  const matcher = globPatternToRegExp(normalizedPattern);
  const repoFiles = await listRepoFiles(repoRoot, cache.repo_files);
  const matchedPaths = repoFiles
    .filter((filePath) => matcher.test(filePath))
    .slice(0, input.max_files ?? Number.MAX_SAFE_INTEGER);

  if (matchedPaths.length === 0) {
    accumulator.omitted.push({
      key,
      source: input,
      reason: `Requested input glob "${input.path}" matched no files after ignore filtering at execution time.`,
      optional: false
    });
    return;
  }

  const files: ContextGlobInputProvenance["files"] = [];

  for (const [matchIndex, relativePath] of matchedPaths.entries()) {
    const sourcePath = resolveSubpathWithinRoot(
      repoRoot,
      relativePath,
      `Glob match "${relativePath}" from "${input.path}"`
    );
    const contents = await readFile(sourcePath);
    const digest = createDigest(contents);
    cache.file_digests.set(sourcePath, digest);
    const materialized = prepareMaterialization(contents, maxBytesPerItem);

    await appendMaterializedItem(
      accumulator,
      {
        key: `${key}_${matchIndex + 1}`,
        kind: "input",
        source: input,
        materialized_path: join(
          options.execution_dir,
          "context_materialized",
          key,
          `${matchIndex + 1}-${basename(relativePath)}`
        ),
        bytes: materialized.bytes,
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

  inputProvenance.push({
    kind: "glob",
    key,
    repo_alias,
    pattern: normalizedPattern,
    files,
    digest: aggregateDigest(files)
  } satisfies ContextGlobInputProvenance);
}

async function materializeInputItem(
  input: InputItem,
  index: number,
  options: ResolveContextOptions,
  cache: ContextDiscoveryCache,
  accumulator: MaterializationAccumulator,
  inputProvenance: ContextInputProvenance[],
  maxBytesPerItem: number
): Promise<void> {
  if (input.kind === "text") {
    await materializeTextInput(input, index, options, accumulator, maxBytesPerItem);
    return;
  }

  if (input.kind === "file") {
    await materializeFileInput(
      input,
      index,
      options,
      cache,
      accumulator,
      inputProvenance,
      maxBytesPerItem
    );
    return;
  }

  await materializeGlobInput(
    input,
    index,
    options,
    cache,
    accumulator,
    inputProvenance,
    maxBytesPerItem
  );
}

async function materializeContextReference(
  reference: ContextReference,
  index: number,
  options: ResolveContextOptions,
  accumulator: MaterializationAccumulator,
  maxBytesPerItem: number
): Promise<void> {
  const compiledIds = options.compiled_graph.authored_to_compiled[reference.node] ?? [];
  const attempts = selectAttemptsForReference(
    options.attempts,
    options.compiled_graph,
    compiledIds,
    reference
  );

  if (attempts.length === 0) {
    if (reference.optional) {
      accumulator.omitted.push({
        key: `context_${index + 1}`,
        source: reference,
        reason: `No execution matched "${reference.node}".`,
        optional: true
      });
      return;
    }

    throw new Error(`No execution matched required context reference "${reference.node}".`);
  }

  const selected = attempts[0];

  if (!selected) {
    throw new Error(`No execution matched required context reference "${reference.node}".`);
  }

  let sourcePath: string | undefined;

  if (reference.include === "summary") {
    sourcePath = selected.context_summary_path;
  } else if (reference.include === "result") {
    sourcePath = selected.result_path;
  } else {
    sourcePath = reference.output ? selected.output_artifacts[reference.output] : undefined;
  }

  if (!sourcePath) {
    if (reference.optional) {
      accumulator.omitted.push({
        key: `context_${index + 1}`,
        source: reference,
        reason: `Selected execution for "${reference.node}" did not produce the requested artifact.`,
        optional: true
      });
      return;
    }

    throw new Error(`Required context artifact is missing for "${reference.node}".`);
  }

  const materialized = prepareMaterialization(await readFile(sourcePath), maxBytesPerItem);

  await appendMaterializedItem(
    accumulator,
    {
      key: `context_${index + 1}`,
      kind: "context",
      source: reference,
      materialized_path: join(
        options.execution_dir,
        "context_materialized",
        `context_${index + 1}`,
        basename(sourcePath)
      ),
      bytes: materialized.bytes,
      truncated: materialized.truncated
    },
    materialized,
    describeContextReference(reference, index)
  );
}

function renderContextSummary(packet: ContextPacket): string {
  const truncatedCount = packet.materials.filter((item) => item.truncated).length;
  const liveInputItems = packet.materials.filter((item) => item.binding?.kind === "live_workspace_input");
  const lines = [
    `# Context Summary: ${packet.execution_id}`,
    "",
    `- Compiled node: \`${packet.compiled_id}\``,
    `- Repo: \`${packet.repo_alias}\``,
    `- Workspace: \`${packet.workspace_path}\``,
    `- Materialized items: \`${packet.totals.material_count}\``,
    `- Total files: \`${packet.totals.file_count}\``,
    `- Total bytes: \`${packet.totals.total_bytes}\``,
    `- Truncated items: \`${truncatedCount}\``,
    `- Live workspace inputs: \`${liveInputItems.length}\``,
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
        `- \`${item.key}\` -> \`${item.materialized_path}\` (${item.bytes} bytes${item.truncated ? ", truncated" : ""}${bindingSuffix})`
      );
    }

    lines.push("");
  }

  if (packet.omitted.length > 0) {
    lines.push("## Omitted", "");

    for (const item of packet.omitted) {
      lines.push(`- \`${item.key}\`: ${item.reason}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export async function resolveExecutionContext(
  options: ResolveContextOptions
): Promise<{
  packet: ContextPacket;
  packet_path: string;
  summary_path: string;
  provenance: ContextProvenance;
  provenance_path: string;
}> {
  const cache = createContextDiscoveryCache();
  const inputProvenance: ContextInputProvenance[] = [];
  const accumulator: MaterializationAccumulator = {
    materials: [],
    omitted: [],
    total_bytes: 0,
    max_total_bytes: options.node.effective_policy.input_rules.max_total_bytes
  };

  for (const [index, input] of (options.node.inputs ?? []).entries()) {
    await materializeInputItem(
      input,
      index,
      options,
      cache,
      accumulator,
      inputProvenance,
      options.node.effective_policy.input_rules.max_bytes_per_item
    );
  }

  for (const [index, reference] of (options.node.context_from ?? []).entries()) {
    await materializeContextReference(
      reference,
      index,
      options,
      accumulator,
      options.node.effective_policy.input_rules.max_bytes_per_item
    );
  }

  const harness_instructions = await computeHarnessInstructionProvenance({
    node: options.node,
    repo_workspaces: options.repo_workspaces,
    cache
  });
  const provenance: ContextProvenance = {
    compiled_id: options.node.compiled_id,
    authored_id: options.node.authored_id,
    repo_alias: options.node.repo,
    inputs: inputProvenance,
    ...(harness_instructions ? { harness_instructions } : {})
  };

  const packet: ContextPacket = {
    execution_id: options.execution_id,
    compiled_id: options.node.compiled_id,
    authored_id: options.node.authored_id,
    repo_alias: options.node.repo,
    workspace_path: options.workspace_path,
    materials: accumulator.materials,
    omitted: accumulator.omitted,
    totals: {
      material_count: accumulator.materials.length,
      file_count: accumulator.materials.length,
      total_bytes: accumulator.total_bytes
    }
  };

  const packet_path = join(options.execution_dir, "context_packet.json");
  const summary_path = join(options.execution_dir, "context_summary.md");
  const provenance_path = join(options.execution_dir, "context_provenance.json");
  await mkdir(dirname(packet_path), { recursive: true });
  await writeFile(packet_path, `${JSON.stringify(packet, null, 2)}\n`);
  await writeFile(summary_path, renderContextSummary(packet));
  await writeFile(provenance_path, `${JSON.stringify(provenance, null, 2)}\n`);

  return {
    packet,
    packet_path,
    summary_path,
    provenance,
    provenance_path
  };
}

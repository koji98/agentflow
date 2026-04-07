import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { resolveSubpathWithinRoot } from "../../path_rules.js";
import type { ContextReference, InputItem } from "../../graph/authored.js";
import type { CompiledExecutableNode, CompiledGraph } from "../../graph/compiled.js";
import type { AttemptRegistry, AttemptSelector, RuntimeNodeAttempt } from "../attempts.js";
import { listAttemptsForCompiledNode, selectAttempt } from "../attempts.js";
import { globPatternToRegExp, normalizeRelativePath, splitQualifiedPath } from "./common.js";
import type {
  ContextPacket,
  ContextPacketMaterializedItem,
  ContextPacketOmittedItem,
  ContextProvenance
} from "./packet.js";
import {
  computeContextProvenance,
  createContextDiscoveryCache,
  type ContextDiscoveryCache
} from "./provenance.js";
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

async function materializeInputItem(
  input: InputItem,
  index: number,
  options: ResolveContextOptions,
  cache: ContextDiscoveryCache,
  accumulator: MaterializationAccumulator,
  maxBytesPerItem: number
): Promise<void> {
  const materialsRoot = join(options.execution_dir, "context_materialized", `input_${index + 1}`);
  const descriptor = describeInput(input, index);

  if (input.kind === "text") {
    const destinationPath = join(materialsRoot, `${input.name}.txt`);
    const materialized = prepareMaterialization(input.text, maxBytesPerItem);

    await appendMaterializedItem(
      accumulator,
      {
        key: `input_${index + 1}`,
        kind: "input",
        source: input,
        materialized_path: destinationPath,
        bytes: materialized.bytes,
        truncated: materialized.truncated
      },
      materialized,
      descriptor
    );
    return;
  }

  const { repo_alias, repo_relative_path } = splitQualifiedPath(input.path, options.node.repo);
  const repoRoot = options.repo_workspaces[repo_alias];

  if (!repoRoot) {
    throw new Error(`Unknown repo alias "${repo_alias}" while resolving input.`);
  }

  if (input.kind === "file") {
    const sourcePath = resolveSubpathWithinRoot(
      repoRoot,
      repo_relative_path,
      `Input path "${input.path}"`
    );
    const materialized = prepareMaterialization(await readFile(sourcePath), maxBytesPerItem);

    await appendMaterializedItem(
      accumulator,
      {
        key: `input_${index + 1}`,
        kind: "input",
        source: input,
        materialized_path: join(materialsRoot, basename(repo_relative_path)),
        bytes: materialized.bytes,
        truncated: materialized.truncated
      },
      materialized,
      descriptor
    );
    return;
  }

  const repoFiles = await listRepoFiles(repoRoot, cache.repo_file_lists);
  const matcher = globPatternToRegExp(normalizeRelativePath(repo_relative_path));
  const matchedPaths = repoFiles
    .filter((filePath) => matcher.test(filePath))
    .slice(0, input.max_files ?? Number.MAX_SAFE_INTEGER);

  for (const [matchIndex, relativePath] of matchedPaths.entries()) {
    const materialized = prepareMaterialization(await readFile(join(repoRoot, relativePath)), maxBytesPerItem);

    await appendMaterializedItem(
      accumulator,
      {
        key: `input_${index + 1}_${matchIndex + 1}`,
        kind: "input",
        source: input,
        materialized_path: join(materialsRoot, `${matchIndex + 1}-${basename(relativePath)}`),
        bytes: materialized.bytes,
        truncated: materialized.truncated
      },
      materialized,
      `${descriptor} match "${relativePath}"`
    );
  }
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
    `- Omitted optional items: \`${packet.omitted.length}\``,
    ""
  ];

  if (packet.materials.length > 0) {
    lines.push("## Materials", "");

    for (const item of packet.materials) {
      lines.push(
        `- \`${item.key}\` -> \`${item.materialized_path}\` (${item.bytes} bytes${item.truncated ? ", truncated" : ""})`
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
  const provenance = await computeContextProvenance({
    node: options.node,
    repo_workspaces: options.repo_workspaces,
    cache
  });
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

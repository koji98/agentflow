import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

import { resolveSubpathWithinRoot } from "../../path_rules.js";
import type { ContextReference, InputItem } from "../../graph/authored.js";
import type { CompiledExecutableNode, CompiledGraph } from "../../graph/compiled.js";
import type { AttemptRegistry, AttemptSelector, RuntimeNodeAttempt } from "../attempts.js";
import { listAttemptsForCompiledNode, selectAttempt } from "../attempts.js";
import type {
  ContextPacket,
  ContextPacketMaterializedItem,
  ContextPacketOmittedItem
} from "./packet.js";

interface MaterializedPayload {
  bytes: number;
  truncated: boolean;
  file_path: string;
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

function normalizeRelativePath(value: string): string {
  return value.split("\\").join("/");
}

function globPatternToRegExp(pattern: string): RegExp {
  const escaped = normalizeRelativePath(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ":::DOUBLE_STAR:::")
    .replace(/\*/g, "[^/]*")
    .replace(/:::DOUBLE_STAR:::/g, ".*")
    .replace(/\?/g, ".");

  return new RegExp(`^${escaped}$`);
}

async function walkFiles(rootPath: string, currentPath = rootPath): Promise<string[]> {
  const entries = await (await import("node:fs/promises")).readdir(currentPath, {
    withFileTypes: true
  });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = join(currentPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await walkFiles(rootPath, entryPath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

async function materializeBytes(
  contents: string | Buffer,
  destinationPath: string,
  maxBytesPerItem: number
): Promise<MaterializedPayload> {
  await mkdir(dirname(destinationPath), { recursive: true });
  const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  const truncatedBuffer =
    buffer.byteLength > maxBytesPerItem ? truncateMaterializedBuffer(buffer, maxBytesPerItem) : buffer;
  await writeFile(destinationPath, truncatedBuffer);

  return {
    bytes: truncatedBuffer.byteLength,
    truncated: truncatedBuffer.byteLength !== buffer.byteLength,
    file_path: destinationPath
  };
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

function splitQualifiedPath(
  value: string,
  fallbackRepo: string
): {
  repo_alias: string;
  repo_relative_path: string;
} {
  const separatorIndex = value.indexOf(":");

  if (separatorIndex <= 0) {
    return {
      repo_alias: fallbackRepo,
      repo_relative_path: value
    };
  }

  return {
    repo_alias: value.slice(0, separatorIndex),
    repo_relative_path: value.slice(separatorIndex + 1)
  };
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
  maxBytesPerItem: number
): Promise<ContextPacketMaterializedItem[]> {
  const materialsRoot = join(options.execution_dir, "context_materialized", `input_${index + 1}`);

  if (input.kind === "text") {
    const destinationPath = join(materialsRoot, `${input.name}.txt`);
    const materialized = await materializeBytes(input.text, destinationPath, maxBytesPerItem);

    return [
      {
        key: `input_${index + 1}`,
        kind: "input",
        source: input,
        materialized_path: destinationPath,
        bytes: materialized.bytes,
        truncated: materialized.truncated
      }
    ];
  }

  if (input.kind === "file") {
    const { repo_alias, repo_relative_path } = splitQualifiedPath(input.path, options.node.repo);
    const repoRoot = options.repo_workspaces[repo_alias];

    if (!repoRoot) {
      throw new Error(`Unknown repo alias "${repo_alias}" while resolving input.`);
    }

    const sourcePath = resolveSubpathWithinRoot(
      repoRoot,
      repo_relative_path,
      `Input path "${input.path}"`
    );
    const contents = await readFile(sourcePath);
    const destinationPath = join(materialsRoot, basename(repo_relative_path));
    const materialized = await materializeBytes(contents, destinationPath, maxBytesPerItem);

    return [
      {
        key: `input_${index + 1}`,
        kind: "input",
        source: input,
        materialized_path: destinationPath,
        bytes: materialized.bytes,
        truncated: materialized.truncated
      }
    ];
  }

  const { repo_alias, repo_relative_path } = splitQualifiedPath(input.path, options.node.repo);
  const repoRoot = options.repo_workspaces[repo_alias];

  if (!repoRoot) {
    throw new Error(`Unknown repo alias "${repo_alias}" while resolving glob input.`);
  }

  const allFiles = await walkFiles(repoRoot);
  const matcher = globPatternToRegExp(normalizeRelativePath(repo_relative_path));
  const matches = allFiles
    .filter((filePath) => matcher.test(normalizeRelativePath(relative(repoRoot, filePath))))
    .slice(0, input.max_files ?? Number.MAX_SAFE_INTEGER);

  return Promise.all(
    matches.map(async (filePath, matchIndex) => {
      const contents = await readFile(filePath);
      const destinationPath = join(materialsRoot, `${matchIndex + 1}-${basename(filePath)}`);
      const materialized = await materializeBytes(contents, destinationPath, maxBytesPerItem);

      return {
        key: `input_${index + 1}_${matchIndex + 1}`,
        kind: "input" as const,
        source: input,
        materialized_path: destinationPath,
        bytes: materialized.bytes,
        truncated: materialized.truncated
      };
    })
  );
}

async function materializeContextReference(
  reference: ContextReference,
  index: number,
  options: ResolveContextOptions,
  maxBytesPerItem: number
): Promise<{
  materials: ContextPacketMaterializedItem[];
  omitted: ContextPacketOmittedItem[];
}> {
  const compiledIds = options.compiled_graph.authored_to_compiled[reference.node] ?? [];
  const attempts = selectAttemptsForReference(
    options.attempts,
    options.compiled_graph,
    compiledIds,
    reference
  );

  if (attempts.length === 0) {
    if (reference.optional) {
      return {
        materials: [],
        omitted: [
          {
            key: `context_${index + 1}`,
            source: reference,
            reason: `No execution matched "${reference.node}".`,
            optional: true
          }
        ]
      };
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
      return {
        materials: [],
        omitted: [
          {
            key: `context_${index + 1}`,
            source: reference,
            reason: `Selected execution for "${reference.node}" did not produce the requested artifact.`,
            optional: true
          }
        ]
      };
    }

    throw new Error(`Required context artifact is missing for "${reference.node}".`);
  }

  const contents = await readFile(sourcePath);
  const destinationPath = join(
    options.execution_dir,
    "context_materialized",
    `context_${index + 1}`,
    basename(sourcePath)
  );
  const materialized = await materializeBytes(contents, destinationPath, maxBytesPerItem);

  return {
    materials: [
      {
        key: `context_${index + 1}`,
        kind: "context",
        source: reference,
        materialized_path: destinationPath,
        bytes: materialized.bytes,
        truncated: materialized.truncated
      }
    ],
    omitted: []
  };
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
}> {
  const materials: ContextPacketMaterializedItem[] = [];
  const omitted: ContextPacketOmittedItem[] = [];

  for (const [index, input] of (options.node.inputs ?? []).entries()) {
    materials.push(
      ...(await materializeInputItem(
        input,
        index,
        options,
        options.node.effective_policy.input_rules.max_bytes_per_item
      ))
    );
  }

  for (const [index, reference] of (options.node.context_from ?? []).entries()) {
    const resolved = await materializeContextReference(
      reference,
      index,
      options,
      options.node.effective_policy.input_rules.max_bytes_per_item
    );
    materials.push(...resolved.materials);
    omitted.push(...resolved.omitted);
  }

  const total_bytes =
    materials.reduce((sum, item) => sum + item.bytes, 0);
  const file_count = materials.length;

  if (file_count > options.node.effective_policy.input_rules.max_files) {
    throw new Error(
      `Resolved ${file_count} context files, exceeding max_files ${options.node.effective_policy.input_rules.max_files}.`
    );
  }

  if (total_bytes > options.node.effective_policy.input_rules.max_total_bytes) {
    throw new Error(
      `Resolved ${total_bytes} context bytes, exceeding max_total_bytes ${options.node.effective_policy.input_rules.max_total_bytes}.`
    );
  }

  const packet: ContextPacket = {
    execution_id: options.execution_id,
    compiled_id: options.node.compiled_id,
    authored_id: options.node.authored_id,
    repo_alias: options.node.repo,
    workspace_path: options.workspace_path,
    materials,
    omitted,
    totals: {
      material_count: materials.length,
      file_count,
      total_bytes
    }
  };

  const packet_path = join(options.execution_dir, "context_packet.json");
  const summary_path = join(options.execution_dir, "context_summary.md");
  await mkdir(dirname(packet_path), { recursive: true });
  await writeFile(packet_path, `${JSON.stringify(packet, null, 2)}\n`);
  await writeFile(summary_path, renderContextSummary(packet));

  return {
    packet,
    packet_path,
    summary_path
  };
}

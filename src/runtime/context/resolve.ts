import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { resolveSubpathWithinRoot } from "../../path_rules.js";
import {
  resolveExecutionAgentContextPath,
  resolveExecutionAgentRecoveryBriefPath,
  resolveExecutionHumanDebugDirectory,
  resolveExecutionRuntimeContextPath
} from "../../artifacts/paths.js";
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
  RuntimeSupervisorContextRepairContext,
  ContextProvenance,
  PluginFileContextProvenance,
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
import { RuntimeFailureError } from "../failure.js";
import { renderAttemptEvidenceMarkdown } from "../attempt_evidence.js";
import {
  globPatternToRegExp,
  normalizeRelativePath,
  splitQualifiedPath
} from "./common.js";
import {
  defaultContextIgnoredRoots,
  listRepoFiles
} from "./repo_files.js";
import { buildRepeatHistory } from "./repeat_history.js";
import type { SupervisorRecoveryEnvelope } from "../../supervisor/types.js";

interface MaterializationAccumulator {
  materials: ContextPacketMaterializedItem[];
  omitted: ContextPacketOmittedItem[];
}

export interface ResolveContextOptions {
  compiled_graph: CompiledGraph;
  node: CompiledExecutableNode;
  execution_id: string;
  execution_dir: string;
  workspace_path: string;
  repo_workspaces: Record<string, string>;
  attempts: AttemptRegistry;
  recovery_envelope?: SupervisorRecoveryEnvelope;
}

async function writeRuntimeContextFile(
  destinationPath: string,
  text: string
): Promise<Pick<ContextPacketMaterializedItem, "pointer_path" | "digest" | "size_bytes">> {
  await mkdir(dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, text, "utf8");
  const contents = Buffer.from(text, "utf8");
  return {
    pointer_path: destinationPath,
    digest: createDigest(contents),
    size_bytes: contents.byteLength
  };
}

function buildFilePointer(
  pointerPath: string,
  contents: Buffer
): Pick<ContextPacketMaterializedItem, "pointer_path" | "digest" | "size_bytes"> {
  return {
    pointer_path: pointerPath,
    digest: createDigest(contents),
    size_bytes: contents.byteLength
  };
}

type ArtifactContextItem = Extract<ContextItem, { ref: string }>;

function isArtifactContextItem(item: ContextItem): item is ArtifactContextItem {
  return "ref" in item;
}

function artifactReferenceKey(reference: {
  node: string;
  artifact: string;
  iteration?: unknown;
  attempt?: unknown;
}): string {
  return JSON.stringify({
    node: reference.node,
    artifact: reference.artifact,
    iteration: reference.iteration,
    attempt: reference.attempt
  });
}

function describeReservedArtifact(artifact: string): string | undefined {
  if (artifact === "agent_response") {
    return "Final response captured from the producer node.";
  }

  if (artifact === "verification_json") {
    return "Structured verification record captured from the producer node.";
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

  if (item.from === "workspace_file") {
    return `${key} (workspace file "${item.path}")`;
  }

  if (item.from === "plugin_file") {
    return `${key} (plugin file "${item.path}")`;
  }

  return `${key} (workspace glob "${item.path}")`;
}

function explicitIgnoredRootOptIn(pattern: string): string | undefined {
  const normalized = normalizeRelativePath(pattern).replace(/^\/+/u, "");
  const [first] = normalized.split("/");
  return first && defaultContextIgnoredRoots.includes(first as (typeof defaultContextIgnoredRoots)[number])
    ? first
    : undefined;
}

function contextFailure(
  failureCode: "context_path_escape" | "graph_contract_gap" | "unresolved_context" | "context_contract_failure",
  message: string,
  details?: Record<string, unknown>
): RuntimeFailureError {
  return new RuntimeFailureError(failureCode, message, details);
}

function resolveContextSubpathWithinRoot(root: string, subpath: string, label: string): string {
  try {
    return resolveSubpathWithinRoot(root, subpath, label);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw contextFailure("context_path_escape", message, { label, subpath });
  }
}

function appendPointerItem(
  accumulator: MaterializationAccumulator,
  item: ContextPacketMaterializedItem
): void {
  accumulator.materials.push(item);
}

async function materializeRepeatHistoryContext(
  options: ResolveContextOptions,
  accumulator: MaterializationAccumulator
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

  const pointer = await writeRuntimeContextFile(
    join(
      options.execution_dir,
      "context",
      "runtime",
      history.source.name,
      "repeat-history.md"
    ),
    history.text
  );

  appendPointerItem(
    accumulator,
    {
      key: history.source.name,
      source: history.source,
      description: history.description,
      ...pointer
    }
  );
}

function renderSupervisorRecoveryEnvelope(envelope: SupervisorRecoveryEnvelope): string {
  const directive = envelope.retry_directive;
  const evidenceToRead = directive.evidence_to_read.filter(isAgentFacingEvidencePath);
  return [
    "# Supervisor Recovery Case",
    "",
    "This node is being retried after a supervisor recovery cycle.",
    "The original goal, acceptance criteria, constraints, repo authority, sandbox, and declared artifacts are unchanged.",
    "",
    `- Classification: \`${envelope.classification}\``,
    `- Resume point: \`${envelope.resume_point}\``,
    `- Restart boundary: \`${envelope.resume_decision.restart_boundary}\``,
    `- Workspace decision: \`${envelope.workspace_decision}\``,
    `- Resume reason: \`${envelope.resume_decision.reason_code}\``,
    `- Repeated matching symptom count: \`${envelope.repeated_fingerprint_count}\``,
    "",
    ...renderAttemptEvidenceMarkdown(envelope.prior_attempt_evidence),
    "",
    "## Recovery Summary",
    directive.summary,
    "",
    "## Must Do",
    ...directive.must_do.map((item) => `- ${item}`),
    "",
    "## Preserve Progress",
    ...(envelope.preserve_progress.length > 0
      ? envelope.preserve_progress.map((item) => `- ${item}`)
      : ["- Preserve in-scope prior progress unless recovery evidence says it is unsafe."]),
    "",
    "## Reuse",
    ...envelope.resume_decision.reuse.map((item) => `- ${item}`),
    "",
    "## Discard",
    ...envelope.resume_decision.discard.map((item) => `- ${item}`),
    "",
    "## Must Not Do",
    ...[...new Set([...directive.must_not_do, ...envelope.do_not_redo])].map((item) => `- ${item}`),
    "",
    "## Required Next Action",
    envelope.required_next_action,
    "",
    "",
    "## Evidence To Read",
    ...(evidenceToRead.length > 0
      ? evidenceToRead.map((item) => `- ${item}`)
      : ["- Use the current context pointers, prior declared artifacts, and artifact status."]),
    "",
    "## Validation Focus",
    ...directive.validation_focus.map((item) => `- ${item}`),
    "",
    "## Contract Preservation",
    "- Goal: unchanged.",
    "- Acceptance criteria: unchanged.",
    "- Constraints: unchanged.",
    "- Repo authority: unchanged.",
    "- Sandbox: unchanged.",
    "- Declared artifacts: unchanged."
  ].join("\n");
}

function isAgentFacingEvidencePath(value: string): boolean {
  if (value.trim().length === 0) {
    return false;
  }
  return !/(^|[/\\])(human-debug|runtime)([/\\]|$)/u.test(value)
    && !/(^|[/\\])agent[/\\](prompt|context|attempt-memory|supervisor-recovery|response)\.md$/u.test(value)
    && !/(^|[/\\])(case-file|recovery-plan|recovery-envelope)\.json$/u.test(value);
}

async function materializeSupervisorRecoveryEnvelopeContext(
  options: ResolveContextOptions,
  accumulator: MaterializationAccumulator
): Promise<void> {
  const envelope = options.recovery_envelope;

  if (!envelope) {
    return;
  }

  const source: ContextPacketSource = {
    name: "supervisor_recovery_envelope",
    from: "runtime_supervisor_recovery",
    prior_execution_id: envelope.prior_execution_id,
    classification: envelope.classification,
    failure_fingerprint: envelope.failure_fingerprint,
    repeated_fingerprint_count: envelope.repeated_fingerprint_count,
    resume_point: envelope.resume_point,
    restart_boundary: envelope.resume_decision.restart_boundary,
    workspace_decision: envelope.workspace_decision,
    reason_code: envelope.resume_decision.reason_code,
    recovery_plan_path: envelope.recovery_plan_path,
    case_file_path: envelope.case_file_path
  };
  const description = "Supervisor recovery envelope, merged evidence, and retry directive for this retry attempt.";

  const pointer = await writeRuntimeContextFile(
    resolveExecutionAgentRecoveryBriefPath(options.execution_dir),
    renderSupervisorRecoveryEnvelope(envelope)
  );

  appendPointerItem(
    accumulator,
    {
      key: source.name,
      source,
      description,
      ...pointer
    }
  );
}

async function materializeSupervisorContextRepair(
  options: ResolveContextOptions,
  accumulator: MaterializationAccumulator
): Promise<boolean> {
  const patch = options.recovery_envelope?.runtime_overlay?.context_repair;

  if (!patch) {
    return false;
  }

  for (const [index, material] of patch.materials.entries()) {
    const source: RuntimeSupervisorContextRepairContext = {
      name: "supervisor_context_repair",
      from: "runtime_supervisor_context_repair",
      patch_id: patch.patch_id,
      strategy: patch.strategy,
      reason: patch.reason
    };

    const pointer = await writeRuntimeContextFile(
      join(
        options.execution_dir,
        "context",
        "runtime",
        material.key,
        `${index + 1}-context-repair.md`
      ),
      material.text
    );

    appendPointerItem(
      accumulator,
      {
        key: material.key,
        source,
        description: material.title,
        ...pointer
      }
    );
  }

  for (const [index, item] of (options.node.context ?? []).entries()) {
    accumulator.omitted.push({
      key: item.name || `context_${index + 1}`,
      source: item,
      reason: "Authored context item was replaced by a supervisor context repair overlay.",
      if_available: true
    });
  }

  for (const omitted of patch.omitted) {
    const source: RuntimeSupervisorContextRepairContext = {
      name: "supervisor_context_repair",
      from: "runtime_supervisor_context_repair",
      patch_id: patch.patch_id,
      strategy: patch.strategy,
      reason: patch.reason
    };
    accumulator.omitted.push({
      key: omitted.key,
      source,
      ...(omitted.source_name ? { description: omitted.source_name } : {}),
      reason: omitted.reason,
      if_available: true
    });
  }

  return true;
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

async function materializeWorkspaceFileContext(
  item: Extract<ContextItem, { from: "workspace_file" }>,
  index: number,
  options: ResolveContextOptions,
  cache: ContextDiscoveryCache,
  accumulator: MaterializationAccumulator,
  contextProvenance: ContextInputProvenance[]
): Promise<void> {
  const descriptor = describeContextItem(item, index);
  const key = item.name;
  const { repo_alias, repo_relative_path } = splitQualifiedPath(item.path, options.node.repo);
  const repoRoot = options.repo_workspaces[repo_alias];

  if (!repoRoot) {
    throw contextFailure("graph_contract_gap", `Unknown repo alias "${repo_alias}" while resolving ${descriptor}.`, {
      repo_alias,
      descriptor
    });
  }

  const normalizedPath = normalizeRelativePath(repo_relative_path);
  const sourcePath = resolveContextSubpathWithinRoot(
    repoRoot,
    repo_relative_path,
    `Context path "${item.path}"`
  );

  let contents: Buffer;

  try {
    contents = await readFile(sourcePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw contextFailure("unresolved_context", `Requested context workspace file "${item.path}" was not found at execution time.`, {
        key,
        path: item.path
      });
    }

    throw error;
  }

  const pointer = buildFilePointer(sourcePath, contents);
  appendPointerItem(
    accumulator,
    {
      key,
      source: item,
      description: `${item.what} Why: ${item.why}`,
      ...pointer,
      binding: {
        kind: "live_workspace_input",
        requested_path: normalizedPath,
        resolved_path: sourcePath
      }
    }
  );

  const digest = pointer.digest!;
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
  contextProvenance: ContextInputProvenance[]
): Promise<void> {
  const descriptor = describeContextItem(item, index);
  const key = item.name;
  const { repo_alias, repo_relative_path } = splitQualifiedPath(item.path, options.node.repo);
  const repoRoot = options.repo_workspaces[repo_alias];

  if (!repoRoot) {
    throw contextFailure("graph_contract_gap", `Unknown repo alias "${repo_alias}" while resolving ${descriptor}.`, {
      repo_alias,
      descriptor
    });
  }

  const normalizedPattern = normalizeRelativePath(repo_relative_path);
  const matcher = globPatternToRegExp(normalizedPattern);
  const ignoredRootOptIn = explicitIgnoredRootOptIn(normalizedPattern);
  const repoFiles = await listRepoFiles(repoRoot, cache.repo_files, {
    ...(ignoredRootOptIn ? { include_ignored_root: ignoredRootOptIn } : {})
  });
  const matchedPaths = repoFiles
    .filter((filePath) => matcher.test(filePath))
    .slice(0, item.max_files ?? Number.MAX_SAFE_INTEGER);

  if (matchedPaths.length === 0) {
    throw contextFailure("unresolved_context", `Requested context workspace glob "${item.path}" matched no files after ignore filtering at execution time.`, {
      key,
      path: item.path
    });
  }

  const files: WorkspaceGlobContextProvenance["files"] = [];

  for (const [matchIndex, relativePath] of matchedPaths.entries()) {
    const sourcePath = resolveContextSubpathWithinRoot(
      repoRoot,
      relativePath,
      `Glob match "${relativePath}" from "${item.path}"`
    );
    const contents = await readFile(sourcePath);
    const digest = createDigest(contents);
    cache.file_digests.set(sourcePath, digest);
    const pointerKey = `${key}_${matchIndex + 1}`;
    appendPointerItem(
      accumulator,
      {
        key: pointerKey,
        source: item,
        description: `${item.what} Why: ${item.why}`,
        ...buildFilePointer(sourcePath, contents),
        binding: {
          kind: "live_workspace_input",
          requested_path: relativePath,
          resolved_path: sourcePath
        }
      }
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

async function materializePluginFileContext(
  item: Extract<ContextItem, { from: "plugin_file" }>,
  index: number,
  accumulator: MaterializationAccumulator,
  contextProvenance: ContextInputProvenance[]
): Promise<void> {
  const descriptor = describeContextItem(item, index);
  const key = item.name;

  let contents: Buffer;

  try {
    contents = await readFile(item.path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw contextFailure("unresolved_context", `Requested ${descriptor} was not found at execution time.`, {
        key,
        path: item.path
      });
    }

    throw error;
  }

  const pointer = buildFilePointer(item.path, contents);
  appendPointerItem(
    accumulator,
    {
      key,
      source: item,
      description: `${item.what} Why: ${item.why}`,
      ...pointer
    }
  );

  contextProvenance.push({
    from: "plugin_file",
    key,
    path: item.path,
    digest: pointer.digest!
  } satisfies PluginFileContextProvenance);
}

async function materializeContextItem(
  item: ContextItem,
  index: number,
  options: ResolveContextOptions,
  cache: ContextDiscoveryCache,
  accumulator: MaterializationAccumulator,
  contextProvenance: ContextInputProvenance[]
): Promise<void> {
  if (isArtifactContextItem(item)) {
    await materializeArtifactContext(
      item,
      index,
      options,
      accumulator
    );
    return;
  }

  if (item.from === "workspace_file") {
    await materializeWorkspaceFileContext(
      item,
      index,
      options,
      cache,
      accumulator,
      contextProvenance
    );
    return;
  }

  if (item.from === "plugin_file") {
    await materializePluginFileContext(
      item,
      index,
      accumulator,
      contextProvenance
    );
    return;
  }

  await materializeWorkspaceGlobContext(
    item,
    index,
    options,
    cache,
    accumulator,
    contextProvenance
  );
}

async function materializeArtifactContext(
  reference: ArtifactContextItem,
  index: number,
  options: ResolveContextOptions,
  accumulator: MaterializationAccumulator
): Promise<void> {
  const compiledIds = options.compiled_graph.authored_to_compiled[reference.node] ?? [];
  const description = describeArtifactReference(options.compiled_graph, compiledIds, reference);
  const supportDescription = `${reference.what} Why: ${reference.why}${description ? ` Producer artifact: ${description}` : ""}`;
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
        description: supportDescription,
        reason: `No execution matched "${reference.node}".`,
        if_available: true
      });
      return;
    }

    throw contextFailure("unresolved_context", `No execution matched required context reference "${reference.node}".`, {
      node: reference.node,
      artifact: reference.artifact
    });
  }

  const selected = attempts[0];

  if (!selected) {
    throw contextFailure("unresolved_context", `No execution matched required context reference "${reference.node}".`, {
      node: reference.node,
      artifact: reference.artifact
    });
  }

  const sourcePath = selected.artifacts[reference.artifact];

  if (!sourcePath) {
    if (reference.if_available) {
      accumulator.omitted.push({
        key: reference.name,
        source: reference,
        description: supportDescription,
        reason: `Selected execution for "${reference.node}" did not produce the requested artifact.`,
        if_available: true
      });
      return;
    }

    throw contextFailure("unresolved_context", `Required context artifact is missing for "${reference.node}".`, {
      node: reference.node,
      artifact: reference.artifact
    });
  }

  const contents = await readFile(sourcePath);
  const key = reference.name;
  appendPointerItem(
    accumulator,
    {
      key,
      source: reference,
      description: supportDescription,
      ...buildFilePointer(sourcePath, contents)
    }
  );
}

async function materializeCheckpointReviewContext(
  options: ResolveContextOptions,
  accumulator: MaterializationAccumulator
): Promise<void> {
  if (options.node.kind !== "checkpoint") {
    return;
  }

  const reviewFrom = options.node.review_from;
  const alreadyAuthored = (options.node.context ?? []).some(
    (item) => isArtifactContextItem(item) && artifactReferenceKey(item) === artifactReferenceKey(reviewFrom)
  );

  if (alreadyAuthored) {
    return;
  }

  await materializeArtifactContext(
    {
      ref: `${reviewFrom.node}.${reviewFrom.artifact}`,
      node: reviewFrom.node,
      artifact: reviewFrom.artifact,
      ...(reviewFrom.iteration !== undefined ? { iteration: reviewFrom.iteration } : {}),
      ...(reviewFrom.attempt !== undefined ? { attempt: reviewFrom.attempt } : {}),
      name: `checkpoint_review_${reviewFrom.artifact}`,
      what: "Artifact selected by this checkpoint's review_from reference.",
      why: "It is the required evidence the checkpoint operator reviews before deciding whether the repeat loop may proceed."
    },
    -1,
    options,
    accumulator
  );
}

function renderContextManifest(packet: ContextPacket): string {
  const lines = [
    "# Context Manifest",
    "",
    "Context entries are pointers. Agentflow does not copy or truncate source context into this prompt package.",
    ""
  ];

  if (packet.materials.length > 0) {
    lines.push("## Pointers", "");
    lines.push("| Name | Kind | Pointer | What | Why |");
    lines.push("| --- | --- | --- | --- | --- |");

    for (const item of packet.materials) {
      const from = "ref" in item.source ? "artifact" : item.source.from;
      const what = "what" in item.source && typeof item.source.what === "string"
        ? item.source.what
        : item.description ?? "";
      const why = "why" in item.source && typeof item.source.why === "string"
        ? item.source.why
        : "";
      lines.push(`| \`${item.key}\` | \`${from}\` | \`${formatManifestPointerPath(item.pointer_path)}\` | ${what} | ${why} |`);
    }

    lines.push("");
  } else {
    lines.push("No context pointers were provided for this node.", "");
  }

  return `${lines.join("\n")}\n`;
}

function formatManifestPointerPath(pointerPath: string): string {
  const match = /[/\\]context[/\\]runtime[/\\](.+)$/u.exec(pointerPath);
  if (!match?.[1]) {
    return pointerPath;
  }
  return `runtime/${match[1].replace(/\\/gu, "/")}`;
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
    omitted: []
  };

  await materializeSupervisorRecoveryEnvelopeContext(
    options,
    accumulator
  );

  const authoredContextReplaced = await materializeSupervisorContextRepair(
    options,
    accumulator
  );

  if (!authoredContextReplaced) {
    await materializeCheckpointReviewContext(
      options,
      accumulator
    );

    for (const [index, item] of (options.node.context ?? []).entries()) {
      await materializeContextItem(
        item,
        index,
        options,
        cache,
        accumulator,
        contextProvenance
      );
    }
  }

  await materializeRepeatHistoryContext(
    options,
    accumulator
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
    materials: accumulator.materials,
    omitted: accumulator.omitted,
    totals: {
      pointer_count: accumulator.materials.length,
      file_count: accumulator.materials.length
    }
  };

  const packet_path = resolveExecutionRuntimeContextPath(options.execution_dir);
  const manifest_path = resolveExecutionAgentContextPath(options.execution_dir);
  const provenance_path = join(resolveExecutionHumanDebugDirectory(options.execution_dir), "context-provenance.json");
  await mkdir(dirname(packet_path), { recursive: true });
  await mkdir(dirname(manifest_path), { recursive: true });
  await mkdir(dirname(provenance_path), { recursive: true });
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

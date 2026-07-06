import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ArtifactDefinition, ExecutableNodeIntent } from "../../graph/authored.js";
import type { CompiledAgentNode } from "../../graph/compiled.js";
import type { HarnessName } from "../../graph/schema.js";
import { managedPromptContract } from "../../managed/foundation.js";
import {
  resolveExecutionAgentContextPath,
  resolveExecutionAgentPromptPath,
  resolveExecutionArtifactsDirectory,
  resolveExecutionHumanDebugHarnessDirectory,
  resolveExecutionRuntimeContextPath,
  resolveExecutionRuntimeDirectory,
  resolveExecutionRuntimeResultPath
} from "../../artifacts/paths.js";
import type { RuntimeNodeAttempt } from "../attempts.js";
import { renderContextManifest } from "../context/manifest.js";
import type { ContextPacket, ContextPacketMaterializedItem, ContextPriorityBucket } from "../context/packet.js";
import { RuntimeFailureError } from "../failure.js";
import { renderHarnessPrompt, type AgentInvocation, type HarnessAdapter, type HarnessResult } from "../harness/types.js";
import { prepareAgentTools } from "../tools/setup.js";
import type { RuntimeNodeExecutionResult, RuntimeNodeExecutorContext } from "../core/engine.js";
import {
  ManagedContractFailureError,
  managedContractFailureSummary,
  writeManagedContractFailurePacket,
  type ManagedContractFinding
} from "./contract_failures.js";

interface ManagedMapReduceFrozenItem {
  id: string;
  title: string;
  input: Record<string, unknown>;
  scope_rationale: string;
  evidence_refs: string[];
}

interface ManagedMapReduceFrozen {
  schema_version: number;
  status: "frozen";
  frozen_at?: string;
  source_path?: string;
  items: ManagedMapReduceFrozenItem[];
  omissions?: string[];
  uncertainty?: string[];
}

type ManagedMapReduceItemStatus = "passed" | "finding" | "skipped" | "blocked";

interface ManagedMapReduceItemEvidence {
  ref: string;
  summary: string;
}

interface ManagedMapReduceItemResult {
  id: string;
  status: ManagedMapReduceItemStatus;
  summary: string;
  evidence: ManagedMapReduceItemEvidence[];
  findings: unknown[];
  skip_rationale?: string;
  blocker?: string;
  accepted_attempt_path?: string;
}

interface ManagedMapReduceRuntimeConfig {
  parent_intent: ExecutableNodeIntent;
  map_intent: ExecutableNodeIntent;
  max_concurrency: number;
}

interface ManagedMapItemRunPassed {
  status: "passed";
  result: ManagedMapReduceItemResult;
  resultPath: string;
  attemptPath: string;
}

interface ManagedMapItemRunFailed {
  status: "failed";
  item_id: string;
  message: string;
  findings?: ManagedContractFinding[];
}

type ManagedMapItemRunResult = ManagedMapItemRunPassed | ManagedMapItemRunFailed;

export function isManagedMapReduceMapItemsNode(node: CompiledAgentNode): boolean {
  return (
    node.managed_runtime?.kind === "pattern_map_reduce" &&
    node.managed_runtime.phase === "map_items"
  );
}

function parseManagedMapReduceRuntimeConfig(node: CompiledAgentNode): ManagedMapReduceRuntimeConfig {
  const config = node.managed_runtime?.config;
  if (!isRecord(config)) {
    throw new RuntimeFailureError("graph_contract_gap", "Map-reduce map_items node is missing runtime config.");
  }
  if (!isRecord(config.parent_intent) || !isRecord(config.map_intent)) {
    throw new RuntimeFailureError("graph_contract_gap", "Map-reduce map_items runtime config is missing parent or map intent.");
  }
  if (typeof config.max_concurrency !== "number" || !Number.isInteger(config.max_concurrency) || config.max_concurrency < 1) {
    throw new RuntimeFailureError("graph_contract_gap", "Map-reduce map_items runtime config requires positive integer max_concurrency.");
  }

  return config as unknown as ManagedMapReduceRuntimeConfig;
}

function contextPointer(materials: ContextPacketMaterializedItem[] | undefined, key: string): string | undefined {
  return materials?.find((item) => item.key === key)?.pointer_path;
}

async function readJsonFile<T>(label: string, filePath: string | undefined): Promise<T> {
  if (!filePath) {
    throw new RuntimeFailureError("context_contract_failure", `Missing ${label} context pointer.`);
  }

  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    throw new RuntimeFailureError(
      "context_contract_failure",
      `Failed to read ${label}: ${error instanceof Error ? error.message : String(error)}.`
    );
  }
}

async function readContextManifestContent(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function jsonValueTypeName(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "string" && value.trim().length === 0) {
    return "empty string";
  }
  return typeof value;
}

function mapReduceContractFinding(options: {
  phase: string;
  itemId: string;
  artifactName: string;
  artifactPath: string;
  failureKind: ManagedContractFinding["failure_kind"];
  message: string;
  expected: string;
  requiredNextAction: string;
  evidenceRefs?: string[];
}): ManagedContractFinding {
  return {
    managed_kind: "pattern_map_reduce",
    phase: options.phase,
    item_id: options.itemId,
    artifact_name: options.artifactName,
    artifact_path: options.artifactPath,
    failure_kind: options.failureKind,
    message: options.message,
    expected: options.expected,
    retry_boundary: "current_item",
    required_next_action: options.requiredNextAction,
    evidence_refs: options.evidenceRefs ?? [options.artifactPath]
  };
}

async function ensureManagedArtifactPresent(options: {
  phase: string;
  item: ManagedMapReduceFrozenItem;
  artifactName: string;
  artifactPath: string;
  fileName: string;
}): Promise<ManagedContractFinding | undefined> {
  try {
    await access(options.artifactPath);
    return undefined;
  } catch {
    return mapReduceContractFinding({
      phase: options.phase,
      itemId: options.item.id,
      artifactName: options.artifactName,
      artifactPath: options.artifactPath,
      failureKind: "missing_artifact",
      message: `${options.fileName} was not published for map-reduce item ${options.item.id}.`,
      expected: `${options.fileName} must be present before the map item can be accepted.`,
      requiredNextAction: `Publish ${options.fileName} for item ${options.item.id}.`
    });
  }
}

async function readManagedJsonArtifact(options: {
  phase: string;
  item: ManagedMapReduceFrozenItem;
  artifactName: string;
  artifactPath: string;
  fileName: string;
}): Promise<unknown> {
  try {
    return JSON.parse(await readFile(options.artifactPath, "utf8")) as unknown;
  } catch (error) {
    throw new ManagedContractFailureError(mapReduceContractFinding({
      phase: options.phase,
      itemId: options.item.id,
      artifactName: options.artifactName,
      artifactPath: options.artifactPath,
      failureKind: error instanceof SyntaxError ? "invalid_json" : "unreadable_artifact",
      message: `${options.fileName} for map-reduce item ${options.item.id} could not be parsed: ${error instanceof Error ? error.message : String(error)}.`,
      expected: `${options.fileName} must be valid JSON using the managed map-reduce item-result contract.`,
      requiredNextAction: `Repair ${options.fileName} for item ${options.item.id} so it is valid JSON with id, status, summary, evidence, and status-specific details.`
    }));
  }
}

function validateEvidenceArray(options: {
  phase: string;
  item: ManagedMapReduceFrozenItem;
  artifactName: string;
  artifactPath: string;
  fileName: string;
  value: unknown;
  status: ManagedMapReduceItemStatus;
  findings: ManagedContractFinding[];
}): ManagedMapReduceItemEvidence[] {
  if (options.status === "blocked" && options.value === undefined) {
    return [];
  }
  if (!Array.isArray(options.value)) {
    options.findings.push(mapReduceContractFinding({
      phase: options.phase,
      itemId: options.item.id,
      artifactName: options.artifactName,
      artifactPath: options.artifactPath,
      failureKind: "schema_mismatch",
      message: `${options.fileName} evidence must be an array for item ${options.item.id}.`,
      expected: "Passed, finding, and skipped map item results include evidence as an array of objects with ref and summary.",
      requiredNextAction: `Set evidence to an array in ${options.fileName} for item ${options.item.id}.`
    }));
    return [];
  }

  const evidence: ManagedMapReduceItemEvidence[] = [];
  options.value.forEach((entry, index) => {
    if (!isRecord(entry) || !nonEmptyString(entry.ref) || !nonEmptyString(entry.summary)) {
      options.findings.push(mapReduceContractFinding({
        phase: options.phase,
        itemId: options.item.id,
        artifactName: options.artifactName,
        artifactPath: options.artifactPath,
        failureKind: "schema_mismatch",
        message: `${options.fileName} evidence[${index}] must include non-empty ref and summary strings.`,
        expected: "Each evidence entry is an object with ref and summary strings.",
        requiredNextAction: `Repair evidence[${index}] in ${options.fileName} for item ${options.item.id}.`
      }));
      return;
    }
    evidence.push({
      ref: entry.ref.trim(),
      summary: entry.summary.trim()
    });
  });

  if (options.status !== "blocked" && evidence.length === 0) {
    options.findings.push(mapReduceContractFinding({
      phase: options.phase,
      itemId: options.item.id,
      artifactName: options.artifactName,
      artifactPath: options.artifactPath,
      failureKind: "contract_mismatch",
      message: `${options.fileName} item ${options.item.id} requires evidence for status ${options.status}.`,
      expected: "Passed, finding, and skipped map item results cite concrete evidence.",
      requiredNextAction: `Add concrete evidence for item ${options.item.id} in ${options.fileName}.`
    }));
  }

  return evidence;
}

function validateManagedMapReduceItemResultContract(options: {
  phase: string;
  item: ManagedMapReduceFrozenItem;
  artifactName: string;
  artifactPath: string;
  fileName: string;
  value: unknown;
}): ManagedMapReduceItemResult {
  const findings: ManagedContractFinding[] = [];
  if (!isRecord(options.value)) {
    throw new ManagedContractFailureError(mapReduceContractFinding({
      phase: options.phase,
      itemId: options.item.id,
      artifactName: options.artifactName,
      artifactPath: options.artifactPath,
      failureKind: "schema_mismatch",
      message: `${options.fileName} must be a JSON object for map-reduce item ${options.item.id}.`,
      expected: `${options.fileName} includes id, status, summary, evidence, and status-specific fields.`,
      requiredNextAction: `Rewrite ${options.fileName} as a managed map item result JSON object for item ${options.item.id}.`
    }));
  }

  if (typeof options.value.item_id === "string") {
    findings.push(mapReduceContractFinding({
      phase: options.phase,
      itemId: options.item.id,
      artifactName: options.artifactName,
      artifactPath: options.artifactPath,
      failureKind: "schema_mismatch",
      message: `${options.fileName} uses stale field item_id; map-reduce item results must use id.`,
      expected: `The item result id field equals "${options.item.id}" and no item_id field is used.`,
      requiredNextAction: `Replace item_id with id in ${options.fileName} for item ${options.item.id}.`
    }));
  }

  if (options.value.id !== options.item.id) {
    findings.push(mapReduceContractFinding({
      phase: options.phase,
      itemId: options.item.id,
      artifactName: options.artifactName,
      artifactPath: options.artifactPath,
      failureKind: "contract_mismatch",
      message: `${options.fileName} id "${typeof options.value.id === "string" ? options.value.id : String(options.value.id)}" does not match frozen item "${options.item.id}".`,
      expected: `The item result id exactly matches frozen item "${options.item.id}".`,
      requiredNextAction: `Set id to "${options.item.id}" in ${options.fileName}.`
    }));
  }

  const status = options.value.status;
  if (status !== "passed" && status !== "finding" && status !== "skipped" && status !== "blocked") {
    findings.push(mapReduceContractFinding({
      phase: options.phase,
      itemId: options.item.id,
      artifactName: options.artifactName,
      artifactPath: options.artifactPath,
      failureKind: "schema_mismatch",
      message: `${options.fileName} status must be passed, finding, skipped, or blocked, not ${jsonValueTypeName(status)}.`,
      expected: "Map item status is one of passed, finding, skipped, or blocked.",
      requiredNextAction: `Set status to passed, finding, skipped, or blocked in ${options.fileName} for item ${options.item.id}.`
    }));
  }

  if (!nonEmptyString(options.value.summary)) {
    findings.push(mapReduceContractFinding({
      phase: options.phase,
      itemId: options.item.id,
      artifactName: options.artifactName,
      artifactPath: options.artifactPath,
      failureKind: "schema_mismatch",
      message: `${options.fileName} is missing a non-empty summary for item ${options.item.id}.`,
      expected: "Every map item result includes a concrete non-empty summary.",
      requiredNextAction: `Add a concrete summary to ${options.fileName} for item ${options.item.id}.`
    }));
  }

  const normalizedStatus = status === "passed" || status === "finding" || status === "skipped" || status === "blocked"
    ? status
    : "blocked";
  const evidence = validateEvidenceArray({
    ...options,
    value: options.value.evidence,
    status: normalizedStatus,
    findings
  });
  const itemFindings = Array.isArray(options.value.findings) ? options.value.findings : [];
  if (options.value.findings !== undefined && !Array.isArray(options.value.findings)) {
    findings.push(mapReduceContractFinding({
      phase: options.phase,
      itemId: options.item.id,
      artifactName: options.artifactName,
      artifactPath: options.artifactPath,
      failureKind: "schema_mismatch",
      message: `${options.fileName} findings must be an array when present for item ${options.item.id}.`,
      expected: "findings is an array; use an empty array or omit it when status is not finding.",
      requiredNextAction: `Set findings to an array in ${options.fileName} for item ${options.item.id}.`
    }));
  }
  if (normalizedStatus === "finding" && itemFindings.length === 0) {
    findings.push(mapReduceContractFinding({
      phase: options.phase,
      itemId: options.item.id,
      artifactName: options.artifactName,
      artifactPath: options.artifactPath,
      failureKind: "contract_mismatch",
      message: `${options.fileName} marks item ${options.item.id} as finding but does not include findings.`,
      expected: "A finding status includes at least one finding entry.",
      requiredNextAction: `Add at least one finding entry to ${options.fileName} for item ${options.item.id}.`
    }));
  }
  if (normalizedStatus !== "finding" && itemFindings.length > 0) {
    findings.push(mapReduceContractFinding({
      phase: options.phase,
      itemId: options.item.id,
      artifactName: options.artifactName,
      artifactPath: options.artifactPath,
      failureKind: "contract_mismatch",
      message: `${options.fileName} item ${options.item.id} has status ${normalizedStatus} but includes findings.`,
      expected: "Only finding status may include non-empty findings.",
      requiredNextAction: `Remove findings from ${options.fileName} for item ${options.item.id} or set status to finding.`
    }));
  }
  if (normalizedStatus === "skipped" && !nonEmptyString(options.value.skip_rationale)) {
    findings.push(mapReduceContractFinding({
      phase: options.phase,
      itemId: options.item.id,
      artifactName: options.artifactName,
      artifactPath: options.artifactPath,
      failureKind: "contract_mismatch",
      message: `${options.fileName} marks item ${options.item.id} as skipped but does not include skip_rationale.`,
      expected: "A skipped status includes a concrete skip_rationale.",
      requiredNextAction: `Add skip_rationale to ${options.fileName} for item ${options.item.id}.`
    }));
  }
  if (normalizedStatus === "blocked" && !nonEmptyString(options.value.blocker)) {
    findings.push(mapReduceContractFinding({
      phase: options.phase,
      itemId: options.item.id,
      artifactName: options.artifactName,
      artifactPath: options.artifactPath,
      failureKind: "contract_mismatch",
      message: `${options.fileName} marks item ${options.item.id} as blocked but does not include blocker.`,
      expected: "A blocked status includes a concrete blocker.",
      requiredNextAction: `Add blocker to ${options.fileName} for item ${options.item.id}.`
    }));
  }

  if (findings.length > 0) {
    throw new ManagedContractFailureError(findings);
  }

  return {
    id: options.value.id as string,
    status: normalizedStatus,
    summary: (options.value.summary as string).trim(),
    evidence,
    findings: itemFindings,
    ...(nonEmptyString(options.value.skip_rationale) ? { skip_rationale: options.value.skip_rationale.trim() } : {}),
    ...(nonEmptyString(options.value.blocker) ? { blocker: options.value.blocker.trim() } : {})
  };
}

async function readManagedMapItemArtifacts(outputDir: string, item: ManagedMapReduceFrozenItem): Promise<{
  resultPath: string;
  result: ManagedMapReduceItemResult;
}> {
  const resultPath = join(outputDir, "item-result.json");
  const phase = "map_item";
  const missing = await ensureManagedArtifactPresent({
    phase,
    item,
    artifactName: "item_result",
    artifactPath: resultPath,
    fileName: "item-result.json"
  });
  if (missing) {
    throw new ManagedContractFailureError(missing);
  }

  const result = validateManagedMapReduceItemResultContract({
    phase,
    item,
    artifactName: "item_result",
    artifactPath: resultPath,
    fileName: "item-result.json",
    value: await readManagedJsonArtifact({
      phase,
      item,
      artifactName: "item_result",
      artifactPath: resultPath,
      fileName: "item-result.json"
    })
  });

  return { resultPath, result };
}

function itemArtifactDefinitions(): Record<string, ArtifactDefinition> {
  return {
    item_result: {
      from: "output_dir",
      path: "item-result.json",
      description: "Structured result, status, evidence, and status-specific details for this frozen map-reduce item."
    }
  };
}

function managedItemExecutionDir(parentExecutionDir: string, itemId: string): string {
  return join(parentExecutionDir, "managed-items", itemId, "execution");
}

function managedItemExecutionId(parentAttempt: RuntimeNodeAttempt, itemId: string): string {
  return `${parentAttempt.execution_id}__item_${itemId}`;
}

function buildManagedItemAttempt(options: {
  context: RuntimeNodeExecutorContext<CompiledAgentNode>;
  itemNode: CompiledAgentNode;
  executionDir: string;
  executionId: string;
  attemptIndex: number;
}): RuntimeNodeAttempt {
  return {
    execution_id: options.executionId,
    compiled_id: options.itemNode.compiled_id,
    authored_id: options.itemNode.authored_id,
    kind: "agent",
    repo_alias: options.itemNode.repo,
    execution_dir: options.executionDir,
    attempt_index: options.attemptIndex,
    status: "running",
    started_at: new Date().toISOString(),
    artifacts: {},
    metadata: {
      managed_parent_execution_id: options.context.attempt.execution_id,
      managed_phase: "map_reduce_item"
    }
  };
}

async function writeManagedItemAttemptStart(attempt: RuntimeNodeAttempt): Promise<void> {
  const runtimeDir = resolveExecutionRuntimeDirectory(attempt.execution_dir);
  const harnessDir = resolveExecutionHumanDebugHarnessDirectory(attempt.execution_dir);
  await mkdir(runtimeDir, { recursive: true });
  await mkdir(harnessDir, { recursive: true });
  await writeFile(join(runtimeDir, "execution.json"), `${JSON.stringify(attempt, null, 2)}\n`, "utf8");
  await writeFile(join(harnessDir, "stdout.log"), "", "utf8");
  await writeFile(join(harnessDir, "stderr.log"), "", "utf8");
}

async function writeManagedItemAttemptResult(options: {
  attempt: RuntimeNodeAttempt;
  result: HarnessResult;
  artifacts?: Record<string, string>;
}): Promise<RuntimeNodeAttempt> {
  const endedAt = new Date().toISOString();
  const status = options.result.status === "passed"
    ? "passed"
    : options.result.status === "canceled" ? "canceled" : "failed";
  const outcome = status === "canceled" ? undefined : status;
  const completed: RuntimeNodeAttempt = {
    ...options.attempt,
    status,
    ...(outcome ? { outcome } : {}),
    ended_at: endedAt,
    stdout_log_path: join(resolveExecutionHumanDebugHarnessDirectory(options.attempt.execution_dir), "stdout.log"),
    stderr_log_path: join(resolveExecutionHumanDebugHarnessDirectory(options.attempt.execution_dir), "stderr.log"),
    result_path: resolveExecutionRuntimeResultPath(options.attempt.execution_dir),
    prompt_path: resolveExecutionAgentPromptPath(options.attempt.execution_dir),
    context_packet_path: resolveExecutionRuntimeContextPath(options.attempt.execution_dir),
    context_manifest_path: resolveExecutionAgentContextPath(options.attempt.execution_dir),
    artifacts: options.artifacts ?? options.attempt.artifacts,
    metadata: {
      ...options.attempt.metadata,
      ...(options.result.metadata ?? {})
    }
  };

  await writeFile(join(resolveExecutionRuntimeDirectory(options.attempt.execution_dir), "execution.json"), `${JSON.stringify(completed, null, 2)}\n`, "utf8");
  await writeFile(resolveExecutionRuntimeResultPath(options.attempt.execution_dir), `${JSON.stringify({
    status: options.result.status,
    exit_code: options.result.exitCode,
    metadata: options.result.metadata ?? {}
  }, null, 2)}\n`, "utf8");
  await writeFile(completed.stdout_log_path!, options.result.stdout ?? "", "utf8");
  await writeFile(completed.stderr_log_path!, options.result.stderr ?? "", "utf8");
  return completed;
}

function rankContextMaterials(materials: ContextPacketMaterializedItem[]): ContextPacketMaterializedItem[] {
  const rankCounts = new Map<ContextPriorityBucket, number>();
  return materials.map((material) => {
    const bucket = material.priority_bucket ?? "task_context";
    const rank = rankCounts.get(bucket) ?? 0;
    rankCounts.set(bucket, rank + 1);
    return {
      ...material,
      priority_bucket: bucket,
      priority_rank: rank
    };
  });
}

function materializedFileCount(item: ContextPacketMaterializedItem): number {
  return item.glob_files?.length ?? 1;
}

async function writeManagedMapItemContext(options: {
  parentContext: RuntimeNodeExecutorContext<CompiledAgentNode>;
  itemNode: CompiledAgentNode;
  executionDir: string;
  executionId: string;
  item: ManagedMapReduceFrozenItem;
  frozenPath: string;
}): Promise<{ packetPath: string; manifestPath: string; currentItemPath: string }> {
  const runtimeDir = join(options.executionDir, "runtime");
  const agentDir = join(options.executionDir, "agent");
  const currentItemPath = join(runtimeDir, "current-item.json");
  await mkdir(runtimeDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(currentItemPath, `${JSON.stringify(options.item, null, 2)}\n`, "utf8");

  const explicitMaterials: ContextPacketMaterializedItem[] = [
    {
      key: "current_item",
      source: {
        name: "current_item",
        from: "runtime_map_reduce_item",
        path: currentItemPath,
        what: "The current frozen map-reduce item contract.",
        why: "The map worker must judge exactly this item."
      } as unknown as ContextPacketMaterializedItem["source"],
      pointer_path: currentItemPath,
      description: "The current frozen map-reduce item contract.",
      priority_bucket: "current_work",
      priority_reason: "Current frozen map-reduce item defines the immediate unit of work."
    },
    {
      key: "frozen_items",
      source: {
        name: "frozen_items",
        from: "artifact",
        path: options.frozenPath,
        what: "Runtime-validated frozen map-reduce item list.",
        why: "The map worker must not add, remove, split, merge, or reorder items."
      } as unknown as ContextPacketMaterializedItem["source"],
      pointer_path: options.frozenPath,
      description: "Runtime-validated frozen map-reduce item list.",
      priority_bucket: "progress_state",
      priority_reason: "Frozen item state is continuation context, not a new discovery target."
    }
  ];
  const inheritedMaterials = (options.parentContext.context_materials ?? [])
    .filter((material) => material.key !== "frozen_items")
    .map((material) => ({ ...material }));

  const packetPath = resolveExecutionRuntimeContextPath(options.executionDir);
  const manifestPath = resolveExecutionAgentContextPath(options.executionDir);
  const materials = rankContextMaterials([...explicitMaterials, ...inheritedMaterials]);
  const packet: ContextPacket = {
    execution_id: options.executionId,
    compiled_id: options.itemNode.compiled_id,
    authored_id: options.itemNode.authored_id,
    repo_alias: options.itemNode.repo,
    workspace_path: options.parentContext.workspace_path,
    materials,
    omitted: [],
    totals: {
      pointer_count: materials.length,
      file_count: materials.reduce((total, item) => total + materializedFileCount(item), 0)
    }
  };
  await mkdir(dirname(packetPath), { recursive: true });
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  await writeFile(manifestPath, renderContextManifest(packet), "utf8");
  return { packetPath, manifestPath, currentItemPath };
}

function buildManagedMapItemGoal(options: {
  item: ManagedMapReduceFrozenItem;
  config: ManagedMapReduceRuntimeConfig;
}): string {
  return [
    `Map frozen item \`${options.item.id}\`: ${options.item.title}.`,
    "",
    "Produce evidence for exactly this current item.",
    "",
    `Parent task goal: ${options.config.parent_intent.goal}`,
    `Current item goal: ${options.config.map_intent.goal}`,
    `Current item scope rationale: ${options.item.scope_rationale}`,
    `Current item input: ${JSON.stringify(options.item.input)}`,
    "",
    "## Item Output Contract",
    "Publish exactly one declared `item_result` artifact.",
    "Use `af artifact write item_result` to publish the item result.",
    "JSON with this exact shape:",
    "```json",
    "{",
    "  \"id\": \"<current frozen item id>\",",
    "  \"status\": \"passed | finding | skipped | blocked\",",
    "  \"summary\": \"<concrete summary of this item result>\",",
    "  \"evidence\": [{ \"ref\": \"<file/path or source ref>\", \"summary\": \"<what the evidence shows>\" }],",
    "  \"findings\": [],",
    "  \"skip_rationale\": \"<required when status is skipped>\",",
    "  \"blocker\": \"<required when status is blocked>\"",
    "}",
    "```",
    "For passed, finding, and skipped, evidence must be non-empty.",
    "For finding, findings must contain at least one entry.",
    "For skipped, include skip_rationale.",
    "For blocked, include blocker.",
    "",
    "Do not work on later frozen items. Do not add, remove, split, merge, reorder, or rediscover the item list. Write only the current item result. Do not make whole-list coverage claims."
  ].join("\n");
}

function buildManagedMapItemNode(options: {
  parentNode: CompiledAgentNode;
  item: ManagedMapReduceFrozenItem;
  config: ManagedMapReduceRuntimeConfig;
}): CompiledAgentNode {
  const itemGoal = buildManagedMapItemGoal(options);
  return {
    ...options.parentNode,
    compiled_id: `${options.parentNode.compiled_id}__item_${options.item.id}`,
    authored_id: `${options.parentNode.authored_id}__item_${options.item.id}`,
    label: `Map Item ${options.item.id}: ${options.item.title}`,
    intent: {
      goal: itemGoal,
      acceptance_criteria: [
        ...options.config.map_intent.acceptance_criteria,
        "The item result id exactly matches the current frozen item id.",
        "The item result status is passed, finding, skipped, or blocked.",
        "The item result cites concrete evidence unless blocked."
      ],
      constraints: [
        ...options.parentNode.intent.constraints,
        ...options.config.map_intent.constraints,
        "Do not mutate the frozen map-reduce item list.",
        "Do not work on any item other than the current item.",
        "Do not make whole-list coverage claims."
      ]
    },
    declared_artifacts: itemArtifactDefinitions(),
    managed_runtime: {
      kind: "pattern_map_reduce",
      root_id: options.parentNode.managed_runtime?.root_id ?? options.parentNode.authored_id,
      phase: "map_item",
      config: {
        item_id: options.item.id
      }
    },
    managed_prompt: managedPromptContract("map_item", "Inspect/process the current frozen item.", [
      {
        title: "Current Item Instructions",
        lines: itemGoal.split("\n")
      }
    ])
  };
}

async function runManagedMapItemAgent(options: {
  context: RuntimeNodeExecutorContext<CompiledAgentNode>;
  harnesses: Partial<Record<HarnessName, HarnessAdapter>>;
  itemNode: CompiledAgentNode;
  executionDir: string;
  executionId: string;
  contextPacketPath: string;
  contextManifestPath: string;
  contextManifest: string;
}): Promise<HarnessResult> {
  const harnessName = options.itemNode.effective_policy.harness!;
  const harness = options.harnesses[harnessName];
  if (!harness) {
    throw new RuntimeFailureError("harness_unavailable", `Missing harness adapter "${harnessName}" for managed map-reduce item.`);
  }

  const outputDir = resolveExecutionArtifactsDirectory(options.executionDir);
  await mkdir(outputDir, { recursive: true });
  const runtimeDir = join(options.context.run_root, "runtime");
  const toolSetup = await prepareAgentTools({
    node: options.itemNode,
    execution_dir: options.executionDir,
    workspace_path: options.context.workspace_path,
    artifacts_root: outputDir,
    run_root: options.context.run_root,
    runtime_dir: runtimeDir,
    run_id: options.context.run_id,
    graph_id: options.context.graph_id,
    execution_id: options.executionId,
    repo_alias: options.itemNode.repo,
    ...(options.itemNode.effective_policy.harness ? { harness: options.itemNode.effective_policy.harness } : {}),
    ...(options.itemNode.effective_policy.model ? { model: options.itemNode.effective_policy.model } : {}),
    ...(options.itemNode.effective_policy.reasoning_effort ? { reasoning_effort: options.itemNode.effective_policy.reasoning_effort } : {}),
    sandbox: options.itemNode.effective_policy.sandbox ?? "workspace-write",
    timeout_sec: options.itemNode.effective_policy.timeout_sec,
    context_packet_path: options.contextPacketPath,
    context_manifest_path: options.contextManifestPath,
    credential_specs: options.context.credential_specs ?? {}
  });
  const promptPath = resolveExecutionAgentPromptPath(options.executionDir);
  const invocation: AgentInvocation = {
    promptKind: "agent",
    runId: options.context.run_id,
    executionId: options.executionId,
    repoAlias: options.itemNode.repo,
    repoPath: options.context.workspace_path,
    runtimeDir,
    sandbox: options.itemNode.effective_policy.sandbox ?? "workspace-write",
    ...(options.itemNode.effective_policy.skip_git_repo_check ? { skipGitRepoCheck: true } : {}),
    ...(options.itemNode.effective_policy.harness_config ? { harnessConfig: options.itemNode.effective_policy.harness_config } : {}),
    model: options.itemNode.effective_policy.model,
    baseEnv: options.context.environment,
    ...(options.itemNode.effective_policy.reasoning_effort ? { reasoningEffort: options.itemNode.effective_policy.reasoning_effort } : {}),
    graphGoal: options.context.graph_intent.goal,
    ...(options.context.graph_intent.acceptance_criteria ? { graphAcceptanceCriteria: options.context.graph_intent.acceptance_criteria } : {}),
    ...(options.context.graph_intent.constraints ? { graphConstraints: options.context.graph_intent.constraints } : {}),
    nodeGoal: options.itemNode.intent.goal,
    ...(options.itemNode.managed_prompt ? { managedPrompt: options.itemNode.managed_prompt } : {}),
    nodeAcceptanceCriteria: options.itemNode.intent.acceptance_criteria,
    nodeConstraints: options.itemNode.intent.constraints,
    contextPacketPath: options.contextPacketPath,
    contextManifestPath: options.contextManifestPath,
    contextManifest: options.contextManifest,
    promptPath,
    outputDir,
    artifacts: options.itemNode.declared_artifacts,
    timeoutSec: options.itemNode.effective_policy.timeout_sec,
    signal: options.context.signal,
    ...(options.context.on_stdout_chunk ? { onStdoutChunk: options.context.on_stdout_chunk } : {}),
    ...(options.context.on_stderr_chunk ? { onStderrChunk: options.context.on_stderr_chunk } : {}),
    toolBinDir: toolSetup.bin_dir,
    toolEnv: toolSetup.env,
    tools: toolSetup.resolved_tools,
    skills: options.itemNode.skills,
    cli: options.itemNode.cli
  };
  const renderedPrompt = renderHarnessPrompt(invocation);
  await mkdir(dirname(promptPath), { recursive: true });
  await writeFile(promptPath, `${renderedPrompt}\n`, "utf8");
  return harness.run(invocation);
}

async function runOneMapItem(options: {
  context: RuntimeNodeExecutorContext<CompiledAgentNode>;
  harnesses: Partial<Record<HarnessName, HarnessAdapter>>;
  config: ManagedMapReduceRuntimeConfig;
  frozenPath: string;
  item: ManagedMapReduceFrozenItem;
  index: number;
}): Promise<ManagedMapItemRunResult> {
  await options.context.emit_managed_progress?.({
    phase: "map_item",
    status: "item_started",
    item_id: options.item.id,
    summary: options.item.title
  });

  const itemExecutionDir = managedItemExecutionDir(options.context.execution_dir, options.item.id);
  const itemExecutionId = managedItemExecutionId(options.context.attempt, options.item.id);
  const itemNode = buildManagedMapItemNode({
    parentNode: options.context.node,
    item: options.item,
    config: options.config
  });
  const itemAttempt = buildManagedItemAttempt({
    context: options.context,
    itemNode,
    executionDir: itemExecutionDir,
    executionId: itemExecutionId,
    attemptIndex: options.index + 1
  });
  await writeManagedItemAttemptStart(itemAttempt);

  const itemContext = await writeManagedMapItemContext({
    parentContext: options.context,
    itemNode,
    executionDir: itemExecutionDir,
    executionId: itemExecutionId,
    item: options.item,
    frozenPath: options.frozenPath
  });
  const contextManifest = await readContextManifestContent(itemContext.manifestPath);
  const harnessResult = await runManagedMapItemAgent({
    context: options.context,
    harnesses: options.harnesses,
    itemNode,
    executionDir: itemExecutionDir,
    executionId: itemExecutionId,
    contextPacketPath: itemContext.packetPath,
    contextManifestPath: itemContext.manifestPath,
    contextManifest
  });
  await writeFile(join(itemExecutionDir, "agent", "response.md"), harnessResult.transcript?.last_message ?? harnessResult.stdout ?? "", "utf8");
  let completedItemAttempt = await writeManagedItemAttemptResult({
    attempt: itemAttempt,
    result: harnessResult
  });

  if (harnessResult.status !== "passed") {
    const message = harnessResult.stderr ?? harnessResult.stdout ?? `Map-reduce item ${options.item.id} harness failed.`;
    await options.context.emit_managed_progress?.({
      phase: "map_item",
      status: "item_failed",
      item_id: options.item.id,
      summary: message
    });
    return {
      status: "failed",
      item_id: options.item.id,
      message
    };
  }

  try {
    const itemArtifacts = await readManagedMapItemArtifacts(
      resolveExecutionArtifactsDirectory(itemExecutionDir),
      options.item
    );
    completedItemAttempt = await writeManagedItemAttemptResult({
      attempt: completedItemAttempt,
      result: harnessResult,
      artifacts: {
        item_result: itemArtifacts.resultPath
      }
    });
    await options.context.emit_managed_progress?.({
      phase: "map_item",
      status: "item_completed",
      item_id: options.item.id,
      summary: options.item.title
    });
    return {
      status: "passed",
      result: {
        ...itemArtifacts.result,
        accepted_attempt_path: completedItemAttempt.execution_dir
      },
      resultPath: itemArtifacts.resultPath,
      attemptPath: completedItemAttempt.execution_dir
    };
  } catch (error) {
    const message = error instanceof ManagedContractFailureError
      ? managedContractFailureSummary(error.findings)
      : error instanceof Error ? error.message : String(error);
    const findings = error instanceof ManagedContractFailureError ? error.findings : undefined;
    if (findings) {
      await writeManagedContractFailurePacket({
        executionDir: itemExecutionDir,
        findings
      });
    }
    await writeManagedItemAttemptResult({
      attempt: completedItemAttempt,
      result: {
        status: "failed",
        exitCode: 1,
        stderr: message,
        transcript: { last_message: message }
      }
    });
    await options.context.emit_managed_progress?.({
      phase: "map_item",
      status: "item_failed",
      item_id: options.item.id,
      summary: message
    });
    return {
      status: "failed",
      item_id: options.item.id,
      message,
      ...(findings ? { findings } : {})
    };
  }
}

async function mapWithConcurrency<TItem, TResult>(
  items: TItem[],
  concurrency: number,
  worker: (item: TItem, index: number) => Promise<TResult>
): Promise<TResult[]> {
  const results = new Array<TResult>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;

      if (index >= items.length) {
        return;
      }

      results[index] = await worker(items[index]!, index);
    }
  }));

  return results;
}

function validateFrozenItems(frozen: ManagedMapReduceFrozen): void {
  if (!frozen || !Array.isArray(frozen.items) || frozen.items.length === 0) {
    throw new RuntimeFailureError("graph_contract_gap", "Frozen map-reduce item list has no items.");
  }
  const seen = new Set<string>();
  frozen.items.forEach((item, index) => {
    const expectedId = `m${index + 1}`;
    if (!isRecord(item) || item.id !== expectedId || seen.has(item.id)) {
      throw new RuntimeFailureError("graph_contract_gap", `Frozen map-reduce item ${index + 1} must use sequential id ${expectedId}.`);
    }
    seen.add(item.id);
    if (!nonEmptyString(item.title) || !isRecord(item.input) || !nonEmptyString(item.scope_rationale)) {
      throw new RuntimeFailureError("graph_contract_gap", `Frozen map-reduce item ${item.id} is missing title, input, or scope_rationale.`);
    }
  });
}

export async function runManagedMapReduceItems(
  context: RuntimeNodeExecutorContext<CompiledAgentNode>,
  harnesses: Partial<Record<HarnessName, HarnessAdapter>>
): Promise<RuntimeNodeExecutionResult> {
  const config = parseManagedMapReduceRuntimeConfig(context.node);
  const frozenPath = contextPointer(context.context_materials, "frozen_items");
  const frozen = await readJsonFile<ManagedMapReduceFrozen>("frozen map-reduce items", frozenPath);
  validateFrozenItems(frozen);

  const outputDir = resolveExecutionArtifactsDirectory(context.execution_dir);
  const runtimeDir = join(context.execution_dir, "runtime");
  await mkdir(outputDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });

  await context.emit_managed_progress?.({
    phase: "map_items",
    status: "items_frozen",
    summary: `Executing ${frozen.items.length} frozen map-reduce item(s).`
  });

  const itemRuns = await mapWithConcurrency(
    frozen.items,
    config.max_concurrency,
    async (item, index) => runOneMapItem({
      context,
      harnesses,
      config,
      frozenPath: frozenPath!,
      item,
      index
    })
  );
  const acceptedResults = itemRuns.flatMap((run) => run.status === "passed" ? [run.result] : []);
  const failedResults = itemRuns.flatMap((run) => run.status === "failed" ? [run] : []);
  const itemResultsPath = join(outputDir, "item-results.json");

  if (failedResults.length > 0) {
    const findings = failedResults.flatMap((failure) => failure.findings ?? []);
    if (findings.length > 0) {
      await writeManagedContractFailurePacket({
        executionDir: context.execution_dir,
        findings
      });
    }
    await writeFile(itemResultsPath, `${JSON.stringify({
      schema_version: 1,
      status: "failed",
      generated_at: new Date().toISOString(),
      item_count: frozen.items.length,
      completed_item_count: acceptedResults.length,
      items: acceptedResults,
      failures: failedResults.map((failure) => ({
        item_id: failure.item_id,
        message: failure.message
      }))
    }, null, 2)}\n`, "utf8");
    const summary = failedResults.map((failure) => `${failure.item_id}: ${failure.message}`).join(" ");
    await context.emit_managed_progress?.({
      phase: "map_items",
      status: "items_failed",
      summary
    });
    return {
      status: "failed",
      outcome: "failed",
      result: {
        error: summary,
        completed_item_count: acceptedResults.length,
        failed_item_count: failedResults.length
      },
      stdout: undefined,
      stderr: summary
    };
  }

  await writeFile(itemResultsPath, `${JSON.stringify({
    schema_version: 1,
    status: "completed",
    generated_at: new Date().toISOString(),
    item_count: acceptedResults.length,
    items: acceptedResults
  }, null, 2)}\n`, "utf8");
  await context.emit_managed_progress?.({
    phase: "map_items",
    status: "items_completed",
    summary: `Completed ${acceptedResults.length} frozen map-reduce item(s).`
  });

  return {
    status: "passed",
    outcome: "passed",
    result: {
      exit_code: 0,
      completed_item_count: acceptedResults.length
    },
    stdout: `Completed ${acceptedResults.length} frozen map-reduce item(s).`,
    stderr: undefined,
    agent_response: `Completed ${acceptedResults.length} frozen map-reduce item(s).`
  };
}

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ArtifactDefinition } from "../../graph/authored.js";
import type { CompiledAgentNode, CompiledGraph } from "../../graph/compiled.js";
import type { HarnessName } from "../../graph/schema.js";
import { readRunExecutionAttempts } from "../../artifacts/reader.js";
import {
  resolveExecutionAgentContextPath,
  resolveExecutionAgentPromptPath,
  resolveExecutionAgentResponsePath,
  resolveExecutionArtifactsDirectory,
  resolveExecutionHumanDebugHarnessDirectory,
  resolveExecutionRuntimeContextPath,
  resolveExecutionRuntimeDirectory,
  resolveExecutionRuntimeResultPath
} from "../../artifacts/paths.js";
import type { RuntimeNodeAttempt } from "../attempts.js";
import { runAiCheck } from "../checks/ai.js";
import { runDeterministicCheck } from "../checks/deterministic.js";
import {
  buildCompletionPacket,
  persistCompletionPacket,
  type CompletionPacket
} from "../completion/index.js";
import type { ContextPacketMaterializedItem } from "../context/packet.js";
import { RuntimeFailureError } from "../failure.js";
import { renderHarnessPrompt, type AgentInvocation, type HarnessAdapter, type HarnessResult } from "../harness/types.js";
import { readOperatorObservations } from "../observations/index.js";
import { prepareAgentTools } from "../tools/setup.js";
import type { OutcomeVerificationResult } from "../verification/types.js";
import { runOutcomeVerification } from "../verification/verifier.js";
import type { RuntimeNodeExecutionResult, RuntimeNodeExecutorContext } from "../core/engine.js";

async function readContextManifestContent(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

interface ManagedWorkListFrozenItem {
  id: string;
  title: string;
  goal: string;
  acceptance_criteria: string[];
  constraints: string[];
  validation_expectations: string[];
  handoff_focus: string[];
  rationale: string;
}

interface ManagedWorkListFrozen {
  schema_version: number;
  status: "frozen";
  planning_summary: string;
  ordering_rationale: string;
  items: ManagedWorkListFrozenItem[];
}

interface ManagedWorkListItemResult {
  id: string;
  status: string;
  summary: string;
  validation: ManagedWorkListItemValidation;
  risks: string[];
  downstream_implications: string[];
  accepted_attempt_path?: string;
  item_handoff_path?: string;
  item_validation_path?: string;
  scorecard_path?: string;
  cycles?: unknown[];
}

interface ManagedWorkListItemValidation {
  passed: string[];
  failed_then_fixed: string[];
  unavailable: string[];
  blocked: string[];
}

interface ManagedWorkListPriorProgress {
  accepted_results: ManagedWorkListItemResult[];
  accepted_handoffs: string[];
  accepted_validation: string[];
}

interface ManagedWorkListRuntimeConfig {
  parent_intent: {
    goal: string;
    acceptance_criteria: string[];
    constraints: string[];
  };
  item_guidance: {
    what_counts_as_one_item: string;
    done_when: string[];
  };
  item_worker:
    | { kind: "agent" }
    | {
        kind: "deep_work";
        completion: {
          max_cycles: number;
          pass_threshold: number;
          criteria: Array<{
            id: string;
            kind: "command" | "rubric";
            weight: number;
            required?: boolean;
            command?: string;
            target?: "workspace" | "item_handoff" | "work_list_ledger";
            rubric?: string;
          }>;
        };
      };
  criteria_concurrency?: number;
}

export function isManagedWorkListRunItemsNode(node: CompiledAgentNode): boolean {
  return (
    node.managed_runtime?.kind === "pattern_work_list" &&
    node.managed_runtime.phase === "run_items"
  );
}

function parseManagedWorkListRuntimeConfig(node: CompiledAgentNode): ManagedWorkListRuntimeConfig {
  const config = node.managed_runtime?.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new RuntimeFailureError("graph_contract_gap", "Work-list run_items node is missing runtime config.");
  }

  return config as unknown as ManagedWorkListRuntimeConfig;
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

async function readTextFileOptional(filePath: string | undefined): Promise<string | undefined> {
  if (!filePath) {
    return undefined;
  }

  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function managedWorkListErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function normalizeManagedWorkListItemValidation(value: unknown): ManagedWorkListItemValidation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const validation = {
    passed: stringArray(record.passed),
    failed_then_fixed: stringArray(record.failed_then_fixed),
    unavailable: stringArray(record.unavailable),
    blocked: stringArray(record.blocked)
  };

  if (
    validation.passed.length === 0
    && validation.failed_then_fixed.length === 0
    && validation.unavailable.length === 0
  ) {
    return undefined;
  }

  return validation;
}

function itemArtifactDefinitions(): Record<string, ArtifactDefinition> {
  return {
    item_handoff: {
      from: "output_dir",
      path: "item-handoff.md",
      description: "Human-readable handoff for this frozen work-list item."
    },
    item_result: {
      from: "output_dir",
      path: "item-result.json",
      description: "Structured result for this frozen work-list item."
    },
    item_validation: {
      from: "output_dir",
      path: "item-validation.md",
      description: "Validation evidence for this frozen work-list item."
    }
  };
}

function managedItemExecutionDir(parentExecutionDir: string, itemId: string, cycle: number): string {
  return join(parentExecutionDir, "managed-items", itemId, "executions", `${String(cycle).padStart(3, "0")}-exec`);
}

function managedItemExecutionId(parentAttempt: RuntimeNodeAttempt, itemId: string, cycle: number): string {
  return `${parentAttempt.execution_id}__item_${itemId}__cycle_${cycle}`;
}

function buildManagedItemAttempt(options: {
  context: RuntimeNodeExecutorContext<CompiledAgentNode>;
  itemNode: CompiledAgentNode;
  executionDir: string;
  executionId: string;
  cycle: number;
}): RuntimeNodeAttempt {
  return {
    execution_id: options.executionId,
    compiled_id: options.itemNode.compiled_id,
    authored_id: options.itemNode.authored_id,
    kind: "agent",
    repo_alias: options.itemNode.repo,
    execution_dir: options.executionDir,
    attempt_index: options.cycle,
    status: "running",
    started_at: new Date().toISOString(),
    artifacts: {},
    metadata: {
      managed_parent_execution_id: options.context.attempt.execution_id,
      managed_phase: "work_list_item"
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

function renderManagedItemContextManifest(rows: Array<{
  name: string;
  kind: string;
  pointer: string;
  what: string;
  why: string;
}>): string {
  const lines = [
    "# Context Manifest",
    "",
    "Context entries are pointers. Agentflow does not copy or truncate source context into this prompt package.",
    "",
    "## Pointers",
    "",
    "| Name | Kind | Pointer | What | Why |",
    "| --- | --- | --- | --- | --- |"
  ];

  rows.forEach((row) => {
    lines.push(`| \`${row.name}\` | \`${row.kind}\` | \`${row.pointer}\` | ${row.what} | ${row.why} |`);
  });

  return `${lines.join("\n")}\n`;
}

async function writeManagedItemContext(options: {
  parentContext: RuntimeNodeExecutorContext<CompiledAgentNode>;
  itemNode: CompiledAgentNode;
  executionDir: string;
  executionId: string;
  item: ManagedWorkListFrozenItem;
  frozenPath: string;
  ledgerPath: string;
  priorHandoffsPath?: string;
  priorScorecardPath?: string;
}): Promise<{ packetPath: string; manifestPath: string; currentItemPath: string }> {
  const runtimeDir = join(options.executionDir, "runtime");
  const agentDir = join(options.executionDir, "agent");
  const currentItemPath = join(runtimeDir, "current-item.json");
  await mkdir(runtimeDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(currentItemPath, `${JSON.stringify(options.item, null, 2)}\n`, "utf8");

  const rows = [
    {
      name: "current_item",
      kind: "runtime_work_list_item",
      pointer: currentItemPath,
      what: "The current frozen work-list item contract.",
      why: "The item worker must complete exactly this item."
    },
    {
      name: "frozen_work_list",
      kind: "artifact",
      pointer: options.frozenPath,
      what: "Runtime-validated frozen work list.",
      why: "The item worker must not add, remove, split, merge, or reorder items."
    },
    {
      name: "work_list_ledger",
      kind: "runtime_ledger",
      pointer: options.ledgerPath,
      what: "Current runtime-owned item ledger.",
      why: "The item worker can see prior accepted item status without manually checking off work."
    },
    ...(options.priorHandoffsPath
      ? [{
          name: "prior_completed_item_handoffs",
          kind: "runtime_handoff",
          pointer: options.priorHandoffsPath,
          what: "Accepted handoffs from earlier frozen items.",
          why: "Later items may build on earlier item evidence."
        }]
      : []),
    ...(options.priorScorecardPath
      ? [{
          name: "prior_item_scorecard",
          kind: "runtime_scorecard",
          pointer: options.priorScorecardPath,
          what: "Most recent failed scorecard for this item.",
          why: "The retry should address concrete item-level feedback."
        }]
      : [])
  ];

  const packetPath = resolveExecutionRuntimeContextPath(options.executionDir);
  const manifestPath = resolveExecutionAgentContextPath(options.executionDir);
  const packet = {
    execution_id: options.executionId,
    compiled_id: options.itemNode.compiled_id,
    authored_id: options.itemNode.authored_id,
    repo_alias: options.itemNode.repo,
    workspace_path: options.parentContext.workspace_path,
    materials: rows.map((row) => ({
      key: row.name,
      source: {
        name: row.name,
        from: "workspace_file",
        path: row.pointer,
        what: row.what,
        why: row.why
      },
      pointer_path: row.pointer,
      description: row.what
    })),
    omitted: [],
    totals: {
      pointer_count: rows.length,
      file_count: rows.length
    }
  };
  await mkdir(dirname(packetPath), { recursive: true });
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  await writeFile(manifestPath, renderManagedItemContextManifest(rows), "utf8");
  return { packetPath, manifestPath, currentItemPath };
}

function buildManagedWorkListItemGoal(options: {
  parentNode: CompiledAgentNode;
  item: ManagedWorkListFrozenItem;
  config: ManagedWorkListRuntimeConfig;
  cycle: number;
  maxCycles: number;
}): string {
  return [
    `Complete frozen work-list item \`${options.item.id}\`: ${options.item.title}.`,
    "",
    "The runtime owns item status and ledger updates. Produce evidence; do not mark ledger status yourself.",
    "",
    `Parent work-list goal: ${options.config.parent_intent.goal}`,
    `Current item goal: ${options.item.goal}`,
    `Current item rationale: ${options.item.rationale}`,
    `Cycle: ${options.cycle} of ${options.maxCycles}`,
    "",
    `What counts as one item: ${options.config.item_guidance.what_counts_as_one_item}`,
    "Done when:",
    ...options.config.item_guidance.done_when.map((entry) => `- ${entry}`),
    "",
    "Write exactly these declared item artifacts:",
    "- `item_handoff`: Markdown with item goal, changes/results, evidence, validation, risks, and downstream implications.",
    [
      "- `item_result`: JSON with this exact shape:",
      "  ```json",
      "  {",
      `    "id": "${options.item.id}",`,
      "    \"status\": \"completed\",",
      "    \"summary\": \"Concrete summary of the completed item outcome.\",",
      "    \"validation\": {",
      "      \"passed\": [\"Exact command/check/manual result evidence that passed.\"],",
      "      \"failed_then_fixed\": [],",
      "      \"unavailable\": [],",
      "      \"blocked\": []",
      "    },",
      "    \"risks\": [],",
      "    \"downstream_implications\": []",
      "  }",
      "  ```"
    ].join("\n"),
    "- `item_validation`: Markdown with validation commands, checks, manual evidence, unavailable validation, and reruns.",
    "",
    "If the item requires branch, base, PR, or workspace evidence, use inspectable local workspace evidence unless the graph explicitly says otherwise. Remote-only branch or PR updates are not a substitute for local branch/base evidence.",
    "",
    "Do not work on later frozen items. Do not add, remove, split, merge, or reorder work-list items."
  ].join("\n");
}

function buildManagedWorkListItemNode(options: {
  parentNode: CompiledAgentNode;
  item: ManagedWorkListFrozenItem;
  config: ManagedWorkListRuntimeConfig;
  cycle: number;
  maxCycles: number;
}): CompiledAgentNode {
  return {
    ...options.parentNode,
    compiled_id: `${options.parentNode.compiled_id}__item_${options.item.id}`,
    authored_id: `${options.parentNode.authored_id}__item_${options.item.id}`,
    label: `Work List Item ${options.item.id}: ${options.item.title}`,
    intent: {
      goal: buildManagedWorkListItemGoal(options),
      acceptance_criteria: [
        ...options.item.acceptance_criteria,
        "The item handoff cites concrete evidence and downstream implications.",
        "The item result JSON matches the current frozen item id and marks completed work only when evidence exists."
      ],
      constraints: [
        ...options.parentNode.intent.constraints,
        ...options.item.constraints,
        "Do not mutate the frozen work-list contract.",
        "Do not work on any item other than the current item."
      ]
    },
    context: [],
    declared_artifacts: itemArtifactDefinitions(),
    managed_runtime: {
      kind: "pattern_work_list",
      root_id: options.parentNode.managed_runtime?.root_id ?? options.parentNode.authored_id,
      phase: "item",
      config: {
        item_id: options.item.id,
        cycle: options.cycle
      }
    }
  };
}

async function readManagedItemArtifacts(outputDir: string, item: ManagedWorkListFrozenItem): Promise<{
  handoffPath: string;
  resultPath: string;
  validationPath: string;
  result: ManagedWorkListItemResult;
}> {
  const handoffPath = join(outputDir, "item-handoff.md");
  const resultPath = join(outputDir, "item-result.json");
  const validationPath = join(outputDir, "item-validation.md");
  try {
    await access(handoffPath);
    await access(resultPath);
    await access(validationPath);
  } catch {
    throw new RuntimeFailureError(
      "artifact_contract_failure",
      `Managed work-list item ${item.id} did not publish item_handoff, item_result, and item_validation.`
    );
  }

  const result = await readJsonFile<ManagedWorkListItemResult>("item result", resultPath);
  if (result.id !== item.id) {
    throw new RuntimeFailureError("artifact_contract_failure", `Item result id "${result.id}" does not match frozen item "${item.id}".`);
  }
  if (result.status !== "completed") {
    throw new RuntimeFailureError("artifact_contract_failure", `Item ${item.id} result status is "${result.status}", not completed.`);
  }
  if (typeof result.summary !== "string" || result.summary.trim().length === 0) {
    throw new RuntimeFailureError("artifact_contract_failure", `Item ${item.id} result is missing a summary.`);
  }
  const validation = normalizeManagedWorkListItemValidation(result.validation);
  if (!validation) {
    throw new RuntimeFailureError("artifact_contract_failure", `Item ${item.id} result is missing validation evidence.`);
  }

  return {
    handoffPath,
    resultPath,
    validationPath,
    result: {
      ...result,
      validation,
      risks: Array.isArray(result.risks) ? result.risks : [],
      downstream_implications: Array.isArray(result.downstream_implications) ? result.downstream_implications : []
    }
  };
}

function isReusableManagedWorkListResult(
  result: ManagedWorkListItemResult | undefined,
  item: ManagedWorkListFrozenItem
): result is ManagedWorkListItemResult {
  return Boolean(
    result
    && result.id === item.id
    && result.status === "completed"
    && typeof result.summary === "string"
    && result.summary.trim().length > 0
    && Boolean(normalizeManagedWorkListItemValidation(result.validation))
  );
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

async function collectReusableManagedWorkListResult(
  result: ManagedWorkListItemResult | undefined,
  frozenItem: ManagedWorkListFrozenItem
): Promise<{
  result: ManagedWorkListItemResult;
  handoff: string;
  validation: string;
} | undefined> {
  if (!isReusableManagedWorkListResult(result, frozenItem)) {
    return undefined;
  }

  const handoff = await readTextFileOptional(result.item_handoff_path);
  const validation = await readTextFileOptional(result.item_validation_path);
  if (!handoff || !validation) {
    return undefined;
  }

  return { result, handoff, validation };
}

async function loadPriorManagedWorkListProgressFromAggregate(options: {
  attempt: RuntimeNodeAttempt;
  frozen: ManagedWorkListFrozen;
}): Promise<ManagedWorkListPriorProgress | undefined> {
  if (!options.attempt.artifacts.item_results) {
    return undefined;
  }

  const previous = await readJsonFile<{ items?: ManagedWorkListItemResult[] }>(
    "previous work-list item results",
    options.attempt.artifacts.item_results
  );
  const previousById = new Map((previous.items ?? []).map((item) => [item.id, item]));
  const acceptedResults: ManagedWorkListItemResult[] = [];
  const acceptedHandoffs: string[] = [];
  const acceptedValidation: string[] = [];

  for (const frozenItem of options.frozen.items) {
    const reusable = await collectReusableManagedWorkListResult(previousById.get(frozenItem.id), frozenItem);
    if (!reusable) {
      break;
    }

    acceptedResults.push(reusable.result);
    acceptedHandoffs.push(reusable.handoff);
    acceptedValidation.push(reusable.validation);
  }

  if (acceptedResults.length === 0) {
    return undefined;
  }

  return {
    accepted_results: acceptedResults,
    accepted_handoffs: acceptedHandoffs,
    accepted_validation: acceptedValidation
  };
}

async function loadPriorManagedWorkListProgressFromLedger(options: {
  attempt: RuntimeNodeAttempt;
  frozen: ManagedWorkListFrozen;
}): Promise<ManagedWorkListPriorProgress | undefined> {
  const ledgerPath = join(resolveExecutionRuntimeDirectory(options.attempt.execution_dir), "work-list-ledger.json");
  const ledger = await readJsonFile<{ items?: Array<{ id?: string; status?: string; accepted_attempt_path?: string }> }>(
    "previous work-list ledger",
    ledgerPath
  );
  const ledgerById = new Map((ledger.items ?? []).map((item) => [item.id, item]));
  const acceptedResults: ManagedWorkListItemResult[] = [];
  const acceptedHandoffs: string[] = [];
  const acceptedValidation: string[] = [];

  for (const frozenItem of options.frozen.items) {
    const ledgerItem = ledgerById.get(frozenItem.id);
    if (
      ledgerItem?.status !== "completed" ||
      !ledgerItem.accepted_attempt_path
    ) {
      break;
    }

    const artifacts = await readManagedItemArtifacts(
      resolveExecutionArtifactsDirectory(ledgerItem.accepted_attempt_path),
      frozenItem
    );
    const reusable = await collectReusableManagedWorkListResult({
      ...artifacts.result,
      accepted_attempt_path: ledgerItem.accepted_attempt_path,
      item_handoff_path: artifacts.handoffPath,
      item_validation_path: artifacts.validationPath
    }, frozenItem);
    if (!reusable) {
      break;
    }

    acceptedResults.push(reusable.result);
    acceptedHandoffs.push(reusable.handoff);
    acceptedValidation.push(reusable.validation);
  }

  if (acceptedResults.length === 0) {
    return undefined;
  }

  return {
    accepted_results: acceptedResults,
    accepted_handoffs: acceptedHandoffs,
    accepted_validation: acceptedValidation
  };
}

async function loadPriorManagedWorkListProgress(options: {
  context: RuntimeNodeExecutorContext<CompiledAgentNode>;
  frozen: ManagedWorkListFrozen;
}): Promise<ManagedWorkListPriorProgress> {
  if (options.context.attempt.attempt_index <= 1) {
    return { accepted_results: [], accepted_handoffs: [], accepted_validation: [] };
  }

  const attempts = await readRunExecutionAttempts(options.context.run_root);
  const previousAttempts = attempts
    .filter((attempt) =>
      attempt.compiled_id === options.context.node.compiled_id
      && attempt.attempt_index < options.context.attempt.attempt_index
    )
    .sort((left, right) => right.attempt_index - left.attempt_index);

  for (const attempt of previousAttempts) {
    try {
      const aggregateProgress = await loadPriorManagedWorkListProgressFromAggregate({ attempt, frozen: options.frozen });
      if (aggregateProgress) {
        return aggregateProgress;
      }

      const ledgerProgress = await loadPriorManagedWorkListProgressFromLedger({ attempt, frozen: options.frozen });
      if (ledgerProgress) {
        return ledgerProgress;
      }
    } catch {
      // Stale or malformed prior attempts are audit evidence, not reusable progress.
    }
  }

  return { accepted_results: [], accepted_handoffs: [], accepted_validation: [] };
}

async function runManagedWorkListItemAgent(options: {
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
  const harness = options.harnesses[harnessName]!;
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

async function buildManagedWorkListItemCompletionPacket(options: {
  context: RuntimeNodeExecutorContext<CompiledAgentNode>;
  itemNode: CompiledAgentNode;
  itemAttempt: RuntimeNodeAttempt;
}): Promise<CompletionPacket> {
  const priorAttempts = (await readRunExecutionAttempts(options.context.run_root).catch(() => []))
    .filter((attempt) =>
      attempt.execution_id !== options.itemAttempt.execution_id &&
      attempt.compiled_id === options.itemNode.compiled_id
    );
  const runtimeDir = join(options.context.run_root, "runtime");
  const packet = await buildCompletionPacket({
    runRoot: options.context.run_root,
    node: options.itemNode,
    attempt: options.itemAttempt,
    priorAttempts,
    workspacePath: options.context.workspace_path,
    outputDir: resolveExecutionArtifactsDirectory(options.itemAttempt.execution_dir),
    runtimeDir,
    sandbox: options.itemNode.effective_policy.sandbox ?? "workspace-write",
    observations: await readOperatorObservations(options.context.run_root)
  });
  await persistCompletionPacket(packet);
  return packet;
}

async function verifyManagedWorkListItemAttempt(options: {
  context: RuntimeNodeExecutorContext<CompiledAgentNode>;
  harnesses: Partial<Record<HarnessName, HarnessAdapter>>;
  itemNode: CompiledAgentNode;
  itemAttempt: RuntimeNodeAttempt;
  itemArtifacts: Awaited<ReturnType<typeof readManagedItemArtifacts>>;
  completionPacket: CompletionPacket;
  contextPacketPath: string;
  contextManifestPath: string;
  contextManifest: string;
}): Promise<OutcomeVerificationResult> {
  const harnessName = options.itemNode.effective_policy.harness!;
  const harness = options.harnesses[harnessName];
  if (!harness) {
    throw new RuntimeFailureError("harness_unavailable", `Missing harness adapter "${harnessName}" for managed work-list item verification.`);
  }

  const graph: CompiledGraph = {
    graph_id: options.context.graph_id,
    intent: options.context.graph_intent,
    supervision: {
      profile: "supervisor",
      max_total_interventions: 0
    },
    launch: {
      launch_profile: "managed-item",
      workspace_backend: "inplace"
    },
    entry_node_ids: [options.itemNode.compiled_id],
    nodes: [options.itemNode],
    edges: [],
    scopes: [],
    authored_to_compiled: {
      [options.itemNode.authored_id]: [options.itemNode.compiled_id]
    },
    ...(options.context.credential_specs ? { credential_specs: options.context.credential_specs } : {})
  };

  return runOutcomeVerification({
    graph,
    node: options.itemNode,
    attempt: options.itemAttempt,
    workspacePath: options.context.workspace_path,
    outputDir: resolveExecutionArtifactsDirectory(options.itemAttempt.execution_dir),
    contextPacketPath: options.contextPacketPath,
    contextManifestPath: options.contextManifestPath,
    contextManifest: options.contextManifest,
    agentResponseArtifactPath: resolveExecutionAgentResponsePath(options.itemAttempt.execution_dir),
    declaredArtifactPaths: {
      item_handoff: options.itemArtifacts.handoffPath,
      item_result: options.itemArtifacts.resultPath,
      item_validation: options.itemArtifacts.validationPath
    },
    completionPacket: options.completionPacket,
    harness,
    runId: options.context.run_id,
    baseEnv: options.context.environment,
    ...(options.context.signal ? { signal: options.context.signal } : {}),
    runtimeDir: join(options.context.run_root, "runtime")
  });
}

async function evaluateManagedWorkListItemCriteria(options: {
  context: RuntimeNodeExecutorContext<CompiledAgentNode>;
  config: Extract<ManagedWorkListRuntimeConfig["item_worker"], { kind: "deep_work" }>["completion"];
  item: ManagedWorkListFrozenItem;
  itemNode: CompiledAgentNode;
  itemExecutionDir: string;
  itemArtifacts: Awaited<ReturnType<typeof readManagedItemArtifacts>>;
  ledgerPath: string;
  contextPacketPath: string;
  contextManifestPath: string;
  contextManifest: string;
  harnesses: Partial<Record<HarnessName, HarnessAdapter>>;
  cycle: number;
  maxConcurrency?: number;
}): Promise<{ passed: boolean; scorecardPath: string; scorecard: Record<string, unknown> }> {
  const criteriaDir = join(options.itemExecutionDir, "criteria");
  await mkdir(criteriaDir, { recursive: true });
  type CriterionResult = {
    id: string;
    kind: string;
    weight: number;
    required: boolean;
    passed: boolean;
    score: number;
    weighted_score: number;
    summary: string;
    issues: unknown[];
    evidence_path?: string;
  };

  const criterionResults = await mapWithConcurrency(options.config.criteria, options.maxConcurrency ?? options.config.criteria.length, async (criterion, index): Promise<CriterionResult> => {
    const criterionDir = join(criteriaDir, `${String(index + 1).padStart(2, "0")}-${criterion.id}`);
    await mkdir(criterionDir, { recursive: true });

    if (criterion.kind === "command") {
      const result = await runDeterministicCheck({
        command: "sh",
        args: ["-lc", criterion.command ?? ""],
        pass_if: { exit_code: 0 },
        cwd: options.context.workspace_path,
        env: undefined,
        base_env: options.context.environment,
        runtime_env: {
          ...(options.context.runtime_env ?? {}),
          AGENTFLOW_OUTPUT_DIR: criterionDir,
          AGENTFLOW_CONTEXT_CURRENT_ITEM: join(options.itemExecutionDir, "runtime", "current-item.json"),
          AGENTFLOW_CONTEXT_ITEM_HANDOFF: options.itemArtifacts.handoffPath,
          AGENTFLOW_CONTEXT_ITEM_RESULT: options.itemArtifacts.resultPath,
          AGENTFLOW_CONTEXT_ITEM_VALIDATION: options.itemArtifacts.validationPath,
          AGENTFLOW_CONTEXT_WORK_LIST_LEDGER: options.ledgerPath
        },
        timeout_sec: options.itemNode.effective_policy.timeout_sec,
        signal: options.context.signal
      });
      const evidencePath = join(criterionDir, "verification.json");
      await writeFile(evidencePath, `${JSON.stringify(result.verification_json, null, 2)}\n`, "utf8");
      await writeFile(join(criterionDir, "stdout.log"), result.stdout, "utf8");
      await writeFile(join(criterionDir, "stderr.log"), result.stderr, "utf8");
      const score = result.passed ? 1 : 0;
      return {
        id: criterion.id,
        kind: "command",
        weight: criterion.weight,
        required: criterion.required === true,
        passed: result.passed,
        score,
        weighted_score: score * criterion.weight,
        summary: result.summary,
        issues: result.passed ? [] : [result.summary],
        evidence_path: evidencePath
      };
    }

    const harnessName = options.itemNode.effective_policy.harness!;
    const harness = options.harnesses[harnessName]!;
    const promptPath = join(criterionDir, "prompt.md");
    const aiResult = await runAiCheck({
      harness,
      run_id: options.context.run_id,
      execution_id: `${options.itemNode.compiled_id}__criterion_${criterion.id}__cycle_${options.cycle}`,
      repo_alias: options.itemNode.repo,
      repo_path: options.context.workspace_path,
      model: options.itemNode.effective_policy.model,
      ...(options.itemNode.effective_policy.reasoning_effort ? { reasoning_effort: options.itemNode.effective_policy.reasoning_effort } : {}),
      ...(options.itemNode.effective_policy.harness_config ? { harness_config: options.itemNode.effective_policy.harness_config } : {}),
      ...(options.itemNode.effective_policy.skip_git_repo_check ? { skip_git_repo_check: true } : {}),
      rubric: criterion.rubric,
      graph_goal: options.context.graph_intent.goal,
      ...(options.context.graph_intent.acceptance_criteria ? { graph_acceptance_criteria: options.context.graph_intent.acceptance_criteria } : {}),
      ...(options.context.graph_intent.constraints ? { graph_constraints: options.context.graph_intent.constraints } : {}),
      node_goal: [
        `Evaluate work-list item ${options.item.id}: ${options.item.title}.`,
        `Criterion target: ${criterion.target ?? "workspace"}.`,
        "Grade only the current item evidence and the relevant ledger/prior-item pointers."
      ].join("\n"),
      node_acceptance_criteria: options.item.acceptance_criteria,
      node_constraints: options.itemNode.intent.constraints,
      context_packet_path: options.contextPacketPath,
      context_manifest_path: options.contextManifestPath,
      context_manifest: options.contextManifest,
      prompt_path: promptPath,
      output_dir: criterionDir,
      skills: options.itemNode.skills,
      cli: options.itemNode.cli,
      timeout_sec: options.itemNode.effective_policy.timeout_sec,
      signal: options.context.signal
    });
    const score = typeof aiResult.evaluation.score === "number"
      ? Math.max(0, Math.min(1, aiResult.evaluation.score))
      : aiResult.evaluation.passed ? 1 : 0;
    const evidencePath = join(criterionDir, "verification.json");
    await writeFile(evidencePath, `${JSON.stringify({
      passed: aiResult.evaluation.passed,
      score,
      summary: aiResult.evaluation.summary,
      issues: aiResult.evaluation.issues ?? [],
      raw: aiResult.evaluation.raw
    }, null, 2)}\n`, "utf8");
    return {
      id: criterion.id,
      kind: "rubric",
      weight: criterion.weight,
      required: criterion.required === true,
      passed: aiResult.evaluation.passed,
      score,
      weighted_score: score * criterion.weight,
      summary: aiResult.evaluation.summary ?? (aiResult.evaluation.passed ? "Criterion passed." : "Criterion failed."),
      issues: aiResult.evaluation.issues ?? [],
      evidence_path: evidencePath
    };
  });

  const blockers = criterionResults
    .filter((result) => result.required && !result.passed)
    .map((result) => ({ criterion_id: result.id, summary: result.summary }));
  const totalScore = criterionResults.reduce((sum, result) => sum + result.weighted_score, 0);
  const passed = blockers.length === 0 && totalScore >= options.config.pass_threshold;
  const scorecard = {
    passed,
    item_id: options.item.id,
    cycle: options.cycle,
    total_score: Number(totalScore.toFixed(4)),
    pass_threshold: options.config.pass_threshold,
    blockers,
    criteria: criterionResults,
    next_attempt_guidance: criterionResults
      .filter((result) => !result.passed || result.score < 0.85)
      .map((result) => ({ criterion_id: result.id, guidance: result.summary })),
    generated_at: new Date().toISOString()
  };
  const scorecardPath = join(options.itemExecutionDir, "artifacts", "scorecard.json");
  await writeFile(scorecardPath, `${JSON.stringify(scorecard, null, 2)}\n`, "utf8");
  return { passed, scorecardPath, scorecard };
}

export async function runManagedWorkListItems(
  context: RuntimeNodeExecutorContext<CompiledAgentNode>,
  harnesses: Partial<Record<HarnessName, HarnessAdapter>>
): Promise<RuntimeNodeExecutionResult> {
  const config = parseManagedWorkListRuntimeConfig(context.node);
  const frozenPath = contextPointer(context.context_materials, "frozen_work_list");
  const initialLedgerPath = contextPointer(context.context_materials, "work_list_ledger");
  const frozen = await readJsonFile<ManagedWorkListFrozen>("frozen work list", frozenPath);
  if (!frozen.items || !Array.isArray(frozen.items) || frozen.items.length === 0) {
    throw new RuntimeFailureError("graph_contract_gap", "Frozen work list has no items.");
  }
  if (!initialLedgerPath) {
    throw new RuntimeFailureError("context_contract_failure", "Missing work-list ledger context pointer.");
  }

  const outputDir = resolveExecutionArtifactsDirectory(context.execution_dir);
  const runtimeDir = join(context.execution_dir, "runtime");
  await mkdir(outputDir, { recursive: true });
  await mkdir(runtimeDir, { recursive: true });

  const priorProgress = await loadPriorManagedWorkListProgress({ context, frozen });
  const acceptedResults: ManagedWorkListItemResult[] = [...priorProgress.accepted_results];
  const acceptedHandoffs: string[] = [...priorProgress.accepted_handoffs];
  const acceptedValidation: string[] = [...priorProgress.accepted_validation];
  let ledger = {
    schema_version: 1,
    status: "running",
    items: frozen.items.map((item, index) => ({
      id: item.id,
      title: item.title,
      status: index < acceptedResults.length ? "completed" : "pending",
      ...(acceptedResults[index]?.accepted_attempt_path
        ? { accepted_attempt_path: acceptedResults[index]!.accepted_attempt_path }
        : {})
    }))
  };
  const runtimeLedgerPath = join(runtimeDir, "work-list-ledger.json");
  await writeFile(runtimeLedgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  await context.emit_managed_progress?.({
    phase: "run_items",
    status: "list_frozen",
    summary: `Executing ${frozen.items.length} frozen work-list item(s).`
  });

  for (const reused of acceptedResults) {
    await context.emit_managed_progress?.({
      phase: "run_item",
      status: "item_completed",
      item_id: reused.id,
      summary: `Preserved completed item ${reused.id} from a prior attempt.`
    });
  }

  for (const item of frozen.items) {
    if (acceptedResults.some((result) => result.id === item.id)) {
      continue;
    }

    const maxCycles = config.item_worker.kind === "deep_work"
      ? config.item_worker.completion.max_cycles
      : 1;
    let accepted: ManagedWorkListItemResult | undefined;
    let lastScorecardPath: string | undefined;
    let lastFailure = "";

    for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
      await context.emit_managed_progress?.({
        phase: "run_item",
        status: cycle === 1 ? "item_started" : "item_retrying",
        item_id: item.id,
        attempt: cycle,
        max_attempts: maxCycles,
        summary: item.title
      });
      const itemExecutionDir = managedItemExecutionDir(context.execution_dir, item.id, cycle);
      const itemExecutionId = managedItemExecutionId(context.attempt, item.id, cycle);
      const itemNode = buildManagedWorkListItemNode({
        parentNode: context.node,
        item,
        config,
        cycle,
        maxCycles
      });
      const itemAttempt = buildManagedItemAttempt({
        context,
        itemNode,
        executionDir: itemExecutionDir,
        executionId: itemExecutionId,
        cycle
      });
      await writeManagedItemAttemptStart(itemAttempt);
      const priorHandoffsPath = acceptedHandoffs.length > 0
        ? join(runtimeDir, `prior-handoffs-before-${item.id}.md`)
        : undefined;
      if (priorHandoffsPath) {
        await writeFile(priorHandoffsPath, acceptedHandoffs.join("\n\n"), "utf8");
      }
      const itemContext = await writeManagedItemContext({
        parentContext: context,
        itemNode,
        executionDir: itemExecutionDir,
        executionId: itemExecutionId,
        item,
        frozenPath: frozenPath!,
        ledgerPath: runtimeLedgerPath,
        ...(priorHandoffsPath ? { priorHandoffsPath } : {}),
        ...(lastScorecardPath ? { priorScorecardPath: lastScorecardPath } : {})
      });
      const contextManifest = await readContextManifestContent(itemContext.manifestPath);
      const harnessResult = await runManagedWorkListItemAgent({
        context,
        harnesses,
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
        lastFailure = harnessResult.stderr ?? harnessResult.stdout ?? `Item ${item.id} harness failed.`;
        continue;
      }

      let itemArtifacts: Awaited<ReturnType<typeof readManagedItemArtifacts>>;
      try {
        itemArtifacts = await readManagedItemArtifacts(
          resolveExecutionArtifactsDirectory(itemExecutionDir),
          item
        );
      } catch (error) {
        lastFailure = managedWorkListErrorMessage(error);
        continue;
      }
      completedItemAttempt = await writeManagedItemAttemptResult({
        attempt: completedItemAttempt,
        result: harnessResult,
        artifacts: {
          item_handoff: itemArtifacts.handoffPath,
          item_result: itemArtifacts.resultPath,
          item_validation: itemArtifacts.validationPath
        }
      });
      let scorecardPath: string | undefined;
      let cycles: unknown[] | undefined;
      if (config.item_worker.kind === "deep_work") {
        const scorecard = await evaluateManagedWorkListItemCriteria({
          context,
          config: config.item_worker.completion,
          item,
          itemNode,
          itemExecutionDir,
          itemArtifacts,
          ledgerPath: runtimeLedgerPath,
          contextPacketPath: itemContext.packetPath,
          contextManifestPath: itemContext.manifestPath,
          contextManifest,
          harnesses,
          cycle,
          ...(config.criteria_concurrency !== undefined ? { maxConcurrency: config.criteria_concurrency } : {})
        });
        scorecardPath = scorecard.scorecardPath;
        lastScorecardPath = scorecard.scorecardPath;
        cycles = [{ cycle, scorecard_path: scorecard.scorecardPath, passed: scorecard.passed }];
        if (!scorecard.passed) {
          lastFailure = typeof scorecard.scorecard.summary === "string"
            ? scorecard.scorecard.summary
            : `Item ${item.id} criteria did not pass.`;
          continue;
        }
      }

      await context.emit_managed_progress?.({
        phase: "run_item",
        status: "item_verifying",
        item_id: item.id,
        attempt: cycle,
        max_attempts: maxCycles,
        summary: item.title
      });
      const completionPacket = await buildManagedWorkListItemCompletionPacket({
        context,
        itemNode,
        itemAttempt: completedItemAttempt
      });
      if (!completionPacket.ready_for_verification) {
        lastFailure = [
          `Item ${item.id} completion packet is ${completionPacket.completion_status}.`,
          ...completionPacket.blocking_reasons
        ].filter(Boolean).join(" ");
        await context.emit_managed_progress?.({
          phase: "run_item",
          status: "item_retrying",
          item_id: item.id,
          attempt: cycle,
          max_attempts: maxCycles,
          summary: lastFailure
        });
        continue;
      }
      const itemVerification = await verifyManagedWorkListItemAttempt({
        context,
        harnesses,
        itemNode,
        itemAttempt: completedItemAttempt,
        itemArtifacts,
        completionPacket,
        contextPacketPath: itemContext.packetPath,
        contextManifestPath: itemContext.manifestPath,
        contextManifest
      });
      await context.emit_managed_progress?.({
        phase: "run_item",
        status: itemVerification.passed ? "item_verified" : "item_retrying",
        item_id: item.id,
        attempt: cycle,
        max_attempts: maxCycles,
        summary: itemVerification.summary
      });
      if (!itemVerification.passed) {
        lastFailure = itemVerification.summary;
        continue;
      }

      accepted = {
        ...itemArtifacts.result,
        accepted_attempt_path: itemExecutionDir,
        item_handoff_path: itemArtifacts.handoffPath,
        item_validation_path: itemArtifacts.validationPath,
        ...(scorecardPath ? { scorecard_path: scorecardPath } : {}),
        ...(cycles ? { cycles } : {})
      };
      acceptedResults.push(accepted);
      acceptedHandoffs.push(await readFile(itemArtifacts.handoffPath, "utf8"));
      acceptedValidation.push(await readFile(itemArtifacts.validationPath, "utf8"));
      ledger = {
        ...ledger,
        items: ledger.items.map((entry) =>
          entry.id === item.id
            ? { ...entry, status: "completed", accepted_attempt_path: itemExecutionDir }
            : entry
        )
      };
      await writeFile(runtimeLedgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
      await context.emit_managed_progress?.({
        phase: "run_item",
        status: "item_completed",
        item_id: item.id,
        attempt: cycle,
        max_attempts: maxCycles,
        summary: item.title
      });
      break;
    }

    if (!accepted) {
      ledger = {
        ...ledger,
        status: "failed",
        items: ledger.items.map((entry) =>
          entry.id === item.id ? { ...entry, status: "failed", summary: lastFailure } : entry
        )
      };
      await writeFile(runtimeLedgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
      await writeFile(join(outputDir, "item-results.json"), `${JSON.stringify({ items: acceptedResults }, null, 2)}\n`, "utf8");
      await writeFile(join(outputDir, "item-handoffs.md"), acceptedHandoffs.join("\n\n"), "utf8");
      await writeFile(join(outputDir, "item-validation.md"), acceptedValidation.join("\n\n"), "utf8");
      await context.emit_managed_progress?.({
        phase: "run_item",
        status: "item_failed",
        item_id: item.id,
        summary: lastFailure || `Item ${item.id} failed.`
      });
      return {
        status: "failed",
        outcome: "failed",
        result: {
          error: lastFailure || `Work-list item ${item.id} failed.`,
          failed_item_id: item.id,
          completed_item_count: acceptedResults.length
        },
        stdout: undefined,
        stderr: lastFailure || `Work-list item ${item.id} failed.`
      };
    }
  }

  await writeFile(join(outputDir, "item-results.json"), `${JSON.stringify({ items: acceptedResults }, null, 2)}\n`, "utf8");
  await writeFile(join(outputDir, "item-handoffs.md"), acceptedHandoffs.join("\n\n"), "utf8");
  await writeFile(join(outputDir, "item-validation.md"), acceptedValidation.join("\n\n"), "utf8");
  await context.emit_managed_progress?.({
    phase: "run_items",
    status: "items_completed",
    summary: `Completed ${acceptedResults.length} frozen work-list item(s).`
  });

  return {
    status: "passed",
    outcome: "passed",
    result: {
      exit_code: 0,
      completed_item_count: acceptedResults.length
    },
    stdout: `Completed ${acceptedResults.length} frozen work-list item(s).`,
    stderr: undefined,
    agent_response: `Completed ${acceptedResults.length} frozen work-list item(s).`
  };
}

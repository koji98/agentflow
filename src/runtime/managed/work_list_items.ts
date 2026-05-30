import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ArtifactDefinition, ContextItem } from "../../graph/authored.js";
import type { CompiledAgentNode, CompiledGraph, ResolvedSkill, ResolvedTool } from "../../graph/compiled.js";
import type { EffectiveNodePolicy } from "../../graph/profiles.js";
import type { HarnessName } from "../../graph/schema.js";
import type { PatternDeepWorkPhaseName, PatternDeepWorkPhaseOverride } from "../../managed/pattern_deep_work.js";
import { resolveSubpathWithinRoot } from "../../path_rules.js";
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

interface ManagedWorkListScorecardCriterion {
  id: string;
  required: boolean;
  passed: boolean;
  score: number;
  summary: string;
}

interface ManagedWorkListItemScorecard {
  passed?: boolean;
  total_score?: number;
  pass_threshold?: number;
  blockers?: unknown[];
  criteria?: ManagedWorkListScorecardCriterion[];
}

interface ManagedWorkListPriorProgress {
  accepted_results: ManagedWorkListItemResult[];
  accepted_handoffs: string[];
  accepted_validation: string[];
}

interface ManagedWorkListPhaseTemplate {
  effective_policy: EffectiveNodePolicy;
  context: ContextItem[];
  skills: ResolvedSkill[];
  cli: CompiledAgentNode["cli"];
  tools: ResolvedTool[];
}

interface ManagedWorkListReuseDecision {
  item_id: string;
  decision: "reuse_prior_completed_item";
  accepted_attempt_path: string;
  contract_hash: string;
  frozen_list_hash: string;
  frozen_item_hash: string;
  criterion_thresholds_hash: string;
  support_tool_contract_hash: string;
  validation_refs: string[];
  accepted_prior_attempt_state: "passed";
  reason: string;
  created_at: string;
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
        phases?: Partial<Record<PatternDeepWorkPhaseName, PatternDeepWorkPhaseOverride>>;
        phase_templates?: Partial<Record<PatternDeepWorkPhaseName, ManagedWorkListPhaseTemplate>>;
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

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
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

function requiredCriterionGateBlocker(
  criterion: ManagedWorkListScorecardCriterion,
  passThreshold: number
): { criterion_id: string; summary: string } | undefined {
  if (!criterion.required) {
    return undefined;
  }

  if (!criterion.passed) {
    return { criterion_id: criterion.id, summary: criterion.summary };
  }

  if (criterion.score < passThreshold) {
    return {
      criterion_id: criterion.id,
      summary: `${criterion.summary} Required criterion score ${criterion.score.toFixed(2)} is below the item pass threshold ${passThreshold.toFixed(2)}.`
    };
  }

  return undefined;
}

function normalizeCriterionForGate(
  criterion: ManagedWorkListScorecardCriterion,
  passThreshold: number
): ManagedWorkListScorecardCriterion & { evaluator_passed?: boolean } {
  const blocker = requiredCriterionGateBlocker(criterion, passThreshold);
  if (!blocker) {
    return criterion;
  }

  return {
    ...criterion,
    evaluator_passed: criterion.passed,
    passed: false,
    summary: blocker.summary
  };
}

function scorecardPassesItemGate(scorecard: ManagedWorkListItemScorecard): boolean {
  const passThreshold = typeof scorecard.pass_threshold === "number" ? scorecard.pass_threshold : undefined;
  const criteria = Array.isArray(scorecard.criteria) ? scorecard.criteria : [];
  if (
    scorecard.passed !== true ||
    passThreshold === undefined ||
    typeof scorecard.total_score !== "number" ||
    scorecard.total_score < passThreshold ||
    (Array.isArray(scorecard.blockers) && scorecard.blockers.length > 0)
  ) {
    return false;
  }

  return criteria.every((criterion) =>
    requiredCriterionGateBlocker(criterion, passThreshold) === undefined
  );
}

async function reusableScorecardPath(scorecardPath: string | undefined): Promise<boolean> {
  if (!scorecardPath) {
    return true;
  }

  try {
    const scorecard = JSON.parse(await readFile(scorecardPath, "utf8")) as ManagedWorkListItemScorecard;
    return scorecardPassesItemGate(scorecard);
  } catch {
    return false;
  }
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

function itemPlanArtifactDefinitions(): Record<string, ArtifactDefinition> {
  return {
    item_cycle_plan: {
      from: "output_dir",
      path: "item-cycle-plan.md",
      description: "Focused plan for the current work-list item cycle."
    }
  };
}

function itemDraftArtifactDefinitions(): Record<string, ArtifactDefinition> {
  return {
    item_work_notes: {
      from: "output_dir",
      path: "item-work-notes.md",
      description: "Execution notes for the current work-list item cycle."
    },
    draft_item_handoff: {
      from: "output_dir",
      path: "draft-item-handoff.md",
      description: "Draft item handoff to be graded before final publication."
    },
    draft_item_result: {
      from: "output_dir",
      path: "draft-item-result.json",
      description: "Draft structured item result to be graded before final publication."
    },
    draft_item_validation: {
      from: "output_dir",
      path: "draft-item-validation.md",
      description: "Draft validation evidence to be graded before final publication."
    }
  };
}

function managedItemExecutionDir(parentExecutionDir: string, itemId: string, cycle: number): string {
  return join(parentExecutionDir, "managed-items", itemId, "executions", `${String(cycle).padStart(3, "0")}-exec`);
}

function managedItemExecutionId(parentAttempt: RuntimeNodeAttempt, itemId: string, cycle: number): string {
  return `${parentAttempt.execution_id}__item_${itemId}__cycle_${cycle}`;
}

function managedItemPhaseExecutionDir(itemExecutionDir: string, phase: PatternDeepWorkPhaseName): string {
  return join(itemExecutionDir, "phases", phase);
}

function managedItemPhaseExecutionId(parentAttempt: RuntimeNodeAttempt, itemId: string, cycle: number, phase: PatternDeepWorkPhaseName): string {
  return `${managedItemExecutionId(parentAttempt, itemId, cycle)}__${phase}`;
}

async function writeManagedWorkListReuseDecision(options: {
  parentExecutionDir: string;
  node: CompiledAgentNode;
  config: ManagedWorkListRuntimeConfig;
  frozen: ManagedWorkListFrozen;
  item: ManagedWorkListFrozenItem;
  result: ManagedWorkListItemResult;
}): Promise<string> {
  if (!options.result.accepted_attempt_path) {
    throw new RuntimeFailureError(
      "context_contract_failure",
      `Cannot preserve completed work-list item ${options.item.id} without an accepted attempt path.`
    );
  }

  const decision: ManagedWorkListReuseDecision = {
    item_id: options.item.id,
    decision: "reuse_prior_completed_item",
    accepted_attempt_path: options.result.accepted_attempt_path,
    contract_hash: sha256({
      parent_intent: options.config.parent_intent,
      item_guidance: options.config.item_guidance,
      item_worker: options.config.item_worker
    }),
    frozen_list_hash: sha256(options.frozen),
    frozen_item_hash: sha256(options.item),
    criterion_thresholds_hash: sha256(options.config.item_worker.kind === "deep_work"
      ? options.config.item_worker.completion
      : { kind: "agent" }),
    support_tool_contract_hash: sha256({
      model: options.node.effective_policy.model,
      reasoning_effort: options.node.effective_policy.reasoning_effort,
      sandbox: options.node.effective_policy.sandbox,
      harness: options.node.effective_policy.harness,
      skills: options.node.skills,
      cli: options.node.cli,
      tools: options.node.tools
    }),
    validation_refs: [
      ...(options.result.item_validation_path ? [options.result.item_validation_path] : []),
      ...(options.result.scorecard_path ? [options.result.scorecard_path] : []),
      ...options.result.validation.passed,
      ...options.result.validation.failed_then_fixed,
      ...options.result.validation.unavailable
    ],
    accepted_prior_attempt_state: "passed",
    reason: "The frozen item contract, worker contract, validation evidence, and accepted prior attempt are still trusted for this run attempt.",
    created_at: new Date().toISOString()
  };
  const decisionPath = join(options.parentExecutionDir, "managed-items", options.item.id, "reuse-decision.json");
  await mkdir(dirname(decisionPath), { recursive: true });
  await writeFile(decisionPath, `${JSON.stringify(decision, null, 2)}\n`, "utf8");
  return decisionPath;
}

function buildManagedItemAttempt(options: {
  context: RuntimeNodeExecutorContext<CompiledAgentNode>;
  itemNode: CompiledAgentNode;
  executionDir: string;
  executionId: string;
  cycle: number;
  managedPhase?: string;
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
      managed_phase: options.managedPhase ?? "work_list_item"
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

function managedItemContextRows(context: ContextItem[], workspacePath: string): Array<{
  name: string;
  kind: string;
  pointer: string;
  what: string;
  why: string;
}> {
  return context.map((item) => {
    if ("from" in item) {
      const pointer = item.from === "workspace_file" || item.from === "workspace_glob"
        ? resolveSubpathWithinRoot(workspacePath, item.path, `context ${item.name}`)
        : item.path;
      return {
        name: item.name,
        kind: item.from,
        pointer,
        what: item.what,
        why: item.why
      };
    }

    return {
      name: item.name,
      kind: "artifact_ref",
      pointer: item.ref,
      what: item.what,
      why: item.why
    };
  });
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
  extraRows?: Array<{
    name: string;
    kind: string;
    pointer: string;
    what: string;
    why: string;
  }>;
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
      : []),
    ...managedItemContextRows(options.itemNode.context, options.parentContext.workspace_path),
    ...(options.extraRows ?? [])
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

function phaseContractLines(
  worker: Extract<ManagedWorkListRuntimeConfig["item_worker"], { kind: "deep_work" }>,
  phase: PatternDeepWorkPhaseName
): string[] {
  const intent = worker.phases?.[phase]?.intent;
  if (!intent) {
    return [];
  }
  const lines = [
    "",
    "Phase contract:",
    "This phase contract is additive. It does not replace or weaken the parent work-list contract, current frozen item contract, completion criteria, threshold, or constraints."
  ];
  if (intent.goal) {
    lines.push(`Additional phase objective: ${intent.goal}`);
  }
  if (intent.acceptance_criteria && intent.acceptance_criteria.length > 0) {
    lines.push("Additional phase acceptance criteria:");
    lines.push(...intent.acceptance_criteria.map((entry) => `- ${entry}`));
  }
  if (intent.constraints && intent.constraints.length > 0) {
    lines.push("Additional phase constraints:");
    lines.push(...intent.constraints.map((entry) => `- ${entry}`));
  }
  return lines;
}

function buildManagedWorkListItemPlanGoal(options: {
  item: ManagedWorkListFrozenItem;
  config: ManagedWorkListRuntimeConfig;
  worker: Extract<ManagedWorkListRuntimeConfig["item_worker"], { kind: "deep_work" }>;
  cycle: number;
  maxCycles: number;
}): string {
  return [
    `Plan frozen work-list item \`${options.item.id}\`: ${options.item.title}.`,
    "",
    "You are planning one cycle for a managed work-list item. Do not edit source files in this phase.",
    `Parent work-list goal: ${options.config.parent_intent.goal}`,
    `Current item goal: ${options.item.goal}`,
    `Current item rationale: ${options.item.rationale}`,
    `Cycle: ${options.cycle} of ${options.maxCycles}`,
    "",
    "Map the current item contract to evidence, planned material delta, validation strategy, risks, and likely files or areas to inspect.",
    "If prior scorecard feedback is present, plan directly against that feedback.",
    "Keep the plan narrow to the current item. Do not plan later frozen items.",
    ...phaseContractLines(options.worker, "plan"),
    "",
    "Output contract:",
    "Publish only the `item_cycle_plan` artifact.",
    "Include sections: Objective, Relevant evidence, Planned material delta, Criterion evidence map, Validation plan, and Risks or constraints."
  ].join("\n");
}

function buildManagedWorkListItemExecuteGoal(options: {
  item: ManagedWorkListFrozenItem;
  config: ManagedWorkListRuntimeConfig;
  worker: Extract<ManagedWorkListRuntimeConfig["item_worker"], { kind: "deep_work" }>;
  cycle: number;
  maxCycles: number;
}): string {
  return [
    `Execute frozen work-list item \`${options.item.id}\`: ${options.item.title}.`,
    "",
    "You are executing one planned cycle for a managed work-list item. Follow the item cycle plan in context.",
    "If evidence shows the plan is wrong, make the smallest justified deviation and record why in work notes.",
    `Parent work-list goal: ${options.config.parent_intent.goal}`,
    `Current item goal: ${options.item.goal}`,
    `Cycle: ${options.cycle} of ${options.maxCycles}`,
    "",
    "Produce draft item evidence for grading. Do not publish final item artifacts in this phase.",
    ...phaseContractLines(options.worker, "execute"),
    "",
    "Output contract:",
    "Publish `item_work_notes`, `draft_item_handoff`, `draft_item_result`, and `draft_item_validation`.",
    "The draft item result JSON uses the same shape as the final item result and must use the current frozen item id."
  ].join("\n");
}

function buildManagedWorkListItemPublishGoal(options: {
  item: ManagedWorkListFrozenItem;
  config: ManagedWorkListRuntimeConfig;
  worker: Extract<ManagedWorkListRuntimeConfig["item_worker"], { kind: "deep_work" }>;
  cycle: number;
  maxCycles: number;
}): string {
  return [
    `Publish frozen work-list item \`${options.item.id}\`: ${options.item.title}.`,
    "",
    "You are publishing final item artifacts from the latest passing item scorecard.",
    "Use the cycle plan, draft item artifacts, scorecard, and validation evidence in context.",
    "Do not claim success beyond the accepted item evidence.",
    `Parent work-list goal: ${options.config.parent_intent.goal}`,
    `Current item goal: ${options.item.goal}`,
    `Cycle: ${options.cycle} of ${options.maxCycles}`,
    ...phaseContractLines(options.worker, "publish"),
    "",
    "Output contract:",
    "Publish exactly these final declared item artifacts:",
    "- `item_handoff`: Markdown with item goal, final results, evidence, validation, risks, and downstream implications.",
    "- `item_result`: JSON with id, status completed, summary, validation, risks, and downstream_implications.",
    "- `item_validation`: Markdown with exact validation evidence and any unavailable validation."
  ].join("\n");
}

function buildManagedWorkListItemVerifyGoal(options: {
  item: ManagedWorkListFrozenItem;
  config: ManagedWorkListRuntimeConfig;
  worker: Extract<ManagedWorkListRuntimeConfig["item_worker"], { kind: "deep_work" }>;
  cycle: number;
  maxCycles: number;
}): string {
  return [
    `Verify frozen work-list item \`${options.item.id}\`: ${options.item.title}.`,
    "",
    "You are evaluating draft evidence for one managed work-list item cycle.",
    "Grade only the current item evidence, draft artifacts, validation evidence, and relevant ledger/prior-item pointers.",
    `Parent work-list goal: ${options.config.parent_intent.goal}`,
    `Current item goal: ${options.item.goal}`,
    `Cycle: ${options.cycle} of ${options.maxCycles}`,
    ...phaseContractLines(options.worker, "verify")
  ].join("\n");
}

function applyPhaseTemplate(
  node: CompiledAgentNode,
  worker: Extract<ManagedWorkListRuntimeConfig["item_worker"], { kind: "deep_work" }>,
  phase: PatternDeepWorkPhaseName
): CompiledAgentNode {
  const template = worker.phase_templates?.[phase];
  const override = worker.phases?.[phase];
  return {
    ...node,
    effective_policy: template?.effective_policy ?? {
      ...node.effective_policy,
      ...(override?.model ? { model: override.model } : {}),
      ...(override?.reasoning_effort ? { reasoning_effort: override.reasoning_effort } : {}),
      ...(override?.sandbox ? { sandbox: override.sandbox } : {}),
      ...(override?.runtime?.profile ? { profile_name: override.runtime.profile } : {})
    },
    context: template?.context ?? node.context,
    skills: template?.skills ?? node.skills,
    cli: template?.cli ?? node.cli,
    tools: phase === "verify" ? [] : template?.tools ?? node.tools
  };
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
    context: options.parentNode.context,
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

function buildManagedWorkListItemPhaseNode(options: {
  parentNode: CompiledAgentNode;
  item: ManagedWorkListFrozenItem;
  config: ManagedWorkListRuntimeConfig;
  worker: Extract<ManagedWorkListRuntimeConfig["item_worker"], { kind: "deep_work" }>;
  phase: PatternDeepWorkPhaseName;
  cycle: number;
  maxCycles: number;
}): CompiledAgentNode {
  const baseNode = buildManagedWorkListItemNode(options);
  const phaseGoal = options.phase === "plan"
    ? buildManagedWorkListItemPlanGoal(options)
    : options.phase === "execute"
      ? buildManagedWorkListItemExecuteGoal(options)
      : options.phase === "verify"
        ? buildManagedWorkListItemVerifyGoal(options)
      : options.phase === "publish"
        ? buildManagedWorkListItemPublishGoal(options)
        : baseNode.intent.goal;
  const artifacts = options.phase === "plan"
    ? itemPlanArtifactDefinitions()
    : options.phase === "execute"
      ? itemDraftArtifactDefinitions()
      : options.phase === "publish"
        ? itemArtifactDefinitions()
        : {};

  return applyPhaseTemplate({
    ...baseNode,
    compiled_id: `${baseNode.compiled_id}__${options.phase}`,
    authored_id: `${baseNode.authored_id}__${options.phase}`,
    label: `Work List Item ${options.item.id} ${options.phase}`,
    intent: {
      goal: phaseGoal,
      acceptance_criteria: [
        ...options.item.acceptance_criteria,
        `The ${options.phase} phase stays scoped to frozen item ${options.item.id}.`
      ],
      constraints: [
        ...baseNode.intent.constraints,
        ...(options.worker.phases?.[options.phase]?.intent?.constraints ?? [])
      ]
    },
    declared_artifacts: artifacts,
    managed_runtime: {
      kind: "pattern_work_list",
      root_id: options.parentNode.managed_runtime?.root_id ?? options.parentNode.authored_id,
      phase: `item_${options.phase}`,
      config: {
        item_id: options.item.id,
        cycle: options.cycle
      }
    }
  }, options.worker, options.phase);
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

async function readManagedDraftItemArtifacts(outputDir: string, item: ManagedWorkListFrozenItem): Promise<{
  handoffPath: string;
  resultPath: string;
  validationPath: string;
  workNotesPath: string;
  result: ManagedWorkListItemResult;
}> {
  const handoffPath = join(outputDir, "draft-item-handoff.md");
  const resultPath = join(outputDir, "draft-item-result.json");
  const validationPath = join(outputDir, "draft-item-validation.md");
  const workNotesPath = join(outputDir, "item-work-notes.md");
  try {
    await access(handoffPath);
    await access(resultPath);
    await access(validationPath);
    await access(workNotesPath);
  } catch {
    throw new RuntimeFailureError(
      "artifact_contract_failure",
      `Managed work-list item ${item.id} execution phase did not publish item_work_notes, draft_item_handoff, draft_item_result, and draft_item_validation.`
    );
  }

  const result = await readJsonFile<ManagedWorkListItemResult>("draft item result", resultPath);
  if (result.id !== item.id) {
    throw new RuntimeFailureError("artifact_contract_failure", `Draft item result id "${result.id}" does not match frozen item "${item.id}".`);
  }
  if (result.status !== "completed") {
    throw new RuntimeFailureError("artifact_contract_failure", `Draft item ${item.id} result status is "${result.status}", not completed.`);
  }
  const validation = normalizeManagedWorkListItemValidation(result.validation);
  if (!validation) {
    throw new RuntimeFailureError("artifact_contract_failure", `Draft item ${item.id} result is missing validation evidence.`);
  }

  return {
    handoffPath,
    resultPath,
    validationPath,
    workNotesPath,
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
  if (!await reusableScorecardPath(result.scorecard_path)) {
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
  artifactsRoot?: string;
}): Promise<HarnessResult> {
  const harnessName = options.itemNode.effective_policy.harness!;
  const harness = options.harnesses[harnessName]!;
  const outputDir = options.artifactsRoot ?? resolveExecutionArtifactsDirectory(options.executionDir);
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
  runtimeManagedReady?: boolean;
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
  const finalPacket: CompletionPacket = options.runtimeManagedReady &&
    packet.missing_artifacts.length === 0 &&
    packet.artifact_findings.length === 0
    ? {
        ...packet,
        completion_status: "ready_for_verification",
        ready_for_verification: true,
        blocking_reasons: []
      }
    : packet;
  await persistCompletionPacket(finalPacket);
  return finalPacket;
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
  maxCycles: number;
  maxConcurrency?: number;
  emitManagedProgress?: RuntimeNodeExecutorContext<CompiledAgentNode>["emit_managed_progress"];
}): Promise<{ passed: boolean; scorecardPath: string; scorecard: Record<string, unknown> }> {
  const criteriaDir = join(options.itemExecutionDir, "criteria");
  await mkdir(criteriaDir, { recursive: true });
  type CriterionResult = ManagedWorkListScorecardCriterion & {
    kind: string;
    weight: number;
    weighted_score: number;
    issues: unknown[];
    evaluator_passed?: boolean;
    evidence_path?: string;
  };

  const criterionResults = await mapWithConcurrency(options.config.criteria, options.maxConcurrency ?? options.config.criteria.length, async (criterion, index): Promise<CriterionResult> => {
    const criterionDir = join(criteriaDir, `${String(index + 1).padStart(2, "0")}-${criterion.id}`);
    await mkdir(criterionDir, { recursive: true });
    await options.emitManagedProgress?.({
      phase: "item_criterion",
      status: "criterion_started",
      item_id: options.item.id,
      criterion_id: criterion.id,
      attempt: options.cycle,
      max_attempts: options.maxCycles,
      summary: criterion.kind === "command" ? criterion.command ?? criterion.id : criterion.rubric ?? criterion.id
    });

    try {
      let criterionResult: CriterionResult;
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
        criterionResult = {
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
      } else {
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
            options.itemNode.intent.goal,
            "",
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
        criterionResult = {
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
      }

      const gatedCriterionResult = normalizeCriterionForGate(
        criterionResult,
        options.config.pass_threshold
      ) as CriterionResult;
      const issues = [...gatedCriterionResult.issues];
      if (gatedCriterionResult.passed === false && criterionResult.passed === true) {
        issues.push(gatedCriterionResult.summary);
      }
      const finalCriterionResult: CriterionResult = {
        ...gatedCriterionResult,
        issues
      };

      await options.emitManagedProgress?.({
        phase: "item_criterion",
        status: finalCriterionResult.passed ? "criterion_completed" : "criterion_failed",
        item_id: options.item.id,
        criterion_id: criterion.id,
        attempt: options.cycle,
        max_attempts: options.maxCycles,
        summary: finalCriterionResult.summary
      });
      return finalCriterionResult;
    } catch (error) {
      await options.emitManagedProgress?.({
        phase: "item_criterion",
        status: "criterion_failed",
        item_id: options.item.id,
        criterion_id: criterion.id,
        attempt: options.cycle,
        max_attempts: options.maxCycles,
        summary: managedWorkListErrorMessage(error)
      });
      throw error;
    }
  });

  const blockers = criterionResults
    .flatMap((result) => {
      const blocker = requiredCriterionGateBlocker(result, options.config.pass_threshold);
      return blocker ? [blocker] : [];
    });
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
      .filter((result) => !result.passed || result.score < options.config.pass_threshold)
      .map((result) => ({ criterion_id: result.id, guidance: result.summary })),
    generated_at: new Date().toISOString()
  };
  const scorecardPath = join(options.itemExecutionDir, "artifacts", "scorecard.json");
  await mkdir(dirname(scorecardPath), { recursive: true });
  await writeFile(scorecardPath, `${JSON.stringify(scorecard, null, 2)}\n`, "utf8");
  return { passed, scorecardPath, scorecard };
}

function contextRow(name: string, kind: string, pointer: string, what: string, why: string): {
  name: string;
  kind: string;
  pointer: string;
  what: string;
  why: string;
} {
  return { name, kind, pointer, what, why };
}

async function runManagedWorkListDeepWorkItemCycle(options: {
  context: RuntimeNodeExecutorContext<CompiledAgentNode>;
  harnesses: Partial<Record<HarnessName, HarnessAdapter>>;
  config: ManagedWorkListRuntimeConfig;
  worker: Extract<ManagedWorkListRuntimeConfig["item_worker"], { kind: "deep_work" }>;
  item: ManagedWorkListFrozenItem;
  itemNode: CompiledAgentNode;
  itemAttempt: RuntimeNodeAttempt;
  itemExecutionDir: string;
  itemExecutionId: string;
  frozenPath: string;
  runtimeLedgerPath: string;
  priorHandoffsPath?: string;
  lastScorecardPath?: string;
  cycle: number;
  maxCycles: number;
  maxConcurrency?: number;
}): Promise<{
  completedItemAttempt?: RuntimeNodeAttempt;
  itemArtifacts?: Awaited<ReturnType<typeof readManagedItemArtifacts>>;
  scorecardPath?: string;
  cycles?: unknown[];
  lastFailure?: string;
}> {
  const runPhase = async (
    phase: PatternDeepWorkPhaseName,
    phaseNode: CompiledAgentNode,
    extraRows: Array<ReturnType<typeof contextRow>>,
    artifactsRoot?: string
  ): Promise<{ result: HarnessResult; attempt: RuntimeNodeAttempt; phaseDir: string; contextManifest: string; contextPacketPath: string; contextManifestPath: string }> => {
    const phaseDir = managedItemPhaseExecutionDir(options.itemExecutionDir, phase);
    const phaseExecutionId = managedItemPhaseExecutionId(options.context.attempt, options.item.id, options.cycle, phase);
    const phaseAttempt = buildManagedItemAttempt({
      context: options.context,
      itemNode: phaseNode,
      executionDir: phaseDir,
      executionId: phaseExecutionId,
      cycle: options.cycle,
      managedPhase: `work_list_item_${phase}`
    });
    await writeManagedItemAttemptStart(phaseAttempt);
    const phaseContext = await writeManagedItemContext({
      parentContext: options.context,
      itemNode: phaseNode,
      executionDir: phaseDir,
      executionId: phaseExecutionId,
      item: options.item,
      frozenPath: options.frozenPath,
      ledgerPath: options.runtimeLedgerPath,
      ...(options.priorHandoffsPath ? { priorHandoffsPath: options.priorHandoffsPath } : {}),
      ...(options.lastScorecardPath ? { priorScorecardPath: options.lastScorecardPath } : {}),
      extraRows
    });
    const contextManifest = await readContextManifestContent(phaseContext.manifestPath);
    const result = await runManagedWorkListItemAgent({
      context: options.context,
      harnesses: options.harnesses,
      itemNode: phaseNode,
      executionDir: phaseDir,
      executionId: phaseExecutionId,
      contextPacketPath: phaseContext.packetPath,
      contextManifestPath: phaseContext.manifestPath,
      contextManifest,
      ...(artifactsRoot ? { artifactsRoot } : {})
    });
    await writeFile(join(phaseDir, "agent", "response.md"), result.transcript?.last_message ?? result.stdout ?? "", "utf8");
    const completedPhaseAttempt = await writeManagedItemAttemptResult({
      attempt: phaseAttempt,
      result
    });
    return {
      result,
      attempt: completedPhaseAttempt,
      phaseDir,
      contextManifest,
      contextPacketPath: phaseContext.packetPath,
      contextManifestPath: phaseContext.manifestPath
    };
  };

  const planNode = buildManagedWorkListItemPhaseNode({
    parentNode: options.context.node,
    item: options.item,
    config: options.config,
    worker: options.worker,
    phase: "plan",
    cycle: options.cycle,
    maxCycles: options.maxCycles
  });
  const planRun = await runPhase("plan", planNode, []);
  if (planRun.result.status !== "passed") {
    return { lastFailure: planRun.result.stderr ?? planRun.result.stdout ?? `Item ${options.item.id} plan phase failed.` };
  }
  const planPath = join(resolveExecutionArtifactsDirectory(planRun.phaseDir), "item-cycle-plan.md");
  try {
    await access(planPath);
  } catch {
    return { lastFailure: `Item ${options.item.id} plan phase did not publish item_cycle_plan.` };
  }

  const executeNode = buildManagedWorkListItemPhaseNode({
    parentNode: options.context.node,
    item: options.item,
    config: options.config,
    worker: options.worker,
    phase: "execute",
    cycle: options.cycle,
    maxCycles: options.maxCycles
  });
  const executeRun = await runPhase("execute", executeNode, [
    contextRow("item_cycle_plan", "artifact", planPath, "Focused plan for this work-list item cycle.", "The execution phase should follow or explicitly justify deviations from this plan.")
  ]);
  if (executeRun.result.status !== "passed") {
    return { lastFailure: executeRun.result.stderr ?? executeRun.result.stdout ?? `Item ${options.item.id} execute phase failed.` };
  }

  let draftArtifacts: Awaited<ReturnType<typeof readManagedDraftItemArtifacts>>;
  try {
    draftArtifacts = await readManagedDraftItemArtifacts(resolveExecutionArtifactsDirectory(executeRun.phaseDir), options.item);
  } catch (error) {
    return { lastFailure: managedWorkListErrorMessage(error) };
  }

  const verifyNode = buildManagedWorkListItemPhaseNode({
    parentNode: options.context.node,
    item: options.item,
    config: options.config,
    worker: options.worker,
    phase: "verify",
    cycle: options.cycle,
    maxCycles: options.maxCycles
  });
  const verifyDir = managedItemPhaseExecutionDir(options.itemExecutionDir, "verify");
  const verifyExecutionId = managedItemPhaseExecutionId(options.context.attempt, options.item.id, options.cycle, "verify");
  const verifyContext = await writeManagedItemContext({
    parentContext: options.context,
    itemNode: verifyNode,
    executionDir: verifyDir,
    executionId: verifyExecutionId,
    item: options.item,
    frozenPath: options.frozenPath,
    ledgerPath: options.runtimeLedgerPath,
    ...(options.priorHandoffsPath ? { priorHandoffsPath: options.priorHandoffsPath } : {}),
    ...(options.lastScorecardPath ? { priorScorecardPath: options.lastScorecardPath } : {}),
    extraRows: [
      contextRow("item_cycle_plan", "artifact", planPath, "Focused plan for this work-list item cycle.", "The verifier uses this to judge planned vs actual item evidence."),
      contextRow("item_work_notes", "artifact", draftArtifacts.workNotesPath, "Execution notes for this item cycle.", "The verifier uses this to inspect validation and deviations."),
      contextRow("draft_item_handoff", "artifact", draftArtifacts.handoffPath, "Draft item handoff.", "The verifier grades this draft before final publication."),
      contextRow("draft_item_result", "artifact", draftArtifacts.resultPath, "Draft structured item result.", "The verifier grades this draft before final publication."),
      contextRow("draft_item_validation", "artifact", draftArtifacts.validationPath, "Draft validation evidence.", "The verifier grades this draft before final publication.")
    ]
  });
  const verifyManifest = await readContextManifestContent(verifyContext.manifestPath);
  const scorecard = await evaluateManagedWorkListItemCriteria({
    context: options.context,
    config: options.worker.completion,
    item: options.item,
    itemNode: verifyNode,
    itemExecutionDir: options.itemExecutionDir,
    itemArtifacts: draftArtifacts,
    ledgerPath: options.runtimeLedgerPath,
    contextPacketPath: verifyContext.packetPath,
    contextManifestPath: verifyContext.manifestPath,
    contextManifest: verifyManifest,
    harnesses: options.harnesses,
    cycle: options.cycle,
    maxCycles: options.maxCycles,
    emitManagedProgress: options.context.emit_managed_progress,
    ...(options.maxConcurrency !== undefined ? { maxConcurrency: options.maxConcurrency } : {})
  });
  const cycles = [{ cycle: options.cycle, scorecard_path: scorecard.scorecardPath, passed: scorecard.passed }];
  if (!scorecard.passed) {
    return {
      scorecardPath: scorecard.scorecardPath,
      cycles,
      lastFailure: typeof scorecard.scorecard.summary === "string"
        ? scorecard.scorecard.summary
        : `Item ${options.item.id} criteria did not pass.`
    };
  }

  const publishNode = buildManagedWorkListItemPhaseNode({
    parentNode: options.context.node,
    item: options.item,
    config: options.config,
    worker: options.worker,
    phase: "publish",
    cycle: options.cycle,
    maxCycles: options.maxCycles
  });
  const parentArtifactsRoot = resolveExecutionArtifactsDirectory(options.itemExecutionDir);
  const publishRun = await runPhase("publish", publishNode, [
    contextRow("item_cycle_plan", "artifact", planPath, "Focused plan for this work-list item cycle.", "The publisher should preserve planned scope and justified deviations."),
    contextRow("item_scorecard", "artifact", scorecard.scorecardPath, "Passing item scorecard.", "The publisher must only finalize accepted evidence."),
    contextRow("item_work_notes", "artifact", draftArtifacts.workNotesPath, "Execution notes for this item cycle.", "The publisher uses these notes for final validation evidence."),
    contextRow("draft_item_handoff", "artifact", draftArtifacts.handoffPath, "Accepted draft item handoff.", "The publisher turns this into the final handoff."),
    contextRow("draft_item_result", "artifact", draftArtifacts.resultPath, "Accepted draft structured item result.", "The publisher turns this into the final item result."),
    contextRow("draft_item_validation", "artifact", draftArtifacts.validationPath, "Accepted draft validation evidence.", "The publisher turns this into final validation evidence.")
  ], parentArtifactsRoot);
  await mkdir(join(options.itemExecutionDir, "agent"), { recursive: true });
  await writeFile(join(options.itemExecutionDir, "agent", "response.md"), publishRun.result.transcript?.last_message ?? publishRun.result.stdout ?? "", "utf8");
  if (publishRun.result.status !== "passed") {
    return {
      scorecardPath: scorecard.scorecardPath,
      cycles,
      lastFailure: publishRun.result.stderr ?? publishRun.result.stdout ?? `Item ${options.item.id} publish phase failed.`
    };
  }

  let itemArtifacts: Awaited<ReturnType<typeof readManagedItemArtifacts>>;
  try {
    itemArtifacts = await readManagedItemArtifacts(parentArtifactsRoot, options.item);
  } catch (error) {
    return {
      scorecardPath: scorecard.scorecardPath,
      cycles,
      lastFailure: managedWorkListErrorMessage(error)
    };
  }

  const completedItemAttempt = await writeManagedItemAttemptResult({
    attempt: options.itemAttempt,
    result: publishRun.result,
    artifacts: {
      item_handoff: itemArtifacts.handoffPath,
      item_result: itemArtifacts.resultPath,
      item_validation: itemArtifacts.validationPath
    }
  });

  return {
    completedItemAttempt,
    itemArtifacts,
    scorecardPath: scorecard.scorecardPath,
    cycles
  };
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

  const frozenItemById = new Map(frozen.items.map((item) => [item.id, item]));
  for (const reused of acceptedResults) {
    const frozenItem = frozenItemById.get(reused.id);
    const reuseDecisionPath = frozenItem
      ? await writeManagedWorkListReuseDecision({
          parentExecutionDir: context.execution_dir,
          node: context.node,
          config,
          frozen,
          item: frozenItem,
          result: reused
        })
      : undefined;
    await context.emit_managed_progress?.({
      phase: "run_item",
      status: "item_completed",
      item_id: reused.id,
      summary: `Preserved completed item ${reused.id} from a prior attempt.${reuseDecisionPath ? ` Reuse decision: ${reuseDecisionPath}.` : ""}`
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
      let itemArtifacts: Awaited<ReturnType<typeof readManagedItemArtifacts>>;
      let completedItemAttempt: RuntimeNodeAttempt;
      let scorecardPath: string | undefined;
      let cycles: unknown[] | undefined;
      let verificationContextPacketPath: string;
      let verificationContextManifestPath: string;
      let verificationContextManifest: string;

      if (config.item_worker.kind === "deep_work") {
        const deepWorkResult = await runManagedWorkListDeepWorkItemCycle({
          context,
          harnesses,
          config,
          worker: config.item_worker,
          item,
          itemNode,
          itemAttempt,
          itemExecutionDir,
          itemExecutionId,
          frozenPath: frozenPath!,
          runtimeLedgerPath,
          ...(priorHandoffsPath ? { priorHandoffsPath } : {}),
          ...(lastScorecardPath ? { lastScorecardPath } : {}),
          cycle,
          maxCycles,
          ...(config.criteria_concurrency !== undefined ? { maxConcurrency: config.criteria_concurrency } : {})
        });

        if (!deepWorkResult.completedItemAttempt || !deepWorkResult.itemArtifacts) {
          lastFailure = deepWorkResult.lastFailure ?? `Item ${item.id} deep-work cycle failed.`;
          if (deepWorkResult.scorecardPath) {
            lastScorecardPath = deepWorkResult.scorecardPath;
          }
          await writeManagedItemAttemptResult({
            attempt: itemAttempt,
            result: {
              status: "failed",
              exitCode: 1,
              stderr: lastFailure,
              transcript: { last_message: lastFailure }
            }
          });
          continue;
        }

        completedItemAttempt = deepWorkResult.completedItemAttempt;
        itemArtifacts = deepWorkResult.itemArtifacts;
        scorecardPath = deepWorkResult.scorecardPath;
        lastScorecardPath = deepWorkResult.scorecardPath;
        cycles = deepWorkResult.cycles;

        const verificationContext = await writeManagedItemContext({
          parentContext: context,
          itemNode,
          executionDir: itemExecutionDir,
          executionId: itemExecutionId,
          item,
          frozenPath: frozenPath!,
          ledgerPath: runtimeLedgerPath,
          ...(priorHandoffsPath ? { priorHandoffsPath } : {}),
          ...(lastScorecardPath ? { priorScorecardPath: lastScorecardPath } : {}),
          extraRows: [
            ...(scorecardPath
              ? [contextRow("item_scorecard", "artifact", scorecardPath, "Passing item scorecard.", "The outcome verifier checks final item claims against this accepted scorecard.")]
              : []),
            contextRow("item_handoff", "artifact", itemArtifacts.handoffPath, "Final item handoff.", "The outcome verifier checks this final item artifact."),
            contextRow("item_result", "artifact", itemArtifacts.resultPath, "Final structured item result.", "The outcome verifier checks this final item artifact."),
            contextRow("item_validation", "artifact", itemArtifacts.validationPath, "Final item validation evidence.", "The outcome verifier checks this final item artifact.")
          ]
        });
        verificationContextPacketPath = verificationContext.packetPath;
        verificationContextManifestPath = verificationContext.manifestPath;
        verificationContextManifest = await readContextManifestContent(verificationContext.manifestPath);
      } else {
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
        completedItemAttempt = await writeManagedItemAttemptResult({
          attempt: itemAttempt,
          result: harnessResult
        });

        if (harnessResult.status !== "passed") {
          lastFailure = harnessResult.stderr ?? harnessResult.stdout ?? `Item ${item.id} harness failed.`;
          continue;
        }

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
        verificationContextPacketPath = itemContext.packetPath;
        verificationContextManifestPath = itemContext.manifestPath;
        verificationContextManifest = contextManifest;
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
        itemAttempt: completedItemAttempt,
        runtimeManagedReady: config.item_worker.kind === "deep_work"
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
        contextPacketPath: verificationContextPacketPath,
        contextManifestPath: verificationContextManifestPath,
        contextManifest: verificationContextManifest
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

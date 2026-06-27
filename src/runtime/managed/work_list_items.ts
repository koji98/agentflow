import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ArtifactDefinition, ContextItem } from "../../graph/authored.js";
import type { CompiledAgentNode, CompiledGraph, ResolvedSkill, ResolvedTool } from "../../graph/compiled.js";
import type { EffectiveNodePolicy } from "../../graph/profiles.js";
import type { HarnessName } from "../../graph/schema.js";
import { managedPromptContract } from "../../managed/foundation.js";
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
import { renderContextManifest } from "../context/manifest.js";
import type { ContextPacket, ContextPacketMaterializedItem, ContextPriorityBucket } from "../context/packet.js";
import { RuntimeFailureError } from "../failure.js";
import {
  ManagedContractFailureError,
  managedContractFailureSummary,
  writeManagedContractFailurePacket,
  type ManagedContractFinding
} from "./contract_failures.js";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function managedWorkListErrorMessage(error: unknown): string {
  if (error instanceof ManagedContractFailureError) {
    return managedContractFailureSummary(error.findings);
  }
  return error instanceof Error ? error.message : String(error);
}

function workListContractFinding(options: {
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
    managed_kind: "pattern_work_list",
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
  item: ManagedWorkListFrozenItem;
  artifactName: string;
  artifactPath: string;
  fileName: string;
}): Promise<ManagedContractFinding | undefined> {
  try {
    await access(options.artifactPath);
    return undefined;
  } catch {
    return workListContractFinding({
      phase: options.phase,
      itemId: options.item.id,
      artifactName: options.artifactName,
      artifactPath: options.artifactPath,
      failureKind: "missing_artifact",
      message: `${options.fileName} was not published for work-list item ${options.item.id}.`,
      expected: `${options.fileName} must be present before the managed item can be accepted.`,
      requiredNextAction: `Publish ${options.fileName} for item ${options.item.id}.`
    });
  }
}

async function readManagedJsonArtifact(options: {
  phase: string;
  item: ManagedWorkListFrozenItem;
  artifactName: string;
  artifactPath: string;
  fileName: string;
}): Promise<unknown> {
  try {
    return JSON.parse(await readFile(options.artifactPath, "utf8")) as unknown;
  } catch (error) {
    throw new ManagedContractFailureError(workListContractFinding({
      phase: options.phase,
      itemId: options.item.id,
      artifactName: options.artifactName,
      artifactPath: options.artifactPath,
      failureKind: error instanceof SyntaxError ? "invalid_json" : "unreadable_artifact",
      message: `${options.fileName} for work-list item ${options.item.id} could not be parsed: ${error instanceof Error ? error.message : String(error)}.`,
      expected: `${options.fileName} must be valid JSON using the managed work-list item result contract.`,
      requiredNextAction: `Repair ${options.fileName} for item ${options.item.id} so it is valid JSON with id, completed status, summary, validation, risks, and downstream_implications.`
    }));
  }
}

function validateManagedItemValidationContract(options: {
  phase: string;
  item: ManagedWorkListFrozenItem;
  artifactName: string;
  artifactPath: string;
  fileName: string;
  value: unknown;
  findings: ManagedContractFinding[];
}): ManagedWorkListItemValidation | undefined {
  if (!isRecord(options.value)) {
    options.findings.push(workListContractFinding({
      phase: options.phase,
      itemId: options.item.id,
      artifactName: options.artifactName,
      artifactPath: options.artifactPath,
      failureKind: "schema_mismatch",
      message: `${options.fileName} validation must be an object with passed, failed_then_fixed, unavailable, and blocked arrays.`,
      expected: "Completed item validation includes structured arrays for passed, failed_then_fixed, unavailable, and blocked evidence.",
      requiredNextAction: `Rewrite the validation object in ${options.fileName} for item ${options.item.id}.`
    }));
    return undefined;
  }

  const validation = {
    passed: stringArray(options.value.passed),
    failed_then_fixed: stringArray(options.value.failed_then_fixed),
    unavailable: stringArray(options.value.unavailable),
    blocked: stringArray(options.value.blocked)
  };

  for (const key of ["passed", "failed_then_fixed", "unavailable", "blocked"] as const) {
    if (!Array.isArray(options.value[key])) {
      options.findings.push(workListContractFinding({
        phase: options.phase,
        itemId: options.item.id,
        artifactName: options.artifactName,
        artifactPath: options.artifactPath,
        failureKind: "schema_mismatch",
        message: `${options.fileName} validation.${key} must be an array.`,
        expected: "Every validation channel is represented as an array of evidence strings.",
        requiredNextAction: `Set validation.${key} to an array in ${options.fileName} for item ${options.item.id}.`
      }));
    }
  }

  if (
    validation.passed.length === 0 &&
    validation.failed_then_fixed.length === 0 &&
    validation.unavailable.length === 0
  ) {
    options.findings.push(workListContractFinding({
      phase: options.phase,
      itemId: options.item.id,
      artifactName: options.artifactName,
      artifactPath: options.artifactPath,
      failureKind: validation.blocked.length > 0 ? "contract_mismatch" : "schema_mismatch",
      message: validation.blocked.length > 0
        ? `${options.fileName} marks item ${options.item.id} completed but only provides blocked validation.`
        : `${options.fileName} is missing usable validation evidence for completed item ${options.item.id}.`,
      expected: "Completed item results include at least one passed, failed_then_fixed, or unavailable validation evidence entry.",
      requiredNextAction: `Update validation in ${options.fileName} for item ${options.item.id} with completed-work evidence or do not mark the item completed.`
    }));
    return undefined;
  }

  return validation;
}

function validateManagedWorkListItemResultContract(options: {
  phase: string;
  item: ManagedWorkListFrozenItem;
  artifactName: string;
  artifactPath: string;
  fileName: string;
  value: unknown;
}): ManagedWorkListItemResult {
  const findings: ManagedContractFinding[] = [];
  if (!isRecord(options.value)) {
    throw new ManagedContractFailureError(workListContractFinding({
      phase: options.phase,
      itemId: options.item.id,
      artifactName: options.artifactName,
      artifactPath: options.artifactPath,
      failureKind: "schema_mismatch",
      message: `${options.fileName} must be a JSON object for work-list item ${options.item.id}.`,
      expected: `${options.fileName} includes id, status completed, summary, validation, risks, and downstream_implications.`,
      requiredNextAction: `Rewrite ${options.fileName} as a managed item result JSON object for item ${options.item.id}.`
    }));
  }

  if (typeof options.value.item_id === "string") {
    findings.push(workListContractFinding({
      phase: options.phase,
      itemId: options.item.id,
      artifactName: options.artifactName,
      artifactPath: options.artifactPath,
      failureKind: "schema_mismatch",
      message: `${options.fileName} uses stale field item_id; managed item results must use id.`,
      expected: `The item result id field equals "${options.item.id}" and no item_id field is used.`,
      requiredNextAction: `Replace item_id with id in ${options.fileName} for item ${options.item.id}.`
    }));
  }

  if (options.value.id !== options.item.id) {
    findings.push(workListContractFinding({
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

  if (options.value.status !== "completed") {
    findings.push(workListContractFinding({
      phase: options.phase,
      itemId: options.item.id,
      artifactName: options.artifactName,
      artifactPath: options.artifactPath,
      failureKind: "contract_mismatch",
      message: `${options.fileName} status is "${typeof options.value.status === "string" ? options.value.status : String(options.value.status)}", not completed.`,
      expected: "Only completed managed item results can be accepted; blocked work must retry or fail the item.",
      requiredNextAction: `Complete item ${options.item.id} and publish ${options.fileName} with status "completed", or let the item fail with runtime evidence.`
    }));
  }

  if (typeof options.value.summary !== "string" || options.value.summary.trim().length === 0) {
    findings.push(workListContractFinding({
      phase: options.phase,
      itemId: options.item.id,
      artifactName: options.artifactName,
      artifactPath: options.artifactPath,
      failureKind: "schema_mismatch",
      message: `${options.fileName} is missing a non-empty summary for item ${options.item.id}.`,
      expected: "Completed managed item results include a concrete non-empty summary.",
      requiredNextAction: `Add a concrete summary to ${options.fileName} for item ${options.item.id}.`
    }));
  }

  const validation = validateManagedItemValidationContract({
    phase: options.phase,
    item: options.item,
    artifactName: options.artifactName,
    artifactPath: options.artifactPath,
    fileName: options.fileName,
    value: options.value.validation,
    findings
  });

  if (!Array.isArray(options.value.risks)) {
    findings.push(workListContractFinding({
      phase: options.phase,
      itemId: options.item.id,
      artifactName: options.artifactName,
      artifactPath: options.artifactPath,
      failureKind: "schema_mismatch",
      message: `${options.fileName} risks must be an array.`,
      expected: "Managed item results include risks as an array of strings; use an empty array when no active risks remain.",
      requiredNextAction: `Set risks to an array in ${options.fileName} for item ${options.item.id}.`
    }));
  }

  if (!Array.isArray(options.value.downstream_implications)) {
    findings.push(workListContractFinding({
      phase: options.phase,
      itemId: options.item.id,
      artifactName: options.artifactName,
      artifactPath: options.artifactPath,
      failureKind: "schema_mismatch",
      message: `${options.fileName} downstream_implications must be an array.`,
      expected: "Managed item results include downstream_implications as an array of strings; use an empty array when none apply.",
      requiredNextAction: `Set downstream_implications to an array in ${options.fileName} for item ${options.item.id}.`
    }));
  }

  if (findings.length > 0 || !validation) {
    throw new ManagedContractFailureError(findings);
  }

  return {
    id: options.value.id as string,
    status: options.value.status as string,
    summary: options.value.summary as string,
    validation,
    risks: stringArray(options.value.risks),
    downstream_implications: stringArray(options.value.downstream_implications)
  };
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
    item_result: {
      from: "output_dir",
      path: "item-result.json",
      description: "Structured result, validation evidence, risks, and downstream implications for this frozen work-list item."
    }
  };
}

function itemPlanArtifactDefinitions(): Record<string, ArtifactDefinition> {
  return {
    plan: {
      from: "output_dir",
      path: "plan.md",
      description: "Execution plan for satisfying this frozen work-list item from the current state."
    }
  };
}

function itemDraftArtifactDefinitions(): Record<string, ArtifactDefinition> {
  return {
    item_work_notes: {
      from: "output_dir",
      path: "item-work-notes.md",
      description: "Execution notes and validation evidence for the current work-list item result."
    },
    draft_item_result: {
      from: "output_dir",
      path: "draft-item-result.json",
      description: "Draft structured item result, validation evidence, risks, and downstream implications to be graded before final publication."
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

interface ManagedItemContextRow {
  name: string;
  kind: string;
  pointer: string;
  what: string;
  why: string;
  priorityBucket?: ContextPriorityBucket;
  priorityReason?: string;
  isBroadReference?: boolean;
  sourceAuthoredOrder?: number;
}

function managedItemContextRows(context: ContextItem[], workspacePath: string): ManagedItemContextRow[] {
  return context.map((item, index) => {
    if ("from" in item) {
      const pointer = item.from === "workspace_file" || item.from === "workspace_glob"
        ? resolveSubpathWithinRoot(workspacePath, item.path, `context ${item.name}`)
        : item.path;
      return {
        name: item.name,
        kind: item.from,
        pointer,
        what: item.what,
        why: item.why,
        priorityBucket: item.from === "workspace_glob" ? "reference_set" : "task_context",
        priorityReason: item.from === "workspace_glob"
          ? "Authored workspace glob context; use as a selective search/open index."
          : "Authored context for this work-list item.",
        isBroadReference: item.from === "workspace_glob",
        sourceAuthoredOrder: index
      };
    }

    return {
      name: item.name,
      kind: "artifact_ref",
      pointer: item.ref,
      what: item.what,
      why: item.why,
      priorityBucket: "task_context",
      priorityReason: "Authored artifact context for this work-list item.",
      sourceAuthoredOrder: index
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
  priorResultsPath?: string;
  priorScorecardPath?: string;
  managedContractFailurePath?: string;
  managedContractFailureSummary?: string;
  extraRows?: ManagedItemContextRow[];
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
      why: "The item worker must complete exactly this item.",
      priorityBucket: "current_work" as const,
      priorityReason: "Current frozen work-list item defines the immediate unit of work."
    },
    {
      name: "frozen_work_list",
      kind: "artifact",
      pointer: options.frozenPath,
      what: "Runtime-validated frozen work list.",
      why: "The item worker must not add, remove, split, merge, or reorder items.",
      priorityBucket: "progress_state" as const,
      priorityReason: "Frozen work-list state is continuation context, not the first repair instruction."
    },
    {
      name: "work_list_ledger",
      kind: "runtime_ledger",
      pointer: options.ledgerPath,
      what: "Current runtime-owned item ledger.",
      why: "The item worker can see prior accepted item status without manually checking off work.",
      priorityBucket: "progress_state" as const,
      priorityReason: "Work-list ledger records progress state for continuation."
    },
    ...(options.priorResultsPath
      ? [{
          name: "prior_completed_item_results",
          kind: "runtime_item_results",
          pointer: options.priorResultsPath,
          what: "Accepted structured results from earlier frozen items.",
          why: "Later items may build on earlier item evidence.",
          priorityBucket: "progress_state" as const,
          priorityReason: "Prior completed item results are progress state."
        }]
      : []),
    ...(options.priorScorecardPath
      ? [{
          name: "prior_item_scorecard",
          kind: "runtime_scorecard",
          pointer: options.priorScorecardPath,
          what: "Most recent failed scorecard for this item.",
          why: "The retry should address concrete item-level feedback.",
          priorityBucket: "read_first" as const,
          priorityReason: "Failed item scorecard is retry feedback to inspect before continuing."
        }]
      : []),
    ...(options.managedContractFailurePath
      ? [{
          name: "managed_contract_failure",
          kind: "runtime_contract_failure",
          pointer: options.managedContractFailurePath,
          what: options.managedContractFailureSummary
            ? `Structured runtime-owned managed contract failure from the previous item attempt: ${options.managedContractFailureSummary}`
            : "Structured runtime-owned managed contract failure from the previous item attempt.",
          why: "The retry should repair this exact managed artifact contract issue before continuing.",
          priorityBucket: "read_first" as const,
          priorityReason: options.managedContractFailureSummary
            ? `Managed contract failure is the immediate retry repair target: ${options.managedContractFailureSummary}`
            : "Managed contract failure is the immediate retry repair target."
        }]
      : []),
    ...managedItemContextRows(options.itemNode.context, options.parentContext.workspace_path),
    ...(options.extraRows ?? [])
  ];

  const packetPath = resolveExecutionRuntimeContextPath(options.executionDir);
  const manifestPath = resolveExecutionAgentContextPath(options.executionDir);
  const rankCounts = new Map<ContextPriorityBucket, number>();
  const materials: ContextPacketMaterializedItem[] = rows.map((row) => {
    const bucket = row.priorityBucket ?? "task_context";
    const rank = rankCounts.get(bucket) ?? 0;
    rankCounts.set(bucket, rank + 1);
    return {
      key: row.name,
      source: {
        name: row.name,
        from: row.kind,
        path: row.pointer,
        what: row.what,
        why: row.why
      } as unknown as ContextPacketMaterializedItem["source"],
      pointer_path: row.pointer,
      description: row.what,
      priority_bucket: bucket,
      priority_rank: rank,
      priority_reason: row.priorityReason ?? row.why,
      ...(row.isBroadReference !== undefined ? { is_broad_reference: row.isBroadReference } : {}),
      ...(row.sourceAuthoredOrder !== undefined ? { source_authored_order: row.sourceAuthoredOrder } : {})
    };
  });
  const packet: ContextPacket = {
    execution_id: options.executionId,
    compiled_id: options.itemNode.compiled_id,
    authored_id: options.itemNode.authored_id,
    repo_alias: options.itemNode.repo,
    workspace_path: options.parentContext.workspace_path,
    materials,
    omitted: [],
    totals: {
      pointer_count: rows.length,
      file_count: rows.length
    }
  };
  await mkdir(dirname(packetPath), { recursive: true });
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(packetPath, `${JSON.stringify(packet, null, 2)}\n`, "utf8");
  await writeFile(manifestPath, renderContextManifest(packet), "utf8");
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
    "## Item Output Contract",
    "Write exactly these declared item artifacts:",
    "- `item_result`: JSON object using the active item-result contract: field id set to the current frozen item id, completed status, concrete summary, validation object, risks, and downstream implications. The validation object has passed, failed_then_fixed, unavailable, and blocked keys; each value is an array of short evidence strings. Use failed_then_fixed, not fixed. Do not use field item_id.",
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
    "You are planning the work needed to satisfy this frozen item from the current state. Do not edit source files in this phase.",
    `Parent work-list goal: ${options.config.parent_intent.goal}`,
    `Current item goal: ${options.item.goal}`,
    `Current item rationale: ${options.item.rationale}`,
    "",
    "Map the current item contract to evidence, planned material change, validation strategy, risks, and likely files or areas to inspect.",
    "Use prior scorecard feedback as gap evidence; do not shrink the item task to only the last failed check.",
    "Keep the plan scoped to the current frozen item. Do not plan later frozen items or mutate the frozen list.",
    "Aim to complete this item in the next execution. If full item completion is not feasible now, plan the most complete useful slice and state the remaining gap explicitly.",
    ...phaseContractLines(options.worker, "plan"),
    "",
    "Output contract:",
    "Publish only the `plan` artifact.",
    "Write it to `plan.md` as the executor handoff for this frozen item, not as the final item result.",
    "Include sections: Task target, Current state, Gap, Execution plan, Validation plan, Expected material change, Remaining gap, and Risks or constraints.",
    "Preserve exact task-specific names, labels, commands, and required phrases from the parent work-list and current item contract in the plan.",
    "Do not create a milestone solely to restate the plan. If you do create a milestone, complete it before running `af complete check`."
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
    "You are responsible for satisfying this frozen item from the current state.",
    "Use `plan.md` as guidance, not as a limit.",
    "The parent work-list contract and current frozen item contract control when `plan.md` is incomplete, stale, too small, or contradicted by repository evidence.",
    "Satisfy the item contract, not only the visible tests; handle edge cases directly implied by the goal, acceptance criteria, and local code.",
    "Keep edits scoped; add/edit tests only when the item asks or repo contract expects them.",
    "If evidence shows the plan is wrong, make the task-justified adjustment needed to satisfy the item and record why in work notes.",
    `Parent work-list goal: ${options.config.parent_intent.goal}`,
    `Current item goal: ${options.item.goal}`,
    "",
    "Produce draft item evidence after doing the item work. Do not publish final item artifacts in this phase.",
    ...phaseContractLines(options.worker, "execute"),
    "",
    "Output contract:",
    "Publish `item_work_notes` and `draft_item_result`.",
    "`item_work_notes` should include what changed, why any deviations from `plan.md` were needed, validation evidence, remaining risks, and any remaining gap.",
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
    "Use `plan.md`, draft item artifacts, scorecard, and validation evidence in context.",
    "Do not claim success beyond the accepted item evidence.",
    `Parent work-list goal: ${options.config.parent_intent.goal}`,
    `Current item goal: ${options.item.goal}`,
    ...phaseContractLines(options.worker, "publish"),
    "",
    "Output contract:",
    "Publish exactly these final declared item artifacts:",
    "- `item_result`: JSON with id, status completed, summary, validation, risks, and downstream_implications."
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
    "You are evaluating draft evidence for the current frozen item result.",
    "Grade only the current item evidence, draft artifacts, validation evidence, and relevant ledger/prior-item pointers.",
    `Parent work-list goal: ${options.config.parent_intent.goal}`,
    `Current item goal: ${options.item.goal}`,
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
        "The item result JSON cites concrete evidence and downstream implications.",
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
  const phasePrompt = options.phase === "plan"
    ? buildManagedWorkListItemPlanGoal(options)
    : options.phase === "execute"
      ? buildManagedWorkListItemExecuteGoal(options)
      : options.phase === "verify"
        ? buildManagedWorkListItemVerifyGoal(options)
        : options.phase === "publish"
          ? buildManagedWorkListItemPublishGoal(options)
          : baseNode.intent.goal;
  const phaseGoal = options.phase === "plan"
    ? `Plan the work needed to satisfy frozen work-list item ${options.item.id} from the current state.`
    : options.phase === "execute"
      ? `Satisfy frozen work-list item ${options.item.id} from the current state using plan.md as guidance.`
      : options.phase === "verify"
        ? `Evaluate the current draft evidence for frozen work-list item ${options.item.id}.`
        : options.phase === "publish"
          ? `Publish the accepted final result for frozen work-list item ${options.item.id}.`
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
    managed_prompt: managedPromptContract(`item_${options.phase}`, phaseGoal, [
      {
        title: "Item Phase Instructions",
        lines: phasePrompt.split("\n")
      }
    ]),
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

async function readManagedItemArtifacts(outputDir: string, item: ManagedWorkListFrozenItem, phase = "item_publish"): Promise<{
  resultPath: string;
  result: ManagedWorkListItemResult;
}> {
  const resultPath = join(outputDir, "item-result.json");
  const missing = (await Promise.all([
    ensureManagedArtifactPresent({ phase, item, artifactName: "item_result", artifactPath: resultPath, fileName: "item-result.json" })
  ])).filter((finding): finding is ManagedContractFinding => Boolean(finding));
  if (missing.length > 0) {
    throw new ManagedContractFailureError(missing);
  }

  const result = validateManagedWorkListItemResultContract({
    phase,
    item,
    artifactName: "item_result",
    artifactPath: resultPath,
    fileName: "item-result.json",
    value: await readManagedJsonArtifact({ phase, item, artifactName: "item_result", artifactPath: resultPath, fileName: "item-result.json" })
  });

  return {
    resultPath,
    result
  };
}

async function readManagedDraftItemArtifacts(outputDir: string, item: ManagedWorkListFrozenItem): Promise<{
  resultPath: string;
  workNotesPath: string;
  result: ManagedWorkListItemResult;
}> {
  const resultPath = join(outputDir, "draft-item-result.json");
  const workNotesPath = join(outputDir, "item-work-notes.md");
  const phase = "item_execute";
  const missing = (await Promise.all([
    ensureManagedArtifactPresent({ phase, item, artifactName: "item_work_notes", artifactPath: workNotesPath, fileName: "item-work-notes.md" }),
    ensureManagedArtifactPresent({ phase, item, artifactName: "draft_item_result", artifactPath: resultPath, fileName: "draft-item-result.json" })
  ])).filter((finding): finding is ManagedContractFinding => Boolean(finding));
  if (missing.length > 0) {
    throw new ManagedContractFailureError(missing);
  }

  const result = validateManagedWorkListItemResultContract({
    phase,
    item,
    artifactName: "draft_item_result",
    artifactPath: resultPath,
    fileName: "draft-item-result.json",
    value: await readManagedJsonArtifact({ phase, item, artifactName: "draft_item_result", artifactPath: resultPath, fileName: "draft-item-result.json" })
  });

  return {
    resultPath,
    workNotesPath,
    result
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
} | undefined> {
  if (!isReusableManagedWorkListResult(result, frozenItem)) {
    return undefined;
  }
  if (!await reusableScorecardPath(result.scorecard_path)) {
    return undefined;
  }

  return { result };
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

  for (const frozenItem of options.frozen.items) {
    const reusable = await collectReusableManagedWorkListResult(previousById.get(frozenItem.id), frozenItem);
    if (!reusable) {
      break;
    }

    acceptedResults.push(reusable.result);
  }

  if (acceptedResults.length === 0) {
    return undefined;
  }

  return {
    accepted_results: acceptedResults
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
      accepted_attempt_path: ledgerItem.accepted_attempt_path
    }, frozenItem);
    if (!reusable) {
      break;
    }

    acceptedResults.push(reusable.result);
  }

  if (acceptedResults.length === 0) {
    return undefined;
  }

  return {
    accepted_results: acceptedResults
  };
}

async function loadPriorManagedWorkListProgress(options: {
  context: RuntimeNodeExecutorContext<CompiledAgentNode>;
  frozen: ManagedWorkListFrozen;
}): Promise<ManagedWorkListPriorProgress> {
  if (options.context.attempt.attempt_index <= 1) {
    return { accepted_results: [] };
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

  return { accepted_results: [] };
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
      item_result: options.itemArtifacts.resultPath
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
            AGENTFLOW_CONTEXT_ITEM_RESULT: options.itemArtifacts.resultPath,
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
          evaluator_surface: "managed_criterion",
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
          ...(options.itemNode.managed_prompt ? { managed_prompt: options.itemNode.managed_prompt } : {}),
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

function contextRow(
  name: string,
  kind: string,
  pointer: string,
  what: string,
  why: string,
  priorityBucket?: ContextPriorityBucket,
  priorityReason?: string
): ManagedItemContextRow {
  return {
    name,
    kind,
    pointer,
    what,
    why,
    ...(priorityBucket ? { priorityBucket } : {}),
    ...(priorityReason ? { priorityReason } : {})
  };
}

async function persistManagedContractFailureFromError(
  error: unknown,
  executionDir: string
): Promise<{ jsonPath: string; markdownPath: string; findings: ManagedContractFinding[] } | undefined> {
  if (!(error instanceof ManagedContractFailureError)) {
    return undefined;
  }

  const written = await writeManagedContractFailurePacket({
    executionDir,
    findings: error.findings
  });
  return {
    jsonPath: written.jsonPath,
    markdownPath: written.markdownPath,
    findings: written.packet.findings
  };
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
  priorResultsPath?: string;
  lastScorecardPath?: string;
  lastContractFailurePath?: string;
  lastContractFailureSummary?: string;
  cycle: number;
  maxCycles: number;
  maxConcurrency?: number;
}): Promise<{
  completedItemAttempt?: RuntimeNodeAttempt;
  itemArtifacts?: Awaited<ReturnType<typeof readManagedItemArtifacts>>;
  scorecardPath?: string;
  cycles?: unknown[];
  lastFailure?: string;
  contractFailurePath?: string;
  contractFailureFindings?: ManagedContractFinding[];
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
      ...(options.priorResultsPath ? { priorResultsPath: options.priorResultsPath } : {}),
      ...(options.lastScorecardPath ? { priorScorecardPath: options.lastScorecardPath } : {}),
      ...(options.lastContractFailurePath ? { managedContractFailurePath: options.lastContractFailurePath } : {}),
      ...(options.lastContractFailureSummary ? { managedContractFailureSummary: options.lastContractFailureSummary } : {}),
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
  const planPath = join(resolveExecutionArtifactsDirectory(planRun.phaseDir), "plan.md");
  try {
    await access(planPath);
  } catch {
    return { lastFailure: `Item ${options.item.id} plan phase did not publish plan.md.` };
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
    contextRow("plan", "artifact", planPath, "Execution plan for this frozen work-list item.", "Use this as guidance; the frozen item contract controls if the plan is incomplete or contradicted by evidence.")
  ]);
  if (executeRun.result.status !== "passed") {
    return { lastFailure: executeRun.result.stderr ?? executeRun.result.stdout ?? `Item ${options.item.id} execute phase failed.` };
  }

  let draftArtifacts: Awaited<ReturnType<typeof readManagedDraftItemArtifacts>>;
  try {
    draftArtifacts = await readManagedDraftItemArtifacts(resolveExecutionArtifactsDirectory(executeRun.phaseDir), options.item);
  } catch (error) {
    const contractFailure = await persistManagedContractFailureFromError(error, executeRun.phaseDir);
    return {
      lastFailure: managedWorkListErrorMessage(error),
      ...(contractFailure
        ? {
            contractFailurePath: contractFailure.markdownPath,
            contractFailureFindings: contractFailure.findings
          }
        : {})
    };
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
    ...(options.priorResultsPath ? { priorResultsPath: options.priorResultsPath } : {}),
    ...(options.lastScorecardPath ? { priorScorecardPath: options.lastScorecardPath } : {}),
    ...(options.lastContractFailurePath ? { managedContractFailurePath: options.lastContractFailurePath } : {}),
    ...(options.lastContractFailureSummary ? { managedContractFailureSummary: options.lastContractFailureSummary } : {}),
    extraRows: [
      contextRow("plan", "artifact", planPath, "Execution plan for this frozen work-list item.", "The verifier uses this to judge planned vs actual item evidence."),
      contextRow("item_work_notes", "artifact", draftArtifacts.workNotesPath, "Execution notes for this item result.", "The verifier uses this to inspect validation and deviations."),
      contextRow("draft_item_result", "artifact", draftArtifacts.resultPath, "Draft structured item result.", "The verifier grades this draft before final publication.")
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

  const parentArtifactsRoot = resolveExecutionArtifactsDirectory(options.itemExecutionDir);
  await mkdir(parentArtifactsRoot, { recursive: true });
  await copyFile(draftArtifacts.resultPath, join(parentArtifactsRoot, "item-result.json"));
  await mkdir(join(options.itemExecutionDir, "agent"), { recursive: true });
  const promotionMessage = `Accepted item ${options.item.id} draft result after passing item criteria.`;
  await writeFile(join(options.itemExecutionDir, "agent", "response.md"), `${promotionMessage}\n`, "utf8");

  let itemArtifacts: Awaited<ReturnType<typeof readManagedItemArtifacts>>;
  try {
    itemArtifacts = await readManagedItemArtifacts(parentArtifactsRoot, options.item);
  } catch (error) {
    const contractFailure = await persistManagedContractFailureFromError(error, options.itemExecutionDir);
    return {
      scorecardPath: scorecard.scorecardPath,
      cycles,
      lastFailure: managedWorkListErrorMessage(error),
      ...(contractFailure
        ? {
            contractFailurePath: contractFailure.markdownPath,
            contractFailureFindings: contractFailure.findings
          }
        : {})
    };
  }

  const completedItemAttempt = await writeManagedItemAttemptResult({
    attempt: options.itemAttempt,
    result: {
      status: "passed",
      exitCode: 0,
      stdout: promotionMessage,
      stderr: "",
      transcript: { last_message: promotionMessage }
    },
    artifacts: {
      item_result: itemArtifacts.resultPath
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
    let lastContractFailurePath: string | undefined;
    let lastContractFailureSummary: string | undefined;
    let lastContractFailureFindings: ManagedContractFinding[] | undefined;
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
      const priorResultsPath = acceptedResults.length > 0
        ? join(runtimeDir, `prior-results-before-${item.id}.json`)
        : undefined;
      if (priorResultsPath) {
        await writeFile(priorResultsPath, `${JSON.stringify({ items: acceptedResults }, null, 2)}\n`, "utf8");
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
          ...(priorResultsPath ? { priorResultsPath } : {}),
          ...(lastScorecardPath ? { lastScorecardPath } : {}),
          ...(lastContractFailurePath ? { lastContractFailurePath } : {}),
          ...(lastContractFailureSummary ? { lastContractFailureSummary } : {}),
          cycle,
          maxCycles,
          ...(config.criteria_concurrency !== undefined ? { maxConcurrency: config.criteria_concurrency } : {})
        });

        if (!deepWorkResult.completedItemAttempt || !deepWorkResult.itemArtifacts) {
          lastFailure = deepWorkResult.lastFailure ?? `Item ${item.id} deep-work item attempt failed.`;
          if (deepWorkResult.scorecardPath) {
            lastScorecardPath = deepWorkResult.scorecardPath;
          }
          if (deepWorkResult.contractFailurePath) {
            lastContractFailurePath = deepWorkResult.contractFailurePath;
            lastContractFailureSummary = managedContractFailureSummary(deepWorkResult.contractFailureFindings ?? []);
          } else {
            lastContractFailurePath = undefined;
            lastContractFailureSummary = undefined;
          }
          if (deepWorkResult.contractFailureFindings) {
            lastContractFailureFindings = deepWorkResult.contractFailureFindings;
          } else {
            lastContractFailureFindings = undefined;
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
          ...(priorResultsPath ? { priorResultsPath } : {}),
          ...(lastScorecardPath ? { priorScorecardPath: lastScorecardPath } : {}),
          extraRows: [
            ...(scorecardPath
              ? [contextRow("item_scorecard", "artifact", scorecardPath, "Passing item scorecard.", "The outcome verifier checks final item claims against this accepted scorecard.")]
              : []),
            contextRow("item_result", "artifact", itemArtifacts.resultPath, "Final structured item result.", "The outcome verifier checks this final item artifact.")
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
          ...(priorResultsPath ? { priorResultsPath } : {}),
          ...(lastScorecardPath ? { priorScorecardPath: lastScorecardPath } : {}),
          ...(lastContractFailurePath ? { managedContractFailurePath: lastContractFailurePath } : {}),
          ...(lastContractFailureSummary ? { managedContractFailureSummary: lastContractFailureSummary } : {})
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
          const contractFailure = await persistManagedContractFailureFromError(error, itemExecutionDir);
          if (contractFailure) {
            lastContractFailurePath = contractFailure.markdownPath;
            lastContractFailureSummary = managedContractFailureSummary(contractFailure.findings);
            lastContractFailureFindings = contractFailure.findings;
          }
          lastFailure = managedWorkListErrorMessage(error);
          continue;
        }
        completedItemAttempt = await writeManagedItemAttemptResult({
          attempt: completedItemAttempt,
          result: harnessResult,
          artifacts: {
            item_result: itemArtifacts.resultPath
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
        ...(scorecardPath ? { scorecard_path: scorecardPath } : {}),
        ...(cycles ? { cycles } : {})
      };
      acceptedResults.push(accepted);
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
      if (lastContractFailureFindings && lastContractFailureFindings.length > 0) {
        await writeManagedContractFailurePacket({
          executionDir: context.execution_dir,
          findings: lastContractFailureFindings
        });
      }
      ledger = {
        ...ledger,
        status: "failed",
        items: ledger.items.map((entry) =>
          entry.id === item.id ? { ...entry, status: "failed", summary: lastFailure } : entry
        )
      };
      await writeFile(runtimeLedgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
      await writeFile(join(outputDir, "item-results.json"), `${JSON.stringify({ items: acceptedResults }, null, 2)}\n`, "utf8");
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

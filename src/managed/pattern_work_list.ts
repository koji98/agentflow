import type {
  AgentNode,
  ArtifactDefinition,
  BaseExecutableNode,
  ContextItem,
  ExecNode,
  SequenceNode
} from "../graph/authored.js";
import type { PatternDeepWorkPhaseName, PatternDeepWorkPhaseOverride } from "./pattern_deep_work.js";
import {
  artifactContext,
  body,
  managedId,
  mergeArtifacts,
  mergeSupportContext,
  maxConcurrency,
  outputDirArtifact,
  renderPrompt,
  section,
  sharedAgentBase,
  sharedNonPromptNodeBase,
  type ManagedPatternAgentOptions,
  type ManagedPatternRuntime
} from "./foundation.js";

export interface PatternWorkListItemGuidance {
  what_counts_as_one_item: string;
  done_when: string[];
}

export interface PatternWorkListCriterionBase {
  id: string;
  weight: number;
  required?: boolean;
}

export interface PatternWorkListCommandCriterion extends PatternWorkListCriterionBase {
  kind: "command";
  command: string;
}

export interface PatternWorkListRubricCriterion extends PatternWorkListCriterionBase {
  kind: "rubric";
  target: "workspace" | "item_handoff" | "work_list_ledger";
  rubric: string;
}

export type PatternWorkListCompletionCriterion =
  | PatternWorkListCommandCriterion
  | PatternWorkListRubricCriterion;

export interface PatternWorkListDeepWorkCompletion {
  max_cycles: number;
  pass_threshold: number;
  criteria: PatternWorkListCompletionCriterion[];
}

export type PatternWorkListItemWorker =
  | { kind: "agent" }
  | {
      kind: "deep_work";
      completion: PatternWorkListDeepWorkCompletion;
      phases?: Partial<Record<PatternDeepWorkPhaseName, PatternDeepWorkPhaseOverride>>;
    };

export interface PatternWorkListBlock {
  planning_goal: string;
  item_guidance: PatternWorkListItemGuidance;
  item_worker: PatternWorkListItemWorker;
}

export interface PatternWorkListConfig extends BaseExecutableNode, ManagedPatternAgentOptions {
  work_list: PatternWorkListBlock;
  runtime?: ManagedPatternRuntime;
}

function workflowNodeId(rootId: string, suffix: string): string {
  return managedId(rootId, "pattern_work_list", suffix);
}

export function defaultPatternWorkListPublicArtifacts(): Record<string, ArtifactDefinition> {
  return mergeArtifacts(
    outputDirArtifact("summary", "summary.md", "Human-readable final summary for the completed work list."),
    outputDirArtifact("work_items", "work-items.json", "Machine-readable index of frozen work-list items, item outcomes, validation evidence, and residual risks.")
  );
}

function listOrFallback(title: string, values: string[] | undefined, fallback: string): string[] {
  return values && values.length > 0
    ? [title, ...values.map((value) => `- ${value}`)]
    : [`${title}: ${fallback}`];
}

function formatPublicArtifacts(artifacts: Record<string, ArtifactDefinition>): string[] {
  return Object.entries(artifacts).flatMap(([name, artifact]) => [
    `- ${name}: publish this declared artifact; the Declared Artifacts table shows the exact command.`,
    `  ${artifact.description}`
  ]);
}

function formatCriteria(criteria: PatternWorkListCompletionCriterion[]): string[] {
  return criteria.map((criterion) => {
    const required = criterion.required ? "required" : "weighted";
    if (criterion.kind === "command") {
      return `- ${criterion.id} (${required}, weight ${criterion.weight}): command \`${criterion.command}\``;
    }
    return `- ${criterion.id} (${required}, weight ${criterion.weight}, target ${criterion.target}): ${criterion.rubric}`;
  });
}

function buildPlannerPrompt(config: PatternWorkListConfig): string {
  return renderPrompt([
    body("You are planning a finite ordered list of work items required to satisfy this task. Do not edit product or source files in this phase."),
    section("Task Contract", [
      `Goal: ${config.intent.goal}`,
      ...listOrFallback("Acceptance criteria", config.intent.acceptance_criteria, "Use the graph and node acceptance criteria."),
      ...listOrFallback("Constraints", config.intent.constraints, "Stay inside the authored task contract.")
    ]),
    section("Planning Goal", [
      config.work_list.planning_goal
    ]),
    section("Item Guidance", [
      `What counts as one item: ${config.work_list.item_guidance.what_counts_as_one_item}`,
      ...listOrFallback("Done when", config.work_list.item_guidance.done_when, "The item is completed with evidence and a handoff.")
    ]),
    section("Planning Rules", [
      "Plan only work needed for the task goal.",
      "Create reviewable items that are coherent enough to complete independently, but not so broad that evidence becomes vague.",
      "Order items so each item can use earlier item handoffs as evidence.",
      "Do not create speculative future work, unrelated cleanup, or optional polish items.",
      "Do not run or log implementation validation as blocked during planning; assign validation commands and evidence expectations to the planned items.",
      "The runtime will freeze this list before execution; later workers cannot add, remove, split, merge, or reorder items."
    ]),
    section("Output Contract", [
      "Publish only the `work_list_json` artifact.",
      "Use this exact JSON shape:",
      '{"planning_summary":"why this finite list satisfies the node contract","ordering_rationale":"why this order is correct","items":[{"id":"w1","title":"short label","goal":"item outcome","acceptance_criteria":["concrete success condition"],"constraints":["item boundary"],"validation_expectations":["validation or evidence expected"],"handoff_focus":["what later items or reviewers need"],"rationale":"why this item exists and has this boundary"}]}',
      "Use sequential ids starting at `w1` with no gaps."
    ])
  ]);
}

function buildRunnerPrompt(config: PatternWorkListConfig): string {
  const worker = config.work_list.item_worker;
  const workerLines = worker.kind === "agent"
    ? [
        "Worker kind: agent.",
        "The runtime will launch one item worker per frozen item.",
        "Each item worker uses the standard Agentflow work loop: orient, create milestones, attach evidence, validate, write item handoff, and complete."
      ]
    : [
        "Worker kind: deep_work.",
        `Maximum item cycles: ${worker.completion.max_cycles}`,
        `Pass threshold for each item gate: ${worker.completion.pass_threshold}`,
        ...formatCriteria(worker.completion.criteria),
        "The runtime will run a bounded deep-work lifecycle for each frozen item before moving to the next item.",
        "Each item cycle runs planning, execution, verification, and publishing phases.",
        "Item deep-work phases may add phase-specific intent, support, model, reasoning effort, sandbox, or profile policy.",
        "Phase intent is additive to the parent work-list contract and current frozen item contract.",
        "Use prior item scorecard feedback when present, but do not mutate the frozen list between cycles.",
        "If an item cannot be completed, record the concrete blocker and evidence instead of silently changing scope."
      ];

  return renderPrompt([
    body("You are running the frozen work list. The runtime launches one item worker per frozen item and owns item status and aggregation."),
    section("Task Contract", [
      `Goal: ${config.intent.goal}`,
      ...listOrFallback("Acceptance criteria", config.intent.acceptance_criteria, "Use the graph and node acceptance criteria."),
      ...listOrFallback("Constraints", config.intent.constraints, "Stay inside the authored task contract.")
    ]),
    section("Frozen List Discipline", [
      "Read the frozen work list and current ledger from context.",
      "Do not add, remove, split, merge, or reorder work-list items.",
      "Use prior completed item handoffs as pointer evidence for later items.",
      "If the frozen list is wrong, record the concrete blocker instead of silently changing it."
    ]),
    section("Item Guidance", [
      `What counts as one item: ${config.work_list.item_guidance.what_counts_as_one_item}`,
      ...listOrFallback("Done when", config.work_list.item_guidance.done_when, "The item is completed with evidence and a handoff.")
    ]),
    section("Item Worker", workerLines),
    section("Retry And Preservation", [
      "On retry, inspect attempt memory and prior item evidence before editing.",
      "Preserve completed, in-scope item work unless the verifier or supervisor identifies it as contaminated or based on a bad premise.",
      "Focus item retries on the failed, blocked, or semantically rejected item; do not redo completed items just because the parent task restarted.",
      "If a later item fails, keep earlier accepted item evidence as the starting point for the retry."
    ]),
    section("Output Contract", [
      "Each item worker writes the item handoff, item result, and item validation artifacts in its own item execution directory.",
      "The item result validation field is an object with passed, failed_then_fixed, unavailable, and blocked arrays. A completed item needs concrete evidence recorded under passed, failed_then_fixed, or unavailable.",
      "The runtime aggregates accepted item artifacts into final work-list artifacts.",
      "The final runtime step fails unless every frozen item is marked completed with evidence.",
      "For deep_work mode, include item cycle and scorecard evidence in the item result when useful."
    ])
  ]);
}

function buildPublisherPrompt(
  config: PatternWorkListConfig,
  publicArtifacts: Record<string, ArtifactDefinition>
): string {
  return renderPrompt([
    body("You are publishing final artifacts from verified work item evidence."),
    section("Task Contract", [
      `Goal: ${config.intent.goal}`,
      ...listOrFallback("Acceptance criteria", config.intent.acceptance_criteria, "Use the graph and node acceptance criteria."),
      ...listOrFallback("Constraints", config.intent.constraints, "Stay inside the authored task contract.")
    ]),
    section("Source Evidence", [
      "Use the verified work-items artifact, frozen work list, and item handoffs from context.",
      "Do not claim completion for items that the verified work-items artifact does not mark completed.",
      "Preserve residual risks and downstream implications."
    ]),
    section("Declared Final Artifacts", [
      "Publish the declared final artifacts.",
      ...formatPublicArtifacts(publicArtifacts),
      "The `work_items` artifact is forwarded by the runtime from the deterministic verifier; do not rewrite it.",
      "The `summary` artifact should summarize the frozen list, completed items, validation evidence, risks, and downstream constraints."
    ])
  ]);
}

function buildFreezeScript(): string {
  return String.raw`
const fs = require("node:fs");
const path = require("node:path");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail("Failed to parse work-list JSON: " + (error && error.message ? error.message : String(error)));
  }
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim()) : [];
}

const sourcePath = process.env.AGENTFLOW_CONTEXT_WORK_LIST_JSON;
const outputDir = process.env.AGENTFLOW_OUTPUT_DIR;
if (!sourcePath) fail("Missing AGENTFLOW_CONTEXT_WORK_LIST_JSON.");
if (!outputDir) fail("Missing AGENTFLOW_OUTPUT_DIR.");

const raw = readJson(sourcePath);
if (!raw || typeof raw !== "object" || !Array.isArray(raw.items)) {
  fail('work-list.json must be an object with an "items" array.');
}
const planningSummary = typeof raw.planning_summary === "string" ? raw.planning_summary.trim() : "";
const orderingRationale = typeof raw.ordering_rationale === "string" ? raw.ordering_rationale.trim() : "";
if (planningSummary.length < 12) {
  fail("work-list.json must include a concrete planning_summary.");
}
if (orderingRationale.length < 12) {
  fail("work-list.json must include a concrete ordering_rationale.");
}
if (raw.items.length === 0) {
  fail("work-list.json must include at least one item.");
}

const seen = new Set();
const items = raw.items.map((item, index) => {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    fail("Work-list item " + (index + 1) + " must be an object.");
  }
  const expectedId = "w" + (index + 1);
  if (item.id !== expectedId) {
    fail("Work-list item " + (index + 1) + " must use sequential id " + expectedId + ".");
  }
  if (seen.has(item.id)) {
    fail("Duplicate work-list item id " + item.id + ".");
  }
  seen.add(item.id);
  const title = typeof item.title === "string" ? item.title.trim() : "";
  const goal = typeof item.goal === "string" ? item.goal.trim() : "";
  const rationale = typeof item.rationale === "string" ? item.rationale.trim() : "";
  const acceptance = stringArray(item.acceptance_criteria);
  if (title.length < 3) fail("Work-list item " + item.id + " needs a concrete title.");
  if (goal.length < 12) fail("Work-list item " + item.id + " needs a concrete goal.");
  if (rationale.length < 12) fail("Work-list item " + item.id + " needs a concrete rationale.");
  if (acceptance.length === 0) fail("Work-list item " + item.id + " needs at least one acceptance criterion.");
  if (acceptance.some((entry) => entry.length < 8)) fail("Work-list item " + item.id + " has a vague acceptance criterion.");
  return {
    id: item.id,
    title,
    goal,
    acceptance_criteria: acceptance,
    constraints: stringArray(item.constraints),
    validation_expectations: stringArray(item.validation_expectations),
    handoff_focus: stringArray(item.handoff_focus),
    rationale
  };
});

const frozen = {
  schema_version: 1,
  status: "frozen",
  frozen_at: new Date().toISOString(),
  source_path: sourcePath,
  planning_summary: planningSummary,
  ordering_rationale: orderingRationale,
  items
};
const ledger = {
  schema_version: 1,
  status: "frozen",
  frozen_at: frozen.frozen_at,
  items: items.map((item) => ({
    id: item.id,
    title: item.title,
    status: "pending"
  }))
};
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, "work-list-frozen.json"), JSON.stringify(frozen, null, 2) + "\n");
fs.writeFileSync(path.join(outputDir, "work-list-ledger.json"), JSON.stringify(ledger, null, 2) + "\n");
console.log("Frozen " + items.length + " work-list item(s).");
`;
}

function buildFinalizeScript(): string {
  return String.raw`
const fs = require("node:fs");
const path = require("node:path");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readJson(label, filePath) {
  if (!filePath) fail("Missing " + label + " context path.");
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail("Failed to parse " + label + ": " + (error && error.message ? error.message : String(error)));
  }
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim()) : [];
}

function validationEvidence(value, itemId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("Frozen item " + itemId + " result validation must be an object with passed, failed_then_fixed, unavailable, and blocked arrays.");
  }
  const validation = {
    passed: stringArray(value.passed),
    failed_then_fixed: stringArray(value.failed_then_fixed),
    unavailable: stringArray(value.unavailable),
    blocked: stringArray(value.blocked)
  };
  for (const key of ["passed", "failed_then_fixed", "unavailable", "blocked"]) {
    if (!Array.isArray(value[key])) {
      fail("Frozen item " + itemId + " result validation." + key + " must be an array.");
    }
  }
  if (
    validation.passed.length === 0 &&
    validation.failed_then_fixed.length === 0 &&
    validation.unavailable.length === 0
  ) {
    if (validation.blocked.length > 0) {
      fail("Frozen item " + itemId + " result is completed but only provides blocked validation.");
    }
    fail("Frozen item " + itemId + " result is missing usable validation evidence.");
  }
  return validation;
}

const frozen = readJson("frozen work list", process.env.AGENTFLOW_CONTEXT_FROZEN_WORK_LIST);
const results = readJson("item results", process.env.AGENTFLOW_CONTEXT_ITEM_RESULTS);
const itemHandoffsPath = process.env.AGENTFLOW_CONTEXT_ITEM_HANDOFFS;
const outputDir = process.env.AGENTFLOW_OUTPUT_DIR;
if (!outputDir) fail("Missing AGENTFLOW_OUTPUT_DIR.");
if (!frozen || !Array.isArray(frozen.items) || frozen.items.length === 0) {
  fail("Frozen work list is missing items.");
}
if (!results || !Array.isArray(results.items)) {
  fail('item-results.json must be an object with an "items" array.');
}
if (!itemHandoffsPath || !fs.existsSync(itemHandoffsPath)) {
  fail("Missing item-handoffs.md artifact.");
}

for (const result of results.items) {
  if (result && typeof result === "object" && typeof result.item_id === "string") {
    fail("item-results.json uses stale field item_id for item " + result.item_id + "; use id.");
  }
}
const resultsById = new Map(results.items.map((item) => [item && item.id, item]));
const verifiedItems = frozen.items.map((item) => {
  const result = resultsById.get(item.id);
  if (!result || typeof result !== "object") {
    fail("Missing result for frozen item " + item.id + ".");
  }
  if (typeof result.item_id === "string") {
    fail("Frozen item " + item.id + " result uses stale field item_id; use id.");
  }
  if (result.id !== item.id) {
    fail("Frozen item " + item.id + " result id does not match the frozen list.");
  }
  if (result.status !== "completed") {
    fail("Frozen item " + item.id + " is " + (result.status || "missing status") + ", not completed.");
  }
  const summary = typeof result.summary === "string" ? result.summary.trim() : "";
  if (summary.length === 0) {
    fail("Frozen item " + item.id + " needs a result summary.");
  }
  if (!Array.isArray(result.risks)) {
    fail("Frozen item " + item.id + " result risks must be an array.");
  }
  if (!Array.isArray(result.downstream_implications)) {
    fail("Frozen item " + item.id + " result downstream_implications must be an array.");
  }
  return {
    id: item.id,
    title: item.title,
    goal: item.goal,
    status: "completed",
    summary,
    validation: validationEvidence(result.validation, item.id),
    risks: stringArray(result.risks),
    downstream_implications: stringArray(result.downstream_implications),
    ...(result.scorecard ? { scorecard: result.scorecard } : {}),
    ...(result.cycles ? { cycles: result.cycles } : {})
  };
});
const extraIds = results.items
  .map((item) => item && item.id)
  .filter((id) => typeof id === "string" && !frozen.items.some((item) => item.id === id));
if (extraIds.length > 0) {
  fail("item-results.json contains ids not present in the frozen list: " + extraIds.join(", "));
}

const workItems = {
  schema_version: 1,
  status: "completed",
  completed_at: new Date().toISOString(),
  item_count: verifiedItems.length,
  item_handoffs_path: itemHandoffsPath,
  items: verifiedItems
};
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, "work-items.json"), JSON.stringify(workItems, null, 2) + "\n");
console.log("Verified " + verifiedItems.length + " completed work-list item(s).");
`;
}

function buildRunnerContext(freezeId: string): ContextItem[] {
  return [
    artifactContext("frozen_work_list", freezeId, "frozen_work_list", {
      what: "Runtime-validated frozen work list.",
      why: "The item worker must execute exactly this ordered list."
    }),
    artifactContext("work_list_ledger", freezeId, "work_list_ledger", {
      what: "Initial runtime-owned work-list ledger.",
      why: "The item worker needs the starting status for every item."
    })
  ];
}

function buildFinalizeContext(
  freezeId: string,
  runItemsId: string
): ContextItem[] {
  return [
    artifactContext("frozen_work_list", freezeId, "frozen_work_list", {
      what: "Runtime-validated frozen work list.",
      why: "The finalizer must compare item results against the exact frozen list."
    }),
    artifactContext("item_results", runItemsId, "item_results", {
      what: "Structured item results written by the item worker.",
      why: "The finalizer uses this to verify every frozen item completed."
    }),
    artifactContext("item_handoffs", runItemsId, "item_handoffs", {
      what: "Human-readable item handoffs written by the item worker.",
      why: "The finalizer and publisher need item evidence for the final handoff."
    }),
    artifactContext("item_validation", runItemsId, "item_validation", {
      what: "Validation evidence for the executed work-list items.",
      why: "The finalizer and publisher need validation evidence for completed items."
    })
  ];
}

function buildPublishContext(
  freezeId: string,
  runItemsId: string,
  finalizeId: string
): ContextItem[] {
  return [
    artifactContext("frozen_work_list", freezeId, "frozen_work_list", {
      what: "Runtime-validated frozen work list.",
      why: "The publisher needs the fixed item order and contracts."
    }),
    artifactContext("item_handoffs", runItemsId, "item_handoffs", {
      what: "Human-readable item handoffs.",
      why: "The publisher needs item evidence for the final summary and packet."
    }),
    artifactContext("verified_work_items", finalizeId, "work_items", {
      what: "Runtime-verified completed work item index.",
      why: "The publisher must only claim completed items from this verified artifact."
    })
  ];
}

export function buildPatternWorkList(config: PatternWorkListConfig): SequenceNode {
  const workflowId = workflowNodeId(config.id, "workflow");
  const planId = workflowNodeId(config.id, "plan");
  const freezeId = workflowNodeId(config.id, "freeze");
  const runItemsId = workflowNodeId(config.id, "run_items");
  const finalizeId = workflowNodeId(config.id, "finalize");
  const agentShared = sharedAgentBase(config);
  const publicArtifacts = mergeArtifacts(defaultPatternWorkListPublicArtifacts(), config.artifacts ?? {});

  const planNode: AgentNode = {
    type: "agent",
    id: planId,
    label: "Plan Work List",
    ...agentShared,
    artifacts: mergeArtifacts(
      outputDirArtifact("work_list_json", "work-list.json", "Machine-readable planned work-list items.")
    ),
    managed_runtime: {
      kind: "pattern_work_list",
      root_id: config.id,
      phase: "plan"
    },
    intent: {
      goal: buildPlannerPrompt(config),
      acceptance_criteria: [
        "The work list is finite, ordered, and scoped to the task contract.",
        "The machine-readable list uses sequential ids w1, w2, w3, and so on.",
        "The machine-readable list includes planning_summary, ordering_rationale, and per-item rationale.",
        "The planner does not edit product or source files."
      ],
      constraints: config.intent.constraints
    }
  };

  const freezeNode: ExecNode = {
    type: "exec",
    id: freezeId,
    label: "Freeze Work List",
    ...sharedNonPromptNodeBase(config),
    support: mergeSupportContext(sharedNonPromptNodeBase(config).support, [
      artifactContext("work_list_json", planId, "work_list_json", {
        what: "Machine-readable planned work-list items.",
        why: "The freeze step validates and freezes this list before execution."
      })
    ]),
    command: "node",
    args: ["-e", buildFreezeScript()],
    artifacts: mergeArtifacts(
      outputDirArtifact("frozen_work_list", "work-list-frozen.json", "Runtime-validated frozen work list."),
      outputDirArtifact("work_list_ledger", "work-list-ledger.json", "Initial runtime-owned ledger for frozen work-list items.")
    ),
    intent: {
      goal: "Validate and freeze the planned work list before item execution starts.",
      acceptance_criteria: [
        "The frozen work list has a finite non-empty ordered item array.",
        "Every item has a sequential id, concrete goal, and acceptance criteria.",
        "The initial ledger marks every item pending."
      ],
      constraints: config.intent.constraints
    }
  };

  const runItemsNode: AgentNode = {
    type: "agent",
    id: runItemsId,
    label: "Run Work List Items",
    ...agentShared,
    support: mergeSupportContext(
      agentShared.support,
      buildRunnerContext(freezeId)
    ),
    artifacts: mergeArtifacts(
      outputDirArtifact("item_handoffs", "item-handoffs.md", "Human-readable handoffs for every frozen work-list item."),
      outputDirArtifact("item_results", "item-results.json", "Structured result for every frozen work-list item."),
      outputDirArtifact("item_validation", "item-validation.md", "Validation evidence for the executed work-list items.")
    ),
    managed_runtime: {
      kind: "pattern_work_list",
      root_id: config.id,
      phase: "run_items",
      config: {
        parent_intent: config.intent,
        item_guidance: config.work_list.item_guidance,
        item_worker: config.work_list.item_worker,
        ...(config.work_list.item_worker.kind === "deep_work"
          ? { criteria_concurrency: maxConcurrency(config.runtime, config.work_list.item_worker.completion.criteria.length) }
          : {})
      }
    },
    intent: {
      goal: buildRunnerPrompt(config),
      acceptance_criteria: [
        "Every frozen work-list item has a result entry.",
        "Completed items include evidence, validation, risks, and downstream implications.",
        "The worker does not add, remove, split, merge, or reorder frozen work-list items."
      ],
      constraints: config.intent.constraints
    }
  };

  const finalizeNode: ExecNode = {
    type: "exec",
    id: finalizeId,
    label: "Verify Work List Items",
    ...sharedNonPromptNodeBase(config),
    support: mergeSupportContext(
      sharedNonPromptNodeBase(config).support,
      buildFinalizeContext(freezeId, runItemsId)
    ),
    command: "node",
    args: ["-e", buildFinalizeScript()],
    artifacts: outputDirArtifact("work_items", "work-items.json", "Runtime-verified completed work item index."),
    intent: {
      goal: "Verify every frozen work-list item completed and publish the stable work item index.",
      acceptance_criteria: [
        "The verified work item index includes exactly the frozen item ids.",
        "Every item is marked completed with summary and validation evidence.",
        "The final work item index exposes only the stable completed item evidence."
      ],
      constraints: config.intent.constraints
    }
  };

  const publishNode: AgentNode = {
    type: "agent",
    id: config.id,
    ...(config.label ? { label: config.label } : { label: "Publish Work List" }),
    ...agentShared,
    support: mergeSupportContext(
      agentShared.support,
      buildPublishContext(freezeId, runItemsId, finalizeId)
    ),
    artifacts: publicArtifacts,
    managed_artifact_forwards: {
      work_items: {
        node: finalizeId,
        artifact: "work_items"
      }
    },
    intent: {
      goal: buildPublisherPrompt(config, publicArtifacts),
      acceptance_criteria: [
        ...config.intent.acceptance_criteria,
        "The final artifacts summarize the frozen list, completed items, validation evidence, residual risks, and downstream constraints.",
        "The final artifacts expose only the stable completed item evidence."
      ],
      constraints: config.intent.constraints
    }
  };

  return {
    type: "sequence",
    id: workflowId,
    label: config.label ? `${config.label} Workflow` : "Work List Workflow",
    steps: [
      planNode,
      freezeNode,
      runItemsNode,
      finalizeNode,
      publishNode
    ]
  };
}

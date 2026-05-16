import type {
  AgentNode,
  ArtifactDefinition,
  BaseExecutableNode,
  CheckNode,
  ContextItem,
  ExecNode,
  ParallelNode,
  RepeatNode,
  SequenceNode
} from "../graph/authored.js";
import {
  artifactContext,
  body,
  managedId,
  maxConcurrency,
  mergeArtifacts,
  mergeSupportContext,
  outputDirArtifact,
  renderPrompt,
  section,
  sharedAgentBase,
  sharedAiCheckBase,
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

function zeroPad(value: number): string {
  return String(value).padStart(2, "0");
}

export function defaultPatternWorkListPublicArtifacts(): Record<string, ArtifactDefinition> {
  return mergeArtifacts(
    outputDirArtifact("summary", "summary.md", "Human-readable final summary for the managed work list."),
    outputDirArtifact("packet", "packet.json", "Machine-readable final packet for downstream Agentflow nodes."),
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
    `- ${name}: ${artifact.from}:${artifact.path}`,
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
    body("You are the planner for a managed work-list pattern. Your job is to discover the finite ordered list of work items required to satisfy this node contract. Do not edit product or source files in this phase."),
    section("Managed Node Contract", [
      `Goal: ${config.intent.goal}`,
      ...listOrFallback("Acceptance criteria", config.intent.acceptance_criteria, "Use the graph and node acceptance criteria."),
      ...listOrFallback("Constraints", config.intent.constraints, "Stay inside the authored graph contract.")
    ]),
    section("Planning Goal", [
      config.work_list.planning_goal
    ]),
    section("Item Guidance", [
      `What counts as one item: ${config.work_list.item_guidance.what_counts_as_one_item}`,
      ...listOrFallback("Done when", config.work_list.item_guidance.done_when, "The item is completed with evidence and a handoff.")
    ]),
    section("Planning Rules", [
      "Plan only work needed for the managed node goal.",
      "Create reviewable items that are coherent enough to complete independently, but not so broad that evidence becomes vague.",
      "Order items so each item can use earlier item handoffs as evidence.",
      "Do not create speculative future work, unrelated cleanup, or optional polish items.",
      "The runtime will freeze this list before execution; later workers cannot add, remove, split, merge, or reorder items."
    ]),
    section("Output Contract", [
      "Write `work-list.md` as a human-readable explanation of the planned item order and why it satisfies the node contract.",
      "Write `work-list.json` with this exact shape:",
      '{"items":[{"id":"w1","title":"short label","goal":"item outcome","acceptance_criteria":["concrete success condition"],"constraints":["item boundary"],"validation_expectations":["validation or evidence expected"],"handoff_focus":["what later items or reviewers need"]}]}',
      "Use sequential ids starting at `w1` with no gaps."
    ])
  ]);
}

function buildRunnerPrompt(config: PatternWorkListConfig): string {
  const worker = config.work_list.item_worker;
  const workerLines = worker.kind === "agent"
    ? [
        "Worker kind: agent.",
        "Execute each frozen item once with the standard Agentflow work loop: orient, create milestones, attach evidence, validate, write item handoff, then continue.",
        "If an item cannot be completed, stop and record concrete evidence in `item-results.json`."
      ]
    : [
        "Worker kind: deep_work.",
        `Maximum frozen-list cycles: ${worker.completion.max_cycles}`,
        `Pass threshold for the frozen-list gate: ${worker.completion.pass_threshold}`,
        ...formatCriteria(worker.completion.criteria),
        "In each cycle, work through the frozen list sequentially, record item evidence/results, and then let the runtime criteria evaluate the cycle.",
        "Use prior scorecard feedback when present, but do not mutate the frozen list between cycles.",
        "If an item cannot be completed, record the concrete blocker and evidence instead of silently changing scope."
      ];

  return renderPrompt([
    body("You are the item worker for a managed work-list pattern. Complete the frozen list sequentially. The runtime owns item status; your job is to produce evidence the runtime can verify."),
    section("Managed Node Contract", [
      `Goal: ${config.intent.goal}`,
      ...listOrFallback("Acceptance criteria", config.intent.acceptance_criteria, "Use the graph and node acceptance criteria."),
      ...listOrFallback("Constraints", config.intent.constraints, "Stay inside the authored graph contract.")
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
    section("Output Contract", [
      "Write `item-handoffs.md` with one section per frozen item id. Each section must include item goal, result, evidence, validation, risks, and downstream implications.",
      "Write `item-results.json` with this exact shape:",
      '{"items":[{"id":"w1","status":"completed","summary":"what changed or was produced","validation":[{"summary":"validation evidence","result":"pass"}],"risks":[],"downstream_implications":[]}]}',
      "The final runtime step will fail unless every frozen item is marked completed.",
      "Write `item-validation.md` with validation commands, checks, manual evidence, unavailable validation, and any reruns.",
      "For deep_work mode, include frozen-list cycle and scorecard evidence in `item-results.json` when useful."
    ])
  ]);
}

function buildPublisherPrompt(
  config: PatternWorkListConfig,
  publicArtifacts: Record<string, ArtifactDefinition>
): string {
  return renderPrompt([
    body("You are publishing the final public artifacts for a managed work-list pattern. Downstream graph nodes will use these stable artifacts, not the internal item attempts."),
    section("Managed Node Contract", [
      `Goal: ${config.intent.goal}`,
      ...listOrFallback("Acceptance criteria", config.intent.acceptance_criteria, "Use the graph and node acceptance criteria."),
      ...listOrFallback("Constraints", config.intent.constraints, "Stay inside the authored graph contract.")
    ]),
    section("Source Evidence", [
      "Use the verified work-items artifact, frozen work list, and item handoffs from context.",
      "Do not claim completion for items that the verified work-items artifact does not mark completed.",
      "Preserve residual risks and downstream implications."
    ]),
    section("Declared Public Artifacts", [
      "Publish the declared public artifacts.",
      ...formatPublicArtifacts(publicArtifacts),
      "The `work_items` artifact is forwarded by the runtime from the deterministic verifier; do not rewrite it.",
      "The `packet` artifact should summarize the frozen list, completed items, validation evidence, risks, and downstream constraints."
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
  const acceptance = stringArray(item.acceptance_criteria);
  if (title.length < 3) fail("Work-list item " + item.id + " needs a concrete title.");
  if (goal.length < 12) fail("Work-list item " + item.id + " needs a concrete goal.");
  if (acceptance.length === 0) fail("Work-list item " + item.id + " needs at least one acceptance criterion.");
  if (acceptance.some((entry) => entry.length < 8)) fail("Work-list item " + item.id + " has a vague acceptance criterion.");
  return {
    id: item.id,
    title,
    goal,
    acceptance_criteria: acceptance,
    constraints: stringArray(item.constraints),
    validation_expectations: stringArray(item.validation_expectations),
    handoff_focus: stringArray(item.handoff_focus)
  };
});

const frozen = {
  schema_version: 1,
  status: "frozen",
  frozen_at: new Date().toISOString(),
  source_path: sourcePath,
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

const resultsById = new Map(results.items.map((item) => [item && item.id, item]));
const verifiedItems = frozen.items.map((item) => {
  const result = resultsById.get(item.id);
  if (!result || typeof result !== "object") {
    fail("Missing result for frozen item " + item.id + ".");
  }
  if (result.status !== "completed") {
    fail("Frozen item " + item.id + " is " + (result.status || "missing status") + ", not completed.");
  }
  const summary = typeof result.summary === "string" ? result.summary.trim() : "";
  if (summary.length === 0) {
    fail("Frozen item " + item.id + " needs a result summary.");
  }
  return {
    id: item.id,
    title: item.title,
    goal: item.goal,
    status: "completed",
    summary,
    validation: Array.isArray(result.validation) ? result.validation : [],
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

function buildRunnerContext(planId: string, freezeId: string, gateId?: string): ContextItem[] {
  const context: ContextItem[] = [
    artifactContext("work_list_markdown", planId, "work_list_md", {
      what: "Human-readable planned work list.",
      why: "The item worker needs the planner's rationale and ordering."
    }),
    artifactContext("frozen_work_list", freezeId, "frozen_work_list", {
      what: "Runtime-validated frozen work list.",
      why: "The item worker must execute exactly this ordered list."
    }),
    artifactContext("work_list_ledger", freezeId, "work_list_ledger", {
      what: "Initial runtime-owned work-list ledger.",
      why: "The item worker needs the starting status for every item."
    })
  ];

  if (gateId) {
    context.push(
      artifactContext("failed_work_list_scorecard", gateId, "work_list_scorecard", {
        iteration: "latest_failed",
        if_available: true,
        what: "Most recent failed work-list scorecard.",
        why: "The next frozen-list cycle needs concrete feedback from failed criteria."
      })
    );
  }

  return context;
}

function buildFinalizeContext(
  freezeId: string,
  runItemsId: string,
  options: { iteration?: "latest_passed" } = {}
): ContextItem[] {
  return [
    artifactContext("frozen_work_list", freezeId, "frozen_work_list", {
      what: "Runtime-validated frozen work list.",
      why: "The finalizer must compare item results against the exact frozen list."
    }),
    artifactContext("item_results", runItemsId, "item_results", {
      ...(options.iteration ? { iteration: options.iteration } : {}),
      what: "Structured item results written by the item worker.",
      why: "The finalizer uses this to verify every frozen item completed."
    }),
    artifactContext("item_handoffs", runItemsId, "item_handoffs", {
      ...(options.iteration ? { iteration: options.iteration } : {}),
      what: "Human-readable item handoffs written by the item worker.",
      why: "The finalizer and publisher need item evidence for the final handoff."
    }),
    artifactContext("item_validation", runItemsId, "item_validation", {
      ...(options.iteration ? { iteration: options.iteration } : {}),
      what: "Validation evidence for the executed work-list items.",
      why: "The finalizer and publisher need validation evidence for completed items."
    })
  ];
}

function buildPublishContext(
  freezeId: string,
  runItemsId: string,
  finalizeId: string,
  options: { iteration?: "latest_passed" } = {}
): ContextItem[] {
  return [
    artifactContext("frozen_work_list", freezeId, "frozen_work_list", {
      what: "Runtime-validated frozen work list.",
      why: "The publisher needs the fixed item order and contracts."
    }),
    artifactContext("item_handoffs", runItemsId, "item_handoffs", {
      ...(options.iteration ? { iteration: options.iteration } : {}),
      what: "Human-readable item handoffs.",
      why: "The publisher needs item evidence for the final summary and packet."
    }),
    artifactContext("verified_work_items", finalizeId, "work_items", {
      what: "Runtime-verified completed work item index.",
      why: "The publisher must only claim completed items from this verified artifact."
    })
  ];
}

function buildWorkListRubricGoal(criterion: PatternWorkListRubricCriterion): string {
  const targetDescription =
    criterion.target === "workspace"
      ? "the current workspace state, item handoffs, item results, validation evidence, and frozen work-list contract"
      : criterion.target === "item_handoff"
        ? "the item handoff and validation evidence"
        : "the frozen list, runtime ledger, and structured item results";

  return renderPrompt([
    body(`You are an evidence-based evaluator for work-list completion criterion \`${criterion.id}\`.`),
    section("Criterion", [
      `Rubric: ${criterion.rubric}`,
      `Target: ${criterion.target}`,
      `Weight: ${criterion.weight}`,
      `Required blocker: ${criterion.required === true ? "yes" : "no"}`
    ]),
    section("Evaluation Guidance", [
      `Grade only ${targetDescription}.`,
      "Give full credit when the evidence satisfies the criterion.",
      "Do not require work outside the frozen work-list contract.",
      "Withhold credit for missing item evidence, violated constraints, failed validation, or unsupported completion claims.",
      "Use score 0.85 or higher when the criterion is clearly satisfied; set `passed` true when the criterion is adequately satisfied."
    ]),
    section("Required JSON Output", [
      "Return valid JSON only:",
      '{"passed":true,"score":1,"summary":"short evidence-backed rationale","issues":[]}',
      "Score must be a number from 0 to 1."
    ])
  ]);
}

function buildWorkListCriterionContext(
  freezeId: string,
  runItemsId: string,
  criterion: PatternWorkListCompletionCriterion
): ContextItem[] {
  if (criterion.kind === "command") {
    return [
      artifactContext("item_validation", runItemsId, "item_validation"),
      artifactContext("item_results", runItemsId, "item_results")
    ];
  }

  if (criterion.target === "item_handoff") {
    return [
      artifactContext("item_handoffs", runItemsId, "item_handoffs"),
      artifactContext("item_validation", runItemsId, "item_validation")
    ];
  }

  if (criterion.target === "work_list_ledger") {
    return [
      artifactContext("frozen_work_list", freezeId, "frozen_work_list"),
      artifactContext("work_list_ledger", freezeId, "work_list_ledger"),
      artifactContext("item_results", runItemsId, "item_results")
    ];
  }

  return [
    artifactContext("frozen_work_list", freezeId, "frozen_work_list"),
    artifactContext("item_handoffs", runItemsId, "item_handoffs"),
    artifactContext("item_results", runItemsId, "item_results"),
    artifactContext("item_validation", runItemsId, "item_validation")
  ];
}

function buildWorkListCriterionNode(
  config: PatternWorkListConfig,
  freezeId: string,
  runItemsId: string,
  criterion: PatternWorkListCompletionCriterion,
  index: number
): CheckNode {
  const id = workflowNodeId(config.id, `criterion_${zeroPad(index + 1)}_${criterion.id}`);

  if (criterion.kind === "command") {
    return {
      type: "check",
      id,
      label: `Work List Criterion ${criterion.id}`,
      ...sharedNonPromptNodeBase(config),
      check_kind: "deterministic",
      command: "sh",
      args: ["-lc", criterion.command],
      on_failure: "continue",
      support: mergeSupportContext(
        sharedNonPromptNodeBase(config).support,
        buildWorkListCriterionContext(freezeId, runItemsId, criterion)
      ),
      intent: {
        goal: `Run deterministic work-list completion criterion \`${criterion.id}\`.`,
        acceptance_criteria: [
          "The command result is captured as completion feedback for the work-list gate."
        ],
        constraints: config.intent.constraints
      }
    };
  }

  return {
    type: "check",
    id,
    label: `Work List Criterion ${criterion.id}`,
    ...sharedAiCheckBase(config),
    check_kind: "ai",
    on_failure: "continue",
    support: mergeSupportContext(
      sharedAiCheckBase(config).support,
      buildWorkListCriterionContext(freezeId, runItemsId, criterion)
    ),
    rubric: criterion.rubric,
    intent: {
      goal: buildWorkListRubricGoal(criterion),
      acceptance_criteria: [
        "The evaluator returns valid JSON with passed, score, summary, and issues fields.",
        "The evaluator grades only evidence in context and does not require work outside the frozen work-list contract."
      ],
      constraints: config.intent.constraints
    }
  };
}

function buildWorkListGateContext(
  config: PatternWorkListConfig,
  freezeId: string,
  runItemsId: string
): ContextItem[] {
  const worker = config.work_list.item_worker;
  const criteria = worker.kind === "deep_work" ? worker.completion.criteria : [];

  return [
    artifactContext("frozen_work_list", freezeId, "frozen_work_list"),
    artifactContext("item_results", runItemsId, "item_results"),
    artifactContext("item_handoffs", runItemsId, "item_handoffs"),
    ...criteria.flatMap((criterion, index) => {
      const suffix = zeroPad(index + 1);
      const criterionId = workflowNodeId(config.id, `criterion_${suffix}_${criterion.id}`);
      const contexts: ContextItem[] = [
        artifactContext(`criterion_${suffix}_result`, criterionId, "verification_json")
      ];

      if (criterion.kind === "command") {
        contexts.push(
          artifactContext(`criterion_${suffix}_stdout`, criterionId, "stdout", {
            if_available: true
          }),
          artifactContext(`criterion_${suffix}_stderr`, criterionId, "stderr", {
            if_available: true
          })
        );
      }

      return contexts;
    })
  ];
}

function buildWorkListGateScript(criteria: PatternWorkListCompletionCriterion[], passThreshold: number): string {
  const criterionRecords = criteria.map((criterion, index) => ({
    id: criterion.id,
    kind: criterion.kind,
    weight: criterion.weight,
    required: criterion.required === true,
    context_key: `CRITERION_${zeroPad(index + 1)}_RESULT`,
    ...(criterion.kind === "command"
      ? {
          stdout_key: `CRITERION_${zeroPad(index + 1)}_STDOUT`,
          stderr_key: `CRITERION_${zeroPad(index + 1)}_STDERR`
        }
      : {})
  }));

  return `
const fs = require("node:fs");
const path = require("node:path");
const criteria = ${JSON.stringify(criterionRecords)};
const passThreshold = ${JSON.stringify(passThreshold)};
const out = process.env.AGENTFLOW_OUTPUT_DIR;

function readJson(label, pointerPath) {
  if (!pointerPath) {
    return { ok: false, error: label + " pointer was not available." };
  }
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(pointerPath, "utf8")) };
  } catch (error) {
    return { ok: false, error: label + " could not be read: " + (error && error.message ? error.message : String(error)) };
  }
}

function readOptionalText(contextKey) {
  if (!contextKey) return undefined;
  const pointerPath = process.env["AGENTFLOW_CONTEXT_" + contextKey];
  if (!pointerPath) return undefined;
  try {
    const text = fs.readFileSync(pointerPath, "utf8");
    if (!text.trim()) return undefined;
    return text.length > 4000 ? text.slice(0, 4000) + "\\n...[truncated]" : text;
  } catch {
    return undefined;
  }
}

function readCriterion(record) {
  const envName = "AGENTFLOW_CONTEXT_" + record.context_key;
  const pointerPath = process.env[envName];
  if (!pointerPath) {
    return {
      id: record.id,
      kind: record.kind,
      weight: record.weight,
      required: record.required,
      passed: false,
      score: 0,
      summary: "Criterion result pointer was not available.",
      evidence_path: null
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
    const passed = parsed.passed === true;
    const rawScore = typeof parsed.score === "number" ? parsed.score : passed ? 1 : 0;
    const score = Math.max(0, Math.min(1, rawScore));
    return {
      id: record.id,
      kind: record.kind,
      weight: record.weight,
      required: record.required,
      passed,
      score,
      weighted_score: score * record.weight,
      summary: typeof parsed.summary === "string" ? parsed.summary : passed ? "Criterion passed." : "Criterion failed.",
      evidence_path: pointerPath,
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      stdout_excerpt: readOptionalText(record.stdout_key),
      stderr_excerpt: readOptionalText(record.stderr_key)
    };
  } catch (error) {
    return {
      id: record.id,
      kind: record.kind,
      weight: record.weight,
      required: record.required,
      passed: false,
      score: 0,
      weighted_score: 0,
      summary: "Criterion result could not be read: " + (error && error.message ? error.message : String(error)),
      evidence_path: pointerPath,
      issues: ["criterion_result_unreadable"]
    };
  }
}

const frozenRead = readJson("frozen work list", process.env.AGENTFLOW_CONTEXT_FROZEN_WORK_LIST);
const resultsRead = readJson("item results", process.env.AGENTFLOW_CONTEXT_ITEM_RESULTS);
let itemCompletion = {
  id: "frozen_items_completed",
  kind: "deterministic",
  weight: 0,
  required: true,
  passed: false,
  score: 0,
  summary: frozenRead.error || resultsRead.error || "Frozen item completion could not be verified.",
  issues: ["work_list_unreadable"]
};

if (frozenRead.ok && resultsRead.ok) {
  const frozenItems = Array.isArray(frozenRead.value.items) ? frozenRead.value.items : [];
  const resultItems = Array.isArray(resultsRead.value.items) ? resultsRead.value.items : [];
  const resultById = new Map(resultItems.map((item) => [item && item.id, item]));
  const missing = [];
  const incomplete = [];
  for (const item of frozenItems) {
    const result = resultById.get(item.id);
    if (!result) missing.push(item.id);
    else if (result.status !== "completed") incomplete.push(item.id + ":" + (result.status || "missing_status"));
  }
  const extra = resultItems
    .map((item) => item && item.id)
    .filter((id) => typeof id === "string" && !frozenItems.some((item) => item.id === id));
  const passed = frozenItems.length > 0 && missing.length === 0 && incomplete.length === 0 && extra.length === 0;
  itemCompletion = {
    id: "frozen_items_completed",
    kind: "deterministic",
    weight: 0,
    required: true,
    passed,
    score: passed ? 1 : 0,
    summary: passed
      ? "Every frozen work-list item has a completed structured result."
      : "Item result mismatch. Missing: " + (missing.join(", ") || "none") + "; incomplete: " + (incomplete.join(", ") || "none") + "; extra: " + (extra.join(", ") || "none") + ".",
    issues: passed ? [] : ["frozen_item_result_mismatch"]
  };
}

const criterionResults = criteria.map(readCriterion);
const results = [itemCompletion, ...criterionResults];
const blockers = results
  .filter((result) => result.required && !result.passed)
  .map((result) => ({
    criterion_id: result.id,
    summary: result.summary
  }));
const totalScore = criterionResults.reduce((sum, result) => sum + (result.weighted_score ?? result.score * result.weight), 0);
const passed = blockers.length === 0 && totalScore >= passThreshold;
const failedCriteria = results.filter((result) => !result.passed || (result.weight > 0 && result.score * result.weight < result.weight));
const scorecard = {
  passed,
  total_score: Number(totalScore.toFixed(4)),
  pass_threshold: passThreshold,
  blockers,
  criteria: results,
  next_attempt_guidance: failedCriteria.map((result) => ({
    criterion_id: result.id,
    guidance: result.summary
  })),
  generated_at: new Date().toISOString()
};

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "scorecard.json"), JSON.stringify(scorecard, null, 2) + "\\n");
fs.writeFileSync(path.join(out, "verification.json"), JSON.stringify({
  passed,
  score: scorecard.total_score,
  summary: passed
    ? "Work-list completion criteria passed."
    : "Work-list completion criteria did not pass or frozen items were incomplete.",
  issues: blockers,
  check_kind: "deterministic"
}, null, 2) + "\\n");
`.trim();
}

export function buildPatternWorkList(config: PatternWorkListConfig): SequenceNode {
  const workflowId = workflowNodeId(config.id, "workflow");
  const planId = workflowNodeId(config.id, "plan");
  const freezeId = workflowNodeId(config.id, "freeze");
  const runItemsId = workflowNodeId(config.id, "run_items");
  const finalizeId = workflowNodeId(config.id, "finalize");
  const criteriaPanelId = workflowNodeId(config.id, "criteria_panel");
  const gateId = workflowNodeId(config.id, "completion_gate");
  const loopId = workflowNodeId(config.id, "work_loop");
  const loopBodyId = workflowNodeId(config.id, "work_loop_body");
  const agentShared = sharedAgentBase(config);
  const publicArtifacts = mergeArtifacts(defaultPatternWorkListPublicArtifacts(), config.artifacts ?? {});
  const itemWorker = config.work_list.item_worker;

  const planNode: AgentNode = {
    type: "agent",
    id: planId,
    label: "Plan Work List",
    ...agentShared,
    artifacts: mergeArtifacts(
      outputDirArtifact("work_list_md", "work-list.md", "Human-readable planned work-list rationale."),
      outputDirArtifact("work_list_json", "work-list.json", "Machine-readable planned work-list items.")
    ),
    intent: {
      goal: buildPlannerPrompt(config),
      acceptance_criteria: [
        "The work list is finite, ordered, and scoped to the managed node contract.",
        "The machine-readable list uses sequential ids w1, w2, w3, and so on.",
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
      buildRunnerContext(planId, freezeId, itemWorker.kind === "deep_work" ? gateId : undefined)
    ),
    artifacts: mergeArtifacts(
      outputDirArtifact("item_handoffs", "item-handoffs.md", "Human-readable handoffs for every frozen work-list item."),
      outputDirArtifact("item_results", "item-results.json", "Structured result for every frozen work-list item."),
      outputDirArtifact("item_validation", "item-validation.md", "Validation evidence for the executed work-list items.")
    ),
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

  const criterionNodes = itemWorker.kind === "deep_work"
    ? itemWorker.completion.criteria.map((criterion, index) =>
        buildWorkListCriterionNode(config, freezeId, runItemsId, criterion, index)
      )
    : [];

  const criteriaPanel: ParallelNode | undefined = itemWorker.kind === "deep_work"
    ? {
        type: "parallel",
        id: criteriaPanelId,
        label: "Work List Completion Criteria",
        max_concurrency: maxConcurrency(config.runtime, criterionNodes.length),
        steps: criterionNodes
      }
    : undefined;

  const gateNode: CheckNode | undefined = itemWorker.kind === "deep_work"
    ? {
        type: "check",
        id: gateId,
        label: "Work List Completion Gate",
        ...sharedNonPromptNodeBase(config),
        check_kind: "deterministic",
        command: "node",
        args: ["-e", buildWorkListGateScript(itemWorker.completion.criteria, itemWorker.completion.pass_threshold)],
        intent: {
          goal: "Aggregate work-list item completion and completion criterion results.",
          acceptance_criteria: [
            "The scorecard records frozen item completion and every completion criterion result.",
            "Required criterion failures block completion regardless of weighted score.",
            `The weighted score must meet or exceed ${itemWorker.completion.pass_threshold} to pass.`
          ],
          constraints: config.intent.constraints
        },
        pass_if: {
          json_path: "$.passed",
          equals: true
        },
        support: mergeSupportContext(
          sharedNonPromptNodeBase(config).support,
          buildWorkListGateContext(config, freezeId, runItemsId)
        ),
        artifacts: outputDirArtifact(
          "work_list_scorecard",
          "scorecard.json",
          "Weighted completion scorecard for the current frozen-list cycle."
        )
      }
    : undefined;

  const workLoop: RepeatNode | undefined =
    itemWorker.kind === "deep_work" && criteriaPanel && gateNode
      ? {
          type: "repeat",
          id: loopId,
          label: "Work List Item Loop",
          max_attempts: itemWorker.completion.max_cycles,
          body: {
            type: "sequence",
            id: loopBodyId,
            label: "Work List Item Loop Body",
            steps: [
              runItemsNode,
              criteriaPanel,
              gateNode
            ]
          },
          until: {
            node: gateId
          }
        }
      : undefined;

  const finalizeNode: ExecNode = {
    type: "exec",
    id: finalizeId,
    label: "Verify Work List Items",
    ...sharedNonPromptNodeBase(config),
    support: mergeSupportContext(
      sharedNonPromptNodeBase(config).support,
      buildFinalizeContext(freezeId, runItemsId, itemWorker.kind === "deep_work" ? { iteration: "latest_passed" } : {})
    ),
    command: "node",
    args: ["-e", buildFinalizeScript()],
    artifacts: outputDirArtifact("work_items", "work-items.json", "Runtime-verified completed work item index."),
    intent: {
      goal: "Verify every frozen work-list item completed and publish the stable work item index.",
      acceptance_criteria: [
        "The verified work item index includes exactly the frozen item ids.",
        "Every item is marked completed with summary and validation evidence.",
        "No dynamic item ids are exposed as graph-addressable artifacts."
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
      buildPublishContext(freezeId, runItemsId, finalizeId, itemWorker.kind === "deep_work" ? { iteration: "latest_passed" } : {})
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
        "The final public artifacts summarize the frozen list, completed items, validation evidence, residual risks, and downstream constraints.",
        "The public artifacts do not expose dynamic item refs as graph-addressable dependencies."
      ],
      constraints: config.intent.constraints
    }
  };

  return {
    type: "sequence",
    id: workflowId,
    label: config.label ? `${config.label} Workflow` : "Work List Workflow",
    steps: itemWorker.kind === "deep_work" && workLoop
      ? [
          planNode,
          freezeNode,
          workLoop,
          finalizeNode,
          publishNode
        ]
      : [
          planNode,
          freezeNode,
          runItemsNode,
          finalizeNode,
          publishNode
        ]
  };
}

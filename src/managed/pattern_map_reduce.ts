import type {
  AgentNode,
  ArtifactDefinition,
  BaseExecutableNode,
  ContextItem,
  ExecNode,
  ExecutableNodeIntent,
  SequenceNode
} from "../graph/authored.js";
import {
  artifactContext,
  body,
  managedPromptContract,
  managedId,
  mergeArtifacts,
  mergeSupportContext,
  outputDirArtifact,
  section,
  sharedAgentBase,
  sharedNonPromptNodeBase,
  type ManagedPatternAgentOptions,
  type ManagedPatternRuntime
} from "./foundation.js";

export interface PatternMapReduceItemsBlock {
  intent: ExecutableNodeIntent;
  max_items: number;
}

export interface PatternMapReduceMapBlock {
  intent: ExecutableNodeIntent;
  max_concurrency: number;
}

export interface PatternMapReduceReduceBlock {
  intent: ExecutableNodeIntent;
}

export interface PatternMapReduceBlock {
  items: PatternMapReduceItemsBlock;
  map: PatternMapReduceMapBlock;
  reduce: PatternMapReduceReduceBlock;
}

export interface PatternMapReduceConfig extends BaseExecutableNode, ManagedPatternAgentOptions {
  map_reduce: PatternMapReduceBlock;
  runtime?: ManagedPatternRuntime;
}

function workflowNodeId(rootId: string, suffix: string): string {
  return managedId(rootId, "pattern_map_reduce", suffix);
}

export function defaultPatternMapReducePublicArtifacts(): Record<string, ArtifactDefinition> {
  return outputDirArtifact("aggregate", "aggregate.json", "Machine-readable aggregate evidence packet for the managed map-reduce result.");
}

function listOrFallback(title: string, values: string[] | undefined, fallback: string): string[] {
  return values && values.length > 0
    ? [title, ...values.map((value) => `- ${value}`)]
    : [`${title}: ${fallback}`];
}

function buildPlannerPrompt(config: PatternMapReduceConfig) {
  return managedPromptContract("plan_items", "Discover the finite independent item set needed to satisfy the items contract.", [
    body("You are discovering the finite independent item set for this task. Do not edit source files in this phase."),
    section("Task Contract", [
      `Goal: ${config.intent.goal}`,
      ...listOrFallback("Acceptance criteria", config.intent.acceptance_criteria, "Use the graph and node acceptance criteria."),
      ...listOrFallback("Constraints", config.intent.constraints, "Stay inside the authored task contract.")
    ]),
    section("Items Contract", [
      `Goal: ${config.map_reduce.items.intent.goal}`,
      ...listOrFallback("Acceptance criteria", config.map_reduce.items.intent.acceptance_criteria, "Produce a finite item list with enough evidence to map each item."),
      ...listOrFallback("Constraints", config.map_reduce.items.intent.constraints, "Stay inside the authored item discovery contract."),
      `Maximum items: ${config.map_reduce.items.max_items}`
    ]),
    section("Discovery Rules", [
      "Select only items needed for the parent task.",
      "Each item must be independently inspectable by one map worker.",
      "Do not decide item passed/finding/skipped/blocked status during discovery.",
      "Record omitted candidates and uncertainty when they affect coverage claims.",
      "Do not edit source files."
    ]),
    section("Output Contract", [
      "Publish only the `item_list_json` artifact.",
      "Use `af artifact write item_list_json` to publish the item list JSON.",
      "Use stable item ids starting at `m1` with no gaps.",
      "Use this JSON shape:",
      '{"items":[{"id":"m1","title":"short label","input":{"path":"source/file.ts"},"scope_rationale":"why this item is in scope","evidence_refs":["source/file.ts"]}],"omissions":[],"uncertainty":[]}',
      "Include enough input and scope rationale for a worker to inspect one item without rediscovering the list."
    ])
  ]);
}

function buildMapPrompt(config: PatternMapReduceConfig) {
  return managedPromptContract("map_items", "Inspect/process one frozen item at a time.", [
    body("Each item worker judges exactly one current item."),
    section("Task Contract", [
      `Goal: ${config.intent.goal}`,
      ...listOrFallback("Acceptance criteria", config.intent.acceptance_criteria, "Use the graph and node acceptance criteria."),
      ...listOrFallback("Constraints", config.intent.constraints, "Stay inside the authored task contract.")
    ]),
    section("Map Contract", [
      `Goal: ${config.map_reduce.map.intent.goal}`,
      ...listOrFallback("Acceptance criteria", config.map_reduce.map.intent.acceptance_criteria, "Produce one evidence-backed item result."),
      ...listOrFallback("Constraints", config.map_reduce.map.intent.constraints, "Stay inside the authored map contract."),
      `Maximum concurrency: ${config.map_reduce.map.max_concurrency}`
    ]),
    section("Frozen Item Discipline", [
      "Judge exactly the current item.",
      "Do not add, remove, split, merge, or reorder items.",
      "Do not rediscover the item list.",
      "Inspect related files or shared code only when needed as evidence for the current item.",
      "If the current item cannot be judged, return blocked with concrete missing-evidence details."
    ]),
    section("Output Contract", [
      "Each item worker publishes one `item_result` artifact for the current item id.",
      "Set status to passed, finding, skipped, or blocked.",
      "Cite concrete evidence for passed, finding, and skipped.",
      "Include findings only when the status is finding.",
      "Write only the current item result.",
      "Do not make whole-list coverage claims."
    ])
  ]);
}

function buildFreezeScript(maxItems: number): string {
  return String.raw`
const fs = require("node:fs");
const path = require("node:path");
const maxItems = ${JSON.stringify(maxItems)};

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail("Failed to parse item-list JSON: " + (error && error.message ? error.message : String(error)));
  }
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim()) : [];
}

const sourcePath = process.env.AGENTFLOW_CONTEXT_ITEM_LIST_JSON;
const outputDir = process.env.AGENTFLOW_OUTPUT_DIR;
if (!sourcePath) fail("Missing AGENTFLOW_CONTEXT_ITEM_LIST_JSON.");
if (!outputDir) fail("Missing AGENTFLOW_OUTPUT_DIR.");

const raw = readJson(sourcePath);
if (!raw || typeof raw !== "object" || !Array.isArray(raw.items)) {
  fail('item-list.json must be an object with an "items" array.');
}
if (raw.items.length === 0) {
  fail("item-list.json must include at least one item.");
}
if (raw.items.length > maxItems) {
  fail("Maximum item count is ${maxItems}.");
}

const seen = new Set();
const items = raw.items.map((item, index) => {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    fail("Map-reduce item " + (index + 1) + " must be an object.");
  }
  const expectedId = "m" + (index + 1);
  if (item.id !== expectedId) {
    fail("Map-reduce item " + (index + 1) + " must use sequential id " + expectedId + ".");
  }
  if (seen.has(item.id)) {
    fail("Duplicate map-reduce item id " + item.id + ".");
  }
  seen.add(item.id);
  const title = typeof item.title === "string" ? item.title.trim() : "";
  const scopeRationale = typeof item.scope_rationale === "string" ? item.scope_rationale.trim() : "";
  if (title.length < 3) fail("Map-reduce item " + item.id + " needs a concrete title.");
  if (!item.input || typeof item.input !== "object" || Array.isArray(item.input)) {
    fail("Map-reduce item " + item.id + " needs an input object.");
  }
  if (scopeRationale.length < 12) fail("Map-reduce item " + item.id + " needs a concrete scope_rationale.");
  return {
    id: item.id,
    title,
    input: item.input,
    scope_rationale: scopeRationale,
    evidence_refs: stringArray(item.evidence_refs)
  };
});

const frozen = {
  schema_version: 1,
  status: "frozen",
  frozen_at: new Date().toISOString(),
  source_path: sourcePath,
  items,
  omissions: stringArray(raw.omissions),
  uncertainty: stringArray(raw.uncertainty)
};

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, "items-frozen.json"), JSON.stringify(frozen, null, 2) + "\n");
console.log("Frozen " + items.length + " map-reduce item(s).");
`;
}

function buildReduceScript(aggregatePath: string): string {
  return String.raw`
const fs = require("node:fs");
const path = require("node:path");
const aggregatePath = ${JSON.stringify(aggregatePath)};
const statuses = ["passed", "finding", "skipped", "blocked"];

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

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function evidenceArray(value, itemId, status) {
  if (status === "blocked" && value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail("Item " + itemId + " evidence must be an array.");
  }
  const evidence = value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail("Item " + itemId + " evidence[" + index + "] must be an object.");
    }
    if (!nonEmptyString(entry.ref) || !nonEmptyString(entry.summary)) {
      fail("Item " + itemId + " evidence[" + index + "] must include ref and summary.");
    }
    return { ref: entry.ref.trim(), summary: entry.summary.trim() };
  });
  if (status !== "blocked" && evidence.length === 0) {
    fail("Item " + itemId + " requires evidence for status " + status + ".");
  }
  return evidence;
}

const frozen = readJson("frozen items", process.env.AGENTFLOW_CONTEXT_FROZEN_ITEMS);
const results = readJson("item results", process.env.AGENTFLOW_CONTEXT_ITEM_RESULTS);
const outputDir = process.env.AGENTFLOW_OUTPUT_DIR;
if (!outputDir) fail("Missing AGENTFLOW_OUTPUT_DIR.");
if (!frozen || !Array.isArray(frozen.items) || frozen.items.length === 0) {
  fail("Frozen items artifact is missing items.");
}
if (!results || !Array.isArray(results.items)) {
  fail('item-results.json must be an object with an "items" array.');
}
if (results.schema_version !== 1) {
  fail("item-results.json must use schema_version 1.");
}
if (results.status !== "completed") {
  fail('item-results.json status must be "completed".');
}

const frozenIds = new Set(frozen.items.map((item) => item.id));
if (results.items.length !== frozen.items.length) {
  fail("item-results.json must contain exactly one result per frozen item.");
}
const seenResultIds = new Set();
results.items.forEach((item, index) => {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    fail("item-results.json item " + (index + 1) + " must be an object.");
  }
  if (!nonEmptyString(item.id)) {
    fail("item-results.json item " + (index + 1) + " requires an id.");
  }
  if (seenResultIds.has(item.id)) {
    fail("item-results.json contains duplicate result id " + item.id + ".");
  }
  seenResultIds.add(item.id);
  if (!frozenIds.has(item.id)) {
    fail("item-results.json contains id not present in the frozen list: " + item.id + ".");
  }
});

const resultById = new Map(results.items.map((item) => [item && item.id, item]));
const counts = { passed: 0, finding: 0, skipped: 0, blocked: 0 };
const aggregateItems = frozen.items.map((item) => {
  const result = resultById.get(item.id);
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    fail("Missing result for frozen item " + item.id + ".");
  }
  if (result.id !== item.id) {
    fail("Result id for frozen item " + item.id + " does not match.");
  }
  if (!statuses.includes(result.status)) {
    fail("Item " + item.id + " status must be passed, finding, skipped, or blocked.");
  }
  if (!nonEmptyString(result.summary)) {
    fail("Item " + item.id + " requires a summary.");
  }
  const evidence = evidenceArray(result.evidence, item.id, result.status);
  const findings = Array.isArray(result.findings) ? result.findings : [];
  if (result.status === "finding" && findings.length === 0) {
    fail("Item " + item.id + " with finding status requires at least one finding.");
  }
  if (result.status !== "finding" && findings.length > 0) {
    fail("Item " + item.id + " with status " + result.status + " must not include findings.");
  }
  if (result.status === "skipped" && !nonEmptyString(result.skip_rationale)) {
    fail("Item " + item.id + " with skipped status requires skip_rationale.");
  }
  if (result.status === "blocked" && !nonEmptyString(result.blocker)) {
    fail("Item " + item.id + " with blocked status requires blocker.");
  }
  counts[result.status] += 1;
  return {
    id: item.id,
    title: item.title,
    input: item.input,
    scope_rationale: item.scope_rationale,
    status: result.status,
    summary: result.summary.trim(),
    evidence,
    findings,
    ...(result.skip_rationale ? { skip_rationale: result.skip_rationale } : {}),
    ...(result.blocker ? { blocker: result.blocker } : {})
  };
});

const aggregate = {
  schema_version: 1,
  status: "completed",
  generated_at: new Date().toISOString(),
  item_count: aggregateItems.length,
  coverage: {
    selected: aggregateItems.length,
    omissions: Array.isArray(frozen.omissions) ? frozen.omissions : [],
    uncertainty: Array.isArray(frozen.uncertainty) ? frozen.uncertainty : []
  },
  counts,
  findings: aggregateItems.flatMap((item) => item.findings.map((finding) => ({ item_id: item.id, title: item.title, finding }))),
  blockers: aggregateItems.filter((item) => item.status === "blocked").map((item) => ({ item_id: item.id, title: item.title, blocker: item.blocker })),
  skipped: aggregateItems.filter((item) => item.status === "skipped").map((item) => ({ item_id: item.id, title: item.title, skip_rationale: item.skip_rationale })),
  evidence: aggregateItems.flatMap((item) => item.evidence.map((evidence) => ({ item_id: item.id, ...evidence }))),
  items: aggregateItems,
  residual_uncertainty: Array.isArray(frozen.uncertainty) ? frozen.uncertainty : []
};

fs.mkdirSync(outputDir, { recursive: true });
fs.mkdirSync(path.dirname(path.join(outputDir, aggregatePath)), { recursive: true });
fs.writeFileSync(path.join(outputDir, aggregatePath), JSON.stringify(aggregate, null, 2) + "\n");
console.log("Reduced " + aggregateItems.length + " map-reduce item result(s). Do not claim coverage beyond the frozen list, omissions, and uncertainty recorded by discovery.");
`;
}

function buildMapContext(freezeId: string): ContextItem[] {
  return [
    artifactContext("frozen_items", freezeId, "frozen_items", {
      what: "Runtime-validated frozen map-reduce item list.",
      why: "Each map worker must judge exactly one frozen item without changing the list."
    })
  ];
}

function buildReduceContext(freezeId: string, mapItemsId: string): ContextItem[] {
  return [
    artifactContext("frozen_items", freezeId, "frozen_items", {
      what: "Runtime-validated frozen map-reduce item list.",
      why: "The reducer must compare item results against the exact frozen list."
    }),
    artifactContext("item_results", mapItemsId, "item_results", {
      what: "Accepted structured results from map workers.",
      why: "The reducer aggregates only accepted item result evidence."
    })
  ];
}

export function buildPatternMapReduce(config: PatternMapReduceConfig): SequenceNode {
  const workflowId = workflowNodeId(config.id, "workflow");
  const planId = workflowNodeId(config.id, "plan_items");
  const freezeId = workflowNodeId(config.id, "freeze");
  const mapItemsId = workflowNodeId(config.id, "map_items");
  const agentShared = sharedAgentBase(config);
  const publicArtifacts = defaultPatternMapReducePublicArtifacts();

  const planNode: AgentNode = {
    type: "agent",
    id: planId,
    label: "Plan Map Items",
    ...agentShared,
    artifacts: mergeArtifacts(
      outputDirArtifact("item_list_json", "item-list.json", "Machine-readable finite independent map item list.")
    ),
    managed_runtime: {
      kind: "pattern_map_reduce",
      root_id: config.id,
      phase: "plan_items"
    },
    intent: {
      goal: "Discover the finite independent item set needed to satisfy the items contract. Do not edit source files in this planning phase.",
      acceptance_criteria: [
        "The item list is finite and scoped to the task contract.",
        "The machine-readable list uses sequential ids m1, m2, m3, and so on.",
        "Every item has input, title, scope rationale, and evidence references when relevant.",
        "The planner records omissions and uncertainty when they affect coverage claims."
      ],
      constraints: [
        ...config.intent.constraints,
        ...config.map_reduce.items.intent.constraints
      ]
    },
    managed_prompt: buildPlannerPrompt(config)
  };

  const freezeNode: ExecNode = {
    type: "exec",
    id: freezeId,
    label: "Freeze Map Items",
    ...sharedNonPromptNodeBase(config),
    support: mergeSupportContext(sharedNonPromptNodeBase(config).support, [
      artifactContext("item_list_json", planId, "item_list_json", {
        what: "Machine-readable planned map-reduce items.",
        why: "The freeze step validates and freezes this list before map execution."
      })
    ]),
    command: "node",
    args: ["-e", buildFreezeScript(config.map_reduce.items.max_items)],
    artifacts: mergeArtifacts(
      outputDirArtifact("frozen_items", "items-frozen.json", "Runtime-validated frozen map-reduce item list.")
    ),
    intent: {
      goal: "Validate and freeze the planned map-reduce item list before item execution starts.",
      acceptance_criteria: [
        "The frozen item list has a finite non-empty item array.",
        "Every item has a sequential id, input, title, and scope rationale.",
        "The frozen item list preserves omissions and uncertainty."
      ],
      constraints: config.intent.constraints
    }
  };

  const mapItemsNode: AgentNode = {
    type: "agent",
    id: mapItemsId,
    label: "Map Items",
    ...agentShared,
    support: mergeSupportContext(
      agentShared.support,
      buildMapContext(freezeId)
    ),
    artifacts: mergeArtifacts(
      outputDirArtifact("item_results", "item-results.json", "Accepted structured result for every frozen map-reduce item.")
    ),
    managed_runtime: {
      kind: "pattern_map_reduce",
      root_id: config.id,
      phase: "map_items",
      config: {
        parent_intent: config.intent,
        map_intent: config.map_reduce.map.intent,
        max_concurrency: config.map_reduce.map.max_concurrency
      }
    },
    intent: {
      goal: "Run map workers for frozen items and publish structured item results without mutating the frozen list.",
      acceptance_criteria: [
        "Every frozen item has one terminal result entry.",
        "Item results use status passed, finding, skipped, or blocked.",
        "Passed, finding, and skipped item results cite concrete evidence.",
        "The worker does not add, remove, split, merge, or reorder frozen items."
      ],
      constraints: [
        ...config.intent.constraints,
        ...config.map_reduce.map.intent.constraints
      ]
    },
    managed_prompt: buildMapPrompt(config)
  };

  const reduceNode: ExecNode = {
    type: "exec",
    id: config.id,
    ...(config.label ? { label: config.label } : { label: "Reduce Map Results" }),
    ...sharedNonPromptNodeBase(config),
    support: mergeSupportContext(
      sharedNonPromptNodeBase(config).support,
      buildReduceContext(freezeId, mapItemsId)
    ),
    command: "node",
    args: ["-e", buildReduceScript(publicArtifacts.aggregate!.path)],
    artifacts: publicArtifacts,
    intent: {
      goal: [
        config.map_reduce.reduce.intent.goal,
        "Validate item results and publish the stable map-reduce aggregate artifact."
      ].join("\n\n"),
      acceptance_criteria: [
        ...config.map_reduce.reduce.intent.acceptance_criteria,
        "The aggregate includes coverage, counts, findings, blockers, skipped items, evidence, and residual uncertainty.",
        "The aggregate includes exactly the frozen item ids."
      ],
      constraints: [
        ...config.intent.constraints,
        ...config.map_reduce.reduce.intent.constraints
      ]
    }
  };

  return {
    type: "sequence",
    id: workflowId,
    label: config.label ? `${config.label} Workflow` : "Map Reduce Workflow",
    steps: [
      planNode,
      freezeNode,
      mapItemsNode,
      reduceNode
    ]
  };
}

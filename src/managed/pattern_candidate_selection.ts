import type {
  AgentNode,
  ArtifactDefinition,
  BaseExecutableNode,
  CheckNode,
  ContextItem,
  ExecNode,
  ExecutableNodeIntent,
  ParallelNode,
  SequenceNode
} from "../graph/authored.js";
import {
  artifactContext,
  body,
  managedId,
  managedPromptContract,
  maxConcurrency,
  mergeSupportContext,
  renderPrompt,
  section,
  sharedAgentBase,
  sharedAiCheckBase,
  sharedNonPromptNodeBase,
  type ManagedPatternAgentOptions,
  type ManagedPatternRuntime
} from "./foundation.js";

export interface PatternCandidateSelectionCandidate {
  id: string;
  intent: ExecutableNodeIntent;
}

export interface PatternCandidateSelectionCriterion {
  id: string;
  weight: number;
  required?: boolean;
  rubric: string;
}

export interface PatternCandidateSelectionBlock {
  candidates: PatternCandidateSelectionCandidate[];
  pass_threshold: number;
  criteria: PatternCandidateSelectionCriterion[];
}

export interface PatternCandidateSelectionConfig extends BaseExecutableNode, ManagedPatternAgentOptions {
  selection: PatternCandidateSelectionBlock;
  runtime?: ManagedPatternRuntime;
}

function workflowNodeId(rootId: string, suffix: string): string {
  return managedId(rootId, "pattern_candidate_selection", suffix);
}

function candidateNodeId(rootId: string, candidateId: string): string {
  return workflowNodeId(rootId, `candidate_${candidateId}`);
}

function criterionNodeId(rootId: string, candidateId: string, criterionId: string): string {
  return workflowNodeId(rootId, `criterion_${candidateId}_${criterionId}`);
}

function contextKey(name: string): string {
  return name.toUpperCase();
}

function candidateContextName(candidateId: string): string {
  return `candidate_${candidateId}`;
}

function criterionContextName(candidateId: string, criterionId: string): string {
  return `criterion_${candidateId}_${criterionId}`;
}

export function defaultPatternCandidateSelectionPublicArtifacts(): Record<string, ArtifactDefinition> {
  return {
    selection: {
      from: "output_dir",
      path: "selection.json",
      description: "Machine-readable selected candidate packet with ranking, scorecards, rejected candidates, diversity evidence, and residual uncertainty."
    }
  };
}

function listOrFallback(title: string, values: string[] | undefined, fallback: string): string[] {
  return values && values.length > 0
    ? [title, ...values.map((value) => `- ${value}`)]
    : [`${title}: ${fallback}`];
}

function formatCriteria(criteria: PatternCandidateSelectionCriterion[]): string[] {
  return criteria.map((criterion) => {
    const required = criterion.required ? "required" : "weighted";
    return `- ${criterion.id} (${required}, weight ${criterion.weight}): ${criterion.rubric}`;
  });
}

function buildCandidatePrompt(
  config: PatternCandidateSelectionConfig,
  candidate: PatternCandidateSelectionCandidate
) {
  return managedPromptContract("candidate", `Develop candidate strategy ${candidate.id}.`, [
    body("You are developing one candidate strategy for a decision. Do not edit source files."),
    section("Decision Contract", [
      `Goal: ${config.intent.goal}`,
      ...listOrFallback("Acceptance criteria", config.intent.acceptance_criteria, "Produce a strategy that can be compared fairly."),
      ...listOrFallback("Constraints", config.intent.constraints, "Stay inside the authored decision contract.")
    ]),
    section("Candidate Contract", [
      `Candidate id: ${candidate.id}`,
      `Goal: ${candidate.intent.goal}`,
      ...listOrFallback("Acceptance criteria", candidate.intent.acceptance_criteria, "Produce a complete candidate strategy packet."),
      ...listOrFallback("Constraints", candidate.intent.constraints, "Stay inside the authored candidate contract.")
    ]),
    section("Shared Decision Criteria", formatCriteria(config.selection.criteria)),
    section("Candidate Output Contract", [
      "Publish only the `candidate_json` artifact.",
      "Use `af artifact write candidate_json` to publish the candidate JSON.",
      "Use this JSON shape:",
      '{"schema_version":1,"id":"<candidate id>","title":"short title","summary":"short summary","approach":"primary approach","implementation_outline":["step or design element"],"validation_plan":["validation evidence"],"risks":["risk"],"assumptions":["assumption"],"evidence":[{"ref":"file/path or source","summary":"what the evidence supports"}],"residual_uncertainty":[]}',
      "The `id` must exactly match the current candidate id.",
      "The candidate must be implementation-ready, evidence-backed, and meaningfully distinct from the other authored candidate strategies.",
      "Do not claim source edits are complete."
    ])
  ]);
}

function buildDiversityRubric(config: PatternCandidateSelectionConfig): string {
  return renderPrompt([
    body("Evaluate whether the candidate strategies are materially distinct."),
    section("Decision Contract", [
      `Goal: ${config.intent.goal}`,
      ...listOrFallback("Acceptance criteria", config.intent.acceptance_criteria, "The selected strategy is defensible.")
    ]),
    section("Candidate Lanes", config.selection.candidates.map((candidate) =>
      `- ${candidate.id}: ${candidate.intent.goal}`
    )),
    section("Evaluation Guidance", [
      "Pass only when candidates differ materially in primary strategy, tradeoff profile, and implementation outline.",
      "Do fail wording variants, duplicated plans, or candidates that collapse into the same implementation approach.",
      "Do not penalize shared facts or shared repository evidence when the strategy and tradeoffs are genuinely different."
    ]),
    section("Required JSON Output", [
      "Return valid JSON only:",
      '{"passed":true,"score":1,"summary":"short evidence-backed rationale","issues":[]}',
      "Score must be a number from 0 to 1."
    ])
  ]);
}

function buildCriterionRubric(
  config: PatternCandidateSelectionConfig,
  candidate: PatternCandidateSelectionCandidate,
  criterion: PatternCandidateSelectionCriterion
): string {
  return renderPrompt([
    body(`You are an evidence-based evaluator for candidate \`${candidate.id}\` and selection criterion \`${criterion.id}\`.`),
    section("Criterion", [
      `Rubric: ${criterion.rubric}`,
      `Weight: ${criterion.weight}`,
      `Required blocker: ${criterion.required === true ? "yes" : "no"}`
    ]),
    section("Candidate Lane", [
      `Candidate id: ${candidate.id}`,
      `Candidate goal: ${candidate.intent.goal}`,
      ...listOrFallback("Candidate acceptance criteria", candidate.intent.acceptance_criteria, "Use the candidate packet and evidence in context."),
      ...listOrFallback("Candidate constraints", candidate.intent.constraints, "Stay inside the authored candidate contract.")
    ]),
    section("Evaluation Guidance", [
      "Grade only this candidate packet and supporting context.",
      "Give full credit when the candidate satisfies the criterion with concrete evidence.",
      "Do not compare against other candidates in this criterion check.",
      "Do withhold credit for unsupported claims, violated constraints, missing validation plans, or implementation outlines that are not actionable.",
      `Use score ${config.selection.pass_threshold} or higher when this criterion is clearly satisfied; set \`passed\` true when the candidate adequately satisfies the criterion.`
    ]),
    section("Required JSON Output", [
      "Return valid JSON only:",
      '{"passed":true,"score":1,"summary":"short evidence-backed rationale","issues":[]}',
      "Score must be a number from 0 to 1."
    ])
  ]);
}

function buildSelectorScript(config: PatternCandidateSelectionConfig, selectionPath: string): string {
  const candidates = config.selection.candidates.map((candidate, index) => ({
    id: candidate.id,
    order: index,
    context_key: contextKey(candidateContextName(candidate.id))
  }));
  const criteria = config.selection.criteria.map((criterion) => ({
    id: criterion.id,
    weight: criterion.weight,
    required: criterion.required === true,
    rubric: criterion.rubric
  }));
  const criterionPointers = config.selection.candidates.flatMap((candidate) =>
    config.selection.criteria.map((criterion) => ({
      candidate_id: candidate.id,
      criterion_id: criterion.id,
      context_key: contextKey(criterionContextName(candidate.id, criterion.id))
    }))
  );

  return String.raw`
const fs = require("node:fs");
const path = require("node:path");
const candidates = ${JSON.stringify(candidates)};
const criteria = ${JSON.stringify(criteria)};
const criterionPointers = ${JSON.stringify(criterionPointers)};
const passThreshold = ${JSON.stringify(config.selection.pass_threshold)};
const selectionPath = ${JSON.stringify(selectionPath)};
const out = process.env.AGENTFLOW_OUTPUT_DIR;

function fail(message, packet) {
  if (packet) writeSelection(packet);
  console.error(message);
  process.exit(1);
}

function writeSelection(packet) {
  if (!out) {
    console.error("Missing AGENTFLOW_OUTPUT_DIR.");
    process.exit(1);
  }
  const destination = path.join(out, selectionPath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(packet, null, 2) + "\n");
}

function pointerFor(contextKey) {
  return process.env["AGENTFLOW_CONTEXT_" + contextKey];
}

function readJsonContext(contextKey, label) {
  const pointer = pointerFor(contextKey);
  if (!pointer) {
    throw new Error("Missing " + label + " context pointer.");
  }
  try {
    return { path: pointer, value: JSON.parse(fs.readFileSync(pointer, "utf8")) };
  } catch (error) {
    throw new Error("Failed to parse " + label + ": " + (error && error.message ? error.message : String(error)));
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function nonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function validateCandidate(record, expected) {
  const errors = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return ["Candidate packet for " + expected.id + " must be a JSON object."];
  }
  if (record.schema_version !== 1) errors.push("Candidate packet for " + expected.id + " must use schema_version 1.");
  if (record.id !== expected.id) {
    errors.push('Candidate packet id "' + String(record.id) + '" does not match authored candidate "' + expected.id + '".');
  }
  for (const field of ["title", "summary", "approach"]) {
    if (!nonEmptyString(record[field])) errors.push("Candidate " + expected.id + " requires non-empty " + field + ".");
  }
  for (const field of ["implementation_outline", "validation_plan", "risks", "assumptions", "evidence"]) {
    if (!nonEmptyArray(record[field])) errors.push("Candidate " + expected.id + " requires non-empty " + field + ".");
  }
  if (Array.isArray(record.evidence)) {
    record.evidence.forEach((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || !nonEmptyString(entry.ref) || !nonEmptyString(entry.summary)) {
        errors.push("Candidate " + expected.id + " evidence[" + index + "] must include non-empty ref and summary.");
      }
    });
  }
  return errors;
}

function normalizeCriterionResult(raw, pointer, criterion) {
  const passed = raw && typeof raw === "object" && raw.passed === true;
  const rawScore = raw && typeof raw === "object" && typeof raw.score === "number" ? raw.score : passed ? 1 : 0;
  const score = Math.max(0, Math.min(1, rawScore));
  return {
    id: criterion.id,
    weight: criterion.weight,
    required: criterion.required === true,
    passed,
    score,
    weighted_score: Number((score * criterion.weight).toFixed(4)),
    summary: raw && typeof raw === "object" && typeof raw.summary === "string"
      ? raw.summary
      : passed ? "Criterion passed." : "Criterion failed.",
    issues: raw && typeof raw === "object" && Array.isArray(raw.issues) ? raw.issues : [],
    evidence_path: pointer
  };
}

function requiredCriterionBlocker(result) {
  if (!result.required) return null;
  if (!result.passed) {
    return { criterion_id: result.id, summary: result.summary };
  }
  if (result.score < passThreshold) {
    return {
      criterion_id: result.id,
      summary: result.summary + " Required criterion score " + result.score.toFixed(2) + " is below the pass threshold " + passThreshold.toFixed(2) + "."
    };
  }
  return null;
}

if (!out) {
  console.error("Missing AGENTFLOW_OUTPUT_DIR.");
  process.exit(1);
}

let diversity;
try {
  diversity = readJsonContext("DIVERSITY_RESULT", "diversity result");
} catch (error) {
  fail(error.message, {
    schema_version: 1,
    status: "diversity_failed",
    generated_at: new Date().toISOString(),
    selected_candidate_id: null,
    error: error.message,
    pass_threshold: passThreshold
  });
}

const diversityValue = diversity.value && typeof diversity.value === "object" ? diversity.value : {};
const diversityPacket = {
  passed: diversityValue.passed === true,
  score: typeof diversityValue.score === "number" ? Math.max(0, Math.min(1, diversityValue.score)) : diversityValue.passed === true ? 1 : 0,
  summary: typeof diversityValue.summary === "string" ? diversityValue.summary : "Diversity result did not include a summary.",
  issues: Array.isArray(diversityValue.issues) ? diversityValue.issues : [],
  evidence_path: diversity.path
};
if (!diversityPacket.passed) {
  fail("Candidate diversity check did not pass.", {
    schema_version: 1,
    status: "diversity_failed",
    generated_at: new Date().toISOString(),
    selected_candidate_id: null,
    diversity: diversityPacket,
    pass_threshold: passThreshold
  });
}

const candidatePackets = [];
const candidateErrors = [];
for (const candidate of candidates) {
  try {
    const parsed = readJsonContext(candidate.context_key, "candidate " + candidate.id);
    const errors = validateCandidate(parsed.value, candidate);
    if (errors.length > 0) {
      candidateErrors.push(...errors.map((message) => ({ candidate_id: candidate.id, message, evidence_path: parsed.path })));
    }
    candidatePackets.push({ ...parsed.value, evidence_path: parsed.path, authored_order: candidate.order });
  } catch (error) {
    candidateErrors.push({ candidate_id: candidate.id, message: error.message });
  }
}

if (candidateErrors.length > 0) {
  fail(candidateErrors[0].message, {
    schema_version: 1,
    status: "invalid_candidate_packets",
    generated_at: new Date().toISOString(),
    selected_candidate_id: null,
    errors: candidateErrors,
    diversity: diversityPacket,
    pass_threshold: passThreshold
  });
}

const criterionByCandidate = new Map();
for (const candidate of candidates) {
  criterionByCandidate.set(candidate.id, []);
}
for (const pointer of criterionPointers) {
  const criterion = criteria.find((entry) => entry.id === pointer.criterion_id);
  try {
    const parsed = readJsonContext(pointer.context_key, "criterion " + pointer.candidate_id + "/" + pointer.criterion_id);
    criterionByCandidate.get(pointer.candidate_id).push(normalizeCriterionResult(parsed.value, parsed.path, criterion));
  } catch (error) {
    criterionByCandidate.get(pointer.candidate_id).push({
      id: criterion.id,
      weight: criterion.weight,
      required: criterion.required === true,
      passed: false,
      score: 0,
      weighted_score: 0,
      summary: error.message,
      issues: ["criterion_result_unreadable"],
      evidence_path: null
    });
  }
}

const ranking = candidates.map((candidate) => {
  const results = criterionByCandidate.get(candidate.id);
  const totalScore = Number(results.reduce((sum, result) => sum + result.weighted_score, 0).toFixed(4));
  const blockers = results.flatMap((result) => {
    const blocker = requiredCriterionBlocker(result);
    return blocker ? [blocker] : [];
  });
  const eligible = blockers.length === 0 && totalScore >= passThreshold;
  return {
    candidate_id: candidate.id,
    authored_order: candidate.order,
    eligible,
    total_score: totalScore,
    blockers,
    criteria: results
  };
}).sort((left, right) => {
  if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
  if (right.total_score !== left.total_score) return right.total_score - left.total_score;
  return left.authored_order - right.authored_order;
});

const eligible = ranking.filter((entry) => entry.eligible);
if (eligible.length === 0) {
  fail("No candidate reached the selection threshold.", {
    schema_version: 1,
    status: "no_eligible_candidate",
    generated_at: new Date().toISOString(),
    selected_candidate_id: null,
    pass_threshold: passThreshold,
    diversity: diversityPacket,
    criteria,
    ranking,
    rejected: ranking.map((entry) => ({
      candidate_id: entry.candidate_id,
      total_score: entry.total_score,
      blockers: entry.blockers,
      rationale: entry.blockers.length > 0
        ? "Blocked by required criteria."
        : "Weighted score did not reach the pass threshold."
    }))
  });
}

const selected = eligible[0];
const selectedPacket = candidatePackets.find((candidate) => candidate.id === selected.candidate_id);
const tied = eligible.filter((entry) => entry.total_score === selected.total_score).map((entry) => entry.candidate_id);
const packet = {
  schema_version: 1,
  status: "selected",
  generated_at: new Date().toISOString(),
  selected_candidate_id: selected.candidate_id,
  selected: selectedPacket,
  pass_threshold: passThreshold,
  diversity: diversityPacket,
  criteria,
  ranking,
  rejected: ranking
    .filter((entry) => entry.candidate_id !== selected.candidate_id)
    .map((entry) => ({
      candidate_id: entry.candidate_id,
      total_score: entry.total_score,
      eligible: entry.eligible,
      blockers: entry.blockers,
      rationale: entry.eligible
        ? "Eligible but scored below the selected candidate."
        : entry.blockers.length > 0
          ? "Blocked by required criteria."
          : "Weighted score did not reach the pass threshold."
    })),
  ...(tied.length > 1 ? { tie_breaker: { kind: "authored_order", tied_candidate_ids: tied } } : {})
};
writeSelection(packet);
console.log("Selected candidate " + selected.candidate_id + ".");
`;
}

function candidateContexts(config: PatternCandidateSelectionConfig): ContextItem[] {
  return config.selection.candidates.map((candidate) =>
    artifactContext(candidateContextName(candidate.id), candidateNodeId(config.id, candidate.id), "candidate_json", {
      what: `Candidate strategy packet for ${candidate.id}.`,
      why: "The selection workflow compares authored candidate strategies using shared criteria."
    })
  );
}

function criterionContexts(config: PatternCandidateSelectionConfig): ContextItem[] {
  return config.selection.candidates.flatMap((candidate) =>
    config.selection.criteria.map((criterion) =>
      artifactContext(criterionContextName(candidate.id, criterion.id), criterionNodeId(config.id, candidate.id, criterion.id), "verification_json", {
        what: `Criterion score for candidate ${candidate.id} against ${criterion.id}.`,
        why: "The deterministic selector aggregates criterion scores to choose the selected candidate."
      })
    )
  );
}

function buildCandidateNode(
  config: PatternCandidateSelectionConfig,
  candidate: PatternCandidateSelectionCandidate
): AgentNode {
  const shared = sharedAgentBase(config);
  return {
    type: "agent",
    id: candidateNodeId(config.id, candidate.id),
    label: `Candidate ${candidate.id}`,
    ...shared,
    artifacts: {
      candidate_json: {
        from: "output_dir",
        path: "candidate.json",
        description: `Structured candidate strategy packet for ${candidate.id}.`
      }
    },
    managed_runtime: {
      kind: "pattern_candidate_selection",
      root_id: config.id,
      phase: "candidate",
      config: {
        candidate_id: candidate.id
      }
    },
    intent: {
      goal: `Develop candidate strategy ${candidate.id}: ${candidate.intent.goal}`,
      acceptance_criteria: [
        ...candidate.intent.acceptance_criteria,
        "The candidate packet includes approach, implementation outline, validation plan, risks, assumptions, and evidence."
      ],
      constraints: [
        ...config.intent.constraints,
        ...candidate.intent.constraints,
        "Do not edit source files."
      ]
    },
    managed_prompt: buildCandidatePrompt(config, candidate)
  };
}

function buildDiversityNode(config: PatternCandidateSelectionConfig): CheckNode {
  const shared = sharedAiCheckBase(config);
  return {
    type: "check",
    id: workflowNodeId(config.id, "diversity"),
    label: "Candidate Diversity",
    ...shared,
    support: mergeSupportContext(shared.support, candidateContexts(config)),
    check_kind: "ai",
    rubric: buildDiversityRubric(config),
    managed_runtime: {
      kind: "pattern_candidate_selection",
      root_id: config.id,
      phase: "diversity"
    },
    intent: {
      goal: "Judge whether the candidate strategy packets are materially distinct enough to compare fairly.",
      acceptance_criteria: [
        "The check returns valid JSON with passed, score, summary, and issues fields.",
        "The check fails wording variants or duplicated implementation approaches."
      ],
      constraints: config.intent.constraints
    }
  };
}

function buildCriterionNode(
  config: PatternCandidateSelectionConfig,
  candidate: PatternCandidateSelectionCandidate,
  criterion: PatternCandidateSelectionCriterion
): CheckNode {
  const shared = sharedAiCheckBase(config);
  return {
    type: "check",
    id: criterionNodeId(config.id, candidate.id, criterion.id),
    label: `Candidate ${candidate.id} Criterion ${criterion.id}`,
    ...shared,
    support: mergeSupportContext(shared.support, [
      artifactContext(candidateContextName(candidate.id), candidateNodeId(config.id, candidate.id), "candidate_json", {
        what: `Candidate strategy packet for ${candidate.id}.`,
        why: `This criterion evaluates only candidate ${candidate.id}.`
      })
    ]),
    check_kind: "ai",
    rubric: buildCriterionRubric(config, candidate, criterion),
    managed_runtime: {
      kind: "pattern_candidate_selection",
      root_id: config.id,
      phase: "criterion",
      config: {
        candidate_id: candidate.id,
        criterion_id: criterion.id
      }
    },
    intent: {
      goal: `Evaluate candidate ${candidate.id} against selection criterion ${criterion.id}.`,
      acceptance_criteria: [
        "The evaluator returns valid JSON with passed, score, summary, and issues fields.",
        "The evaluator grades only this candidate packet against the criterion."
      ],
      constraints: config.intent.constraints
    }
  };
}

export function buildPatternCandidateSelection(config: PatternCandidateSelectionConfig): SequenceNode {
  const workflowId = workflowNodeId(config.id, "workflow");
  const candidatesPanelId = workflowNodeId(config.id, "candidates");
  const criteriaPanelId = workflowNodeId(config.id, "criteria");
  const publicArtifacts = defaultPatternCandidateSelectionPublicArtifacts();
  const selectionArtifact = publicArtifacts.selection!;
  const candidateNodes = config.selection.candidates.map((candidate) => buildCandidateNode(config, candidate));
  const criterionNodes = config.selection.candidates.flatMap((candidate) =>
    config.selection.criteria.map((criterion) => buildCriterionNode(config, candidate, criterion))
  );
  const selectorShared = sharedNonPromptNodeBase(config);

  const candidatesPanel: ParallelNode = {
    type: "parallel",
    id: candidatesPanelId,
    label: "Candidate Strategies",
    max_concurrency: maxConcurrency(config.runtime, candidateNodes.length),
    steps: candidateNodes
  };

  const criteriaPanel: ParallelNode = {
    type: "parallel",
    id: criteriaPanelId,
    label: "Candidate Criteria",
    max_concurrency: maxConcurrency(config.runtime, criterionNodes.length),
    steps: criterionNodes
  };

  const selectorNode: ExecNode = {
    type: "exec",
    id: config.id,
    ...(config.label ? { label: config.label } : { label: "Select Candidate" }),
    ...selectorShared,
    support: mergeSupportContext(selectorShared.support, [
      ...candidateContexts(config),
      artifactContext("diversity_result", workflowNodeId(config.id, "diversity"), "verification_json", {
        what: "Candidate diversity verdict.",
        why: "Selection is valid only when candidate strategies are materially distinct."
      }),
      ...criterionContexts(config)
    ]),
    command: "node",
    args: ["-e", buildSelectorScript(config, selectionArtifact.path)],
    artifacts: publicArtifacts,
    intent: {
      goal: "Select the highest-scoring eligible candidate strategy from accepted candidate packets and criterion scorecards.",
      acceptance_criteria: [
        "The selection artifact records the selected candidate, ranking, rejected candidates, scorecards, and diversity evidence.",
        "Required criterion blockers prevent candidate eligibility.",
        `An eligible candidate must reach the pass threshold ${config.selection.pass_threshold}.`
      ],
      constraints: config.intent.constraints
    }
  };

  return {
    type: "sequence",
    id: workflowId,
    label: config.label ? `${config.label} Workflow` : "Candidate Selection Workflow",
    steps: [
      candidatesPanel,
      buildDiversityNode(config),
      criteriaPanel,
      selectorNode
    ]
  };
}

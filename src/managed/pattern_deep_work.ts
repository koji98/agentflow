import { extname } from "node:path";

import type {
  AgentNode,
  ArtifactDefinition,
  BaseExecutableNode,
  CheckNode,
  ContextItem,
  ExecNode,
  NodeSupport,
  ParallelNode,
  RepeatNode,
  SequenceNode
} from "../graph/authored.js";
import type { ReasoningEffort, SandboxMode } from "../graph/schema.js";
import {
  artifactContext,
  body,
  managedPromptContract,
  managedId,
  maxConcurrency,
  mergeArtifacts,
  mergeManagedPublicArtifacts,
  mergeSupportContext,
  outputDirArtifact,
  renderPrompt,
  section,
  sharedAgentBase,
  sharedAiCheckBase,
  sharedNonPromptNodeBase,
  type ManagedPatternAgentOptions,
  type ManagedPatternRuntime,
  type PromptSection
} from "./foundation.js";

export type PatternDeepWorkCompletionCriterion =
  | PatternDeepWorkCommandCriterion
  | PatternDeepWorkRubricCriterion;

export interface PatternDeepWorkCriterionBase {
  id: string;
  weight: number;
  required?: boolean;
}

export interface PatternDeepWorkCommandCriterion extends PatternDeepWorkCriterionBase {
  kind: "command";
  command: string;
}

export interface PatternDeepWorkRubricCriterion extends PatternDeepWorkCriterionBase {
  kind: "rubric";
  target: "workspace" | `artifact:${string}`;
  rubric: string;
}

export interface PatternDeepWorkConfig extends BaseExecutableNode, ManagedPatternAgentOptions {
  completion: {
    max_cycles: number;
    pass_threshold: number;
    criteria: PatternDeepWorkCompletionCriterion[];
  };
  phases?: Partial<Record<PatternDeepWorkPhaseName, PatternDeepWorkPhaseOverride>>;
  runtime?: ManagedPatternRuntime;
}

export type PatternDeepWorkPhaseName = "plan" | "execute" | "verify" | "publish";

export interface PatternDeepWorkPhaseIntent {
  goal?: string;
  acceptance_criteria?: string[];
  constraints?: string[];
}

export interface PatternDeepWorkPhaseRuntime {
  profile?: string;
}

export interface PatternDeepWorkPhaseOverride {
  intent?: PatternDeepWorkPhaseIntent;
  support?: NodeSupport;
  runtime?: PatternDeepWorkPhaseRuntime;
  model?: string;
  reasoning_effort?: ReasoningEffort;
  sandbox?: SandboxMode;
}

function workflowNodeId(rootId: string, suffix: string): string {
  return managedId(rootId, "pattern_deep_work", suffix);
}

function zeroPad(value: number): string {
  return String(value).padStart(2, "0");
}

function draftArtifactName(name: string): string {
  return `draft_${name}`;
}

function draftArtifactPath(name: string, artifact: ArtifactDefinition): string {
  const extension = extname(artifact.path) || ".md";
  return `draft-${name}${extension}`;
}

function formatList(title: string, values: string[] | undefined, fallback: string): string[] {
  return values && values.length > 0
    ? [title, ...values.map((value) => `- ${value}`)]
    : [`${title}: ${fallback}`];
}

function formatDraftArtifacts(artifacts: Record<string, ArtifactDefinition>): string[] {
  return Object.keys(artifacts).flatMap((name) => [
    `- ${draftArtifactName(name)}: Use \`af artifact write ${draftArtifactName(name)}\` to publish the draft for final artifact ${name}.`
  ]);
}

function userAuthoredDraftArtifacts(artifacts: Record<string, ArtifactDefinition> | undefined): Record<string, ArtifactDefinition> {
  return Object.fromEntries(
    Object.entries(artifacts ?? {}).filter(([name]) => name !== "packet")
  );
}

function formatCriteria(criteria: PatternDeepWorkCompletionCriterion[]): string[] {
  return criteria.map((criterion) => {
    const required = criterion.required ? "required" : "weighted";
    if (criterion.kind === "command") {
      return `- ${criterion.id} (${required}, weight ${criterion.weight}): command \`${criterion.command}\``;
    }
    return `- ${criterion.id} (${required}, weight ${criterion.weight}, target ${criterion.target}): ${criterion.rubric}`;
  });
}

function mergeSupport(base: NodeSupport | undefined, override: NodeSupport | undefined): NodeSupport | undefined {
  if (!base && !override) {
    return undefined;
  }
  const merged: NodeSupport = {
    ...(base ?? {}),
    ...(override ?? {})
  };
  const capabilities = [...(base?.capabilities ?? []), ...(override?.capabilities ?? [])];
  const skills = [...(base?.skills ?? []), ...(override?.skills ?? [])];
  const tools = [...(base?.tools ?? []), ...(override?.tools ?? [])];
  const cli = [...(base?.cli ?? []), ...(override?.cli ?? [])];
  const context = [...(base?.context ?? []), ...(override?.context ?? [])];
  if (capabilities.length > 0) {
    merged.capabilities = capabilities;
  }
  if (skills.length > 0) {
    merged.skills = skills;
  }
  if (tools.length > 0) {
    merged.tools = tools;
  }
  if (cli.length > 0) {
    merged.cli = cli;
  }
  if (context.length > 0) {
    merged.context = context;
  }
  return merged;
}

function mergePhaseRuntime(
  base: ManagedPatternRuntime | undefined,
  override: PatternDeepWorkPhaseRuntime | undefined
): ManagedPatternRuntime | undefined {
  if (!base && !override?.profile) {
    return undefined;
  }

  return {
    ...(base ?? {}),
    ...(override?.profile ? { profile: override.profile } : {})
  };
}

function phaseConfig(config: PatternDeepWorkConfig, phase: PatternDeepWorkPhaseName): PatternDeepWorkConfig {
  const override = config.phases?.[phase];
  if (!override) {
    return config;
  }
  const support = override.support ? mergeSupport(config.support, override.support) : undefined;
  const runtime = override.runtime ? mergePhaseRuntime(config.runtime, override.runtime) : undefined;
  return {
    ...config,
    ...(override.model ? { model: override.model } : {}),
    ...(override.reasoning_effort ? { reasoning_effort: override.reasoning_effort } : {}),
    ...(override.sandbox ? { sandbox: override.sandbox } : {}),
    ...(runtime ? { runtime } : {}),
    ...(support ? { support } : {})
  };
}

function formatPhaseContract(config: PatternDeepWorkConfig, phase: PatternDeepWorkPhaseName): PromptSection[] {
  const intent = config.phases?.[phase]?.intent;
  if (!intent) {
    return [];
  }

  const acceptanceCriteria = intent.acceptance_criteria ?? [];
  const constraints = intent.constraints ?? [];
  if (!intent.goal && acceptanceCriteria.length === 0 && constraints.length === 0) {
    return [];
  }

  const lines = [
    "This phase intent is additive. It does not replace or weaken the task contract, completion criteria, threshold, or constraints."
  ];

  if (intent.goal) {
    lines.push(`Additional phase objective: ${intent.goal}`);
  }

  if (acceptanceCriteria.length > 0) {
    lines.push("Additional phase acceptance criteria:");
    lines.push(...acceptanceCriteria.map((criterion) => `- ${criterion}`));
  }

  if (constraints.length > 0) {
    lines.push("Additional phase constraints:");
    lines.push(...constraints.map((constraint) => `- ${constraint}`));
  }

  return [section("Phase Contract", lines)];
}

function buildPlanPrompt(
  config: PatternDeepWorkConfig,
  cycleCount: number
){
  return managedPromptContract("plan", "Plan execution work needed to satisfy the full task from the current state.", [
    body("You are planning execution work to satisfy the full task from the current state. Do not edit files in this phase. Preserve the task intent, inspect the available evidence, and give the execution agent a plan that aims to complete the task now when feasible."),
    section("Task Contract", [
      `Goal: ${config.intent.goal}`,
      ...formatList("Acceptance criteria", config.intent.acceptance_criteria, "Use the graph and node acceptance criteria."),
      ...formatList("Constraints", config.intent.constraints, "Stay inside the authored task contract.")
    ]),
    section("Completion Model", [
      `Maximum cycles: ${cycleCount}`,
      `Pass threshold: ${config.completion.pass_threshold}`,
      ...formatCriteria(config.completion.criteria)
    ]),
    ...formatPhaseContract(config, "plan"),
    section("Planning Task", [
      "Use the provided context pointers for the planning phase.",
      "Read the task context, any prior failed scorecard, criterion verification records, command output excerpts, and current workspace state available to you.",
      "If prior scorecards, work notes, criterion records, or repeat history are omitted because no prior cycle exists, treat that as expected first-cycle state.",
      "Do not wait for, search globally for, or report a blocker solely because first-cycle prior materials are missing.",
      "Identify the concrete gap between the current state and the task contract.",
      "Use prior feedback, scorecards, and failed criteria as gap evidence; do not shrink the task to only the last failed check.",
      "Plan the work needed to satisfy the full task from the current state.",
      "Aim for completion in this execution. If full completion is not feasible now, plan the most complete useful slice and state the remaining gap explicitly.",
      "Map every completion criterion to the evidence the execution phase should produce or inspect.",
      "Name the expected material change or evidence that should prove progress toward completion.",
      "Name likely files or areas to inspect or change, but do not over-prescribe exact code unless the evidence requires it.",
      "Recommend focused validation commands or checks the execution agent should run.",
      "Say the executor may adapt the plan when workspace evidence proves an assumption wrong, as long as the adaptation serves the full task contract.",
      "Do not edit repository or workspace files in this planning phase. Only write the planning artifact requested below."
    ]),
    section("Output Contract", [
      "Publish only the declared `plan` artifact.",
      "Use `af artifact write plan` to publish the plan content.",
      "Do not create or edit workspace files during this planning phase.",
      "Include sections: `Task target`, `Current state`, `Gap`, `Execution plan`, `Validation plan`, `Expected material change`, `Remaining gap`, and `Risks or constraints`.",
      "Preserve exact task-specific names, labels, commands, and required phrases from the task contract in the plan.",
      "Do not create a milestone solely to restate the plan. If you do create a milestone, complete it before running `af complete check`."
    ])
  ]);
}

function buildGenerateValidatePrompt(
  config: PatternDeepWorkConfig,
  draftableArtifacts: Record<string, ArtifactDefinition>
){
  const draftLines = Object.keys(draftableArtifacts).length > 0
    ? [
        "Also write draft versions of user-authored final artifacts so completion criteria can grade them before final publication.",
        "Draft final artifacts should include enough evidence citations for an evaluator to see why the change, validation, and risk claims are supported.",
        ...formatDraftArtifacts(draftableArtifacts)
      ]
    : [
        "No user-authored final artifacts are declared for this node.",
        "Do not create `draft-summary.md`, `draft-packet.json`, or extra final artifacts.",
        "The runtime writes the final `packet` artifact after the completion gate passes."
      ];

  return managedPromptContract("execute", "Do and validate the work needed to satisfy the full task from the current state.", [
    body("You are responsible for satisfying the full task from the current state. Do not stop at a plausible change. Work until you have verified the candidate satisfies the goal, acceptance criteria, and constraints, or until you have concrete evidence of what remains."),
    section("Task Contract", [
      "Aim to complete the task in this execution. Retries are a fallback; write concrete validation evidence and residual risks only after doing the work.",
      `Goal: ${config.intent.goal}`,
      ...formatList("Acceptance criteria", config.intent.acceptance_criteria, "Use the graph and node acceptance criteria."),
      ...formatList("Constraints", config.intent.constraints, "Stay inside the authored task contract.")
    ]),
    section("Completion Criteria", [
      `Pass threshold: ${config.completion.pass_threshold}`,
      ...formatCriteria(config.completion.criteria)
    ]),
    ...formatPhaseContract(config, "execute"),
    section("Execution Task", [
      "Use `plan.md` as guidance, not as a limit.",
      "The task contract controls when `plan.md` is incomplete, stale, too small, or contradicted by repository evidence.",
      "Satisfy the task contract, not only the visible tests; handle edge cases directly implied by the goal, acceptance criteria, and local code.",
      "Keep edits scoped; add/edit tests only when the task asks or repo contract expects them.",
      "If evidence shows the plan is wrong, make the task-justified adjustment needed to satisfy the full task and record why in work notes.",
      "Inspect enough repository context to follow local patterns before editing.",
      "When draft artifacts rely on upstream research, plans, tests, or prior context, cite concrete evidence names, paths, commands, or packet fields instead of using generic references like prior research.",
      "Use available repo, device, and plugin CLIs naturally when they help complete or validate the work.",
      "Run focused validation commands when feasible. If validation fails and the fix is clear, fix and rerun.",
      "If you cannot run a useful validation command, record exactly why and what evidence you used instead.",
      "Fix ordinary task, validation, and quality failures yourself when the next action is clear.",
      "Report precise blockers only for missing context, broken tools, malformed runtime outputs, artifact publishing failures, harness failures, or runtime failures."
    ]),
    section("Output Contract", [
      "Publish the `work_notes` artifact after doing the work.",
      "Use `af artifact write work_notes` to publish the work notes.",
      "Include what changed, why any deviations from `plan.md` were needed, exact validation evidence, remaining risks, and any remaining gap.",
      ...draftLines
    ])
  ]);
}

function buildRubricGoal(criterion: PatternDeepWorkRubricCriterion): string {
  const targetDescription = criterion.target === "workspace"
    ? "the current workspace candidate, work notes, validation evidence, and draft artifacts"
    : `draft artifact \`${criterion.target.slice("artifact:".length)}\` and its supporting evidence`;

  return renderPrompt([
    body(`You are an evidence-based evaluator for completion criterion \`${criterion.id}\`.`),
    section("Criterion", [
      `Rubric: ${criterion.rubric}`,
      `Target: ${criterion.target}`,
      `Weight: ${criterion.weight}`,
      `Required blocker: ${criterion.required === true ? "yes" : "no"}`
    ]),
    section("Evaluation Guidance", [
      `Grade only ${targetDescription}.`,
      "Give full credit when the evidence satisfies the criterion.",
      "Do not invent issues, penalize harmless style differences, or require work outside the task contract.",
      "Do withhold credit for missing evidence, violated constraints, failed validation, or unsupported claims.",
      "Use score 0.85 or higher when the criterion is clearly satisfied; set `passed` true when the criterion is adequately satisfied."
    ]),
    section("Required JSON Output", [
      "Return valid JSON only:",
      '{"passed":true,"score":1,"summary":"short evidence-backed rationale","issues":[]}',
      "Score must be a number from 0 to 1."
    ])
  ]);
}

function buildRubricGoalWithPhase(
  config: PatternDeepWorkConfig,
  criterion: PatternDeepWorkRubricCriterion
): string {
  const phaseLines = formatPhaseContract(config, "verify");
  const base = buildRubricGoal(criterion);
  return phaseLines.length === 0 ? base : `${base}\n\n${renderPrompt(phaseLines)}`;
}

function buildGateScript(criteria: PatternDeepWorkCompletionCriterion[], passThreshold: number): string {
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
    const stdoutExcerpt = readOptionalText(record.stdout_key);
    const stderrExcerpt = readOptionalText(record.stderr_key);
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
      stdout_excerpt: stdoutExcerpt,
      stderr_excerpt: stderrExcerpt
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

function requiredCriterionGateBlocker(result) {
  if (!result.required) return null;
  if (!result.passed) {
    return {
      criterion_id: result.id,
      summary: result.summary
    };
  }
  if (result.score < passThreshold) {
    return {
      criterion_id: result.id,
      summary: result.summary + " Required criterion score " + result.score.toFixed(2) + " is below the pass threshold " + passThreshold.toFixed(2) + "."
    };
  }
  return null;
}

function normalizeCriterionForGate(result) {
  const blocker = requiredCriterionGateBlocker(result);
  if (!blocker) return result;
  const issues = Array.isArray(result.issues) ? [...result.issues] : [];
  if (result.passed === true) {
    issues.push(blocker.summary);
  }
  return {
    ...result,
    evaluator_passed: result.passed,
    passed: false,
    summary: blocker.summary,
    issues
  };
}

const results = criteria.map(readCriterion).map(normalizeCriterionForGate);
const blockers = results
  .flatMap((result) => {
    const blocker = requiredCriterionGateBlocker(result);
    return blocker ? [blocker] : [];
  });
const totalScore = results.reduce((sum, result) => sum + (result.weighted_score ?? result.score * result.weight), 0);
const passed = blockers.length === 0 && totalScore >= passThreshold;
const failedCriteria = results.filter((result) => !result.passed || result.score < passThreshold);
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
    ? "Completion criteria passed."
    : "Completion criteria did not reach the pass threshold or had required blockers.",
  issues: blockers,
  check_kind: "deterministic"
}, null, 2) + "\\n");
`.trim();
}

function buildFinalizerScript(
  packetArtifact: ArtifactDefinition,
  artifacts: Record<string, ArtifactDefinition>
): string {
  const artifactRecords = Object.entries(artifacts).map(([name, definition]) => ({
    name,
    definition,
    draft_name: draftArtifactName(name)
  }));

  return `
const fs = require("node:fs");
const path = require("node:path");
const artifacts = ${JSON.stringify(artifactRecords)};
const packetDefinition = ${JSON.stringify(packetArtifact)};
const out = process.env.AGENTFLOW_OUTPUT_DIR;
const workspace = process.env.AGENTFLOW_WORKSPACE;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function envKey(name) {
  return "AGENTFLOW_CONTEXT_" + String(name).toUpperCase();
}

function readJsonOptional(filePath) {
  if (!filePath) return undefined;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function resolveWithin(root, relativePath, label) {
  if (!root) fail("Missing root for " + label + ".");
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(resolvedRoot + path.sep)) {
    fail(label + " escapes its root: " + relativePath);
  }
  return resolvedPath;
}

function destinationFor(definition, label) {
  return resolveWithin(definition.from === "workspace" ? workspace : out, definition.path, label);
}

if (!out) fail("Missing AGENTFLOW_OUTPUT_DIR.");

const scorecardPath = process.env.AGENTFLOW_CONTEXT_COMPLETION_SCORECARD;
const workNotesPath = process.env.AGENTFLOW_CONTEXT_WORK_NOTES;
const scorecard = readJsonOptional(scorecardPath);
const finalArtifacts = [];

for (const artifact of artifacts) {
  const source = process.env[envKey(artifact.draft_name)];
  if (!source || !fs.existsSync(source)) {
    fail("Missing accepted draft artifact for " + artifact.name + ".");
  }
  const destination = destinationFor(artifact.definition, "Final artifact " + artifact.name);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  finalArtifacts.push({
    name: artifact.name,
    path: destination,
    source_draft_path: source,
    description: artifact.definition.description
  });
}

const packetPath = destinationFor(packetDefinition, "Runtime packet artifact");
const packet = {
  schema_version: 1,
  status: scorecard && scorecard.passed === true ? "completed" : "unknown",
  generated_at: new Date().toISOString(),
  completion_scorecard_path: scorecardPath ?? null,
  work_notes_path: workNotesPath ?? null,
  completion: scorecard ?? null,
  final_artifacts: finalArtifacts
};

fs.mkdirSync(path.dirname(packetPath), { recursive: true });
fs.writeFileSync(packetPath, JSON.stringify(packet, null, 2) + "\\n");
console.log("Published runtime deep-work packet" + (finalArtifacts.length > 0 ? " and " + finalArtifacts.length + " user-authored artifact(s)." : "."));
`.trim();
}

function buildDraftArtifacts(publicArtifacts: Record<string, ArtifactDefinition>): Record<string, ArtifactDefinition> {
  return Object.fromEntries(
    Object.entries(publicArtifacts).map(([name, artifact]) => [
      draftArtifactName(name),
      {
        from: "output_dir",
        path: draftArtifactPath(name, artifact),
        description: `Draft content for final artifact ${name}.`
      }
    ])
  );
}

function buildCriterionContext(
  generateValidateId: string,
  draftableArtifacts: Record<string, ArtifactDefinition>,
  criterion: PatternDeepWorkCompletionCriterion
): ContextItem[] {
  const common: ContextItem[] = [
    artifactContext("work_notes", generateValidateId, "work_notes")
  ];

  if (criterion.kind === "rubric" && criterion.target.startsWith("artifact:")) {
    const artifactName = criterion.target.slice("artifact:".length);
    if (!draftableArtifacts[artifactName]) {
      return common;
    }
    return [
      ...common,
      artifactContext(
        draftArtifactName(artifactName),
        generateValidateId,
        draftArtifactName(artifactName)
      )
    ];
  }

  return [
    ...common,
    ...Object.keys(draftableArtifacts).map((name) =>
      artifactContext(draftArtifactName(name), generateValidateId, draftArtifactName(name))
    )
  ];
}

function buildCriterionNode(
  config: PatternDeepWorkConfig,
  generateValidateId: string,
  publicArtifacts: Record<string, ArtifactDefinition>,
  criterion: PatternDeepWorkCompletionCriterion,
  index: number
): CheckNode {
  const id = workflowNodeId(config.id, `criterion_${zeroPad(index + 1)}_${criterion.id}`);
  const verifyConfig = phaseConfig(config, "verify");

  if (criterion.kind === "command") {
    const checkShared = sharedNonPromptNodeBase(verifyConfig);

    return {
      type: "check",
      id,
      label: `Completion Criterion ${criterion.id}`,
      ...checkShared,
      check_kind: "deterministic",
      command: "sh",
      args: ["-lc", criterion.command],
      on_failure: "continue",
      support: mergeSupportContext(
        checkShared.support,
        buildCriterionContext(generateValidateId, publicArtifacts, criterion)
      ),
      managed_runtime: {
        kind: "pattern_deep_work",
        root_id: config.id,
        phase: "verify",
        config: {
          criterion_id: criterion.id,
          criterion_kind: criterion.kind
        }
      },
      intent: {
        goal: `Run deterministic completion criterion \`${criterion.id}\` for the current deep work result.`,
        acceptance_criteria: [
          "The command result is captured as completion feedback for the deterministic gate."
        ],
        constraints: verifyConfig.intent.constraints
      }
    };
  }

  return {
    type: "check",
    id,
    label: `Completion Criterion ${criterion.id}`,
    ...sharedAiCheckBase(verifyConfig),
    check_kind: "ai",
    on_failure: "continue",
    managed_runtime: {
      kind: "pattern_deep_work",
      root_id: config.id,
      phase: "verify",
      config: {
        criterion_id: criterion.id,
        criterion_kind: criterion.kind,
        target: criterion.target
      }
    },
    support: mergeSupportContext(
      sharedAiCheckBase(verifyConfig).support,
      buildCriterionContext(generateValidateId, publicArtifacts, criterion)
    ),
    rubric: criterion.rubric,
    intent: {
      goal: buildRubricGoalWithPhase(config, criterion),
      acceptance_criteria: [
        "The evaluator returns valid JSON with passed, score, summary, and issues fields.",
        "The evaluator grades only evidence in context and does not require work outside the task contract."
      ],
      constraints: verifyConfig.intent.constraints
    }
  };
}

function buildGateContext(config: PatternDeepWorkConfig): ContextItem[] {
  return config.completion.criteria.flatMap((criterion, index) => {
    const suffix = zeroPad(index + 1);
    const criterionId = workflowNodeId(config.id, `criterion_${suffix}_${criterion.id}`);
    const contexts: ContextItem[] = [
      artifactContext(`criterion_${suffix}_result`, criterionId, "verification_json")
    ];

    if (criterion.kind === "command") {
      contexts.push(
        artifactContext(`criterion_${suffix}_stdout`, criterionId, "stdout", { if_available: true }),
        artifactContext(`criterion_${suffix}_stderr`, criterionId, "stderr", { if_available: true })
      );
    }

    return contexts;
  });
}

function buildPublishContext(
  config: PatternDeepWorkConfig,
  draftableArtifacts: Record<string, ArtifactDefinition>,
  generateValidateId: string,
  gateId: string
): ContextItem[] {
  return [
    artifactContext("completion_scorecard", gateId, "completion_scorecard", {
      iteration: "latest_passed"
    }),
    artifactContext("work_notes", generateValidateId, "work_notes", {
      iteration: "latest_passed"
    }),
    ...Object.keys(draftableArtifacts).map((name) =>
      artifactContext(draftArtifactName(name), generateValidateId, draftArtifactName(name), {
        iteration: "latest_passed"
      })
    )
  ];
}

function buildPlanContext(
  config: PatternDeepWorkConfig,
  generateValidateId: string,
  gateId: string
): ContextItem[] {
  const feedbackContext: ContextItem[] = [
    artifactContext("failed_completion_scorecard", gateId, "completion_scorecard", {
      iteration: "latest_failed",
      if_available: true
    }),
    artifactContext("previous_work_notes", generateValidateId, "work_notes", {
      iteration: "latest_failed",
      if_available: true
    })
  ];

  for (const [index, criterion] of config.completion.criteria.entries()) {
    const suffix = zeroPad(index + 1);
    const criterionId = workflowNodeId(config.id, `criterion_${suffix}_${criterion.id}`);

    feedbackContext.push(
      artifactContext(`previous_criterion_${suffix}_result`, criterionId, "verification_json", {
        iteration: "latest_failed",
        if_available: true
      })
    );

    if (criterion.kind === "command") {
      feedbackContext.push(
        artifactContext(`previous_criterion_${suffix}_stdout`, criterionId, "stdout", {
          iteration: "latest_failed",
          if_available: true
        }),
        artifactContext(`previous_criterion_${suffix}_stderr`, criterionId, "stderr", {
          iteration: "latest_failed",
          if_available: true
        })
      );
    }
  }

  return feedbackContext;
}

export function buildPatternDeepWork(config: PatternDeepWorkConfig): SequenceNode {
  const workflowId = workflowNodeId(config.id, "workflow");
  const planId = workflowNodeId(config.id, "plan");
  const generateValidateId = workflowNodeId(config.id, "generate_validate");
  const criteriaPanelId = workflowNodeId(config.id, "criteria_panel");
  const gateId = workflowNodeId(config.id, "completion_gate");
  const loopId = workflowNodeId(config.id, "work_loop");
  const loopBodyId = workflowNodeId(config.id, "work_loop_body");
  const publicArtifacts = mergeManagedPublicArtifacts(config.artifacts);
  const draftableArtifacts = userAuthoredDraftArtifacts(config.artifacts);
  const planConfig = phaseConfig(config, "plan");
  const executeConfig = phaseConfig(config, "execute");
  const publishConfig = phaseConfig(config, "publish");
  const planShared = sharedAgentBase(planConfig);
  const executeShared = sharedAgentBase(executeConfig);
  const gateShared = sharedNonPromptNodeBase(config);
  const publishPhaseIntent = config.phases?.publish?.intent;
  const criterionNodes = config.completion.criteria.map((criterion, index) =>
    buildCriterionNode(config, generateValidateId, draftableArtifacts, criterion, index)
  );
  const criteriaPanel: ParallelNode = {
    type: "parallel",
    id: criteriaPanelId,
    label: "Completion Criteria",
    max_concurrency: maxConcurrency(config.runtime, criterionNodes.length),
    steps: criterionNodes
  };

  const planNode: AgentNode = {
    type: "agent",
    id: planId,
    label: "Deep Work Plan",
    ...planShared,
    support: mergeSupportContext(planShared.support, buildPlanContext(config, generateValidateId, gateId)),
    artifacts: outputDirArtifact("plan", "plan.md", "Execution plan for satisfying the deep work task from the current state."),
    managed_runtime: {
      kind: "pattern_deep_work",
      root_id: config.id,
      phase: "plan"
    },
    intent: {
      goal: "Plan the execution work needed to satisfy the full deep-work task from the current state. Do not edit files in this planning phase.",
      acceptance_criteria: [
        "The plan addresses the task contract and any prior failed completion criteria.",
        "The plan identifies focused validation the execution agent should run when feasible.",
        "The plan does not edit the workspace."
      ],
      constraints: planConfig.intent.constraints
    },
    managed_prompt: buildPlanPrompt(planConfig, config.completion.max_cycles)
  };

  const generateValidateNode: AgentNode = {
    type: "agent",
    id: generateValidateId,
    label: "Generate And Validate",
    ...executeShared,
    support: mergeSupportContext(executeShared.support, [
      artifactContext("plan", planId, "plan"),
      artifactContext("failed_completion_scorecard", gateId, "completion_scorecard", {
        iteration: "latest_failed",
        if_available: true
      })
    ]),
    artifacts: mergeArtifacts(
      outputDirArtifact("work_notes", "work-notes.md", "Notes and validation evidence from the current deep work result."),
      buildDraftArtifacts(draftableArtifacts)
    ),
    intent: {
      goal: "Satisfy the full deep-work task from the current state, using plan.md as guidance and validating the result with concrete evidence.",
      acceptance_criteria: [
        "The work satisfies the task contract or records a precise remaining gap.",
        "Focused validation is run when feasible, with exact results recorded in work notes and draft artifacts.",
        Object.keys(draftableArtifacts).length > 0
          ? "Draft user-authored final artifacts exist so completion criteria can grade the result."
          : "The work records enough notes and validation evidence for criteria to grade the result."
      ],
      constraints: executeConfig.intent.constraints
    },
    managed_prompt: buildGenerateValidatePrompt(executeConfig, draftableArtifacts)
  };

  const gateNode: CheckNode = {
    type: "check",
    id: gateId,
    label: "Completion Gate",
    ...gateShared,
    check_kind: "deterministic",
    command: "node",
    args: ["-e", buildGateScript(config.completion.criteria, config.completion.pass_threshold)],
    intent: {
      goal: "Aggregate completion criterion results and decide whether the managed deep work loop is complete.",
      acceptance_criteria: [
        "The scorecard records every completion criterion result.",
        "Required criterion failures block completion regardless of weighted score.",
        `The weighted score must meet or exceed ${config.completion.pass_threshold} to pass.`
      ],
      constraints: config.intent.constraints
    },
    pass_if: {
      json_path: "$.passed",
      equals: true
    },
    support: mergeSupportContext(gateShared.support, buildGateContext(config)),
    artifacts: outputDirArtifact(
      "completion_scorecard",
      "scorecard.json",
      "Weighted completion scorecard for the latest deep work result."
    )
  };

  const loop: RepeatNode = {
    type: "repeat",
    id: loopId,
    label: "Deep Work Loop",
    max_attempts: config.completion.max_cycles,
    body: {
      type: "sequence",
      id: loopBodyId,
      label: "Deep Work Loop Body",
      steps: [
        planNode,
        generateValidateNode,
        criteriaPanel,
        gateNode
      ]
    },
    until: {
      node: gateId
    }
  };

  return {
    type: "sequence",
    id: workflowId,
    label: config.label ? `${config.label} Workflow` : "Deep Work Workflow",
    steps: [
      loop,
      {
        type: "exec",
        id: config.id,
        ...(config.label ? { label: config.label } : { label: "Finalize Deep Work" }),
        ...sharedNonPromptNodeBase(publishConfig),
        support: mergeSupportContext(sharedNonPromptNodeBase(publishConfig).support, buildPublishContext(config, draftableArtifacts, generateValidateId, gateId)),
        command: "node",
        args: ["-e", buildFinalizerScript(publicArtifacts.packet!, draftableArtifacts)],
        artifacts: publicArtifacts,
        intent: {
          goal: [
            "Finalize the latest passing deep-work result into graph-addressable artifacts without new implementation or unsupported claims.",
            ...(publishPhaseIntent?.goal ? [`Additional finalization objective: ${publishPhaseIntent.goal}`] : [])
          ].join("\n"),
          acceptance_criteria: [
            ...publishConfig.intent.acceptance_criteria,
            ...(publishPhaseIntent?.acceptance_criteria ?? []),
            "The runtime-owned packet records the latest passing completion scorecard, work notes, and promoted artifact references.",
            "User-authored final artifacts are copied from accepted drafts without LLM rewriting."
          ],
          constraints: [
            ...publishConfig.intent.constraints,
            ...(publishPhaseIntent?.constraints ?? [])
          ]
        }
      }
    ]
  };
}

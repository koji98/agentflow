import { extname } from "node:path";

import type {
  AgentNode,
  ArtifactDefinition,
  BaseExecutableNode,
  CheckNode,
  ContextItem,
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
  mergeManagedPublicArtifacts,
  outputDirArtifact,
  renderPrompt,
  section,
  sharedAgentBase,
  sharedAiCheckBase,
  sharedNodeBase,
  type ManagedPatternAgentOptions,
  type ManagedPatternRuntime
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
  runtime?: ManagedPatternRuntime;
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

function formatPublicArtifacts(artifacts: Record<string, ArtifactDefinition>): string[] {
  return Object.entries(artifacts).flatMap(([name, artifact]) => [
    `- ${name}: ${artifact.from}:${artifact.path}`,
    `  ${artifact.description}`
  ]);
}

function formatDraftArtifacts(artifacts: Record<string, ArtifactDefinition>): string[] {
  return Object.entries(artifacts).flatMap(([name, artifact]) => [
    `- ${draftArtifactName(name)}: write ${draftArtifactPath(name, artifact)} in the output directory as the draft for public artifact \`${name}\`.`
  ]);
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

function buildPlanPrompt(
  config: PatternDeepWorkConfig,
  cycleCount: number
): string {
  return renderPrompt([
    body("You are an implementation planner preparing the next cycle of a managed work loop. You do not edit files in this phase. Your job is to understand the contract, feedback, and repository state well enough to give the execution agent the smallest credible plan."),
    section("Managed Workflow Contract", [
      "This managed workflow node has one public contract: the goal, acceptance criteria, constraints, and declared public artifacts below. Internal plans, notes, scorecards, and drafts are private working material.",
      `Goal: ${config.intent.goal}`,
      ...formatList("Acceptance criteria", config.intent.acceptance_criteria, "Use the graph and node acceptance criteria."),
      ...formatList("Constraints", config.intent.constraints, "Stay inside the authored graph contract.")
    ]),
    section("Completion Model", [
      `Maximum cycles: ${cycleCount}`,
      `Pass threshold: ${config.completion.pass_threshold}`,
      ...formatCriteria(config.completion.criteria)
    ]),
    section("Planning Task", [
      "This prompt and materialized context are sufficient for the planning phase.",
      "Read the task context, any prior failed scorecard, criterion verification records, command output excerpts, and current workspace state available to you.",
      "If prior scorecards, work notes, criterion records, or repeat history are omitted because no prior cycle exists, treat that as expected first-cycle state.",
      "Do not wait for, search globally for, or report a blocker solely because first-cycle private materials are missing.",
      "Identify the concrete gap between the current state and the managed workflow contract.",
      "Define the smallest credible next plan that can satisfy failed criteria without widening scope.",
      "Name likely files or areas to inspect or change, but do not over-prescribe exact code unless the evidence requires it.",
      "Recommend focused validation commands or checks the execution agent should run.",
      "Do not edit repository or workspace files in this planning phase. Only write the planning artifact requested below."
    ]),
    section("Output Contract", [
      "Write `cycle-plan.md` to the output directory.",
      "Include sections: `Objective`, `Relevant evidence`, `Planned changes`, `Validation plan`, and `Risks or constraints`."
    ])
  ]);
}

function buildGenerateValidatePrompt(
  config: PatternDeepWorkConfig,
  publicArtifacts: Record<string, ArtifactDefinition>
): string {
  return renderPrompt([
    body("You are an implementation agent responsible for completing and validating this work cycle. Do not stop at a plausible change. Work until you have verified the candidate satisfies the goal, acceptance criteria, and constraints, or until you have concrete evidence of what remains."),
    section("Managed Workflow Contract", [
      "This is one cycle inside a managed work loop. If the completion criteria do not pass, another cycle may use your notes and feedback to continue. Write concrete validation evidence and residual risks so the next cycle can improve rather than restart.",
      `Goal: ${config.intent.goal}`,
      ...formatList("Acceptance criteria", config.intent.acceptance_criteria, "Use the graph and node acceptance criteria."),
      ...formatList("Constraints", config.intent.constraints, "Stay inside the authored graph contract.")
    ]),
    section("Completion Criteria", [
      `Pass threshold: ${config.completion.pass_threshold}`,
      ...formatCriteria(config.completion.criteria)
    ]),
    section("Execution Task", [
      "Follow the cycle plan in context.",
      "Inspect enough repository context to follow local patterns before editing.",
      "Use available repo, device, and plugin CLIs naturally when they help complete or validate the work.",
      "Run focused validation commands when feasible. If validation fails and the fix is clear, fix and rerun.",
      "If you cannot run a useful validation command, record exactly why and what evidence you used instead.",
      "Do not ask for supervisor intervention for ordinary failing tests, low quality feedback, or incomplete work; those are normal loop feedback.",
      "Do rely on runtime supervisor recovery for broken context, missing tools, malformed evaluator output, harness failure, artifact materialization failure, or other runtime substrate issues."
    ]),
    section("Output Contract", [
      "Write `work-notes.md` with what changed, validation attempted, and remaining risks.",
      "Also write draft versions of every public artifact so completion criteria can grade them before final publication.",
      ...formatDraftArtifacts(publicArtifacts)
    ])
  ]);
}

function buildRubricGoal(criterion: PatternDeepWorkRubricCriterion): string {
  const targetDescription = criterion.target === "workspace"
    ? "the current workspace candidate, work notes, validation evidence, and draft artifacts"
    : `draft public artifact \`${criterion.target.slice("artifact:".length)}\` and its supporting evidence`;

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
      "Do not invent issues, penalize harmless style differences, or require work outside the managed workflow contract.",
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

function buildFinalPublishPrompt(
  config: PatternDeepWorkConfig,
  publicArtifacts: Record<string, ArtifactDefinition>
): string {
  return renderPrompt([
    body("You are publishing the final public artifacts from the latest passing managed work cycle. Downstream work will read only these public artifacts, so make them complete, concrete, and evidence-backed."),
    section("Managed Workflow Contract", [
      `Goal: ${config.intent.goal}`,
      ...formatList("Acceptance criteria", config.intent.acceptance_criteria, "Use the graph and node acceptance criteria."),
      ...formatList("Constraints", config.intent.constraints, "Stay inside the authored graph contract.")
    ]),
    section("Current Context", [
      "Use the latest passing completion scorecard, work notes, and draft artifact materials.",
      "Do not claim success beyond the completion evidence."
    ]),
    section("Public Artifact Contract", [
      "Write exactly the declared public artifacts.",
      ...formatPublicArtifacts(publicArtifacts),
      "The `packet` artifact must include completion score, criterion results, validation evidence, residual risks, and next actions."
    ])
  ]);
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
  const materializedPath = process.env["AGENTFLOW_CONTEXT_" + contextKey];
  if (!materializedPath) return undefined;
  try {
    const text = fs.readFileSync(materializedPath, "utf8");
    if (!text.trim()) return undefined;
    return text.length > 4000 ? text.slice(0, 4000) + "\\n...[truncated]" : text;
  } catch {
    return undefined;
  }
}

function readCriterion(record) {
  const envName = "AGENTFLOW_CONTEXT_" + record.context_key;
  const materializedPath = process.env[envName];
  if (!materializedPath) {
    return {
      id: record.id,
      kind: record.kind,
      weight: record.weight,
      required: record.required,
      passed: false,
      score: 0,
      summary: "Criterion result was not materialized.",
      evidence_path: null
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(materializedPath, "utf8"));
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
      evidence_path: materializedPath,
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
      evidence_path: materializedPath,
      issues: ["criterion_result_unreadable"]
    };
  }
}

const results = criteria.map(readCriterion);
const blockers = results
  .filter((result) => result.required && !result.passed)
  .map((result) => ({
    criterion_id: result.id,
    summary: result.summary
  }));
const totalScore = results.reduce((sum, result) => sum + (result.weighted_score ?? result.score * result.weight), 0);
const passed = blockers.length === 0 && totalScore >= passThreshold;
const failedCriteria = results.filter((result) => !result.passed || result.score * result.weight < result.weight);
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

function buildDraftArtifacts(publicArtifacts: Record<string, ArtifactDefinition>): Record<string, ArtifactDefinition> {
  return Object.fromEntries(
    Object.entries(publicArtifacts).map(([name, artifact]) => [
      draftArtifactName(name),
      {
        from: "output_dir",
        path: draftArtifactPath(name, artifact),
        description: `Draft content for public artifact ${name}.`
      }
    ])
  );
}

function buildCriterionContext(
  generateValidateId: string,
  publicArtifacts: Record<string, ArtifactDefinition>,
  criterion: PatternDeepWorkCompletionCriterion
): ContextItem[] {
  const common: ContextItem[] = [
    artifactContext("work_notes", generateValidateId, "work_notes")
  ];

  if (criterion.kind === "rubric" && criterion.target.startsWith("artifact:")) {
    return [
      ...common,
      artifactContext(
        draftArtifactName(criterion.target.slice("artifact:".length)),
        generateValidateId,
        draftArtifactName(criterion.target.slice("artifact:".length))
      )
    ];
  }

  return [
    ...common,
    ...Object.keys(publicArtifacts).map((name) =>
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

  if (criterion.kind === "command") {
    return {
      type: "check",
      id,
      label: `Completion Criterion ${criterion.id}`,
      ...sharedNodeBase(config),
      check_kind: "deterministic",
      command: "sh",
      args: ["-lc", criterion.command],
      on_failure: "continue",
      context: [
        artifactContext("work_notes", generateValidateId, "work_notes")
      ],
      intent: {
        goal: `Run deterministic completion criterion \`${criterion.id}\` for the current deep work cycle.`,
        acceptance_criteria: [
          "The command result is captured as completion feedback for the deterministic gate."
        ],
        constraints: config.intent.constraints
      }
    };
  }

  return {
    type: "check",
    id,
    label: `Completion Criterion ${criterion.id}`,
    ...sharedAiCheckBase(config),
    check_kind: "ai",
    on_failure: "continue",
    context: buildCriterionContext(generateValidateId, publicArtifacts, criterion),
    rubric: criterion.rubric,
    intent: {
      goal: buildRubricGoal(criterion),
      acceptance_criteria: [
        "The evaluator returns valid JSON with passed, score, summary, and issues fields.",
        "The evaluator grades only evidence in context and does not require work outside the managed workflow contract."
      ],
      constraints: config.intent.constraints
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
  publicArtifacts: Record<string, ArtifactDefinition>,
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
    ...Object.keys(publicArtifacts).map((name) =>
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

  return [
    ...(config.context ?? []),
    ...feedbackContext
  ];
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
  const agentShared = sharedAgentBase(config);
  const criterionNodes = config.completion.criteria.map((criterion, index) =>
    buildCriterionNode(config, generateValidateId, publicArtifacts, criterion, index)
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
    ...agentShared,
    context: buildPlanContext(config, generateValidateId, gateId),
    artifacts: outputDirArtifact("cycle_plan", "cycle-plan.md", "Focused plan for the next deep work cycle."),
    intent: {
      goal: buildPlanPrompt(config, config.completion.max_cycles),
      acceptance_criteria: [
        "The plan addresses the managed workflow contract and any prior failed completion criteria.",
        "The plan identifies focused validation the execution agent should run when feasible.",
        "The plan does not edit the workspace."
      ],
      constraints: config.intent.constraints
    }
  };

  const generateValidateNode: AgentNode = {
    type: "agent",
    id: generateValidateId,
    label: "Generate And Validate",
    ...agentShared,
    context: [
      ...(config.context ?? []),
      artifactContext("cycle_plan", planId, "cycle_plan"),
      artifactContext("failed_completion_scorecard", gateId, "completion_scorecard", {
        iteration: "latest_failed",
        if_available: true
      })
    ],
    artifacts: mergeArtifacts(
      outputDirArtifact("work_notes", "work-notes.md", "Notes from the current deep work cycle."),
      buildDraftArtifacts(publicArtifacts)
    ),
    intent: {
      goal: buildGenerateValidatePrompt(config, publicArtifacts),
      acceptance_criteria: [
        "The cycle implements the plan or records why the plan had to change.",
        "Focused validation is run when feasible, with exact results recorded in work notes and draft artifacts.",
        "Draft public artifacts exist so completion criteria can grade the result."
      ],
      constraints: config.intent.constraints
    }
  };

  const gateNode: CheckNode = {
    type: "check",
    id: gateId,
    label: "Completion Gate",
    ...sharedNodeBase(config),
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
    context: buildGateContext(config),
    artifacts: outputDirArtifact(
      "completion_scorecard",
      "scorecard.json",
      "Weighted completion scorecard for the latest deep work cycle."
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
        type: "agent",
        id: config.id,
        ...(config.label ? { label: config.label } : { label: "Publish Deep Work" }),
        ...agentShared,
        context: buildPublishContext(config, publicArtifacts, generateValidateId, gateId),
        artifacts: publicArtifacts,
        intent: {
          goal: buildFinalPublishPrompt(config, publicArtifacts),
          acceptance_criteria: [
            ...config.intent.acceptance_criteria,
            "The public artifacts are consistent with the latest passing completion scorecard and do not claim unsupported success.",
            "The packet preserves completion score, criterion results, validation evidence, residual risks, and next actions."
          ],
          constraints: config.intent.constraints
        }
      }
    ]
  };
}

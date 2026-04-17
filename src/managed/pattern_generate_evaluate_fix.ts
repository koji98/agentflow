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
  listOrFallback,
  managedId,
  mergeArtifacts,
  outputDirArtifact,
  renderPrompt,
  section,
  sharedNodeBase,
  type ManagedPatternRuntime,
  workspaceFileContext,
  workflowBriefOutput
} from "./foundation.js";

export interface PatternGenerateEvaluateFixScope {
  paths?: string[];
  areas?: string[];
}

export interface PatternGenerateEvaluateFixManagedNodeSource {
  kind: "managed_node";
  node: string;
}

export interface PatternGenerateEvaluateFixFileSourceRef {
  kind: "file";
  path: string;
}

export interface PatternGenerateEvaluateFixArtifactSourceRef {
  kind: "artifact";
  node: string;
  artifact: string;
}

export type PatternGenerateEvaluateFixSourceRef =
  | PatternGenerateEvaluateFixFileSourceRef
  | PatternGenerateEvaluateFixArtifactSourceRef;

export interface PatternGenerateEvaluateFixArtifactBundleSource {
  kind: "artifact_bundle";
  design_packet: PatternGenerateEvaluateFixSourceRef;
  design_spec?: PatternGenerateEvaluateFixSourceRef;
  direction_proposal?: PatternGenerateEvaluateFixSourceRef;
  tradeoff_matrix?: PatternGenerateEvaluateFixSourceRef;
  decision_log?: PatternGenerateEvaluateFixSourceRef;
  implementation_readiness?: PatternGenerateEvaluateFixSourceRef;
  additional_context?: PatternGenerateEvaluateFixSourceRef[];
}

export type PatternGenerateEvaluateFixTaskSource =
  | PatternGenerateEvaluateFixManagedNodeSource
  | PatternGenerateEvaluateFixArtifactBundleSource;

export interface PatternGenerateEvaluateFixBrief {
  objective?: string;
  scope?: PatternGenerateEvaluateFixScope;
}

export interface PatternGenerateEvaluateFixContextPolicy {
  allow_official_docs_fallback?: boolean;
  allow_domains?: string[];
}

export interface PatternGenerateEvaluateFixStrategy {
  max_fix_cycles?: number;
}

export interface PatternGenerateEvaluateFixEvaluation {
  commands: string[];
  required?: boolean;
}

export interface PatternGenerateEvaluateFixConfig extends BaseExecutableNode {
  brief: PatternGenerateEvaluateFixBrief;
  task_source: PatternGenerateEvaluateFixTaskSource;
  context_policy: PatternGenerateEvaluateFixContextPolicy;
  strategy: PatternGenerateEvaluateFixStrategy;
  evaluation: PatternGenerateEvaluateFixEvaluation;
  runtime?: ManagedPatternRuntime;
}

function workflowNodeId(rootId: string, suffix: string): string {
  return managedId(rootId, "pattern_generate_evaluate_fix", suffix);
}

function zeroPad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatScope(scope: PatternGenerateEvaluateFixScope | undefined): string[] {
  if (!scope) {
    return ["Scope: infer the most relevant repository surfaces from the task packet and implementation goal."];
  }

  const lines: string[] = [];

  if (scope.paths && scope.paths.length > 0) {
    lines.push("Repository paths in scope:");
    lines.push(...scope.paths.map((path) => `- ${path}`));
  }

  if (scope.areas && scope.areas.length > 0) {
    lines.push("Product or system areas in scope:");
    lines.push(...scope.areas.map((area) => `- ${area}`));
  }

  return lines.length > 0
    ? lines
    : ["Scope: infer the most relevant repository surfaces from the task packet and implementation goal."];
}

function formatBrief(brief: PatternGenerateEvaluateFixBrief): string[] {
  return [
    `Objective: ${brief.objective ?? "Implement the prepared task packet without drifting from its constraints."}`,
    "",
    ...formatScope(brief.scope)
  ].filter((line) => line.length > 0);
}

function formatContextPolicy(policy: PatternGenerateEvaluateFixContextPolicy): string[] {
  return [
    `- Allow official docs fallback: ${policy.allow_official_docs_fallback === false ? "no" : "yes"}`,
    ...(policy.allow_domains && policy.allow_domains.length > 0
      ? [`- Allowed domains: ${policy.allow_domains.join(", ")}`]
      : [])
  ];
}

function formatStrategy(strategy: PatternGenerateEvaluateFixStrategy): string[] {
  return [
    `- Max fix cycles: ${strategy.max_fix_cycles ?? 2}`
  ];
}

function formatEvaluation(evaluation: PatternGenerateEvaluateFixEvaluation): string[] {
  return [
    `- Hard evaluation required: ${evaluation.required === false ? "no" : "yes"}`,
    ...listOrFallback("Evaluator commands", evaluation.commands, "none specified")
  ];
}

function formatSourceRef(reference: PatternGenerateEvaluateFixSourceRef): string {
  return reference.kind === "file"
    ? `file:${reference.path}`
    : `artifact:${reference.node}.${reference.artifact}`;
}

function formatTaskSource(source: PatternGenerateEvaluateFixTaskSource): string[] {
  if (source.kind === "managed_node") {
    return [
      "- Source kind: managed_node",
      `- Source node: ${source.node}`,
      "- Expected artifacts when available: design_packet, design_spec, direction_proposal, tradeoff_matrix, decision_log, implementation_readiness"
    ];
  }

  return [
    "- Source kind: artifact_bundle",
    `- design_packet: ${formatSourceRef(source.design_packet)}`,
    ...(source.design_spec ? [`- design_spec: ${formatSourceRef(source.design_spec)}`] : []),
    ...(source.direction_proposal ? [`- direction_proposal: ${formatSourceRef(source.direction_proposal)}`] : []),
    ...(source.tradeoff_matrix ? [`- tradeoff_matrix: ${formatSourceRef(source.tradeoff_matrix)}`] : []),
    ...(source.decision_log ? [`- decision_log: ${formatSourceRef(source.decision_log)}`] : []),
    ...(source.implementation_readiness
      ? [`- implementation_readiness: ${formatSourceRef(source.implementation_readiness)}`]
      : []),
    ...(source.additional_context && source.additional_context.length > 0
      ? ["- additional_context:", ...source.additional_context.map((reference) => `  - ${formatSourceRef(reference)}`)]
      : [])
  ];
}

function sourceRefToContext(
  name: string,
  reference: PatternGenerateEvaluateFixSourceRef,
  optional: boolean
): ContextItem {
  return reference.kind === "file"
    ? workspaceFileContext(name, reference.path)
    : artifactContext(name, reference.node, reference.artifact, { optional });
}

function resolveTaskSourceMaterials(source: PatternGenerateEvaluateFixTaskSource): {
  context: ContextItem[];
} {
  if (source.kind === "managed_node") {
    return {
      context: [
        artifactContext("design_packet", source.node, "design_packet"),
        artifactContext("design_spec", source.node, "design_spec", { optional: true }),
        artifactContext("direction_proposal", source.node, "direction_proposal", { optional: true }),
        artifactContext("tradeoff_matrix", source.node, "tradeoff_matrix", { optional: true }),
        artifactContext("decision_log", source.node, "decision_log", { optional: true }),
        artifactContext("implementation_readiness", source.node, "implementation_readiness", { optional: true })
      ]
    };
  }

  const refs: Array<{ name: string; reference: PatternGenerateEvaluateFixSourceRef; optional: boolean }> = [
    { name: "design_packet", reference: source.design_packet, optional: false },
    ...(source.design_spec ? [{ name: "design_spec", reference: source.design_spec, optional: true }] : []),
    ...(source.direction_proposal
      ? [{ name: "direction_proposal", reference: source.direction_proposal, optional: true }]
      : []),
    ...(source.tradeoff_matrix ? [{ name: "tradeoff_matrix", reference: source.tradeoff_matrix, optional: true }] : []),
    ...(source.decision_log ? [{ name: "decision_log", reference: source.decision_log, optional: true }] : []),
    ...(source.implementation_readiness
      ? [{ name: "implementation_readiness", reference: source.implementation_readiness, optional: true }]
      : []),
    ...(source.additional_context ?? []).map((reference, index) => ({
      name: `additional_context_${zeroPad(index + 1)}`,
      reference,
      optional: true
    }))
  ];

  return {
    context: refs.map(({ name, reference, optional }) => sourceRefToContext(name, reference, optional))
  };
}

function buildPreparePrompt(config: PatternGenerateEvaluateFixConfig): string {
  return renderPrompt([
    body("Resolve the task source into one execution-ready task packet."),
    section("Objective", formatBrief(config.brief)),
    section("Allowed Sources and Tools", [
      ...formatContextPolicy(config.context_policy),
      "",
      ...formatTaskSource(config.task_source)
    ]),
    section("Evaluation Contract", formatEvaluation(config.evaluation)),
    section("Output Contract", [
      "Write `task-packet.json` and `workflow-brief.md` to the output directory.",
      "Use this exact schema for `task-packet.json`:",
      '{"task_summary":"...","affected_surfaces":["..."],"constraints":["..."],"evaluation_expectations":["..."],"implementation_hints":["..."],"upstream_artifacts":["..."],"follow_up_context":["..."]}'
    ]),
    section("Quality Bar", [
      "The task packet must be concrete enough that the generator can act without re-planning the problem.",
      "Preserve repo-specific constraints, boundaries, and validation expectations from the upstream design materials."
    ])
  ]);
}

function buildGeneratePrompt(config: PatternGenerateEvaluateFixConfig): string {
  return renderPrompt([
    body("Generate or fix the code change against the prepared task packet."),
    section("Objective", formatBrief(config.brief)),
    section("Current Context", [
      "Use the task packet in context.",
      "If a prior failed evaluation ledger is present, fix the concrete failures instead of re-inventing the task."
    ]),
    section("Allowed Sources and Tools", formatContextPolicy(config.context_policy)),
    section("Strategy", formatStrategy(config.strategy)),
    section("Evaluation Contract", formatEvaluation(config.evaluation)),
    section("Output Contract", [
      "Write `change-notes.md` to the output directory."
    ]),
    section("Quality Bar", [
      "Make the smallest coherent change that satisfies the task packet and evaluator expectations.",
      "Do not invent new design decisions that should have been settled upstream."
    ])
  ]);
}

function buildAggregatePrompt(evaluation: PatternGenerateEvaluateFixEvaluation): string {
  return renderPrompt([
    body("Aggregate the evaluator results into one machine-readable evaluation ledger."),
    section("Current Context", [
      "Use the task packet, latest change notes, and every evaluator result in context."
    ]),
    section("Evaluation Contract", formatEvaluation(evaluation)),
    section("Output Contract", [
      "Write `evaluation-ledger.json` to the output directory.",
      "Use this exact schema:",
      '{"required":true,"passed":false,"summary":"...","evaluators":[{"id":"evaluation_01","command":"...","passed":true,"summary":"...","exit_code":0}],"passed_evaluators":["evaluation_01"],"failed_evaluators":["evaluation_02"]}'
    ]),
    section("Quality Bar", [
      "Preserve every evaluator outcome. Do not drop failures, skips, or weak evidence.",
      "If evaluation is soft, keep the truth visible rather than rewriting it into a green summary."
    ])
  ]);
}

function buildGatePrompt(): string {
  return renderPrompt([
    body("Decide whether the aggregated evaluation ledger is clean enough to stop the generate/fix loop."),
    section("Current Context", [
      "Use the evaluation ledger in context."
    ])
  ]);
}

function buildGateRubric(): string {
  return [
    "Pass only if the evaluation ledger clearly shows that every required evaluator passed.",
    "Fail if any required evaluator failed, if the ledger summary is inconsistent, or if the pass state is ambiguous."
  ].join(" ");
}

function buildPublishPrompt(config: PatternGenerateEvaluateFixConfig): string {
  return renderPrompt([
    body("Publish the final change package from the task packet, change notes, and evaluation ledger."),
    section("Objective", formatBrief(config.brief)),
    section("Current Context", [
      "Use the task packet, latest change notes, latest evaluation ledger, and any prior failed evaluation ledger in context."
    ]),
    section("Evaluation Contract", formatEvaluation(config.evaluation)),
    section("Output Contract", [
      "Write `change-summary.md`, `change-packet.json`, `evaluation-ledger.json`, and `fix-log.md` to the output directory.",
      "Use this exact schema for `change-packet.json`:",
      '{"task_summary":"...","touched_surfaces":["..."],"evaluation_summary":{"required":true,"passed":false,"passed_evaluators":["..."],"failed_evaluators":["..."]},"residual_risks":["..."],"follow_up_items":["..."]}'
    ]),
    section("Quality Bar", [
      "The change summary should be brief and execution-focused.",
      "The machine packet must preserve the true evaluation outcome and any residual risk."
    ])
  ]);
}

function buildEvaluatorNode(
  config: PatternGenerateEvaluateFixConfig,
  generateId: string,
  index: number
): CheckNode {
  const suffix = zeroPad(index + 1);
  const command = config.evaluation.commands[index] ?? "";

  return {
    type: "check",
    id: workflowNodeId(config.id, `evaluate_${suffix}`),
    label: `Evaluator ${suffix}`,
    ...sharedNodeBase(config),
    check_kind: "deterministic",
    command: "sh",
    args: ["-lc", command],
    on_failure: "continue",
    context: [
      artifactContext("change_notes", generateId, "change_notes")
    ],
    artifacts: outputDirArtifact(`evaluation_result_${suffix}`, "result.json")
  };
}

function buildAggregateContext(
  config: PatternGenerateEvaluateFixConfig,
  taskPacketId: string,
  generateId: string
): ContextItem[] {
  return [
    artifactContext("task_packet", taskPacketId, "task_packet"),
    artifactContext("change_notes", generateId, "change_notes"),
    ...config.evaluation.commands.map((_, index): ContextItem =>
      artifactContext(
        `evaluation_result_${zeroPad(index + 1)}`,
        workflowNodeId(config.id, `evaluate_${zeroPad(index + 1)}`),
        `evaluation_result_${zeroPad(index + 1)}`
      )
    )
  ];
}

export function buildPatternGenerateEvaluateFix(config: PatternGenerateEvaluateFixConfig): SequenceNode {
  const shared = sharedNodeBase(config);
  const workflowId = workflowNodeId(config.id, "workflow");
  const evaluationRequired = config.evaluation.required !== false;
  const maxFixCycles = config.strategy.max_fix_cycles ?? 2;

  const prepareId = workflowNodeId(config.id, "prepare_task_packet");
  const changeId = workflowNodeId(config.id, "generate_or_fix_change");
  const evaluatorPanelId = workflowNodeId(config.id, "evaluator_panel");
  const aggregateId = workflowNodeId(config.id, "aggregate_evaluations");
  const gateId = workflowNodeId(config.id, "evaluation_gate");
  const loopId = workflowNodeId(config.id, "fix_loop");
  const loopBodyId = workflowNodeId(config.id, "fix_loop_body");

  const sourceMaterials = resolveTaskSourceMaterials(config.task_source);
  const evaluatorNodes = config.evaluation.commands.map((_, index) => buildEvaluatorNode(config, changeId, index));

  const prepareNode: AgentNode = {
    type: "agent",
    id: prepareId,
    label: "Prepare Task Packet",
    ...shared,
    sandbox: "read-only",
    context: [...(config.context ?? []), ...sourceMaterials.context],
    artifacts: mergeArtifacts(
      outputDirArtifact("task_packet", "task-packet.json"),
      workflowBriefOutput()
    ),
    prompt: buildPreparePrompt(config)
  };

  const changeNode: AgentNode = {
    type: "agent",
    id: changeId,
    label: "Generate Or Fix Change",
    ...shared,
    sandbox: "workspace-write",
    context: [
      artifactContext("task_packet", prepareId, "task_packet"),
      artifactContext("failed_evaluation_ledger", aggregateId, "evaluation_ledger", {
        iteration: "latest_failed",
        optional: true
      })
    ],
    artifacts: outputDirArtifact("change_notes", "change-notes.md"),
    prompt: buildGeneratePrompt(config)
  };

  const aggregateNode: AgentNode = {
    type: "agent",
    id: aggregateId,
    label: "Aggregate Evaluations",
    ...shared,
    sandbox: "read-only",
    context: buildAggregateContext(config, prepareId, changeId),
    artifacts: outputDirArtifact("evaluation_ledger", "evaluation-ledger.json"),
    prompt: buildAggregatePrompt(config.evaluation)
  };

  const gateNode: CheckNode = {
    type: "check",
    id: gateId,
    label: "Evaluation Gate",
    ...shared,
    check_kind: "ai",
    context: [
      artifactContext("evaluation_ledger", aggregateId, "evaluation_ledger")
    ],
    artifacts: outputDirArtifact("gate_result", "result.json"),
    prompt: buildGatePrompt(),
    rubric: buildGateRubric()
  };

  const publishedArtifacts: Record<string, ArtifactDefinition> = mergeArtifacts(
    outputDirArtifact("change_summary", "change-summary.md"),
    outputDirArtifact("change_packet", "change-packet.json"),
    outputDirArtifact("evaluation_ledger", "evaluation-ledger.json"),
    outputDirArtifact("fix_log", "fix-log.md")
  );

  const publishNode: AgentNode = {
    type: "agent",
    id: config.id,
    ...(config.label ? { label: config.label } : { label: "Publish Change Package" }),
    ...shared,
    sandbox: "read-only",
    context: [
      artifactContext("task_packet", prepareId, "task_packet"),
      artifactContext("change_notes", changeId, "change_notes", {
        ...(evaluationRequired ? { iteration: "latest_passed" as const } : {})
      }),
      artifactContext("evaluation_ledger", aggregateId, "evaluation_ledger", {
        ...(evaluationRequired ? { iteration: "latest_passed" as const } : {})
      }),
      artifactContext("failed_evaluation_ledger", aggregateId, "evaluation_ledger", {
        iteration: "latest_failed",
        optional: true
      })
    ],
    artifacts: publishedArtifacts,
    prompt: buildPublishPrompt(config)
  };

  const steps: SequenceNode["steps"] = [prepareNode];

  if (evaluationRequired) {
    const loopBody: SequenceNode = {
      type: "sequence",
      id: loopBodyId,
      label: "Generate Evaluate Fix Body",
      steps: [
        changeNode,
        {
          type: "parallel",
          id: evaluatorPanelId,
          label: "Evaluator Panel",
          max_concurrency: config.evaluation.commands.length,
          steps: evaluatorNodes
        } satisfies ParallelNode,
        aggregateNode,
        gateNode
      ]
    };

    steps.push({
      type: "repeat",
      id: loopId,
      label: "Generate Evaluate Fix Loop",
      max_attempts: maxFixCycles + 1,
      body: loopBody,
      until: {
        node: gateId
      }
    } satisfies RepeatNode);
  } else {
    steps.push(
      changeNode,
      {
        type: "parallel",
        id: evaluatorPanelId,
        label: "Evaluator Panel",
        max_concurrency: config.evaluation.commands.length,
        steps: evaluatorNodes
      } satisfies ParallelNode,
      aggregateNode
    );
  }

  steps.push(publishNode);

  return {
    type: "sequence",
    id: workflowId,
    label: config.label ? `${config.label} Workflow` : "Generate Evaluate Fix Pattern",
    steps
  };
}

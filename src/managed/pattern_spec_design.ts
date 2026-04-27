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
  maxConcurrency,
  mergeArtifacts,
  outputDirArtifact,
  renderPrompt,
  section,
  sharedNodeBase,
  type ManagedPatternRuntime,
  workflowBriefOutput,
  workflowPlanJsonOutput,
  workflowPlanMarkdownOutput
} from "./foundation.js";

export interface PatternSpecDesignScope {
  paths?: string[];
  areas?: string[];
}

export interface PatternSpecDesignBrief {
  problem: string;
  goal: string;
  audience?: string;
  constraints?: string[];
  decision_drivers?: string[];
  scope?: PatternSpecDesignScope;
}

export interface PatternSpecDesignContextPolicy {
  repo_first?: boolean;
  allow_web_fallback?: boolean;
  web_triggers?: string[];
  allow_domains?: string[];
}

export interface PatternSpecDesignApprovalPolicy {
  require_direction_approval?: boolean;
}

export interface PatternSpecDesignStrategy {
  alternatives?: number;
  critique_profiles?: string[];
  max_revision_cycles?: number;
}

export interface PatternSpecDesignDelivery {
  format?: string;
  sections?: string[];
}

export interface PatternSpecDesignConfig extends BaseExecutableNode {
  brief: PatternSpecDesignBrief;
  context_policy: PatternSpecDesignContextPolicy;
  approval_policy: PatternSpecDesignApprovalPolicy;
  strategy: PatternSpecDesignStrategy;
  delivery: PatternSpecDesignDelivery;
  runtime?: ManagedPatternRuntime;
}

function workflowNodeId(rootId: string, suffix: string): string {
  return managedId(rootId, "pattern_spec_design", suffix);
}

function formatScope(scope: PatternSpecDesignScope | undefined): string[] {
  if (!scope) {
    return ["Scope: infer the most relevant repository surfaces from the problem and goal."];
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

  return lines.length > 0 ? lines : ["Scope: infer the most relevant repository surfaces from the problem and goal."];
}

function formatBrief(brief: PatternSpecDesignBrief): string[] {
  return [
    `Problem: ${brief.problem}`,
    `Goal: ${brief.goal}`,
    ...(brief.audience ? [`Audience: ${brief.audience}`] : []),
    ...listOrFallback("Constraints", brief.constraints ?? [], "none specified"),
    "",
    ...listOrFallback("Decision drivers", brief.decision_drivers ?? [], "none specified"),
    "",
    ...formatScope(brief.scope)
  ].filter((line) => line.length > 0);
}

function formatContextPolicy(policy: PatternSpecDesignContextPolicy): string[] {
  return [
    `- Repo first: ${policy.repo_first === false ? "no" : "yes"}`,
    `- Allow web fallback: ${policy.allow_web_fallback ? "yes" : "no"}`,
    ...(policy.web_triggers && policy.web_triggers.length > 0
      ? [`- Valid web fallback triggers: ${policy.web_triggers.join(", ")}`]
      : []),
    ...(policy.allow_domains && policy.allow_domains.length > 0
      ? [`- Allowed domains: ${policy.allow_domains.join(", ")}`]
      : [])
  ];
}

function formatStrategy(strategy: PatternSpecDesignStrategy): string[] {
  return [
    `- Alternatives: ${strategy.alternatives ?? 3}`,
    `- Critique profiles: ${(strategy.critique_profiles ?? ["architecture", "implementation", "ux"]).join(", ")}`,
    `- Max revision cycles: ${strategy.max_revision_cycles ?? 2}`
  ];
}

function formatDelivery(delivery: PatternSpecDesignDelivery): string[] {
  return [
    `- Format: ${delivery.format ?? "design_spec"}`,
    ...(delivery.sections && delivery.sections.length > 0
      ? [`- Required sections: ${delivery.sections.join(", ")}`]
      : [])
  ];
}

function buildBriefPrompt(config: PatternSpecDesignConfig): string {
  return renderPrompt([
    body("Clarify the problem and turn it into a concrete design brief."),
    section("Objective", formatBrief(config.brief)),
    section("Allowed Sources and Tools", formatContextPolicy(config.context_policy)),
    section("Output Contract", [
      "Write `design-brief.md` and `workflow-brief.md` to the output directory."
    ]),
    section("Quality Bar", [
      "Make the problem, end state, scope boundaries, and decision criteria explicit.",
      "A downstream designer should not need to guess what success means."
    ])
  ]);
}

function buildInspectPrompt(config: PatternSpecDesignConfig): string {
  return renderPrompt([
    body("Inspect the repository and capture the current system shape relevant to the design problem."),
    section("Objective", formatBrief(config.brief)),
    section("Current Context", [
      "Use the design brief in context."
    ]),
    section("Quality Bar", [
      "Surface existing patterns, constraints, tests, docs, ownership boundaries, and operational assumptions.",
      "Prefer repository truth over generalized design advice."
    ]),
    section("Output Contract", [
      "Write `current-state.md` to the output directory."
    ])
  ]);
}

function buildGapPrompt(config: PatternSpecDesignConfig): string {
  return renderPrompt([
    body("Identify the information gaps that still matter after repo inspection."),
    section("Objective", formatBrief(config.brief)),
    section("Current Context", [
      "Use the design brief and current-state notes in context."
    ]),
    section("Allowed Sources and Tools", formatContextPolicy(config.context_policy)),
    section("Output Contract", [
      "Write `information-gaps.md` to the output directory.",
      "Include repo-sufficient judgment, unresolved questions, and any justified external research topics."
    ]),
    section("Quality Bar", [
      "Recommend external research only when the missing information materially affects design quality."
    ])
  ]);
}

function buildExternalResearchPrompt(config: PatternSpecDesignConfig, taskIndex: number): string {
  return renderPrompt([
    body(`Run targeted external research task ${taskIndex + 1}.`),
    section("Objective", formatBrief(config.brief)),
    section("Current Context", [
      "Read `information-gaps.md` in context and take the topic at your slot index.",
      "If there is no relevant topic, write a short note explaining that no external lookup was required."
    ]),
    section("Allowed Sources and Tools", formatContextPolicy(config.context_policy)),
    section("Output Contract", [
      "Write `external-findings.md` to the output directory."
    ]),
    section("Quality Bar", [
      "Repository conventions remain primary. External research fills gaps; it does not override local patterns."
    ])
  ]);
}

function buildOptionPrompt(config: PatternSpecDesignConfig, optionIndex: number, total: number): string {
  return renderPrompt([
    body(`Generate design option ${optionIndex + 1} of ${total}.`),
    section("Objective", formatBrief(config.brief)),
    section("Current Context", [
      "Use the design brief, current-state notes, information gaps, and any external findings in context."
    ]),
    section("Quality Bar", [
      "The option must be materially distinct from the other likely options, not a paraphrase.",
      "Stay grounded in the repository’s architecture and constraints."
    ]),
    section("Output Contract", [
      `Write \`option-${String(optionIndex + 1).padStart(2, "0")}.md\` to the output directory.`
    ])
  ]);
}

function buildDirectionPrompt(config: PatternSpecDesignConfig, total: number): string {
  return renderPrompt([
    body("Compare the design options, choose a direction, and define the design plan."),
    section("Objective", formatBrief(config.brief)),
    section("Current Context", [
      `Use all ${total} option artifacts, the design brief, current-state notes, and any external findings in context.`
    ]),
    section("Output Contract", [
      "Write `direction-proposal.md`, `tradeoff-matrix.md`, `workflow-plan.md`, and `workflow-plan.json` to the output directory.",
      "Use this JSON schema exactly for `workflow-plan.json`:",
      '{"recommended_direction":"...","decision_drivers":["..."],"risks":["..."],"delivery_expectations":["..."]}'
    ]),
    section("Quality Bar", [
      "The direction must explain why it fits this repository better than the rejected options.",
      "Do not leave implementation-affecting tradeoffs implicit."
    ])
  ]);
}

function buildDirectionCheckpointPrompt(): string {
  return renderPrompt([
    body("Review the proposed direction before the workflow drafts the full design spec."),
    section("Quality Bar", [
      "Pass when the chosen direction is sound, repo-fit, and decision-complete enough to draft against.",
      "Deny when the direction is missing a major tradeoff, repo-fit constraint, or implementation consequence."
    ]),
    section("Blocker and Escalation Rules", [
      "When denying, explain the missing decision or tradeoff explicitly."
    ])
  ]);
}

function buildDraftPrompt(config: PatternSpecDesignConfig): string {
  return renderPrompt([
    body("Draft the strongest current implementation-ready design spec."),
    section("Objective", formatBrief(config.brief)),
    section("Current Context", [
      "Use the latest approved direction, tradeoff matrix, design brief, current-state notes, and information gaps in context."
    ]),
    section("Output Contract", [
      "Write `spec-draft.md` to the output directory.",
      ...formatDelivery(config.delivery)
    ]),
    section("Quality Bar", [
      "A downstream implementer should not need to invent missing boundaries, validation ownership, or migration consequences."
    ])
  ]);
}

function buildCritiquePrompt(profile: string, config: PatternSpecDesignConfig): string {
  return renderPrompt([
    body(`Critique the current spec draft from the ${profile} perspective.`),
    section("Objective", formatBrief(config.brief)),
    section("Current Context", [
      "Use the current spec draft, direction proposal, tradeoff matrix, and current-state notes in context."
    ]),
    section("Quality Bar", [
      "Raise only concrete blockers or high-value improvements.",
      "Each blocker must name the missing decision, the affected repo surface, and the exact revision needed."
    ]),
    section("Output Contract", [
      `Write \`critique-${profile}.md\` to the output directory.`
    ])
  ]);
}

function buildMergePrompt(): string {
  return renderPrompt([
    body("Merge the critique artifacts into one revision brief."),
    section("Quality Bar", [
      "De-duplicate overlap, preserve the strongest blockers, and separate blockers from non-blocking improvements."
    ]),
    section("Output Contract", [
      "Write `critique-merged.md` to the output directory."
    ])
  ]);
}

function buildQualityPrompt(config: PatternSpecDesignConfig): string {
  return renderPrompt([
    body("Review whether the current design spec is implementation-ready."),
    section("Objective", formatBrief(config.brief)),
    section("Current Context", [
      "Use the latest spec draft, merged critiques, direction proposal, and current-state notes in context."
    ]),
    section("Output Contract", [
      "Write `quality-review.json` to the output directory using this exact schema:",
      '{"passed":true,"summary":"...","blockers":[{"title":"...","missing_decision":"...","repo_surface":"...","required_revision":"..."}],"improvements":["..."]}'
    ])
  ]);
}

function buildQualityRubric(config: PatternSpecDesignConfig): string {
  const sectionRequirement =
    config.delivery.sections && config.delivery.sections.length > 0
      ? `Pass only if the draft covers: ${config.delivery.sections.join(", ")}.`
      : "Pass only if the draft covers the problem, recommendation, architecture, risks, and implementation readiness clearly.";

  return [
    sectionRequirement,
    "Fail if the draft leaves repo-specific ownership, migration consequences, file boundaries, or validation expectations implicit.",
    "Fail if blockers remain unresolved in a way that would force pattern_generate_evaluate_fix to guess."
  ].join(" ");
}

function buildFinalizePrompt(config: PatternSpecDesignConfig): string {
  return renderPrompt([
    body("Publish the final design package."),
    section("Objective", formatBrief(config.brief)),
    section("Current Context", [
      "Use the latest passed spec draft, merged critiques, latest direction proposal, and current-state notes in context."
    ]),
    section("Output Contract", [
      "Write `design-spec.md`, `design-packet.json`, `direction-proposal.md`, `tradeoff-matrix.md`, `decision-log.md`, `implementation-readiness.md`, `critique-merged.md`, and `quality-review.json` to the output directory.",
      "Use this exact schema for `design-packet.json`:",
      '{"problem":"...","goal":"...","chosen_direction":"...","affected_surfaces":["..."],"constraints":["..."],"non_goals":["..."],"validation_expectations":["..."],"unresolved_questions":["..."],"downstream_execution_hints":["..."]}'
    ]),
    section("Quality Bar", [
      "The final package should read like the intended long-term design, not a draft with unresolved placeholders."
    ])
  ]);
}

function buildOptionArtifacts(index: number): Record<string, ArtifactDefinition> {
  const suffix = String(index + 1).padStart(2, "0");
  return outputDirArtifact(`option_${suffix}`, `option-${suffix}.md`);
}

export function buildPatternSpecDesign(config: PatternSpecDesignConfig): SequenceNode {
  const shared = sharedNodeBase(config);
  const workflowId = workflowNodeId(config.id, "workflow");
  const alternatives = config.strategy.alternatives ?? 3;
  const critiqueProfiles = config.strategy.critique_profiles ?? ["architecture", "implementation", "ux"];
  const critiqueConcurrency = maxConcurrency(config.runtime, critiqueProfiles.length);
  const optionConcurrency = maxConcurrency(config.runtime, alternatives);
  const externalTasks = config.context_policy.allow_web_fallback ? 2 : 0;

  const briefId = workflowNodeId(config.id, "clarify_brief");
  const inspectId = workflowNodeId(config.id, "inspect_current_state");
  const gapId = workflowNodeId(config.id, "identify_information_gaps");
  const externalId = workflowNodeId(config.id, "targeted_external_research");
  const directionId = workflowNodeId(config.id, "propose_direction");
  const directionCheckpointId = workflowNodeId(config.id, "approve_direction");
  const directionLoopId = workflowNodeId(config.id, "direction_loop");
  const directionBodyId = workflowNodeId(config.id, "direction_body");
  const initialDraftId = workflowNodeId(config.id, "draft_spec");
  const revisionLoopId = workflowNodeId(config.id, "revision_loop");
  const revisionBodyId = workflowNodeId(config.id, "revision_body");
  const reviseId = workflowNodeId(config.id, "revise_spec");
  const critiquePanelId = workflowNodeId(config.id, "critique_panel");
  const mergeId = workflowNodeId(config.id, "merge_critiques");
  const qualityId = workflowNodeId(config.id, "quality_review");

  const steps: SequenceNode["steps"] = [
    {
      type: "agent",
      id: briefId,
      label: "Clarify Design Brief",
      ...shared,
      ...(config.context ? { context: config.context } : {}),
      artifacts: mergeArtifacts(
        outputDirArtifact("design_brief", "design-brief.md"),
        workflowBriefOutput()
      ),
      goal: buildBriefPrompt(config)
    },
    {
      type: "agent",
      id: inspectId,
      label: "Inspect Current State",
      ...shared,
      context: [
        artifactContext("design_brief", briefId, "design_brief")
      ],
      artifacts: outputDirArtifact("current_state", "current-state.md"),
      goal: buildInspectPrompt(config)
    },
    {
      type: "agent",
      id: gapId,
      label: "Identify Information Gaps",
      ...shared,
      context: [
        artifactContext("design_brief", briefId, "design_brief"),
        artifactContext("current_state", inspectId, "current_state")
      ],
      artifacts: outputDirArtifact("information_gaps", "information-gaps.md"),
      goal: buildGapPrompt(config)
    }
  ];

  if (externalTasks > 0) {
    steps.push({
      type: "parallel",
      id: externalId,
      label: "Targeted External Research",
      max_concurrency: maxConcurrency(config.runtime, externalTasks),
      steps: Array.from({ length: externalTasks }, (_, index): AgentNode => ({
        type: "agent",
        id: workflowNodeId(config.id, `external_research_${String(index + 1).padStart(2, "0")}`),
        label: `External Research ${String(index + 1).padStart(2, "0")}`,
        ...shared,
        context: [
          artifactContext("design_brief", briefId, "design_brief"),
          artifactContext("current_state", inspectId, "current_state"),
          artifactContext("information_gaps", gapId, "information_gaps")
        ],
        artifacts: outputDirArtifact(`external_findings_${String(index + 1).padStart(2, "0")}`, "external-findings.md"),
        goal: buildExternalResearchPrompt(config, index)
      }))
    } satisfies ParallelNode);
  }

  const directionContext: ContextItem[] = [
    artifactContext("design_brief", briefId, "design_brief"),
    artifactContext("current_state", inspectId, "current_state"),
    artifactContext("information_gaps", gapId, "information_gaps")
  ];

  if (externalTasks > 0) {
    for (let index = 0; index < externalTasks; index += 1) {
      const suffix = String(index + 1).padStart(2, "0");
      directionContext.push(
        artifactContext(
          `external_findings_${suffix}`,
          workflowNodeId(config.id, `external_research_${suffix}`),
          `external_findings_${suffix}`,
          { if_available: true }
        )
      );
    }
  }

  const optionNodes: AgentNode[] = Array.from({ length: alternatives }, (_, index): AgentNode => ({
    type: "agent",
    id: workflowNodeId(config.id, `option_${String(index + 1).padStart(2, "0")}`),
    label: `Option ${String(index + 1).padStart(2, "0")}`,
    ...shared,
    context: directionContext,
    artifacts: buildOptionArtifacts(index),
    goal: buildOptionPrompt(config, index, alternatives)
  }));

  steps.push({
    type: "parallel",
    id: workflowNodeId(config.id, "generate_options"),
    label: "Generate Options",
    max_concurrency: optionConcurrency,
    steps: optionNodes
  });

  const directionInputs = [
    ...directionContext,
    ...optionNodes.map(
      (_, index): ContextItem => {
        const suffix = String(index + 1).padStart(2, "0");
        return artifactContext(`option_${suffix}`, workflowNodeId(config.id, `option_${suffix}`), `option_${suffix}`);
      }
    )
  ];

  if (config.approval_policy.require_direction_approval) {
    steps.push({
      type: "repeat",
      id: directionLoopId,
      label: "Direction Approval Loop",
      max_attempts: 3,
      body: {
        type: "sequence",
        id: directionBodyId,
        label: "Direction Approval Body",
        steps: [
          {
            type: "agent",
            id: directionId,
            label: "Propose Direction",
            ...shared,
            context: [
              ...directionInputs,
              artifactContext("operator_feedback", directionCheckpointId, "operator_feedback", {
                iteration: "latest_failed",
                if_available: true
              })
            ],
            artifacts: mergeArtifacts(
              outputDirArtifact("direction_proposal", "direction-proposal.md"),
              outputDirArtifact("tradeoff_matrix", "tradeoff-matrix.md"),
              workflowPlanMarkdownOutput(),
              workflowPlanJsonOutput()
            ),
            goal: buildDirectionPrompt(config, alternatives)
          },
          {
            type: "checkpoint",
            id: directionCheckpointId,
            label: "Approve Direction",
            ...shared,
            context: [
              artifactContext("tradeoff_matrix", directionId, "tradeoff_matrix")
            ],
            review_from: {
              node: directionId,
              artifact: "direction_proposal"
            },
            goal: buildDirectionCheckpointPrompt()
          }
        ]
      },
      until: {
        node: directionCheckpointId
      }
    } satisfies RepeatNode);
  } else {
    steps.push({
      type: "agent",
      id: directionId,
      label: "Propose Direction",
      ...shared,
      context: directionInputs,
      artifacts: mergeArtifacts(
        outputDirArtifact("direction_proposal", "direction-proposal.md"),
        outputDirArtifact("tradeoff_matrix", "tradeoff-matrix.md"),
        workflowPlanMarkdownOutput(),
        workflowPlanJsonOutput()
      ),
      goal: buildDirectionPrompt(config, alternatives)
    });
  }

  const latestDirectionRef = artifactContext("direction_proposal", directionId, "direction_proposal", {
    ...(config.approval_policy.require_direction_approval ? { iteration: "latest_passed" as const } : {})
  });

  const latestTradeoffRef = artifactContext("tradeoff_matrix", directionId, "tradeoff_matrix", {
    ...(config.approval_policy.require_direction_approval ? { iteration: "latest_passed" as const } : {})
  });

  steps.push({
    type: "agent",
    id: initialDraftId,
    label: "Draft Spec",
    ...shared,
    context: [
      artifactContext("design_brief", briefId, "design_brief"),
      artifactContext("current_state", inspectId, "current_state"),
      latestDirectionRef,
      latestTradeoffRef
    ],
    artifacts: outputDirArtifact("spec_draft", "spec-draft.md"),
    goal: buildDraftPrompt(config)
  });

  const critiqueNodes: AgentNode[] = critiqueProfiles.map((profile) => ({
    type: "agent",
    id: workflowNodeId(config.id, `critique_${profile}`),
    label: `Critique ${profile}`,
    ...shared,
    context: [
      artifactContext("spec_revision", reviseId, "spec_revision"),
      latestDirectionRef,
      latestTradeoffRef,
      artifactContext("current_state", inspectId, "current_state")
    ],
    artifacts: outputDirArtifact(`critique_${profile}`, `critique-${profile}.md`),
    goal: buildCritiquePrompt(profile, config)
  }));

  steps.push({
    type: "repeat",
    id: revisionLoopId,
    label: "Revision Loop",
    max_attempts: config.strategy.max_revision_cycles ?? 2,
    body: {
      type: "sequence",
      id: revisionBodyId,
      label: "Revision Body",
      steps: [
        {
          type: "agent",
          id: reviseId,
          label: "Revise Spec",
          ...shared,
          context: [
            artifactContext("spec_draft", initialDraftId, "spec_draft"),
            latestDirectionRef,
            latestTradeoffRef,
            artifactContext("current_state", inspectId, "current_state"),
            artifactContext("failed_critique_merged", mergeId, "critique_merged", {
              iteration: "latest_failed",
              if_available: true
            }),
            artifactContext("failed_quality_review", qualityId, "verification_json", {
              iteration: "latest_failed",
              if_available: true
            })
          ],
          artifacts: outputDirArtifact("spec_revision", "spec-revision.md"),
          goal: buildDraftPrompt(config)
        },
        {
          type: "parallel",
          id: critiquePanelId,
          label: "Critique Panel",
          max_concurrency: critiqueConcurrency,
          steps: critiqueNodes
        },
        {
          type: "agent",
          id: mergeId,
          label: "Merge Critiques",
          ...shared,
          context: critiqueProfiles.map((profile): ContextItem =>
            artifactContext(`critique_${profile}`, workflowNodeId(config.id, `critique_${profile}`), `critique_${profile}`)
          ),
          artifacts: outputDirArtifact("critique_merged", "critique-merged.md"),
          goal: buildMergePrompt()
        },
        {
          type: "check",
          id: qualityId,
          label: "Quality Review",
          ...shared,
          check_kind: "ai",
          context: [
            artifactContext("spec_revision", reviseId, "spec_revision"),
            artifactContext("critique_merged", mergeId, "critique_merged"),
            latestDirectionRef,
            artifactContext("current_state", inspectId, "current_state")
          ],
          goal: buildQualityPrompt(config),
          rubric: buildQualityRubric(config)
        }
      ]
    },
    until: {
      node: qualityId
    }
  } satisfies RepeatNode);

  const publishedArtifacts = mergeArtifacts(
    outputDirArtifact("design_spec", "design-spec.md"),
    outputDirArtifact("design_packet", "design-packet.json"),
    outputDirArtifact("direction_proposal", "direction-proposal.md"),
    outputDirArtifact("tradeoff_matrix", "tradeoff-matrix.md"),
    outputDirArtifact("decision_log", "decision-log.md"),
    outputDirArtifact("implementation_readiness", "implementation-readiness.md"),
    outputDirArtifact("critique_merged", "critique-merged.md"),
    outputDirArtifact("quality_review", "quality-review.json")
  );

  steps.push({
    type: "agent",
    id: config.id,
    ...(config.label ? { label: config.label } : { label: "Publish Design Package" }),
    ...shared,
    context: [
      artifactContext("design_brief", briefId, "design_brief"),
      artifactContext("current_state", inspectId, "current_state"),
      latestDirectionRef,
      latestTradeoffRef,
      artifactContext("spec_revision", reviseId, "spec_revision", {
        iteration: "latest_passed"
      }),
      artifactContext("critique_merged", mergeId, "critique_merged", {
        iteration: "latest_passed",
        if_available: true
      }),
      artifactContext("quality_review", qualityId, "verification_json", {
        iteration: "latest_passed"
      })
    ],
    artifacts: publishedArtifacts,
    goal: buildFinalizePrompt(config)
  });

  return {
    type: "sequence",
    id: workflowId,
    label: config.label ? `${config.label} Workflow` : "Spec Design Workflow",
    steps
  };
}

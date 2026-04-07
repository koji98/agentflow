import type {
  AgentNode,
  BaseExecutableNode,
  ContextReference,
  OutputDefinition,
  ParallelNode,
  RepeatNode,
  SequenceNode
} from "../graph/authored.js";

export interface SpecDesignScope {
  paths?: string[];
  areas?: string[];
}

export interface SpecDesignResearchPolicy {
  repo_first: boolean;
  allow_web_fallback: boolean;
  web_triggers?: string[];
  allow_domains?: string[];
  max_external_research_tasks: number;
}

export interface SpecDesignDeliverable {
  format?: string;
  sections?: string[];
}

export interface SpecDesignOrchestration {
  option_count: number;
  max_parallel_options: number;
  critique_roles: string[];
  revision_rounds: number;
}

export interface SpecDesignWorkflowConfig extends BaseExecutableNode {
  problem: string;
  goal: string;
  audience?: string;
  constraints: string[];
  decision_drivers: string[];
  scope: SpecDesignScope;
  research_policy: SpecDesignResearchPolicy;
  deliverable: SpecDesignDeliverable;
  orchestration: SpecDesignOrchestration;
}

function managedId(rootId: string, suffix: string): string {
  return `${rootId}__managed__spec_design__${suffix}`;
}

function sharedNodeBase(config: SpecDesignWorkflowConfig): Pick<
  AgentNode,
  "repo" | "profile" | "timeout_sec"
> {
  return {
    ...(config.repo ? { repo: config.repo } : {}),
    ...(config.profile ? { profile: config.profile } : {}),
    ...(config.timeout_sec !== undefined ? { timeout_sec: config.timeout_sec } : {})
  };
}

function appendOutput(outputs: OutputDefinition[], output: OutputDefinition): OutputDefinition[] {
  return outputs.some((item) => item.name === output.name) ? outputs : [...outputs, output];
}

function formatList(title: string, values: string[]): string[] {
  if (values.length === 0) {
    return [`${title}: none specified`];
  }

  return [title, ...values.map((value) => `- ${value}`)];
}

function formatScope(scope: SpecDesignScope): string[] {
  const lines: string[] = [];

  if (scope.paths && scope.paths.length > 0) {
    lines.push("Repository paths in scope:");
    lines.push(...scope.paths.map((path) => `- ${path}`));
  }

  if (scope.areas && scope.areas.length > 0) {
    lines.push("Product or system areas in scope:");
    lines.push(...scope.areas.map((area) => `- ${area}`));
  }

  return lines.length > 0 ? lines : ["Scope: infer the most relevant parts of the repository from the problem and goal."];
}

function formatResearchPolicy(policy: SpecDesignResearchPolicy): string[] {
  const lines = [
    `- Repo first: ${policy.repo_first ? "yes" : "no"}`,
    `- Allow web fallback: ${policy.allow_web_fallback ? "yes" : "no"}`,
    `- Max external research tasks: ${policy.max_external_research_tasks}`
  ];

  if (policy.web_triggers && policy.web_triggers.length > 0) {
    lines.push(`- Valid web fallback triggers: ${policy.web_triggers.join(", ")}`);
  }

  if (policy.allow_domains && policy.allow_domains.length > 0) {
    lines.push(`- Allowed external domains: ${policy.allow_domains.join(", ")}`);
  }

  return lines;
}

function formatDeliverable(deliverable: SpecDesignDeliverable): string[] {
  const lines = [`- Format: ${deliverable.format ?? "design_spec"}`];

  if (deliverable.sections && deliverable.sections.length > 0) {
    lines.push(`- Required sections: ${deliverable.sections.join(", ")}`);
  }

  return lines;
}

function buildImplementationReadinessLines(config: SpecDesignWorkflowConfig): string[] {
  const requiredSections =
    config.deliverable.sections && config.deliverable.sections.length > 0
      ? config.deliverable.sections.join(", ")
      : "problem, requirements, recommendation, architecture, file_plan, acceptance_criteria, risks, open_questions";

  return [
    "The spec must be implementation-ready and self-contained for the next execution step.",
    `Required sections: ${requiredSections}.`,
    "Make migration, rollout, compatibility, validation, and ownership boundaries explicit whenever existing behavior or contracts are being replaced.",
    "Do not leave repo-specific UI boundaries, operational behavior, cache semantics, or validation ownership implicit when they materially affect implementation."
  ];
}

function buildBlockerClosureLines(): string[] {
  return [
    "When blocker feedback exists, treat it as a closure checklist rather than general inspiration.",
    "For every carried blocker, either resolve it with an explicit repo-fit decision or move it into risks/open_questions with a concrete defer rationale.",
    "When a blocker names specific routes, hooks, components, tests, or live entry points, add those exact surfaces to the file plan and define the replacement owner, adapter, or guard instead of saying 'update remaining consumers'.",
    "When a blocker concerns UX or validation, specify the exact action matrix, mobile/collapse behavior, static checks, scanned paths, allowed exceptions, failure modes, and test or command ownership needed to make the plan executable."
  ];
}

function buildClarifyPrompt(config: SpecDesignWorkflowConfig): string {
  return [
    "Clarify the problem and rewrite it into a concrete design brief.",
    "",
    `Problem: ${config.problem}`,
    `Goal: ${config.goal}`,
    ...(config.audience ? [`Audience: ${config.audience}`] : []),
    "",
    ...formatList("Constraints", config.constraints),
    "",
    ...formatList("Decision drivers", config.decision_drivers),
    "",
    ...formatScope(config.scope),
    "",
    "Write `design-brief.md` to the output directory.",
    "The brief must capture the problem, desired end state, scope boundaries, decision criteria, and what a good design spec must deliver."
  ].join("\n");
}

function buildInspectRepoPrompt(config: SpecDesignWorkflowConfig): string {
  return [
    "Inspect the repository first and extract the current system constraints for this design problem.",
    "",
    `Problem: ${config.problem}`,
    `Goal: ${config.goal}`,
    "",
    ...formatScope(config.scope),
    "",
    "Focus on repository conventions, relevant modules, architecture constraints, existing patterns, tests, docs, and operational assumptions.",
    "Write `current-state.md` to the output directory."
  ].join("\n");
}

function buildGapAssessmentPrompt(config: SpecDesignWorkflowConfig): string {
  return [
    "Assess whether repository context is sufficient for a strong design.",
    "",
    ...formatResearchPolicy(config.research_policy),
    "",
    "Use the design brief and current-state notes in context.",
    "Write `information-gap.json` to the output directory using this exact schema:",
    '{"repo_sufficient":true,"rationale":"...","gaps":["..."],"external_research_topics":["..."]}',
    "",
    "Only recommend external research when the missing information materially affects design quality."
  ].join("\n");
}

function buildExternalResearchPrompt(config: SpecDesignWorkflowConfig, taskIndex: number): string {
  return [
    `You are targeted external research task ${taskIndex + 1} of ${config.research_policy.max_external_research_tasks}.`,
    "",
    `Problem: ${config.problem}`,
    `Goal: ${config.goal}`,
    "",
    ...formatResearchPolicy(config.research_policy),
    "",
    "Read `information-gap.json` in context and take the topic at your slot index from `external_research_topics`.",
    "If there is no topic for your slot or repository context is sufficient, write a short note saying external research was not required.",
    "If a topic exists, do focused external research only for that gap and preserve repository conventions as the primary implementation guide.",
    "",
    "Write `external-findings.md` to the output directory."
  ].join("\n");
}

function buildConstraintSynthesisPrompt(config: SpecDesignWorkflowConfig): string {
  return [
    "Synthesize the final design constraints from the repository findings and any targeted external research.",
    "",
    `Problem: ${config.problem}`,
    `Goal: ${config.goal}`,
    "",
    ...formatList("Constraints", config.constraints),
    "",
    ...formatList("Decision drivers", config.decision_drivers),
    "",
    "Repository conventions must dominate implementation choices. External research should fill gaps, not override local patterns.",
    "Write `constraints-brief.md` to the output directory."
  ].join("\n");
}

function buildOptionPrompt(config: SpecDesignWorkflowConfig, optionIndex: number): string {
  return [
    `Generate design option ${optionIndex + 1} of ${config.orchestration.option_count}.`,
    "",
    `Problem: ${config.problem}`,
    `Goal: ${config.goal}`,
    "",
    ...formatList("Decision drivers", config.decision_drivers),
    "",
    "Use the design brief, current-state notes, information-gap assessment, and constraints brief in context.",
    "Your option must be materially distinct from the other likely options, not a paraphrase.",
    `Write \`option-${String(optionIndex + 1).padStart(2, "0")}.md\` to the output directory.`
  ].join("\n");
}

function buildTradeoffPrompt(config: SpecDesignWorkflowConfig): string {
  return [
    "Compare the proposed design options and recommend one direction.",
    "",
    ...formatList("Decision drivers", config.decision_drivers),
    "",
    ...formatList("Constraints", config.constraints),
    "",
    "Write `tradeoff-matrix.md` to the output directory.",
    "The output must explain why the recommended option best fits the repository, the constraints, and the implementation reality."
  ].join("\n");
}

function buildInitialDraftPrompt(config: SpecDesignWorkflowConfig): string {
  return [
    "Write the initial design spec draft.",
    "",
    `Problem: ${config.problem}`,
    `Goal: ${config.goal}`,
    ...(config.audience ? [`Audience: ${config.audience}`] : []),
    "",
    "Use the design brief, repository inspection, synthesized constraints, and tradeoff recommendation in context.",
    "",
    "Deliverable contract:",
    ...formatDeliverable(config.deliverable),
    "",
    ...buildImplementationReadinessLines(config),
    "",
    "Write `spec-draft.md` to the output directory."
  ].join("\n");
}

function buildRevisionPrompt(config: SpecDesignWorkflowConfig): string {
  return [
    "Produce the strongest current implementation-ready design spec draft from the core design materials.",
    "",
    `Problem: ${config.problem}`,
    `Goal: ${config.goal}`,
    "",
    "Use the initial draft, the repository findings, the synthesized constraints, and the tradeoff recommendation.",
    "If prior iteration feedback is present in context, treat the merged critique and the failed quality-check result as mandatory revision input.",
    ...buildBlockerClosureLines(),
    ...buildImplementationReadinessLines(config),
    "Write a concrete revised spec that resolves ambiguity instead of deferring key policy, migration, boundary, or validation decisions.",
    "Write `spec-revision.md` to the output directory."
  ].join("\n");
}

function buildCritiquePrompt(role: string, config: SpecDesignWorkflowConfig): string {
  return [
    `Critique the current design spec from the ${role} perspective.`,
    "",
    `Problem: ${config.problem}`,
    `Goal: ${config.goal}`,
    "",
    ...formatList("Decision drivers", config.decision_drivers),
    "",
    "Focus on concrete weaknesses, missing details, and reasons the design may fail in this repository.",
    "Only raise blockers that remain unresolved in the current draft.",
    "Each blocker must name the missing decision, the affected repo surface, and the exact revision, file-plan addition, or validation contract needed to close it.",
    "Prefer exact file paths, hooks, route names, and test commands over generic concerns.",
    `Write \`critique-${role}.md\` to the output directory.`
  ].join("\n");
}

function buildMergeCritiquesPrompt(config: SpecDesignWorkflowConfig): string {
  return [
    "Merge the critique outputs into one revision brief.",
    "",
    `Problem: ${config.problem}`,
    `Goal: ${config.goal}`,
    "",
    "De-duplicate overlap, preserve high-signal criticism, and clearly separate blockers from improvements.",
    "For each blocker, include the missing decision, why it blocks execution, the exact repo surfaces, the spec change required, the file-plan entries required, and the validation that must catch regressions.",
    "Write `critique-merged.md` to the output directory."
  ].join("\n");
}

function buildQualityReviewPrompt(config: SpecDesignWorkflowConfig): string {
  return [
    "Review whether the current design spec is implementation-ready.",
    "",
    `Problem: ${config.problem}`,
    `Goal: ${config.goal}`,
    "",
    "Use the revised spec, merged critiques, tradeoff recommendation, and current-state notes in context.",
    "Judge it as the direct input contract for execute_spec: an implementer should not need to invent missing migration, operational, validation, repo-fit ownership, or boundary decisions.",
    "Treat this as an evaluator, not a gate. Always write `quality-review.json` to the output directory using this exact schema:",
    '{"passed":true,"summary":"...","blockers":[{"title":"...","missing_decision":"...","repo_surface":"...","spec_change":"...","file_plan_detail":"...","validation_detail":"..."}],"improvements":["..."]}',
    "Set `passed` to false only when unresolved blockers still require implementers to infer repo surfaces, file ownership, actionability rules, rollout semantics, or validation mechanics.",
    "For each blocker, identify the missing decision, the affected repo surface, and the absent file-plan or validation detail."
  ].join("\n");
}

function buildQualityReviewExpectations(config: SpecDesignWorkflowConfig): string {
  const sectionRequirement =
    config.deliverable.sections && config.deliverable.sections.length > 0
      ? `A ready spec covers: ${config.deliverable.sections.join(", ")}.`
      : "A ready spec covers the problem, requirements, recommendation, implementation plan, risks, and open questions.";

  return [
    sectionRequirement,
    "Mark blockers when carried blockers are not closed by explicit repo-fit ownership, concrete file coverage, and named validation or test ownership.",
    "Mark blockers when the spec misses implementation consequences, ignores repository conventions, lacks acceptance criteria, leaves migration or compatibility unresolved, omits concrete file or ownership boundaries, or lacks explicit risks and open questions when those affect execution."
  ].join(" ");
}

function buildHumanReviewPrompt(config: SpecDesignWorkflowConfig): string {
  return [
    "Review the current design spec and the machine quality review.",
    "",
    `Problem: ${config.problem}`,
    `Goal: ${config.goal}`,
    "",
    "Pass only when the spec is ready to drive execute_spec without inventing missing implementation details.",
    "Deny when another revision round is required. When denying, explain the concrete improvements needed."
  ].join("\n");
}

function buildFinalizePrompt(config: SpecDesignWorkflowConfig): string {
  return [
    "Publish the final implementation-ready design spec and supporting artifacts.",
    "",
    `Problem: ${config.problem}`,
    `Goal: ${config.goal}`,
    ...(config.audience ? [`Audience: ${config.audience}`] : []),
    "",
    "Use the latest passed revised spec, the merged critiques, the design brief, the current-state notes, and the tradeoff recommendation in context.",
    "",
    "Write these artifacts to the output directory:",
    "- `design-spec.md`",
    "- `file-plan.md`",
    "- `acceptance-criteria.md`",
    "- `risks.md`",
    "- `open-questions.md`"
  ].join("\n");
}

function buildOptionOutputs(optionIndex: number): OutputDefinition[] {
  const suffix = String(optionIndex + 1).padStart(2, "0");

  return [
    {
      name: `option_${suffix}`,
      from: "attempt",
      path: `option-${suffix}.md`,
      required: true
    }
  ];
}

function buildCritiqueOutputs(role: string): OutputDefinition[] {
  return [
    {
      name: `critique_${role}`,
      from: "attempt",
      path: `critique-${role}.md`,
      required: true
    }
  ];
}

export function buildSpecDesignWorkflow(config: SpecDesignWorkflowConfig): SequenceNode {
  const shared = sharedNodeBase(config);
  const workflowId = managedId(config.id, "workflow");

  const clarifyId = managedId(config.id, "clarify");
  const inspectId = managedId(config.id, "inspect_repo");
  const gapId = managedId(config.id, "assess_information_gap");
  const externalFanoutId = managedId(config.id, "external_research");
  const synthesizeId = managedId(config.id, "synthesize_constraints");
  const optionFanoutId = managedId(config.id, "generate_options");
  const compareId = managedId(config.id, "compare_tradeoffs");
  const initialDraftId = managedId(config.id, "draft_initial_spec");
  const revisionLoopId = managedId(config.id, "revision_loop");
  const revisionBodyId = managedId(config.id, "revision_body");
  const reviseId = managedId(config.id, "revise_spec");
  const critiquePanelId = managedId(config.id, "critique_panel");
  const mergeId = managedId(config.id, "merge_critiques");
  const qualityReviewId = managedId(config.id, "quality_review");
  const humanReviewId = managedId(config.id, "human_review");

  const steps: SequenceNode["steps"] = [
    {
      type: "agent",
      id: clarifyId,
      label: "Clarify Design Problem",
      ...shared,
      ...(config.context_from ? { context_from: config.context_from } : {}),
      outputs: [
        {
          name: "design_brief",
          from: "attempt",
          path: "design-brief.md",
          required: true
        }
      ],
      prompt: buildClarifyPrompt(config)
    },
    {
      type: "agent",
      id: inspectId,
      label: "Inspect Repository",
      ...shared,
      ...(config.inputs ? { inputs: config.inputs } : {}),
      context_from: [
        {
          node: clarifyId,
          include: "output",
          output: "design_brief"
        }
      ],
      outputs: [
        {
          name: "current_state",
          from: "attempt",
          path: "current-state.md",
          required: true
        }
      ],
      prompt: buildInspectRepoPrompt(config)
    },
    {
      type: "agent",
      id: gapId,
      label: "Assess Information Gap",
      ...shared,
      context_from: [
        {
          node: clarifyId,
          include: "output",
          output: "design_brief"
        },
        {
          node: inspectId,
          include: "output",
          output: "current_state"
        }
      ],
      outputs: [
        {
          name: "information_gap",
          from: "attempt",
          path: "information-gap.json",
          required: true
        }
      ],
      prompt: buildGapAssessmentPrompt(config)
    }
  ];

  if (config.research_policy.allow_web_fallback && config.research_policy.max_external_research_tasks > 0) {
    const externalTasks: AgentNode[] = Array.from(
      { length: config.research_policy.max_external_research_tasks },
      (_, index) => ({
        type: "agent",
        id: managedId(config.id, `external_research_${String(index + 1).padStart(2, "0")}`),
        label: `External Research ${String(index + 1).padStart(2, "0")}`,
        ...shared,
        context_from: [
          {
            node: clarifyId,
            include: "output",
            output: "design_brief"
          },
          {
            node: inspectId,
            include: "output",
            output: "current_state"
          },
          {
            node: gapId,
            include: "output",
            output: "information_gap"
          }
        ],
        outputs: [
          {
            name: `external_findings_${String(index + 1).padStart(2, "0")}`,
            from: "attempt",
            path: "external-findings.md",
            required: false
          }
        ],
        prompt: buildExternalResearchPrompt(config, index)
      })
    );

    steps.push({
      type: "parallel",
      id: externalFanoutId,
      label: "Targeted External Research",
      max_concurrency: config.research_policy.max_external_research_tasks,
      steps: externalTasks
    });
  }

  const synthesizeContext: ContextReference[] = [
    {
      node: clarifyId,
      include: "output",
      output: "design_brief"
    },
    {
      node: inspectId,
      include: "output",
      output: "current_state"
    },
    {
      node: gapId,
      include: "output",
      output: "information_gap"
    }
  ];

  if (config.research_policy.allow_web_fallback && config.research_policy.max_external_research_tasks > 0) {
    for (let index = 0; index < config.research_policy.max_external_research_tasks; index += 1) {
      const suffix = String(index + 1).padStart(2, "0");
      synthesizeContext.push({
        node: managedId(config.id, `external_research_${suffix}`),
        include: "output",
        output: `external_findings_${suffix}`,
        optional: true
      });
    }
  }

  steps.push({
    type: "agent",
    id: synthesizeId,
    label: "Synthesize Constraints",
    ...shared,
    context_from: synthesizeContext,
    outputs: [
      {
        name: "constraints_brief",
        from: "attempt",
        path: "constraints-brief.md",
        required: true
      }
    ],
    prompt: buildConstraintSynthesisPrompt(config)
  });

  const optionNodes: AgentNode[] = Array.from({ length: config.orchestration.option_count }, (_, index) => ({
    type: "agent",
    id: managedId(config.id, `option_${String(index + 1).padStart(2, "0")}`),
    label: `Design Option ${String(index + 1).padStart(2, "0")}`,
    ...shared,
    context_from: [
      {
        node: clarifyId,
        include: "output",
        output: "design_brief"
      },
      {
        node: inspectId,
        include: "output",
        output: "current_state"
      },
      {
        node: gapId,
        include: "output",
        output: "information_gap"
      },
      {
        node: synthesizeId,
        include: "output",
        output: "constraints_brief"
      }
    ],
    outputs: buildOptionOutputs(index),
    prompt: buildOptionPrompt(config, index)
  }));

  steps.push(
    {
      type: "parallel",
      id: optionFanoutId,
      label: "Generate Options",
      max_concurrency: config.orchestration.max_parallel_options,
      steps: optionNodes
    },
    {
      type: "agent",
      id: compareId,
      label: "Compare Tradeoffs",
      ...shared,
      context_from: [
        {
          node: clarifyId,
          include: "output",
          output: "design_brief"
        },
        {
          node: synthesizeId,
          include: "output",
          output: "constraints_brief"
        },
        ...optionNodes.map(
          (_, index): ContextReference => ({
            node: managedId(config.id, `option_${String(index + 1).padStart(2, "0")}`),
            include: "output",
            output: `option_${String(index + 1).padStart(2, "0")}`
          })
        )
      ],
      outputs: [
        {
          name: "tradeoff_matrix",
          from: "attempt",
          path: "tradeoff-matrix.md",
          required: true
        }
      ],
      prompt: buildTradeoffPrompt(config)
    },
    {
      type: "agent",
      id: initialDraftId,
      label: "Draft Initial Spec",
      ...shared,
      context_from: [
        {
          node: clarifyId,
          include: "output",
          output: "design_brief"
        },
        {
          node: inspectId,
          include: "output",
          output: "current_state"
        },
        {
          node: synthesizeId,
          include: "output",
          output: "constraints_brief"
        },
        {
          node: compareId,
          include: "output",
          output: "tradeoff_matrix"
        }
      ],
      outputs: [
        {
          name: "initial_spec_draft",
          from: "attempt",
          path: "spec-draft.md",
          required: true
        }
      ],
      prompt: buildInitialDraftPrompt(config)
    }
  );

  const critiqueRoles = config.orchestration.critique_roles;
  const critiqueNodes: AgentNode[] = critiqueRoles.map((role) => ({
    type: "agent",
    id: managedId(config.id, `critique_${role}`),
    label: `Critique ${role}`,
    ...shared,
    context_from: [
      {
        node: reviseId,
        include: "output",
        output: "spec_revision"
      },
      {
        node: inspectId,
        include: "output",
        output: "current_state"
      },
      {
        node: synthesizeId,
        include: "output",
        output: "constraints_brief"
      },
      {
        node: compareId,
        include: "output",
        output: "tradeoff_matrix"
      }
    ],
    outputs: buildCritiqueOutputs(role),
    prompt: buildCritiquePrompt(role, config)
  }));

  const revisionBody: SequenceNode = {
    type: "sequence",
    id: revisionBodyId,
    label: "Spec Revision Body",
    steps: [
      {
        type: "agent",
        id: reviseId,
        label: "Revise Spec",
        ...shared,
        context_from: [
          {
            node: initialDraftId,
            include: "output",
            output: "initial_spec_draft"
          },
          {
            node: inspectId,
            include: "output",
            output: "current_state"
          },
          {
            node: synthesizeId,
            include: "output",
            output: "constraints_brief"
          },
          {
            node: compareId,
            include: "output",
            output: "tradeoff_matrix"
          },
          {
            node: mergeId,
            include: "output",
            output: "critique_merged",
            iteration: "latest_failed",
            optional: true
          },
          {
            node: qualityReviewId,
            include: "output",
            output: "quality_review",
            iteration: "latest_failed",
            optional: true
          },
          {
            node: humanReviewId,
            include: "output",
            output: "operator_feedback",
            iteration: "latest_failed",
            optional: true
          }
        ],
        outputs: [
          {
            name: "spec_revision",
            from: "attempt",
            path: "spec-revision.md",
            required: true
          }
        ],
        prompt: buildRevisionPrompt(config)
      },
      {
        type: "parallel",
        id: critiquePanelId,
        label: "Critique Panel",
        max_concurrency: critiqueRoles.length,
        steps: critiqueNodes
      },
      {
        type: "agent",
        id: mergeId,
        label: "Merge Critiques",
        ...shared,
        context_from: critiqueRoles.map(
          (role): ContextReference => ({
            node: managedId(config.id, `critique_${role}`),
            include: "output",
            output: `critique_${role}`
          })
        ),
        outputs: [
          {
            name: "critique_merged",
            from: "attempt",
            path: "critique-merged.md",
            required: true
          }
        ],
        prompt: buildMergeCritiquesPrompt(config)
      },
      {
        type: "agent",
        id: qualityReviewId,
        label: "Quality Review",
        ...shared,
        context_from: [
          {
            node: reviseId,
            include: "output",
            output: "spec_revision"
          },
          {
            node: mergeId,
            include: "output",
            output: "critique_merged"
          },
          {
            node: inspectId,
            include: "output",
            output: "current_state"
          },
          {
            node: synthesizeId,
            include: "output",
            output: "constraints_brief"
          },
          {
            node: compareId,
            include: "output",
            output: "tradeoff_matrix"
          }
        ],
        outputs: [
          {
            name: "quality_review",
            from: "attempt",
            path: "quality-review.json",
            required: true
          }
        ],
        prompt: [buildQualityReviewPrompt(config), "", buildQualityReviewExpectations(config)].join("\n")
      },
      {
        type: "checkpoint",
        id: humanReviewId,
        label: "Human Review",
        ...shared,
        context_from: [
          {
            node: qualityReviewId,
            include: "output",
            output: "quality_review"
          },
          {
            node: mergeId,
            include: "output",
            output: "critique_merged"
          }
        ],
        review_from: {
          node: reviseId,
          include: "output",
          output: "spec_revision"
        },
        prompt: buildHumanReviewPrompt(config)
      }
    ]
  };

  const revisionLoop: RepeatNode = {
    type: "repeat",
    id: revisionLoopId,
    label: "Revision Loop",
    max_attempts: config.orchestration.revision_rounds,
    body: revisionBody,
    until: {
      node: humanReviewId
    }
  };

  const finalOutputs: OutputDefinition[] =
    config.outputs && config.outputs.length > 0
      ? config.outputs
      : [
          {
            name: "design_spec",
            from: "attempt",
            path: "design-spec.md",
            required: true
          }
        ];

  steps.push(
    revisionLoop,
    {
      type: "agent",
      id: config.id,
      ...(config.label ? { label: config.label } : { label: "Finalize Spec" }),
      ...shared,
      context_from: [
        {
          node: clarifyId,
          include: "output",
          output: "design_brief"
        },
        {
          node: inspectId,
          include: "output",
          output: "current_state"
        },
        {
          node: compareId,
          include: "output",
          output: "tradeoff_matrix"
        },
        {
          node: reviseId,
          include: "output",
          output: "spec_revision",
          iteration: "latest_passed"
        },
        {
          node: mergeId,
          include: "output",
          output: "critique_merged",
          iteration: "latest_passed"
        }
      ],
      outputs: appendOutput(
        appendOutput(
          appendOutput(
            appendOutput(
              appendOutput(finalOutputs, {
                name: "file_plan",
                from: "attempt",
                path: "file-plan.md",
                required: false
              }),
              {
                name: "acceptance_criteria",
                from: "attempt",
                path: "acceptance-criteria.md",
                required: false
              }
            ),
            {
              name: "risks",
              from: "attempt",
              path: "risks.md",
              required: false
            }
          ),
          {
            name: "open_questions",
            from: "attempt",
            path: "open-questions.md",
            required: false
          }
        ),
        {
          name: "design_spec",
          from: "attempt",
          path: "design-spec.md",
          required: true
        }
      ),
      prompt: buildFinalizePrompt(config)
    }
  );

  return {
    type: "sequence",
    id: workflowId,
    label: config.label ? `${config.label} Workflow` : "Spec Design Workflow",
    steps
  };
}

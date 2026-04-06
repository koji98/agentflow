import type {
  AgentNode,
  BaseExecutableNode,
  CheckNode,
  ContextReference,
  OutputDefinition,
  ParallelNode,
  SequenceNode
} from "../graph/authored.js";

export interface DeepResearchSourcePolicy {
  web?: boolean;
  files?: boolean;
  apps?: boolean;
  allow_domains?: string[];
  deny_domains?: string[];
}

export interface DeepResearchDeliverable {
  format?: string;
  citations?: string;
  sections?: string[];
}

export interface DeepResearchOrchestration {
  track_count: number;
  max_parallel_tracks: number;
  summary_fan_in: number;
  final_critique: boolean;
}

export interface DeepResearchWorkflowConfig extends BaseExecutableNode {
  question: string;
  objective: string;
  audience?: string;
  sources: DeepResearchSourcePolicy;
  deliverable: DeepResearchDeliverable;
  orchestration: DeepResearchOrchestration;
}

function zeroPad(value: number): string {
  return String(value).padStart(2, "0");
}

function managedId(rootId: string, suffix: string): string {
  return `${rootId}__managed__deep_research__${suffix}`;
}

function sharedNodeBase(config: DeepResearchWorkflowConfig): Pick<
  AgentNode,
  "repo" | "profile" | "timeout_sec"
> {
  return {
    ...(config.repo ? { repo: config.repo } : {}),
    ...(config.profile ? { profile: config.profile } : {}),
    ...(config.timeout_sec !== undefined ? { timeout_sec: config.timeout_sec } : {})
  };
}

function formatSourcePolicy(sources: DeepResearchSourcePolicy): string[] {
  const lines = [
    `- Web research: ${sources.web === false ? "disabled" : "enabled"}`,
    `- Local file research: ${sources.files === false ? "disabled" : "enabled"}`,
    `- App or connector research: ${sources.apps ? "enabled" : "disabled"}`
  ];

  if (sources.allow_domains && sources.allow_domains.length > 0) {
    lines.push(`- Prefer or limit to domains: ${sources.allow_domains.join(", ")}`);
  }

  if (sources.deny_domains && sources.deny_domains.length > 0) {
    lines.push(`- Avoid domains: ${sources.deny_domains.join(", ")}`);
  }

  return lines;
}

function formatDeliverable(deliverable: DeepResearchDeliverable): string[] {
  const lines = [
    `- Format: ${deliverable.format ?? "report"}`,
    `- Citations: ${deliverable.citations ?? "inline"}`
  ];

  if (deliverable.sections && deliverable.sections.length > 0) {
    lines.push(`- Required sections: ${deliverable.sections.join(", ")}`);
  }

  return lines;
}

function buildClarifyPrompt(config: DeepResearchWorkflowConfig): string {
  return [
    "Clarify and rewrite the research ask into a concrete brief.",
    "",
    `Question: ${config.question}`,
    `Objective: ${config.objective}`,
    ...(config.audience ? [`Audience: ${config.audience}`] : []),
    "",
    "Research constraints:",
    ...formatSourcePolicy(config.sources),
    "",
    "Deliverable contract:",
    ...formatDeliverable(config.deliverable),
    "",
    "Write `clarified-brief.md` to the output directory.",
    "The brief must restate the goal, assumptions, scope boundaries, evaluation criteria, and the evidence bar for a strong final report."
  ].join("\n");
}

function buildPlanPrompt(config: DeepResearchWorkflowConfig): string {
  return [
    "Create the research plan for this deep research run.",
    "",
    `Question: ${config.question}`,
    `Objective: ${config.objective}`,
    "",
    `Target track count: ${config.orchestration.track_count}`,
    `Summary tree fan-in: ${config.orchestration.summary_fan_in}`,
    "",
    "Use the clarified brief in context to identify the key dimensions, tensions, and subquestions that the parallel tracks must cover.",
    "Write `research-plan.md` to the output directory."
  ].join("\n");
}

function buildTrackPrompt(config: DeepResearchWorkflowConfig): string {
  return [
    "Generate the parallel research track briefs.",
    "",
    `Track count: ${config.orchestration.track_count}`,
    "",
    "Use the clarified brief and research plan in context.",
    "Write `track-briefs.json` to the output directory using this exact schema:",
    '[{"track_id":"track-01","title":"...","focus":"...","angle":"...","questions":["..."],"suggested_sources":["..."],"success_criteria":["..."]}]',
    "",
    "The tracks must be meaningfully different, collectively cover the full problem, and minimize redundant investigation."
  ].join("\n");
}

function buildWorkerPrompt(config: DeepResearchWorkflowConfig, trackIndex: number): string {
  const trackNumber = zeroPad(trackIndex + 1);

  return [
    `You are deep research worker ${trackNumber} of ${zeroPad(config.orchestration.track_count)}.`,
    "",
    `Question: ${config.question}`,
    `Objective: ${config.objective}`,
    "",
    "Read the `track-briefs.json` artifact in context and use the brief whose `track_id` matches your worker number.",
    "Investigate that track thoroughly and maximize unique coverage rather than repeating other tracks.",
    "",
    "Write these artifacts to the output directory:",
    "- `track-report.md`: full findings, evidence, and nuanced observations",
    "- `track-summary.md`: a bounded summary for reducers",
    "- `sources.json`: machine-readable source ledger",
    "",
    "Preserve uncertainty, disagreements, and source quality notes."
  ].join("\n");
}

function buildContradictionPrompt(): string {
  return [
    "Review the track summaries and identify contradictions, unresolved questions, overlap, and missing angles.",
    "",
    "Write `contradictions.md` to the output directory.",
    "Do not collapse disagreements away. Call them out explicitly so the final synthesis can address them."
  ].join("\n");
}

function buildReducerPrompt(roundIndex: number, groupIndex: number): string {
  return [
    `Reduce the provided summaries into reducer summary round ${roundIndex + 1}, group ${groupIndex + 1}.`,
    "",
    "Write `reduce-summary.md` to the output directory.",
    "Keep the important findings, preserve conflicts, retain source-quality caveats, and reduce length enough for the next summarization layer."
  ].join("\n");
}

function buildFinalSynthesisPrompt(config: DeepResearchWorkflowConfig): string {
  return [
    "Produce the final deep research report.",
    "",
    `Question: ${config.question}`,
    `Objective: ${config.objective}`,
    ...(config.audience ? [`Audience: ${config.audience}`] : []),
    "",
    "Use the reduced summaries, track briefs, and contradiction scan in context.",
    "Before writing, derive a coverage checklist from the upstream research so you can preserve the strongest findings from every major problem cluster rather than over-focusing on one dominant narrative.",
    "The report should preserve the strongest findings, acknowledge uncertainty, and reference the track structure when useful.",
    "Every high-signal issue from the upstream research must end up in one of these places: the explicit issue inventory, the recommended fix order, or the preserved open questions and uncertainties.",
    "Do not drop concrete user-facing access findings, guest or denied-state behavior, or cache or invalidation risks just because contract or admin architecture issues appear more central.",
    "Preserve contradictions and unresolved questions as first-class report content, not as optional side notes.",
    "",
    "Deliverable contract:",
    ...formatDeliverable(config.deliverable),
    "",
    "Write `final-report.md` to the output directory unless the node declares a different report artifact."
  ].join("\n");
}

function buildFinalCritiquePrompt(config: DeepResearchWorkflowConfig): string {
  return [
    "Review the final deep research report.",
    "",
    `Question: ${config.question}`,
    `Objective: ${config.objective}`,
    "",
    "Use the final report and the upstream track briefs, contradiction scan, and reduced summaries in context.",
    "Decide whether the report is complete, balanced, and sufficiently grounded in the gathered research rather than merely internally coherent."
  ].join("\n");
}

function buildFinalCritiqueRubric(config: DeepResearchWorkflowConfig): string {
  const sectionRequirement =
    config.deliverable.sections && config.deliverable.sections.length > 0
      ? `Pass only if the report covers: ${config.deliverable.sections.join(", ")}.`
      : "Pass only if the report covers the main problem, analysis, and recommendation clearly.";

  return [
    sectionRequirement,
    "Fail if major contradictions are ignored, if the strongest uncertainties are omitted, if high-signal issue clusters from the upstream research are dropped, or if the report reads like a shallow summary of a single track or one dominant narrative."
  ].join(" ");
}

function appendOutput(
  outputs: OutputDefinition[],
  output: OutputDefinition
): OutputDefinition[] {
  return outputs.some((item) => item.name === output.name) ? outputs : [...outputs, output];
}

function buildWorkerOutputs(trackIndex: number): OutputDefinition[] {
  const index = zeroPad(trackIndex + 1);

  return [
    {
      name: `track_report_${index}`,
      from: "attempt",
      path: "track-report.md",
      required: false
    },
    {
      name: `track_summary_${index}`,
      from: "attempt",
      path: "track-summary.md",
      required: true
    },
    {
      name: `track_sources_${index}`,
      from: "attempt",
      path: "sources.json",
      required: false
    }
  ];
}

function chunkReferences<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

type ReducibleReference = {
  node: string;
  output: string;
};

export function buildDeepResearchWorkflow(config: DeepResearchWorkflowConfig): SequenceNode {
  const shared = sharedNodeBase(config);
  const workflowId = managedId(config.id, "workflow");

  const clarifyId = managedId(config.id, "clarify");
  const planId = managedId(config.id, "plan");
  const trackGeneratorId = managedId(config.id, "generate_tracks");
  const trackParallelId = managedId(config.id, "track_fanout");
  const contradictionId = managedId(config.id, "contradiction_scan");

  const clarifyNode: AgentNode = {
    type: "agent",
    id: clarifyId,
    label: "Clarify Research Goal",
    ...shared,
    ...(config.inputs ? { inputs: config.inputs } : {}),
    ...(config.context_from ? { context_from: config.context_from } : {}),
    outputs: [
      {
        name: "clarified_brief",
        from: "attempt",
        path: "clarified-brief.md",
        required: true
      }
    ],
    prompt: buildClarifyPrompt(config)
  };

  const planNode: AgentNode = {
    type: "agent",
    id: planId,
    label: "Plan Research",
    ...shared,
    context_from: [
      {
        node: clarifyId,
        include: "output",
        output: "clarified_brief"
      }
    ],
    outputs: [
      {
        name: "research_plan",
        from: "attempt",
        path: "research-plan.md",
        required: true
      }
    ],
    prompt: buildPlanPrompt(config)
  };

  const trackGeneratorNode: AgentNode = {
    type: "agent",
    id: trackGeneratorId,
    label: "Generate Research Tracks",
    ...shared,
    context_from: [
      {
        node: clarifyId,
        include: "output",
        output: "clarified_brief"
      },
      {
        node: planId,
        include: "output",
        output: "research_plan"
      }
    ],
    outputs: [
      {
        name: "track_briefs",
        from: "attempt",
        path: "track-briefs.json",
        required: true
      }
    ],
    prompt: buildTrackPrompt(config)
  };

  const trackWorkers: AgentNode[] = Array.from({ length: config.orchestration.track_count }, (_, trackIndex) => ({
    type: "agent",
    id: managedId(config.id, `track_${zeroPad(trackIndex + 1)}`),
    label: `Research Track ${zeroPad(trackIndex + 1)}`,
    ...shared,
    context_from: [
      {
        node: trackGeneratorId,
        include: "output",
        output: "track_briefs"
      },
      {
        node: planId,
        include: "output",
        output: "research_plan"
      },
      {
        node: clarifyId,
        include: "output",
        output: "clarified_brief"
      }
    ],
    outputs: buildWorkerOutputs(trackIndex),
    prompt: buildWorkerPrompt(config, trackIndex)
  }));

  const trackParallelNode: ParallelNode = {
    type: "parallel",
    id: trackParallelId,
    label: "Parallel Research Tracks",
    max_concurrency: config.orchestration.max_parallel_tracks,
    steps: trackWorkers
  };

  const trackSummaryReferences: ReducibleReference[] = trackWorkers.map((worker, trackIndex) => ({
    node: worker.id,
    output: `track_summary_${zeroPad(trackIndex + 1)}`
  }));

  const contradictionNode: AgentNode = {
    type: "agent",
    id: contradictionId,
    label: "Scan Contradictions",
    ...shared,
    context_from: trackSummaryReferences.map(
      (reference): ContextReference => ({
        node: reference.node,
        include: "output",
        output: reference.output
      })
    ),
    outputs: [
      {
        name: "contradictions",
        from: "attempt",
        path: "contradictions.md",
        required: false
      }
    ],
    prompt: buildContradictionPrompt()
  };

  const reductionSteps: Array<ParallelNode | AgentNode> = [];
  let reductionSources = [...trackSummaryReferences];
  let roundIndex = 0;

  while (reductionSources.length > 1) {
    const groups = chunkReferences(reductionSources, config.orchestration.summary_fan_in);
    const reducerNodes: AgentNode[] = groups.map((group, groupIndex) => {
      const reduceId = managedId(config.id, `reduce_r${roundIndex + 1}_g${groupIndex + 1}`);
      const reduceOutputName = `reduce_summary_r${roundIndex + 1}_g${groupIndex + 1}`;

      return {
        type: "agent",
        id: reduceId,
        label: `Reduce Round ${roundIndex + 1} Group ${groupIndex + 1}`,
        ...shared,
        context_from: group.map(
          (reference): ContextReference => ({
            node: reference.node,
            include: "output",
            output: reference.output
          })
        ),
        outputs: [
          {
            name: reduceOutputName,
            from: "attempt",
            path: "reduce-summary.md",
            required: true
          }
        ],
        prompt: buildReducerPrompt(roundIndex, groupIndex)
      };
    });

    reductionSteps.push({
      type: "parallel",
      id: managedId(config.id, `reduce_round_${roundIndex + 1}`),
      label: `Summary Reduction Round ${roundIndex + 1}`,
      max_concurrency: Math.min(groups.length, config.orchestration.max_parallel_tracks),
      steps: reducerNodes
    });

    reductionSources = reducerNodes.map((node, groupIndex) => ({
      node: node.id,
      output: `reduce_summary_r${roundIndex + 1}_g${groupIndex + 1}`
    }));
    roundIndex += 1;
  }

  const finalOutputs: OutputDefinition[] =
    config.outputs && config.outputs.length > 0
      ? config.outputs
      : [
          {
            name: "research_report",
            from: "attempt",
            path: "final-report.md",
            required: false
          }
        ];

  const finalSynthesisNode: AgentNode = {
    type: "agent",
    id: config.id,
    ...(config.label ? { label: config.label } : { label: "Final Deep Research Report" }),
    ...shared,
    context_from: [
      {
        node: trackGeneratorId,
        include: "output",
        output: "track_briefs"
      },
      {
        node: planId,
        include: "output",
        output: "research_plan"
      },
      {
        node: contradictionId,
        include: "output",
        output: "contradictions",
        optional: true
      },
      ...reductionSources.map(
        (reference): ContextReference => ({
          node: reference.node,
          include: "output",
          output: reference.output
        })
      )
    ],
    outputs: appendOutput(finalOutputs, {
      name: "research_report",
      from: "attempt",
      path: "final-report.md",
      required: false
    }),
    prompt: buildFinalSynthesisPrompt(config)
  };

  const steps: SequenceNode["steps"] = [
    clarifyNode,
    planNode,
    trackGeneratorNode,
    trackParallelNode,
    contradictionNode,
    ...reductionSteps,
    finalSynthesisNode
  ];

  if (config.orchestration.final_critique) {
    const critiqueNode: CheckNode = {
      type: "check",
      id: managedId(config.id, "final_critique"),
      label: "Critique Final Report",
      ...shared,
      check_kind: "ai",
      context_from: [
        {
          node: config.id,
          include: "output",
          output: "research_report"
        },
        {
          node: trackGeneratorId,
          include: "output",
          output: "track_briefs"
        },
        {
          node: contradictionId,
          include: "output",
          output: "contradictions",
          optional: true
        },
        ...reductionSources.map(
          (reference): ContextReference => ({
            node: reference.node,
            include: "output",
            output: reference.output
          })
        )
      ],
      outputs: [
        {
          name: "final_critique",
          from: "attempt",
          path: "result.json",
          required: true
        }
      ],
      prompt: buildFinalCritiquePrompt(config),
      rubric: buildFinalCritiqueRubric(config)
    };

    steps.push(critiqueNode);
  }

  return {
    type: "sequence",
    id: workflowId,
    label: config.label ? `${config.label} Workflow` : "Deep Research Workflow",
    steps
  };
}

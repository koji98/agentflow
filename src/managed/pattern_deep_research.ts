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
  outputDirArtifact,
  renderPrompt,
  section,
  sharedNodeBase,
  type ManagedPatternRuntime,
  workflowBriefOutput,
  workflowPlanJsonOutput,
  workflowPlanMarkdownOutput
} from "./foundation.js";

export interface PatternDeepResearchBrief {
  question: string;
  objective: string;
  audience?: string;
  scope_cues?: string[];
  success_bar?: string[];
}

export interface PatternDeepResearchContextPolicy {
  web?: boolean;
  files?: boolean;
  apps?: boolean;
  allow_domains?: string[];
  deny_domains?: string[];
  preferred_sources?: string[];
}

export interface PatternDeepResearchApprovalPolicy {
  require_plan_approval?: boolean;
}

export interface PatternDeepResearchStrategy {
  depth?: "shallow" | "standard" | "deep";
  coverage_mode?: "breadth" | "balanced" | "depth_first";
  followup_passes?: number;
  final_critique?: boolean;
}

export interface PatternDeepResearchDelivery {
  format?: string;
  citation_style?: string;
  sections?: string[];
}

export interface PatternDeepResearchConfig extends BaseExecutableNode {
  brief: PatternDeepResearchBrief;
  context_policy: PatternDeepResearchContextPolicy;
  approval_policy: PatternDeepResearchApprovalPolicy;
  strategy: PatternDeepResearchStrategy;
  delivery: PatternDeepResearchDelivery;
  runtime?: ManagedPatternRuntime;
}

function workflowNodeId(rootId: string, suffix: string): string {
  return managedId(rootId, "pattern_deep_research", suffix);
}

function zeroPad(value: number): string {
  return String(value).padStart(2, "0");
}

function depthTrackCount(depth: PatternDeepResearchStrategy["depth"]): number {
  switch (depth) {
    case "shallow":
      return 3;
    case "deep":
      return 7;
    default:
      return 5;
  }
}

function formatContextPolicy(policy: PatternDeepResearchContextPolicy): string[] {
  return [
    `- Web research: ${policy.web === false ? "disabled" : "enabled"}`,
    `- Local file research: ${policy.files === false ? "disabled" : "enabled"}`,
    `- App or connector research: ${policy.apps ? "enabled" : "disabled"}`,
    ...(policy.allow_domains && policy.allow_domains.length > 0
      ? [`- Allowed domains: ${policy.allow_domains.join(", ")}`]
      : []),
    ...(policy.deny_domains && policy.deny_domains.length > 0
      ? [`- Denied domains: ${policy.deny_domains.join(", ")}`]
      : []),
    ...(policy.preferred_sources && policy.preferred_sources.length > 0
      ? [`- Preferred source types: ${policy.preferred_sources.join(", ")}`]
      : [])
  ];
}

function formatStrategy(strategy: PatternDeepResearchStrategy): string[] {
  return [
    `- Depth: ${strategy.depth ?? "standard"}`,
    `- Coverage mode: ${strategy.coverage_mode ?? "balanced"}`,
    `- Follow-up passes: ${strategy.followup_passes ?? 1}`,
    `- Final critique: ${strategy.final_critique ? "enabled" : "disabled"}`
  ];
}

function formatDelivery(delivery: PatternDeepResearchDelivery): string[] {
  return [
    `- Format: ${delivery.format ?? "report"}`,
    `- Citation style: ${delivery.citation_style ?? "inline"}`,
    ...(delivery.sections && delivery.sections.length > 0
      ? [`- Required sections: ${delivery.sections.join(", ")}`]
      : [])
  ];
}

function formatBrief(brief: PatternDeepResearchBrief): string[] {
  return [
    `Question: ${brief.question}`,
    `Objective: ${brief.objective}`,
    ...(brief.audience ? [`Audience: ${brief.audience}`] : []),
    ...(brief.scope_cues && brief.scope_cues.length > 0
      ? ["Scope cues:", ...brief.scope_cues.map((cue) => `- ${cue}`)]
      : []),
    ...(brief.success_bar && brief.success_bar.length > 0
      ? ["Success bar:", ...brief.success_bar.map((item) => `- ${item}`)]
      : [])
  ];
}

function buildBriefPrompt(config: PatternDeepResearchConfig): string {
  return renderPrompt([
    body("Rewrite the research ask into a concrete, execution-ready research brief."),
    section("Objective", formatBrief(config.brief)),
    section("Allowed Sources and Tools", formatContextPolicy(config.context_policy)),
    section("Quality Bar", [
      "Define what a strong final report must prove.",
      "Make uncertainty, contradiction handling, and evidence quality explicit."
    ]),
    section("Output Contract", [
      "Write `research-brief.md` and `workflow-brief.md` to the output directory.",
      "`workflow-brief.md` should be the compact operator-facing version of the longer research brief."
    ])
  ]);
}

function buildPlanPrompt(config: PatternDeepResearchConfig, trackCount: number): string {
  return renderPrompt([
    body("Build the research plan that will drive the investigation."),
    section("Objective", formatBrief(config.brief)),
    section("Current Context", [
      `Target investigation tracks: ${trackCount}`,
      "Use the research brief in context."
    ]),
    section("Allowed Sources and Tools", formatContextPolicy(config.context_policy)),
    section("Quality Bar", [
      "Define distinct research dimensions that collectively cover the question.",
      "Set explicit success criteria, source expectations, and unresolved-risk thresholds."
    ]),
    section("Output Contract", [
      "Write `research-plan.md`, `research-plan.json`, `workflow-plan.md`, and `workflow-plan.json` to the output directory.",
      "Use this JSON schema exactly for `research-plan.json` and `workflow-plan.json`:",
      '{"tracks":[{"track_id":"track-01","title":"...","focus":"...","questions":["..."],"success_criteria":["..."],"source_priorities":["..."]}],"coverage_checks":["..."],"open_risks":["..."]}'
    ]),
    section("Blocker and Escalation Rules", [
      "Do not produce scheduler advice or runtime tuning.",
      "The plan should describe research intent, coverage, and evidence requirements only."
    ])
  ]);
}

function buildPlanCheckpointPrompt(): string {
  return renderPrompt([
    body("Review the proposed research plan before the workflow fans out into investigation."),
    section("Quality Bar", [
      "Pass when the plan covers the main dimensions of the question, has clear evidence expectations, and does not waste work on redundant tracks.",
      "Deny when the plan misses key dimensions, over-focuses one narrative, or needs scope correction."
    ]),
    section("Blocker and Escalation Rules", [
      "When denying, describe the exact missing dimension, evidence bar, or scope correction needed."
    ])
  ]);
}

function buildTrackPrompt(config: PatternDeepResearchConfig): string {
  return renderPrompt([
    body("Derive the concrete investigation briefs from the approved research plan."),
    section("Objective", formatBrief(config.brief)),
    section("Current Context", [
      "Use the research brief and latest approved research plan in context."
    ]),
    section("Output Contract", [
      "Write `track-briefs.json` to the output directory.",
      "Use this exact schema:",
      '[{"track_id":"track-01","title":"...","focus":"...","questions":["..."],"success_criteria":["..."],"source_priorities":["..."]}]'
    ])
  ]);
}

function buildWorkerPrompt(config: PatternDeepResearchConfig, trackIndex: number, phaseLabel: string): string {
  const trackNumber = zeroPad(trackIndex + 1);

  return renderPrompt([
    body(`Investigate ${phaseLabel} research worker ${trackNumber}.`),
    section("Objective", formatBrief(config.brief)),
    section("Current Context", [
      "Read the relevant track brief in context and execute only that investigative slice.",
      "Maximize unique coverage rather than repeating other workers."
    ]),
    section("Allowed Sources and Tools", formatContextPolicy(config.context_policy)),
    section("Quality Bar", [
      "Preserve uncertainty, note source quality, and keep evidence traceable.",
      "Do not flatten disagreements into premature conclusions."
    ]),
    section("Output Contract", [
      "Write `track-report.md`, `track-summary.md`, and `sources.json` to the output directory."
    ])
  ]);
}

function buildContradictionPrompt(): string {
  return renderPrompt([
    body("Scan the investigation summaries for contradictions, overlap, evidence gaps, and missing angles."),
    section("Output Contract", [
      "Write `contradictions.md` to the output directory."
    ]),
    section("Quality Bar", [
      "Keep contradictions explicit so follow-up passes and final synthesis can address them directly."
    ])
  ]);
}

function buildFollowupPlanPrompt(passIndex: number): string {
  return renderPrompt([
    body(`Plan follow-up research pass ${passIndex + 1}.`),
    section("Current Context", [
      "Use the approved research plan, track briefs, contradictions, and prior findings in context."
    ]),
    section("Output Contract", [
      `Write \`followup-plan-pass-${zeroPad(passIndex + 1)}.json\` to the output directory.`,
      "Use this exact schema:",
      '[{"track_id":"track-01","focus":"...","questions":["..."],"why_now":"..."}]'
    ]),
    section("Quality Bar", [
      "Focus only on unresolved evidence gaps, not broad rework of already-covered material."
    ])
  ]);
}

function buildConsolidatePrompt(config: PatternDeepResearchConfig): string {
  return renderPrompt([
    body("Consolidate the investigation artifacts into machine-readable interim findings, provenance, and uncertainty artifacts."),
    section("Objective", formatBrief(config.brief)),
    section("Current Context", [
      "Use track summaries, track source ledgers, contradiction notes, and any follow-up artifacts in context."
    ]),
    section("Output Contract", [
      "Write `interim-findings.jsonl`, `source-ledger.json`, and `uncertainties.md` to the output directory."
    ]),
    section("Quality Bar", [
      "Every high-signal finding should remain traceable to evidence.",
      "Uncertainty should be explicit, not relegated to optional side notes."
    ]),
    section("Allowed Sources and Tools", formatContextPolicy(config.context_policy))
  ]);
}

function buildFinalPrompt(config: PatternDeepResearchConfig): string {
  return renderPrompt([
    body("Publish the final deep research package."),
    section("Objective", formatBrief(config.brief)),
    section("Current Context", [
      "Use the research brief, latest approved plan, interim findings, source ledger, and uncertainty register in context."
    ]),
    section("Allowed Sources and Tools", formatContextPolicy(config.context_policy)),
    section("Output Contract", [
      "Write `research-report.md`, `research-packet.json`, `source-ledger.json`, `uncertainties.md`, and `interim-findings.jsonl` to the output directory.",
      "Use this exact schema for `research-packet.json`:",
      '{"question":"...","objective":"...","top_findings":["..."],"major_uncertainties":["..."],"source_summary":["..."],"recommended_downstream_uses":["..."]}',
      ...formatDelivery(config.delivery)
    ]),
    section("Quality Bar", [
      "Preserve contradictions and unresolved questions as first-class content.",
      "The final report must not read like a shallow summary of one dominant track."
    ])
  ]);
}

function buildFinalCritiquePrompt(config: PatternDeepResearchConfig): string {
  return renderPrompt([
    body("Review whether the final research report is complete, balanced, and grounded in the gathered evidence."),
    section("Objective", formatBrief(config.brief)),
    section("Current Context", [
      "Use the final report, source ledger, uncertainties, and workflow plan in context."
    ])
  ]);
}

function buildFinalCritiqueRubric(config: PatternDeepResearchConfig): string {
  const sectionRequirement =
    config.delivery.sections && config.delivery.sections.length > 0
      ? `Pass only if the report covers: ${config.delivery.sections.join(", ")}.`
      : "Pass only if the report covers the main problem, analysis, and recommendation clearly.";

  return [
    sectionRequirement,
    "Fail if major contradictions are dropped, if evidence provenance is weak, or if the strongest uncertainties are missing."
  ].join(" ");
}

function buildWorkerArtifacts(trackIndex: number): Record<string, ArtifactDefinition> {
  const suffix = zeroPad(trackIndex + 1);

  return mergeArtifacts(
    outputDirArtifact(`track_report_${suffix}`, "track-report.md"),
    outputDirArtifact(`track_summary_${suffix}`, "track-summary.md"),
    outputDirArtifact(`track_sources_${suffix}`, "sources.json")
  );
}

function buildFollowupArtifacts(passIndex: number, trackIndex: number): Record<string, ArtifactDefinition> {
  const passSuffix = zeroPad(passIndex + 1);
  const trackSuffix = zeroPad(trackIndex + 1);

  return mergeArtifacts(
    outputDirArtifact(`followup_report_${passSuffix}_${trackSuffix}`, "track-report.md"),
    outputDirArtifact(`followup_summary_${passSuffix}_${trackSuffix}`, "track-summary.md"),
    outputDirArtifact(`followup_sources_${passSuffix}_${trackSuffix}`, "sources.json")
  );
}

export function buildPatternDeepResearch(config: PatternDeepResearchConfig): SequenceNode {
  const shared = sharedNodeBase(config);
  const workflowId = workflowNodeId(config.id, "workflow");
  const trackCount = depthTrackCount(config.strategy.depth);
  const concurrency = maxConcurrency(config.runtime, trackCount);

  const briefId = workflowNodeId(config.id, "clarify_brief");
  const planId = workflowNodeId(config.id, "plan_research");
  const planCheckpointId = workflowNodeId(config.id, "approve_research_plan");
  const planningLoopId = workflowNodeId(config.id, "planning_loop");
  const planningBodyId = workflowNodeId(config.id, "planning_body");
  const trackId = workflowNodeId(config.id, "derive_tracks");
  const trackFanoutId = workflowNodeId(config.id, "investigation_fanout");
  const contradictionId = workflowNodeId(config.id, "scan_contradictions");
  const consolidateId = workflowNodeId(config.id, "consolidate_findings");

  const steps: SequenceNode["steps"] = [
    {
      type: "agent",
      id: briefId,
      label: "Clarify Research Brief",
      ...shared,
      ...(config.context ? { context: config.context } : {}),
      artifacts: mergeArtifacts(
        outputDirArtifact("research_brief", "research-brief.md"),
        workflowBriefOutput()
      ),
      goal: buildBriefPrompt(config)
    }
  ];

  const planContext: ContextItem[] = [
    artifactContext("research_brief", briefId, "research_brief")
  ];

  if (config.approval_policy.require_plan_approval) {
    const planningLoop: RepeatNode = {
      type: "repeat",
      id: planningLoopId,
      label: "Research Plan Approval Loop",
      max_attempts: 3,
      body: {
        type: "sequence",
        id: planningBodyId,
        label: "Research Plan Approval Body",
        steps: [
          {
            type: "agent",
            id: planId,
            label: "Draft Research Plan",
            ...shared,
            context: [
              ...planContext,
              artifactContext("operator_feedback", planCheckpointId, "operator_feedback", {
                iteration: "latest_failed",
                if_available: true
              })
            ],
            artifacts: mergeArtifacts(
              outputDirArtifact("research_plan_markdown", "research-plan.md"),
              outputDirArtifact("research_plan_json", "research-plan.json"),
              workflowPlanMarkdownOutput(),
              workflowPlanJsonOutput()
            ),
            goal: buildPlanPrompt(config, trackCount)
          },
          {
            type: "checkpoint",
            id: planCheckpointId,
            label: "Approve Research Plan",
            ...shared,
            context: [
              artifactContext("research_plan_json", planId, "research_plan_json")
            ],
            review_from: {
              node: planId,
              artifact: "research_plan_markdown"
            },
            goal: buildPlanCheckpointPrompt()
          }
        ]
      },
      until: {
        node: planCheckpointId
      }
    };

    steps.push(planningLoop);
  } else {
    steps.push({
      type: "agent",
      id: planId,
      label: "Plan Research",
      ...shared,
      context: planContext,
      artifacts: mergeArtifacts(
        outputDirArtifact("research_plan_markdown", "research-plan.md"),
        outputDirArtifact("research_plan_json", "research-plan.json"),
        workflowPlanMarkdownOutput(),
        workflowPlanJsonOutput()
      ),
      goal: buildPlanPrompt(config, trackCount)
    });
  }

  const latestPlanRef = artifactContext("research_plan_markdown", planId, "research_plan_markdown", {
    ...(config.approval_policy.require_plan_approval ? { iteration: "latest_passed" as const } : {})
  });

  const latestPlanJsonRef = artifactContext("research_plan_json", planId, "research_plan_json", {
    ...(config.approval_policy.require_plan_approval ? { iteration: "latest_passed" as const } : {})
  });

  steps.push(
    {
      type: "agent",
      id: trackId,
      label: "Derive Investigation Tracks",
      ...shared,
      context: [
        artifactContext("research_brief", briefId, "research_brief"),
        latestPlanJsonRef
      ],
      artifacts: outputDirArtifact("track_briefs", "track-briefs.json"),
      goal: buildTrackPrompt(config)
    },
    {
      type: "parallel",
      id: trackFanoutId,
      label: "Investigate In Parallel",
      max_concurrency: concurrency,
      steps: Array.from({ length: trackCount }, (_, index): AgentNode => ({
        type: "agent",
        id: workflowNodeId(config.id, `track_${zeroPad(index + 1)}`),
        label: `Investigation Track ${zeroPad(index + 1)}`,
        ...shared,
        context: [
          artifactContext("track_briefs", trackId, "track_briefs"),
          artifactContext("research_brief", briefId, "research_brief"),
          latestPlanRef
        ],
        artifacts: buildWorkerArtifacts(index),
        goal: buildWorkerPrompt(config, index, "initial")
      }))
    },
    {
      type: "agent",
      id: contradictionId,
      label: "Scan Contradictions",
      ...shared,
      context: Array.from({ length: trackCount }, (_, index): ContextItem => {
        const suffix = zeroPad(index + 1);
        return artifactContext(`track_summary_${suffix}`, workflowNodeId(config.id, `track_${suffix}`), `track_summary_${suffix}`);
      }),
      artifacts: outputDirArtifact("contradictions", "contradictions.md"),
    goal: buildContradictionPrompt()
    }
  );

  const consolidationContext: ContextItem[] = [
    latestPlanJsonRef,
    artifactContext("contradictions", contradictionId, "contradictions"),
    ...Array.from({ length: trackCount }, (_, index): ContextItem => {
      const suffix = zeroPad(index + 1);
      return artifactContext(`track_summary_${suffix}`, workflowNodeId(config.id, `track_${suffix}`), `track_summary_${suffix}`);
    }),
    ...Array.from({ length: trackCount }, (_, index): ContextItem => {
      const suffix = zeroPad(index + 1);
      return artifactContext(`track_sources_${suffix}`, workflowNodeId(config.id, `track_${suffix}`), `track_sources_${suffix}`);
    })
  ];

  for (let passIndex = 0; passIndex < (config.strategy.followup_passes ?? 1); passIndex += 1) {
    const followupPlanId = workflowNodeId(config.id, `followup_plan_${zeroPad(passIndex + 1)}`);
    const followupFanoutId = workflowNodeId(config.id, `followup_fanout_${zeroPad(passIndex + 1)}`);

    steps.push(
      {
        type: "agent",
        id: followupPlanId,
        label: `Plan Follow-up Pass ${zeroPad(passIndex + 1)}`,
        ...shared,
        context: [
          latestPlanJsonRef,
          artifactContext("contradictions", contradictionId, "contradictions"),
          ...Array.from({ length: trackCount }, (_, index): ContextItem => {
            const suffix = zeroPad(index + 1);
            return artifactContext(`track_summary_${suffix}`, workflowNodeId(config.id, `track_${suffix}`), `track_summary_${suffix}`);
          })
        ],
        artifacts: outputDirArtifact(`followup_plan_${zeroPad(passIndex + 1)}`, `followup-plan-pass-${zeroPad(passIndex + 1)}.json`),
        goal: buildFollowupPlanPrompt(passIndex)
      },
      {
        type: "parallel",
        id: followupFanoutId,
        label: `Follow-up Pass ${zeroPad(passIndex + 1)}`,
        max_concurrency: concurrency,
        steps: Array.from({ length: trackCount }, (_, index): AgentNode => ({
          type: "agent",
          id: workflowNodeId(config.id, `followup_${zeroPad(passIndex + 1)}_${zeroPad(index + 1)}`),
          label: `Follow-up ${zeroPad(passIndex + 1)} Track ${zeroPad(index + 1)}`,
          ...shared,
          context: [
            artifactContext(`followup_plan_${zeroPad(passIndex + 1)}`, followupPlanId, `followup_plan_${zeroPad(passIndex + 1)}`),
            artifactContext("research_brief", briefId, "research_brief")
          ],
          artifacts: buildFollowupArtifacts(passIndex, index),
          goal: buildWorkerPrompt(config, index, `follow-up pass ${zeroPad(passIndex + 1)}`)
        }))
      }
    );

    consolidationContext.push(
      artifactContext(`followup_plan_${zeroPad(passIndex + 1)}`, followupPlanId, `followup_plan_${zeroPad(passIndex + 1)}`)
    );

    consolidationContext.push(
      ...Array.from({ length: trackCount }, (_, index): ContextItem => {
        const passSuffix = zeroPad(passIndex + 1);
        const trackSuffix = zeroPad(index + 1);
        return artifactContext(
          `followup_summary_${passSuffix}_${trackSuffix}`,
          workflowNodeId(config.id, `followup_${passSuffix}_${trackSuffix}`),
          `followup_summary_${passSuffix}_${trackSuffix}`
        );
      })
    );
    consolidationContext.push(
      ...Array.from({ length: trackCount }, (_, index): ContextItem => {
        const passSuffix = zeroPad(passIndex + 1);
        const trackSuffix = zeroPad(index + 1);
        return artifactContext(
          `followup_sources_${passSuffix}_${trackSuffix}`,
          workflowNodeId(config.id, `followup_${passSuffix}_${trackSuffix}`),
          `followup_sources_${passSuffix}_${trackSuffix}`
        );
      })
    );
  }

  steps.push({
    type: "agent",
    id: consolidateId,
    label: "Consolidate Findings",
    ...shared,
    context: consolidationContext,
    artifacts: mergeArtifacts(
      outputDirArtifact("interim_findings", "interim-findings.jsonl"),
      outputDirArtifact("source_ledger", "source-ledger.json"),
      outputDirArtifact("uncertainties", "uncertainties.md")
    ),
    goal: buildConsolidatePrompt(config)
  });

  const publishedArtifacts = mergeArtifacts(
    outputDirArtifact("research_report", "research-report.md"),
    outputDirArtifact("research_packet", "research-packet.json"),
    outputDirArtifact("source_ledger", "source-ledger.json"),
    outputDirArtifact("uncertainties", "uncertainties.md"),
    outputDirArtifact("interim_findings", "interim-findings.jsonl")
  );

  steps.push({
    type: "agent",
    id: config.id,
    ...(config.label ? { label: config.label } : { label: "Publish Research Package" }),
    ...shared,
    context: [
      artifactContext("research_brief", briefId, "research_brief"),
      latestPlanRef,
      latestPlanJsonRef,
      artifactContext("interim_findings", consolidateId, "interim_findings"),
      artifactContext("source_ledger", consolidateId, "source_ledger"),
      artifactContext("uncertainties", consolidateId, "uncertainties")
    ],
    artifacts: publishedArtifacts,
    goal: buildFinalPrompt(config)
  });

  if (config.strategy.final_critique) {
    steps.push({
      type: "check",
      id: workflowNodeId(config.id, "final_critique"),
      label: "Critique Final Report",
      ...shared,
      check_kind: "ai",
      context: [
        artifactContext("research_report", config.id, "research_report"),
        artifactContext("source_ledger", config.id, "source_ledger"),
        artifactContext("uncertainties", config.id, "uncertainties"),
        latestPlanRef
      ],
      goal: buildFinalCritiquePrompt(config),
      rubric: buildFinalCritiqueRubric(config)
    } satisfies CheckNode);
  }

  return {
    type: "sequence",
    id: workflowId,
    label: config.label ? `${config.label} Workflow` : "Deep Research Workflow",
    steps
  };
}

import type {
  AgentNode,
  BaseExecutableNode,
  ContextReference,
  FileInput,
  InputItem,
  OutputDefinition,
  ParallelNode,
  SequenceNode
} from "../graph/authored.js";
import {
  attemptOutput,
  body,
  listOrFallback,
  managedId,
  maxConcurrency,
  renderPrompt,
  section,
  sharedNodeBase,
  type ManagedPatternRuntime,
  workflowBriefOutput,
  workflowPlanJsonOutput,
  workflowPlanMarkdownOutput
} from "./foundation.js";

export interface PatternReviewChangeScope {
  paths?: string[];
  areas?: string[];
}

export interface PatternReviewChangeManagedNodeSource {
  kind: "managed_node";
  node: string;
}

export interface PatternReviewChangeFileSourceRef {
  kind: "file";
  path: string;
}

export interface PatternReviewChangeManagedOutputSourceRef {
  kind: "managed_output";
  node: string;
  output: string;
}

export type PatternReviewChangeSourceRef = PatternReviewChangeFileSourceRef | PatternReviewChangeManagedOutputSourceRef;

export interface PatternReviewChangeArtifactBundleSource {
  kind: "artifact_bundle";
  diff?: PatternReviewChangeSourceRef;
  summary?: PatternReviewChangeSourceRef;
  evaluation_ledger?: PatternReviewChangeSourceRef;
  files_touched?: PatternReviewChangeSourceRef;
  additional_context?: PatternReviewChangeSourceRef[];
}

export type PatternReviewChangeSource = PatternReviewChangeManagedNodeSource | PatternReviewChangeArtifactBundleSource;

export interface PatternReviewChangeBrief {
  review_goal?: string;
  focus?: string[];
  audience?: string;
  scope?: PatternReviewChangeScope;
}

export interface PatternReviewChangeContextPolicy {
  include_surrounding_code?: boolean;
  include_tests?: boolean;
  include_docs?: boolean;
  include_validation?: boolean;
}

export interface PatternReviewChangeStrategy {
  reviewer_profiles?: string[];
  severity_policy?: "balanced" | "conservative" | "strict";
  include_surrounding_context?: boolean;
  false_positive_challenge?: boolean;
  require_file_references?: boolean;
}

export interface PatternReviewChangeDelivery {
  format?: string;
  sections?: string[];
}

export interface PatternReviewChangeConfig extends BaseExecutableNode {
  brief: PatternReviewChangeBrief;
  review_source: PatternReviewChangeSource;
  context_policy: PatternReviewChangeContextPolicy;
  strategy: PatternReviewChangeStrategy;
  delivery: PatternReviewChangeDelivery;
  runtime?: ManagedPatternRuntime;
}

function workflowNodeId(rootId: string, suffix: string): string {
  return managedId(rootId, "pattern_review_change", suffix);
}

function slugValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "reviewer";
}

function formatScope(scope: PatternReviewChangeScope | undefined): string[] {
  if (!scope) {
    return ["Scope: infer the most relevant repository surfaces from the review source and packet."];
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

  return lines.length > 0 ? lines : ["Scope: infer the most relevant repository surfaces from the review source and packet."];
}

function formatBrief(brief: PatternReviewChangeBrief): string[] {
  return [
    `Review goal: ${brief.review_goal ?? "Find the highest-signal defects and risks in the change."}`,
    ...(brief.audience ? [`Audience: ${brief.audience}`] : []),
    ...listOrFallback("Review focus", brief.focus ?? [], "infer from the change and repository context"),
    "",
    ...formatScope(brief.scope)
  ].filter((line) => line.length > 0);
}

function formatContextPolicy(policy: PatternReviewChangeContextPolicy): string[] {
  return [
    `- Include surrounding code: ${policy.include_surrounding_code ? "yes" : "no"}`,
    `- Include tests: ${policy.include_tests ? "yes" : "no"}`,
    `- Include docs: ${policy.include_docs ? "yes" : "no"}`,
    `- Include validation context: ${policy.include_validation === false ? "no" : "yes"}`
  ];
}

function formatStrategy(strategy: PatternReviewChangeStrategy): string[] {
  return [
    `- Reviewer profiles: ${(strategy.reviewer_profiles ?? ["correctness", "testing", "maintainability"]).join(", ")}`,
    `- Severity policy: ${strategy.severity_policy ?? "balanced"}`,
    `- Include surrounding context: ${strategy.include_surrounding_context ? "yes" : "no"}`,
    `- False positive challenge: ${strategy.false_positive_challenge ? "enabled" : "disabled"}`,
    `- Require file references when possible: ${strategy.require_file_references === false ? "no" : "yes"}`
  ];
}

function formatDelivery(delivery: PatternReviewChangeDelivery): string[] {
  return [
    `- Format: ${delivery.format ?? "review_summary"}`,
    ...(delivery.sections && delivery.sections.length > 0
      ? [`- Required sections: ${delivery.sections.join(", ")}`]
      : [])
  ];
}

function formatSourceRef(reference: PatternReviewChangeSourceRef): string {
  return reference.kind === "file"
    ? `file:${reference.path}`
    : `managed_output:${reference.node}.${reference.output}`;
}

function formatReviewSource(source: PatternReviewChangeSource): string[] {
  if (source.kind === "managed_node") {
    return [
      "- Source kind: managed_node",
      `- Source node: ${source.node}`,
      "- Expected outputs when available: change_summary, change_packet, evaluation_ledger, fix_log"
    ];
  }

  return [
    "- Source kind: artifact_bundle",
    ...(source.diff ? [`- diff: ${formatSourceRef(source.diff)}`] : []),
    ...(source.summary ? [`- summary: ${formatSourceRef(source.summary)}`] : []),
    ...(source.evaluation_ledger ? [`- evaluation_ledger: ${formatSourceRef(source.evaluation_ledger)}`] : []),
    ...(source.files_touched ? [`- files_touched: ${formatSourceRef(source.files_touched)}`] : []),
    ...(source.additional_context && source.additional_context.length > 0
      ? ["- additional_context:", ...source.additional_context.map((reference) => `  - ${formatSourceRef(reference)}`)]
      : [])
  ];
}

function sourceRefToInput(reference: PatternReviewChangeSourceRef): InputItem | undefined {
  if (reference.kind !== "file") {
    return undefined;
  }

  return {
    kind: "file",
    path: reference.path
  } satisfies FileInput;
}

function sourceRefToContext(reference: PatternReviewChangeSourceRef, optional: boolean): ContextReference | undefined {
  if (reference.kind !== "managed_output") {
    return undefined;
  }

  return {
    node: reference.node,
    include: "output",
    output: reference.output,
    ...(optional ? { optional: true } : {})
  };
}

function resolveReviewSourceMaterials(source: PatternReviewChangeSource): {
  inputs: InputItem[];
  context_from: ContextReference[];
} {
  if (source.kind === "managed_node") {
    return {
      inputs: [],
      context_from: [
        {
          node: source.node,
          include: "summary"
        },
        {
          node: source.node,
          include: "output",
          output: "change_summary",
          optional: true
        },
        {
          node: source.node,
          include: "output",
          output: "change_packet",
          optional: true
        },
        {
          node: source.node,
          include: "output",
          output: "evaluation_ledger",
          optional: true
        },
        {
          node: source.node,
          include: "output",
          output: "fix_log",
          optional: true
        }
      ]
    };
  }

  const refs: Array<{ reference: PatternReviewChangeSourceRef; optional: boolean }> = [
    ...(source.diff ? [{ reference: source.diff, optional: false }] : []),
    ...(source.summary ? [{ reference: source.summary, optional: false }] : []),
    ...(source.evaluation_ledger ? [{ reference: source.evaluation_ledger, optional: true }] : []),
    ...(source.files_touched ? [{ reference: source.files_touched, optional: true }] : []),
    ...(source.additional_context ?? []).map((reference) => ({
      reference,
      optional: true
    }))
  ];

  return refs.reduce(
    (accumulator, item) => {
      const input = sourceRefToInput(item.reference);
      const context = sourceRefToContext(item.reference, item.optional);

      if (input) {
        accumulator.inputs.push(input);
      }

      if (context) {
        accumulator.context_from.push(context);
      }

      return accumulator;
    },
    {
      inputs: [] as InputItem[],
      context_from: [] as ContextReference[]
    }
  );
}

function roleGuidance(role: string): string {
  switch (slugValue(role)) {
    case "correctness":
      return "Prioritize logic bugs, behavioral regressions, and broken invariants.";
    case "testing":
      return "Prioritize missing tests, weak validation, and gaps in verification.";
    case "maintainability":
      return "Prioritize brittle implementation choices, hidden coupling, and long-term maintenance risk.";
    case "security":
      return "Prioritize trust boundaries, permissions, and unsafe operational behavior.";
    case "performance":
      return "Prioritize obviously risky inefficiencies or scaling regressions.";
    default:
      return `Focus on the risks most relevant to the ${role} review perspective.`;
  }
}

function buildPreparePrompt(config: PatternReviewChangeConfig): string {
  return renderPrompt([
    body("Prepare the structured review packet for this change review."),
    section("Objective", formatBrief(config.brief)),
    section("Allowed Sources and Tools", [
      ...formatContextPolicy(config.context_policy),
      "",
      ...formatReviewSource(config.review_source)
    ]),
    section("Output Contract", [
      "Write `review-packet.json` and `workflow-brief.md` to the output directory."
    ]),
    section("Quality Bar", [
      "The packet must summarize the target change, affected surfaces, validation state, and evidence each reviewer should inspect."
    ])
  ]);
}

function buildPlanPrompt(config: PatternReviewChangeConfig): string {
  return renderPrompt([
    body("Turn the review packet into an explicit review plan."),
    section("Objective", formatBrief(config.brief)),
    section("Current Context", [
      "Use the review packet in context."
    ]),
    section("Allowed Sources and Tools", [
      ...formatContextPolicy(config.context_policy),
      "",
      ...formatStrategy(config.strategy)
    ]),
    section("Output Contract", [
      "Write `workflow-plan.md` and `workflow-plan.json` to the output directory.",
      "Use this JSON schema exactly for `workflow-plan.json`:",
      '{"reviewer_profiles":["..."],"focus_areas":["..."],"evidence_expectations":["..."],"high_risk_surfaces":["..."]}'
    ])
  ]);
}

function buildReviewerPrompt(role: string, config: PatternReviewChangeConfig): string {
  const slug = slugValue(role);

  return renderPrompt([
    body(`Review the change from the ${role} perspective.`),
    section("Objective", formatBrief(config.brief)),
    section("Current Context", [
      "Use the review packet and workflow plan in context.",
      roleGuidance(role)
    ]),
    section("Allowed Sources and Tools", [
      ...formatContextPolicy(config.context_policy),
      "",
      ...formatStrategy(config.strategy)
    ]),
    section("Quality Bar", [
      "Focus on high-signal findings only. Prefer concrete bugs, regressions, and missing tests over style commentary.",
      "If a finding is speculative, explain the uncertainty."
    ]),
    section("Output Contract", [
      `Write \`findings-${slug}.json\` to the output directory.`,
      "Use this exact JSON schema:",
      '{"summary":"short summary","findings":[{"title":"...","priority":2,"file":"relative/path.ts","start_line":1,"end_line":1,"body":"...","category":"correctness","confidence":0.8}]}',
      "If there are no material findings, return an empty findings array."
    ])
  ]);
}

function buildRawFindingsPrompt(): string {
  return renderPrompt([
    body("Aggregate the reviewer outputs into one raw findings set."),
    section("Quality Bar", [
      "Preserve reviewer intent and evidence before deduplication or severity calibration."
    ]),
    section("Output Contract", [
      "Write `raw-findings.json` to the output directory."
    ])
  ]);
}

function buildMergePrompt(): string {
  return renderPrompt([
    body("Merge the raw reviewer findings into one deduplicated findings set."),
    section("Quality Bar", [
      "De-duplicate overlap, preserve the strongest finding wording, and keep traceability back to source evidence."
    ]),
    section("Output Contract", [
      "Write `merged-findings.json` to the output directory."
    ])
  ]);
}

function buildCalibratePrompt(config: PatternReviewChangeConfig): string {
  return renderPrompt([
    body("Calibrate the merged findings for severity, confidence, and false positives."),
    section("Objective", formatBrief(config.brief)),
    section("Current Context", [
      "Use the review packet, workflow plan, and merged findings in context."
    ]),
    section("Allowed Sources and Tools", formatStrategy(config.strategy)),
    section("Quality Bar", [
      `Apply the ${config.strategy.severity_policy ?? "balanced"} severity policy consistently.`,
      ...(config.strategy.false_positive_challenge
        ? ["Actively challenge weak, speculative, or duplicate findings before keeping them."]
        : []),
      ...(config.strategy.require_file_references === false
        ? ["File references are preferred but not mandatory when the evidence is clearly scoped."]
        : ["Concrete findings should include file references when reasonably available."])
    ]),
    section("Output Contract", [
      "Write `calibrated-findings.json` to the output directory."
    ])
  ]);
}

function buildFinalizePrompt(config: PatternReviewChangeConfig, outputs: OutputDefinition[]): string {
  return renderPrompt([
    body("Publish the final review package."),
    section("Current Context", [
      "Use the review packet, workflow plan, merged findings, and calibrated findings in context."
    ]),
    section("Output Contract", [
      ...outputs.map((output) => `- \`${output.path}\``),
      "Use this exact schema for `review-bundle.json`:",
      '{"change_summary":"...","findings":[{"title":"...","severity":"...","confidence":"...","evidence":["..."]}],"severity_summary":{"high":0,"medium":0,"low":0},"recommended_actions":["..."]}'
    ]),
    section("Delivery Preferences", formatDelivery(config.delivery)),
    section("Quality Bar", [
      "The final review should be concise, findings-first, and aligned with the calibrated findings set."
    ])
  ]);
}

export function buildPatternReviewChange(config: PatternReviewChangeConfig): SequenceNode {
  const shared = sharedNodeBase(config);
  const workflowId = workflowNodeId(config.id, "workflow");
  const reviewerProfiles = config.strategy.reviewer_profiles ?? ["correctness", "testing", "maintainability"];
  const concurrency = maxConcurrency(config.runtime, reviewerProfiles.length);

  const prepareId = workflowNodeId(config.id, "prepare_review_packet");
  const planId = workflowNodeId(config.id, "plan_review");
  const reviewerPanelId = workflowNodeId(config.id, "reviewer_panel");
  const rawId = workflowNodeId(config.id, "aggregate_raw_findings");
  const mergeId = workflowNodeId(config.id, "merge_findings");
  const calibrateId = workflowNodeId(config.id, "calibrate_findings");

  const sourceMaterials = resolveReviewSourceMaterials(config.review_source);

  const steps: SequenceNode["steps"] = [
    {
      type: "agent",
      id: prepareId,
      label: "Prepare Review Packet",
      ...shared,
      sandbox: "read-only",
      inputs: [...(config.inputs ?? []), ...sourceMaterials.inputs],
      context_from: [...(config.context_from ?? []), ...sourceMaterials.context_from],
      outputs: [
        attemptOutput("review_packet", "review-packet.json", true),
        workflowBriefOutput()
      ],
      prompt: buildPreparePrompt(config)
    },
    {
      type: "agent",
      id: planId,
      label: "Plan Review",
      ...shared,
      sandbox: "read-only",
      context_from: [
        {
          node: prepareId,
          include: "output",
          output: "review_packet"
        }
      ],
      outputs: [
        workflowPlanMarkdownOutput(),
        workflowPlanJsonOutput()
      ],
      prompt: buildPlanPrompt(config)
    },
    {
      type: "parallel",
      id: reviewerPanelId,
      label: "Reviewer Panel",
      max_concurrency: concurrency,
      steps: reviewerProfiles.map((profile): AgentNode => ({
        type: "agent",
        id: workflowNodeId(config.id, `reviewer_${slugValue(profile)}`),
        label: `${profile} Reviewer`,
        ...shared,
        sandbox: "read-only",
        context_from: [
          {
            node: prepareId,
            include: "output",
            output: "review_packet"
          },
          {
            node: planId,
            include: "output",
            output: "workflow_plan_json"
          }
        ],
        outputs: [
          attemptOutput(`findings_${slugValue(profile)}`, `findings-${slugValue(profile)}.json`, true)
        ],
        prompt: buildReviewerPrompt(profile, config)
      }))
    } satisfies ParallelNode,
    {
      type: "agent",
      id: rawId,
      label: "Aggregate Raw Findings",
      ...shared,
      sandbox: "read-only",
      context_from: reviewerProfiles.map(
        (profile): ContextReference => ({
          node: workflowNodeId(config.id, `reviewer_${slugValue(profile)}`),
          include: "output",
          output: `findings_${slugValue(profile)}`
        })
      ),
      outputs: [
        attemptOutput("raw_findings", "raw-findings.json", true)
      ],
      prompt: buildRawFindingsPrompt()
    },
    {
      type: "agent",
      id: mergeId,
      label: "Merge Findings",
      ...shared,
      sandbox: "read-only",
      context_from: [
        {
          node: prepareId,
          include: "output",
          output: "review_packet"
        },
        {
          node: rawId,
          include: "output",
          output: "raw_findings"
        }
      ],
      outputs: [
        attemptOutput("merged_findings", "merged-findings.json", true)
      ],
      prompt: buildMergePrompt()
    },
    {
      type: "agent",
      id: calibrateId,
      label: "Calibrate Findings",
      ...shared,
      sandbox: "read-only",
      context_from: [
        {
          node: prepareId,
          include: "output",
          output: "review_packet"
        },
        {
          node: planId,
          include: "output",
          output: "workflow_plan_json"
        },
        {
          node: mergeId,
          include: "output",
          output: "merged_findings"
        }
      ],
      outputs: [
        attemptOutput("calibrated_findings", "calibrated-findings.json", true)
      ],
      prompt: buildCalibratePrompt(config)
    }
  ];

  const finalOutputs: OutputDefinition[] = [
    attemptOutput("review_summary", "review-summary.md", true),
    attemptOutput("review_bundle", "review-bundle.json", true),
    attemptOutput("raw_findings", "raw-findings.json", true),
    attemptOutput("merged_findings", "merged-findings.json", true),
    attemptOutput("calibrated_findings", "calibrated-findings.json", true)
  ];

  steps.push({
    type: "agent",
    id: config.id,
    ...(config.label ? { label: config.label } : { label: "Publish Review" }),
    ...shared,
    sandbox: "read-only",
    context_from: [
      {
        node: prepareId,
        include: "output",
        output: "review_packet"
      },
      {
        node: planId,
        include: "output",
        output: "workflow_plan_json"
      },
      {
        node: rawId,
        include: "output",
        output: "raw_findings"
      },
      {
        node: mergeId,
        include: "output",
        output: "merged_findings"
      },
      {
        node: calibrateId,
        include: "output",
        output: "calibrated_findings"
      }
    ],
    outputs: finalOutputs,
    prompt: buildFinalizePrompt(config, finalOutputs)
  });

  return {
    type: "sequence",
    id: workflowId,
    label: config.label ? `${config.label} Workflow` : "Review Change Workflow",
    steps
  };
}

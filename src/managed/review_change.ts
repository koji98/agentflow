import type {
  AgentNode,
  BaseExecutableNode,
  CheckNode,
  ContextReference,
  FileInput,
  InputItem,
  OutputDefinition,
  ParallelNode,
  SequenceNode
} from "../graph/authored.js";

export interface ReviewChangeScope {
  paths?: string[];
  areas?: string[];
}

export interface ReviewChangeManagedNodeSource {
  kind: "managed_node";
  node: string;
}

export interface ReviewChangeFileSourceRef {
  kind: "file";
  path: string;
}

export interface ReviewChangeManagedOutputSourceRef {
  kind: "managed_output";
  node: string;
  output: string;
}

export type ReviewChangeSourceRef = ReviewChangeFileSourceRef | ReviewChangeManagedOutputSourceRef;

export interface ReviewChangeArtifactBundleSource {
  kind: "artifact_bundle";
  diff?: ReviewChangeSourceRef;
  summary?: ReviewChangeSourceRef;
  validation_results?: ReviewChangeSourceRef;
  files_touched?: ReviewChangeSourceRef;
  additional_context?: ReviewChangeSourceRef[];
}

export type ReviewChangeSource = ReviewChangeManagedNodeSource | ReviewChangeArtifactBundleSource;

export interface ReviewChangeCriteria {
  focus: string[];
  require_file_references: boolean;
}

export interface ReviewChangeOrchestration {
  reviewer_roles: string[];
  max_parallel_reviewers: number;
}

export interface ReviewChangeDelivery {
  write_review_report: boolean;
  write_findings_json: boolean;
  write_findings_markdown: boolean;
}

export interface ReviewChangeWorkflowConfig extends BaseExecutableNode {
  review_source: ReviewChangeSource;
  scope: ReviewChangeScope;
  criteria: ReviewChangeCriteria;
  orchestration: ReviewChangeOrchestration;
  delivery: ReviewChangeDelivery;
}

function managedId(rootId: string, suffix: string): string {
  return `${rootId}__managed__review_change__${suffix}`;
}

function slugValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "reviewer";
}

function sharedNodeBase(config: ReviewChangeWorkflowConfig): Pick<
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

function formatScope(scope: ReviewChangeScope): string[] {
  const lines: string[] = [];

  if (scope.paths && scope.paths.length > 0) {
    lines.push("Repository paths in scope:");
    lines.push(...scope.paths.map((path) => `- ${path}`));
  }

  if (scope.areas && scope.areas.length > 0) {
    lines.push("Product or system areas in scope:");
    lines.push(...scope.areas.map((area) => `- ${area}`));
  }

  return lines.length > 0 ? lines : ["Scope: infer the most relevant surfaces from the review source and repository state."];
}

function formatCriteria(criteria: ReviewChangeCriteria): string[] {
  return [
    ...formatList("Review focus", criteria.focus),
    `Require file references when possible: ${criteria.require_file_references ? "yes" : "no"}`
  ];
}

function formatSourceRef(reference: ReviewChangeSourceRef): string {
  return reference.kind === "file"
    ? `file:${reference.path}`
    : `managed_output:${reference.node}.${reference.output}`;
}

function formatReviewSource(source: ReviewChangeSource): string[] {
  if (source.kind === "managed_node") {
    return [
      "- Source kind: managed_node",
      `- Source node: ${source.node}`,
      "- Expected outputs when available: change_summary, validation_results, residual_risks, files_touched, implementation_plan"
    ];
  }

  return [
    "- Source kind: artifact_bundle",
    ...(source.diff ? [`- diff: ${formatSourceRef(source.diff)}`] : []),
    ...(source.summary ? [`- summary: ${formatSourceRef(source.summary)}`] : []),
    ...(source.validation_results
      ? [`- validation_results: ${formatSourceRef(source.validation_results)}`]
      : []),
    ...(source.files_touched ? [`- files_touched: ${formatSourceRef(source.files_touched)}`] : []),
    ...(source.additional_context && source.additional_context.length > 0
      ? [
          "- additional_context:",
          ...source.additional_context.map((reference) => `  - ${formatSourceRef(reference)}`)
        ]
      : [])
  ];
}

function sourceRefToInput(reference: ReviewChangeSourceRef): InputItem | undefined {
  if (reference.kind !== "file") {
    return undefined;
  }

  return {
    kind: "file",
    path: reference.path
  } satisfies FileInput;
}

function sourceRefToContext(reference: ReviewChangeSourceRef, optional: boolean): ContextReference | undefined {
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

function resolveReviewSourceMaterials(source: ReviewChangeSource): {
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
          output: "validation_results",
          optional: true
        },
        {
          node: source.node,
          include: "output",
          output: "residual_risks",
          optional: true
        },
        {
          node: source.node,
          include: "output",
          output: "files_touched",
          optional: true
        },
        {
          node: source.node,
          include: "output",
          output: "implementation_plan",
          optional: true
        }
      ]
    };
  }

  const references: Array<{
    reference: ReviewChangeSourceRef;
    optional: boolean;
  }> = [
    ...(source.diff
      ? [
          {
            reference: source.diff,
            optional: false
          }
        ]
      : []),
    ...(source.summary
      ? [
          {
            reference: source.summary,
            optional: false
          }
        ]
      : []),
    ...(source.validation_results
      ? [
          {
            reference: source.validation_results,
            optional: true
          }
        ]
      : []),
    ...(source.files_touched
      ? [
          {
            reference: source.files_touched,
            optional: true
          }
        ]
      : []),
    ...(source.additional_context ?? []).map((reference) => ({
      reference,
      optional: true
    }))
  ];

  return references.reduce(
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
  const normalized = slugValue(role);

  switch (normalized) {
    case "correctness":
      return "Prioritize logic bugs, incorrect assumptions, behavioral regressions, and broken invariants.";
    case "testing":
      return "Prioritize missing tests, weak validation, flaky coverage, and cases the current checks may miss.";
    case "maintainability":
      return "Prioritize complexity, readability problems, brittle implementation choices, and documentation mismatches.";
    case "security":
      return "Prioritize trust boundaries, input validation, permission issues, and unsafe operational behavior.";
    case "performance":
      return "Prioritize obviously risky inefficiencies, wasteful loops, and scalability regressions.";
    default:
      return `Focus on the risks most relevant to the ${role} review perspective.`;
  }
}

function buildPreparePrompt(config: ReviewChangeWorkflowConfig): string {
  return [
    "Prepare the review packet for this change review.",
    "",
    "Review source:",
    ...formatReviewSource(config.review_source),
    "",
    ...formatCriteria(config.criteria),
    "",
    ...formatScope(config.scope),
    "",
    "Inspect the repository state and the review-source materials.",
    "Write `review-packet.md` to the output directory.",
    "The packet must summarize the target change, likely affected surfaces, current validation state, risk hotspots, and what each reviewer should inspect."
  ].join("\n");
}

function buildReviewerPrompt(role: string, config: ReviewChangeWorkflowConfig): string {
  const slug = slugValue(role);

  return [
    `Review the change from the ${role} perspective.`,
    "",
    roleGuidance(role),
    "",
    ...formatCriteria(config.criteria),
    "",
    ...formatScope(config.scope),
    "",
    "Use the review packet in context and inspect the repository itself as needed.",
    "Focus on high-signal findings only. Prefer concrete bugs, risks, regressions, and missing tests over style nits.",
    "Write these artifacts to the output directory:",
    `- \`findings-${slug}.md\``,
    `- \`findings-${slug}.json\``,
    "",
    "Use this exact JSON schema:",
    '{"summary":"short summary","findings":[{"title":"...","priority":2,"file":"relative/path.ts","start_line":1,"end_line":1,"body":"...","category":"correctness","confidence":0.8}]}',
    "If there are no material findings, return an empty findings array."
  ].join("\n");
}

function buildMergePrompt(config: ReviewChangeWorkflowConfig): string {
  return [
    "Merge the reviewer outputs into one final findings set.",
    "",
    ...formatCriteria(config.criteria),
    "",
    "De-duplicate overlap, preserve the strongest findings, and normalize priority based on actual risk.",
    "Write these artifacts to the output directory:",
    "- `merged-findings.md`",
    "- `merged-findings.json`",
    "",
    "Use the same JSON schema the reviewers used."
  ].join("\n");
}

function buildNormalizePrompt(config: ReviewChangeWorkflowConfig): string {
  return [
    "Review whether the merged findings are ready to publish as the final review result.",
    "",
    ...formatCriteria(config.criteria),
    "",
    "Use the review packet and merged findings in context."
  ].join("\n");
}

function buildNormalizeRubric(config: ReviewChangeWorkflowConfig): string {
  const focusRequirement =
    config.criteria.focus.length > 0
      ? `Pass only if the merged findings cover the important risks in these focus areas when applicable: ${config.criteria.focus.join(", ")}.`
      : "Pass only if the merged findings cover the important risks in the reviewed change.";
  const fileReferenceRequirement = config.criteria.require_file_references
    ? "Fail if concrete findings omit file references where they were reasonably available."
    : "File references are preferred but not mandatory.";

  return [
    focusRequirement,
    "Pass only if findings are non-duplicative, actionable, and severity-calibrated.",
    fileReferenceRequirement,
    "Fail if the result is dominated by low-value style commentary or if major correctness/testing risks are missing."
  ].join(" ");
}

function buildFinalizePrompt(outputs: OutputDefinition[]): string {
  const writesFindingsJson = outputs.some((output) => output.name === "findings");
  const writesFindingsMarkdown = outputs.some((output) => output.name === "findings_markdown");

  return [
    "Publish the final review report and final findings artifacts.",
    "",
    "Use the review packet, merged findings, and normalization result in context.",
    "The final review should be concise, findings-first, and explicit about any residual uncertainty.",
    ...(writesFindingsJson
      ? [
          "If you write `findings.json`, preserve the exact reviewer findings schema used by `merged-findings.json`.",
          "Do not invent a new JSON shape for the final findings artifact."
        ]
      : []),
    ...(writesFindingsMarkdown
      ? [
          "If you write `findings.md`, keep it aligned with the final JSON findings set rather than introducing new findings."
        ]
      : []),
    "",
    "Write these artifacts to the output directory:",
    ...outputs.map((output) => `- \`${output.path}\``)
  ].join("\n");
}

function buildReviewerOutputs(role: string): OutputDefinition[] {
  const slug = slugValue(role);

  return [
    {
      name: `findings_${slug}_markdown`,
      from: "attempt",
      path: `findings-${slug}.md`,
      required: true
    },
    {
      name: `findings_${slug}_json`,
      from: "attempt",
      path: `findings-${slug}.json`,
      required: true
    }
  ];
}

export function buildReviewChangeWorkflow(config: ReviewChangeWorkflowConfig): SequenceNode {
  const shared = sharedNodeBase(config);
  const workflowId = managedId(config.id, "workflow");
  const prepareId = managedId(config.id, "prepare_review_packet");
  const reviewersId = managedId(config.id, "reviewer_panel");
  const mergeId = managedId(config.id, "merge_findings");
  const normalizeId = managedId(config.id, "normalize_findings");
  const sourceMaterials = resolveReviewSourceMaterials(config.review_source);

  const steps: SequenceNode["steps"] = [
    {
      type: "agent",
      id: prepareId,
      label: "Prepare Review Packet",
      ...shared,
      sandbox: "read-only",
      inputs: [
        ...(config.inputs ?? []),
        ...sourceMaterials.inputs
      ],
      context_from: [
        ...(config.context_from ?? []),
        ...sourceMaterials.context_from
      ],
      outputs: [
        {
          name: "review_packet",
          from: "attempt",
          path: "review-packet.md",
          required: true
        }
      ],
      prompt: buildPreparePrompt(config)
    }
  ];

  const reviewerNodes: AgentNode[] = config.orchestration.reviewer_roles.map((role) => {
    const slug = slugValue(role);

    return {
      type: "agent",
      id: managedId(config.id, `reviewer_${slug}`),
      label: `${role} Reviewer`,
      ...shared,
      sandbox: "read-only",
      context_from: [
        {
          node: prepareId,
          include: "output",
          output: "review_packet"
        }
      ],
      outputs: buildReviewerOutputs(role),
      prompt: buildReviewerPrompt(role, config)
    };
  });

  steps.push({
    type: "parallel",
    id: reviewersId,
    label: "Reviewer Panel",
    max_concurrency: config.orchestration.max_parallel_reviewers,
    steps: reviewerNodes
  } satisfies ParallelNode);

  const mergeContext: ContextReference[] = [
    {
      node: prepareId,
      include: "output",
      output: "review_packet"
    }
  ];

  for (const role of config.orchestration.reviewer_roles) {
    const slug = slugValue(role);
    const reviewerId = managedId(config.id, `reviewer_${slug}`);

    mergeContext.push(
      {
        node: reviewerId,
        include: "output",
        output: `findings_${slug}_markdown`
      },
      {
        node: reviewerId,
        include: "output",
        output: `findings_${slug}_json`
      }
    );
  }

  steps.push(
    {
      type: "agent",
      id: mergeId,
      label: "Merge Findings",
      ...shared,
      sandbox: "read-only",
      context_from: mergeContext,
      outputs: [
        {
          name: "merged_findings_markdown",
          from: "attempt",
          path: "merged-findings.md",
          required: true
        },
        {
          name: "merged_findings_json",
          from: "attempt",
          path: "merged-findings.json",
          required: true
        }
      ],
      prompt: buildMergePrompt(config)
    },
    {
      type: "check",
      id: normalizeId,
      label: "Normalize Findings",
      ...shared,
      check_kind: "ai",
      context_from: [
        {
          node: prepareId,
          include: "output",
          output: "review_packet"
        },
        {
          node: mergeId,
          include: "output",
          output: "merged_findings_markdown"
        },
        {
          node: mergeId,
          include: "output",
          output: "merged_findings_json"
        }
      ],
      outputs: [
        {
          name: "normalization_result",
          from: "attempt",
          path: "result.json",
          required: true
        }
      ],
      prompt: buildNormalizePrompt(config),
      rubric: buildNormalizeRubric(config)
    }
  );

  let finalOutputs: OutputDefinition[] = config.outputs && config.outputs.length > 0 ? config.outputs : [];

  if (config.delivery.write_review_report) {
    finalOutputs = appendOutput(finalOutputs, {
      name: "review_report",
      from: "attempt",
      path: "review.md",
      required: true
    });
  }

  if (config.delivery.write_findings_json) {
    finalOutputs = appendOutput(finalOutputs, {
      name: "findings",
      from: "attempt",
      path: "findings.json",
      required: true
    });
  }

  if (config.delivery.write_findings_markdown) {
    finalOutputs = appendOutput(finalOutputs, {
      name: "findings_markdown",
      from: "attempt",
      path: "findings.md",
      required: false
    });
  }

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
        node: mergeId,
        include: "output",
        output: "merged_findings_markdown"
      },
      {
        node: mergeId,
        include: "output",
        output: "merged_findings_json"
      },
      {
        node: normalizeId,
        include: "result"
      }
    ],
    outputs: finalOutputs,
    prompt: buildFinalizePrompt(finalOutputs)
  });

  return {
    type: "sequence",
    id: workflowId,
    label: config.label ? `${config.label} Workflow` : "Review Change Workflow",
    steps
  };
}

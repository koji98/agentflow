import type {
  AgentNode,
  BaseExecutableNode,
  CheckNode,
  ContextReference,
  FileInput,
  InputItem,
  OutputDefinition,
  RepeatNode,
  SequenceNode
} from "../graph/authored.js";

export interface ExecuteSpecScope {
  paths?: string[];
  areas?: string[];
}

export interface ExecuteSpecManagedNodeSource {
  kind: "managed_node";
  node: string;
}

export interface ExecuteSpecFileSourceRef {
  kind: "file";
  path: string;
}

export interface ExecuteSpecManagedOutputSourceRef {
  kind: "managed_output";
  node: string;
  output: string;
}

export type ExecuteSpecSourceRef = ExecuteSpecFileSourceRef | ExecuteSpecManagedOutputSourceRef;

export interface ExecuteSpecArtifactBundleSource {
  kind: "artifact_bundle";
  design_spec: ExecuteSpecSourceRef;
  file_plan?: ExecuteSpecSourceRef;
  acceptance_criteria?: ExecuteSpecSourceRef;
  risks?: ExecuteSpecSourceRef;
  open_questions?: ExecuteSpecSourceRef;
}

export type ExecuteSpecSource = ExecuteSpecManagedNodeSource | ExecuteSpecArtifactBundleSource;

export interface ExecuteSpecExecutionPolicy {
  max_repair_rounds: number;
}

export interface ExecuteSpecValidation {
  commands: string[];
  required: boolean;
}

export interface ExecuteSpecImplementationResearch {
  allow_official_docs_fallback: boolean;
  allow_domains?: string[];
  max_external_lookup_tasks: number;
}

export interface ExecuteSpecDelivery {
  write_change_summary: boolean;
  write_validation_results: boolean;
  write_residual_risks: boolean;
  write_files_touched: boolean;
  write_implementation_plan: boolean;
}

export interface ExecuteSpecWorkflowConfig extends BaseExecutableNode {
  objective?: string;
  spec_source: ExecuteSpecSource;
  scope: ExecuteSpecScope;
  execution_policy: ExecuteSpecExecutionPolicy;
  validation: ExecuteSpecValidation;
  implementation_research: ExecuteSpecImplementationResearch;
  delivery: ExecuteSpecDelivery;
}

function managedId(rootId: string, suffix: string): string {
  return `${rootId}__managed__execute_spec__${suffix}`;
}

function sharedNodeBase(config: ExecuteSpecWorkflowConfig): Pick<
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

function formatScope(scope: ExecuteSpecScope): string[] {
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
    : ["Scope: infer the most relevant repository surfaces from the spec and the objective."];
}

function formatValidation(config: ExecuteSpecWorkflowConfig): string[] {
  return [
    `- Required gate: ${config.validation.required ? "yes" : "no"}`,
    ...config.validation.commands.map((command, index) => `- Command ${index + 1}: ${command}`)
  ];
}

function formatImplementationResearch(policy: ExecuteSpecImplementationResearch): string[] {
  const lines = [
    `- Allow official-doc fallback: ${policy.allow_official_docs_fallback ? "yes" : "no"}`,
    `- Max external lookup tasks: ${policy.max_external_lookup_tasks}`
  ];

  if (policy.allow_domains && policy.allow_domains.length > 0) {
    lines.push(`- Allowed domains: ${policy.allow_domains.join(", ")}`);
  }

  return lines;
}

function formatSourceRef(reference: ExecuteSpecSourceRef): string {
  return reference.kind === "file"
    ? `file:${reference.path}`
    : `managed_output:${reference.node}.${reference.output}`;
}

function formatSpecSource(source: ExecuteSpecSource): string[] {
  if (source.kind === "managed_node") {
    return [
      `- Source kind: managed_node`,
      `- Source node: ${source.node}`,
      "- Expected outputs: design_spec, file_plan, acceptance_criteria, risks, open_questions"
    ];
  }

  return [
    "- Source kind: artifact_bundle",
    `- design_spec: ${formatSourceRef(source.design_spec)}`,
    ...(source.file_plan ? [`- file_plan: ${formatSourceRef(source.file_plan)}`] : []),
    ...(source.acceptance_criteria
      ? [`- acceptance_criteria: ${formatSourceRef(source.acceptance_criteria)}`]
      : []),
    ...(source.risks ? [`- risks: ${formatSourceRef(source.risks)}`] : []),
    ...(source.open_questions ? [`- open_questions: ${formatSourceRef(source.open_questions)}`] : [])
  ];
}

function sourceRefToInput(reference: ExecuteSpecSourceRef): InputItem | undefined {
  if (reference.kind !== "file") {
    return undefined;
  }

  return {
    kind: "file",
    path: reference.path
  } satisfies FileInput;
}

function sourceRefToContext(reference: ExecuteSpecSourceRef, optional: boolean): ContextReference | undefined {
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

function resolveSpecSourceMaterials(source: ExecuteSpecSource): {
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
          output: "design_spec"
        },
        {
          node: source.node,
          include: "output",
          output: "file_plan",
          optional: true
        },
        {
          node: source.node,
          include: "output",
          output: "acceptance_criteria",
          optional: true
        },
        {
          node: source.node,
          include: "output",
          output: "risks",
          optional: true
        },
        {
          node: source.node,
          include: "output",
          output: "open_questions",
          optional: true
        }
      ]
    };
  }

  const references: Array<{
    reference: ExecuteSpecSourceRef;
    optional: boolean;
  }> = [
    {
      reference: source.design_spec,
      optional: false
    },
    ...(source.file_plan
      ? [
          {
            reference: source.file_plan,
            optional: true
          }
        ]
      : []),
    ...(source.acceptance_criteria
      ? [
          {
            reference: source.acceptance_criteria,
            optional: true
          }
        ]
      : []),
    ...(source.risks
      ? [
          {
            reference: source.risks,
            optional: true
          }
        ]
      : []),
    ...(source.open_questions
      ? [
          {
            reference: source.open_questions,
            optional: true
          }
        ]
      : [])
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

function quoteForSingleQuotedShell(value: string): string {
  return value.replace(/'/g, `'\"'\"'`);
}

function buildValidationGateScript(commands: string[]): string {
  const lines = [
    "set -u",
    "failures=0",
    "printf '%s\\n' 'Agentflow execute_spec validation gate starting.'"
  ];

  commands.forEach((command, index) => {
    const label = `validation_${String(index + 1).padStart(2, "0")}`;
    lines.push(`printf '%s\\n' '>> ${label}: ${quoteForSingleQuotedShell(command)}'`);
    lines.push(`if ! sh -lc '${quoteForSingleQuotedShell(command)}'; then`);
    lines.push(`  printf '%s\\n' '!! ${label} failed'`);
    lines.push("  failures=1");
    lines.push("fi");
  });

  lines.push("exit \"$failures\"");
  return lines.join("\n");
}

function buildIngestSpecPrompt(config: ExecuteSpecWorkflowConfig): string {
  return [
    "Resolve the structured spec source into one execution packet.",
    "",
    `Objective: ${config.objective ?? "Implement the supplied spec faithfully."}`,
    "",
    "Spec source:",
    ...formatSpecSource(config.spec_source),
    "",
    ...formatScope(config.scope),
    "",
    "Write `spec-packet.md` to the output directory.",
    "The packet must consolidate the executable requirements, intended behavior, affected surfaces, acceptance criteria, risks, open questions, and any missing supporting artifacts.",
    "Clearly separate explicit requirements from repo-grounded inference."
  ].join("\n");
}

function buildSpecReadinessPrompt(config: ExecuteSpecWorkflowConfig): string {
  return [
    "Review whether the spec packet is ready to execute without inventing new design decisions.",
    "",
    `Objective: ${config.objective ?? "Implement the supplied spec faithfully."}`,
    "",
    "Use the spec packet in context."
  ].join("\n");
}

function buildSpecReadinessRubric(config: ExecuteSpecWorkflowConfig): string {
  return [
    "Pass only if the spec packet defines the target behavior clearly enough to implement without redesigning the system.",
    "Pass if missing supporting artifacts can be safely compensated for through repo conventions and the design intent remains clear.",
    `Consider these validation expectations: ${config.validation.commands.join("; ")}.`,
    "Fail if essential behavior is ambiguous, acceptance criteria are not testable enough, the affected surface is too unclear, or unresolved questions would force architectural guessing."
  ].join(" ");
}

function buildInspectRepoPrompt(config: ExecuteSpecWorkflowConfig): string {
  return [
    "Inspect the repository before implementation and extract the execution context.",
    "",
    `Objective: ${config.objective ?? "Implement the supplied spec faithfully."}`,
    "",
    ...formatScope(config.scope),
    "",
    "Use the spec packet and spec readiness result in context.",
    "Focus on existing modules, conventions, relevant files, likely impact areas, tests, and operational constraints.",
    "Write `execution-context.md` to the output directory."
  ].join("\n");
}

function buildImplementationResearchPrompt(config: ExecuteSpecWorkflowConfig): string {
  return [
    "Perform narrow implementation research only if the repo and spec leave critical implementation details unresolved.",
    "",
    `Objective: ${config.objective ?? "Implement the supplied spec faithfully."}`,
    "",
    ...formatImplementationResearch(config.implementation_research),
    "",
    "Prefer official documentation and stay within the allowed domains when they are declared.",
    "Do not redesign the system or broaden the scope.",
    "If no external lookup is needed, write a short note explaining that repo and spec context were sufficient.",
    "Write `implementation-findings.md` to the output directory."
  ].join("\n");
}

function buildPlanPrompt(config: ExecuteSpecWorkflowConfig): string {
  return [
    "Turn the spec packet into a concrete implementation plan.",
    "",
    `Objective: ${config.objective ?? "Implement the supplied spec faithfully."}`,
    "",
    ...formatValidation(config),
    "",
    ...formatScope(config.scope),
    "",
    "Use the spec packet, the spec readiness result, the execution context, and any implementation findings in context.",
    "Because this workflow is single-writer, produce an ordered implementation plan rather than parallel work packets.",
    "Write `implementation-plan.md` to the output directory."
  ].join("\n");
}

function buildImplementPrompt(config: ExecuteSpecWorkflowConfig): string {
  return [
    "Implement the spec in the repository.",
    "",
    `Objective: ${config.objective ?? "Implement the supplied spec faithfully."}`,
    "",
    ...formatValidation(config),
    "",
    "Use the spec packet, spec readiness result, execution context, implementation findings, and implementation plan in context.",
    "Follow repository conventions. Do not redesign the system. Keep changes within the declared scope unless the spec packet proves a small extension is necessary.",
    "Write `implementation-notes.md` to the output directory."
  ].join("\n");
}

function buildStabilizePrompt(config: ExecuteSpecWorkflowConfig): string {
  return [
    "Stabilize the current implementation against the spec and validation contract.",
    "",
    `Objective: ${config.objective ?? "Implement the supplied spec faithfully."}`,
    "",
    ...formatValidation(config),
    "",
    "Use the current workspace, the spec packet, the execution context, the implementation plan, and prior implementation notes in context.",
    "Run or inspect the validation commands yourself when useful, then make only the smallest changes needed to satisfy the spec and the validation gate.",
    "Write `stabilization-notes.md` to the output directory."
  ].join("\n");
}

function buildFinalizePrompt(config: ExecuteSpecWorkflowConfig, outputs: OutputDefinition[]): string {
  const artifactLines = outputs.map((output) => `- \`${output.path}\``);

  return [
    "Publish the final implementation handoff.",
    "",
    `Objective: ${config.objective ?? "Implement the supplied spec faithfully."}`,
    "",
    "Use the spec packet, spec readiness result, execution context, implementation plan, implementation notes, latest passed stabilization notes, and latest passed validation result in context.",
    "Summarize what changed, what validation proved, and what risks or follow-up work remain.",
    "",
    "Write these artifacts to the output directory:",
    ...artifactLines
  ].join("\n");
}

export function buildExecuteSpecWorkflow(config: ExecuteSpecWorkflowConfig): SequenceNode {
  const shared = sharedNodeBase(config);
  const workflowId = managedId(config.id, "workflow");

  const ingestId = managedId(config.id, "ingest_spec");
  const readinessId = managedId(config.id, "assess_spec_readiness");
  const inspectId = managedId(config.id, "inspect_repo_for_execution");
  const researchId = managedId(config.id, "targeted_implementation_research");
  const planId = managedId(config.id, "plan_execution");
  const implementId = managedId(config.id, "implement_spec");
  const stabilizationLoopId = managedId(config.id, "stabilization_loop");
  const stabilizationBodyId = managedId(config.id, "stabilization_body");
  const stabilizeId = managedId(config.id, "stabilize_implementation");
  const validationId = managedId(config.id, "validation_gate");

  const sourceMaterials = resolveSpecSourceMaterials(config.spec_source);

  const steps: SequenceNode["steps"] = [
    {
      type: "agent",
      id: ingestId,
      label: "Ingest Spec",
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
          name: "spec_packet",
          from: "attempt",
          path: "spec-packet.md",
          required: true
        }
      ],
      prompt: buildIngestSpecPrompt(config)
    },
    {
      type: "check",
      id: readinessId,
      label: "Assess Spec Readiness",
      ...shared,
      check_kind: "ai",
      context_from: [
        {
          node: ingestId,
          include: "output",
          output: "spec_packet"
        }
      ],
      outputs: [
        {
          name: "spec_readiness",
          from: "attempt",
          path: "result.json",
          required: true
        }
      ],
      prompt: buildSpecReadinessPrompt(config),
      rubric: buildSpecReadinessRubric(config)
    },
    {
      type: "agent",
      id: inspectId,
      label: "Inspect Repo For Execution",
      ...shared,
      sandbox: "read-only",
      context_from: [
        {
          node: ingestId,
          include: "output",
          output: "spec_packet"
        },
        {
          node: readinessId,
          include: "result"
        }
      ],
      outputs: [
        {
          name: "execution_context",
          from: "attempt",
          path: "execution-context.md",
          required: true
        }
      ],
      prompt: buildInspectRepoPrompt(config)
    }
  ];

  if (
    config.implementation_research.allow_official_docs_fallback &&
    config.implementation_research.max_external_lookup_tasks > 0
  ) {
    steps.push({
      type: "agent",
      id: researchId,
      label: "Targeted Implementation Research",
      ...shared,
      sandbox: "read-only",
      context_from: [
        {
          node: ingestId,
          include: "output",
          output: "spec_packet"
        },
        {
          node: readinessId,
          include: "result"
        },
        {
          node: inspectId,
          include: "output",
          output: "execution_context"
        }
      ],
      outputs: [
        {
          name: "implementation_findings",
          from: "attempt",
          path: "implementation-findings.md",
          required: false
        }
      ],
      prompt: buildImplementationResearchPrompt(config)
    });
  }

  steps.push(
    {
      type: "agent",
      id: planId,
      label: "Plan Execution",
      ...shared,
      sandbox: "read-only",
      context_from: [
        {
          node: ingestId,
          include: "output",
          output: "spec_packet"
        },
        {
          node: readinessId,
          include: "result"
        },
        {
          node: inspectId,
          include: "output",
          output: "execution_context"
        },
        ...(config.implementation_research.allow_official_docs_fallback &&
        config.implementation_research.max_external_lookup_tasks > 0
          ? [
              {
                node: researchId,
                include: "output",
                output: "implementation_findings",
                optional: true
              } satisfies ContextReference
            ]
          : [])
      ],
      outputs: [
        {
          name: "implementation_plan",
          from: "attempt",
          path: "implementation-plan.md",
          required: true
        }
      ],
      prompt: buildPlanPrompt(config)
    },
    {
      type: "agent",
      id: implementId,
      label: "Implement Spec",
      ...shared,
      sandbox: "workspace-write",
      context_from: [
        {
          node: ingestId,
          include: "output",
          output: "spec_packet"
        },
        {
          node: readinessId,
          include: "result"
        },
        {
          node: inspectId,
          include: "output",
          output: "execution_context"
        },
        {
          node: planId,
          include: "output",
          output: "implementation_plan"
        },
        ...(config.implementation_research.allow_official_docs_fallback &&
        config.implementation_research.max_external_lookup_tasks > 0
          ? [
              {
                node: researchId,
                include: "output",
                output: "implementation_findings",
                optional: true
              } satisfies ContextReference
            ]
          : [])
      ],
      outputs: [
        {
          name: "implementation_notes",
          from: "attempt",
          path: "implementation-notes.md",
          required: true
        }
      ],
      prompt: buildImplementPrompt(config)
    }
  );

  const stabilizationBody: SequenceNode = {
    type: "sequence",
    id: stabilizationBodyId,
    label: "Stabilization Body",
    steps: [
      {
        type: "agent",
        id: stabilizeId,
        label: "Stabilize Implementation",
        ...shared,
        sandbox: "workspace-write",
        context_from: [
          {
            node: ingestId,
            include: "output",
            output: "spec_packet"
          },
          {
            node: readinessId,
            include: "result"
          },
          {
            node: inspectId,
            include: "output",
            output: "execution_context"
          },
          {
            node: planId,
            include: "output",
            output: "implementation_plan"
          },
          {
            node: implementId,
            include: "output",
            output: "implementation_notes"
          },
          ...(config.implementation_research.allow_official_docs_fallback &&
          config.implementation_research.max_external_lookup_tasks > 0
            ? [
                {
                  node: researchId,
                  include: "output",
                  output: "implementation_findings",
                  optional: true
                } satisfies ContextReference
              ]
            : [])
        ],
        outputs: [
          {
            name: "stabilization_notes",
            from: "attempt",
            path: "stabilization-notes.md",
            required: true
          }
        ],
        prompt: buildStabilizePrompt(config)
      },
      {
        type: "check",
        id: validationId,
        label: "Validation Gate",
        ...shared,
        check_kind: "deterministic",
        command: "sh",
        args: [
          "-lc",
          buildValidationGateScript(config.validation.commands)
        ],
        pass_if: {
          exit_code: 0
        }
      }
    ]
  };

  const stabilizationLoop: RepeatNode = {
    type: "repeat",
    id: stabilizationLoopId,
    label: "Repair Loop",
    max_attempts: config.execution_policy.max_repair_rounds,
    body: stabilizationBody,
    until: {
      node: validationId
    }
  };

  const finalOutputs: OutputDefinition[] = config.outputs && config.outputs.length > 0 ? config.outputs : [];

  let publishedOutputs = finalOutputs;

  if (config.delivery.write_validation_results) {
    publishedOutputs = appendOutput(publishedOutputs, {
      name: "validation_results",
      from: "attempt",
      path: "validation-results.md",
      required: false
    });
  }

  if (config.delivery.write_residual_risks) {
    publishedOutputs = appendOutput(publishedOutputs, {
      name: "residual_risks",
      from: "attempt",
      path: "residual-risks.md",
      required: false
    });
  }

  if (config.delivery.write_files_touched) {
    publishedOutputs = appendOutput(publishedOutputs, {
      name: "files_touched",
      from: "attempt",
      path: "files-touched.md",
      required: false
    });
  }

  if (config.delivery.write_implementation_plan) {
    publishedOutputs = appendOutput(publishedOutputs, {
      name: "implementation_plan",
      from: "attempt",
      path: "implementation-plan.md",
      required: false
    });
  }

  if (config.delivery.write_change_summary) {
    publishedOutputs = appendOutput(publishedOutputs, {
      name: "change_summary",
      from: "attempt",
      path: "change-summary.md",
      required: true
    });
  }

  steps.push(
    stabilizationLoop,
    {
      type: "agent",
      id: config.id,
      ...(config.label ? { label: config.label } : { label: "Publish Implementation Handoff" }),
      ...shared,
      sandbox: "read-only",
      context_from: [
        {
          node: ingestId,
          include: "output",
          output: "spec_packet"
        },
        {
          node: readinessId,
          include: "result"
        },
        {
          node: inspectId,
          include: "output",
          output: "execution_context"
        },
        {
          node: planId,
          include: "output",
          output: "implementation_plan"
        },
        {
          node: implementId,
          include: "output",
          output: "implementation_notes"
        },
        {
          node: stabilizeId,
          include: "output",
          output: "stabilization_notes",
          iteration: "latest_passed"
        },
        {
          node: validationId,
          include: "result",
          iteration: "latest_passed"
        }
      ],
      outputs: publishedOutputs,
      prompt: buildFinalizePrompt(config, publishedOutputs)
    }
  );

  return {
    type: "sequence",
    id: workflowId,
    label: config.label ? `${config.label} Workflow` : "Execute Spec Workflow",
    steps
  };
}

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
import {
  appendOutput,
  attemptOutput,
  body,
  listOrFallback,
  managedId,
  renderPrompt,
  section,
  sharedNodeBase,
  type ManagedWorkflowRuntime,
  workflowBriefOutput,
  workflowEventsOutput,
  workflowPlanJsonOutput,
  workflowPlanMarkdownOutput,
  workflowStatusOutput
} from "./foundation.js";

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
  direction_proposal?: ExecuteSpecSourceRef;
  tradeoff_matrix?: ExecuteSpecSourceRef;
  decision_log?: ExecuteSpecSourceRef;
  implementation_readiness?: ExecuteSpecSourceRef;
}

export type ExecuteSpecSource = ExecuteSpecManagedNodeSource | ExecuteSpecArtifactBundleSource;

export interface ExecuteSpecBrief {
  objective?: string;
  scope?: ExecuteSpecScope;
}

export interface ExecuteSpecContextPolicy {
  allow_official_docs_fallback?: boolean;
  allow_domains?: string[];
}

export interface ExecuteSpecApprovalPolicy {
  require_execution_plan_approval?: boolean;
}

export interface ExecuteSpecStrategy {
  single_writer?: boolean;
  allow_readonly_recon?: boolean;
  max_repair_cycles?: number;
}

export interface ExecuteSpecValidation {
  commands: string[];
  required?: boolean;
}

export interface ExecuteSpecDelivery {
  write_handoff?: boolean;
  write_validation_ledger?: boolean;
  write_repair_log?: boolean;
}

export interface ExecuteSpecWorkflowConfig extends BaseExecutableNode {
  brief: ExecuteSpecBrief;
  spec_source: ExecuteSpecSource;
  context_policy: ExecuteSpecContextPolicy;
  approval_policy: ExecuteSpecApprovalPolicy;
  strategy: ExecuteSpecStrategy;
  validation: ExecuteSpecValidation;
  delivery: ExecuteSpecDelivery;
  runtime?: ManagedWorkflowRuntime;
}

function workflowNodeId(rootId: string, suffix: string): string {
  return managedId(rootId, "execute_spec", suffix);
}

function formatScope(scope: ExecuteSpecScope | undefined): string[] {
  if (!scope) {
    return ["Scope: infer the most relevant repository surfaces from the spec and execution goal."];
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

  return lines.length > 0 ? lines : ["Scope: infer the most relevant repository surfaces from the spec and execution goal."];
}

function formatBrief(brief: ExecuteSpecBrief): string[] {
  return [
    `Objective: ${brief.objective ?? "Implement the supplied spec faithfully."}`,
    ...formatScope(brief.scope)
  ];
}

function formatContextPolicy(policy: ExecuteSpecContextPolicy): string[] {
  return [
    `- Allow official-doc fallback: ${policy.allow_official_docs_fallback ? "yes" : "no"}`,
    ...(policy.allow_domains && policy.allow_domains.length > 0
      ? [`- Allowed domains: ${policy.allow_domains.join(", ")}`]
      : [])
  ];
}

function formatStrategy(strategy: ExecuteSpecStrategy): string[] {
  return [
    `- Single writer: ${strategy.single_writer === false ? "no (requested)" : "yes"}`,
    `- Allow read-only reconnaissance: ${strategy.allow_readonly_recon ? "yes" : "no"}`,
    `- Max repair cycles: ${strategy.max_repair_cycles ?? 2}`
  ];
}

function formatValidation(validation: ExecuteSpecValidation): string[] {
  return [
    `- Validation required: ${validation.required === false ? "no" : "yes"}`,
    ...validation.commands.map((command, index) => `- Command ${index + 1}: ${command}`)
  ];
}

function formatSourceRef(reference: ExecuteSpecSourceRef): string {
  return reference.kind === "file"
    ? `file:${reference.path}`
    : `managed_output:${reference.node}.${reference.output}`;
}

function formatSpecSource(source: ExecuteSpecSource): string[] {
  if (source.kind === "managed_node") {
    return [
      "- Source kind: managed_node",
      `- Source node: ${source.node}`,
      "- Expected outputs when available: design_spec, direction_proposal, tradeoff_matrix, decision_log, implementation_readiness"
    ];
  }

  return [
    "- Source kind: artifact_bundle",
    `- design_spec: ${formatSourceRef(source.design_spec)}`,
    ...(source.direction_proposal ? [`- direction_proposal: ${formatSourceRef(source.direction_proposal)}`] : []),
    ...(source.tradeoff_matrix ? [`- tradeoff_matrix: ${formatSourceRef(source.tradeoff_matrix)}`] : []),
    ...(source.decision_log ? [`- decision_log: ${formatSourceRef(source.decision_log)}`] : []),
    ...(source.implementation_readiness
      ? [`- implementation_readiness: ${formatSourceRef(source.implementation_readiness)}`]
      : [])
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
          output: "direction_proposal",
          optional: true
        },
        {
          node: source.node,
          include: "output",
          output: "tradeoff_matrix",
          optional: true
        },
        {
          node: source.node,
          include: "output",
          output: "decision_log",
          optional: true
        },
        {
          node: source.node,
          include: "output",
          output: "implementation_readiness",
          optional: true
        }
      ]
    };
  }

  const refs: Array<{ reference: ExecuteSpecSourceRef; optional: boolean }> = [
    {
      reference: source.design_spec,
      optional: false
    },
    ...(source.direction_proposal ? [{ reference: source.direction_proposal, optional: true }] : []),
    ...(source.tradeoff_matrix ? [{ reference: source.tradeoff_matrix, optional: true }] : []),
    ...(source.decision_log ? [{ reference: source.decision_log, optional: true }] : []),
    ...(source.implementation_readiness ? [{ reference: source.implementation_readiness, optional: true }] : [])
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

function buildIngestPrompt(config: ExecuteSpecWorkflowConfig): string {
  return renderPrompt([
    body("Ingest the spec source and normalize it into one execution packet."),
    section("Objective", formatBrief(config.brief)),
    section("Current Context", [
      "Resolve the spec source artifacts and separate explicit requirements from repo-grounded inference."
    ]),
    section("Allowed Sources and Tools", [
      ...formatContextPolicy(config.context_policy),
      "",
      ...formatSpecSource(config.spec_source)
    ]),
    section("Output Contract", [
      "Write `spec-packet.json` and `workflow-brief.md` to the output directory."
    ]),
    section("Quality Bar", [
      "The packet must consolidate behavior, affected surfaces, risks, open questions, and validation expectations into an execution-ready source of truth."
    ])
  ]);
}

function buildReadinessPrompt(config: ExecuteSpecWorkflowConfig): string {
  return renderPrompt([
    body("Review whether the spec packet is ready to execute without inventing new design decisions."),
    section("Objective", formatBrief(config.brief)),
    section("Current Context", [
      "Use the spec packet in context."
    ]),
    section("Quality Bar", [
      "Pass only when the intended behavior and affected surfaces are concrete enough to implement safely."
    ])
  ]);
}

function buildReadinessRubric(config: ExecuteSpecWorkflowConfig): string {
  return [
    "Pass only if the spec packet defines the target behavior clearly enough to implement without redesigning the system.",
    `Consider these validation expectations: ${config.validation.commands.join("; ")}.`,
    "Fail if essential behavior is ambiguous, acceptance criteria are too weak, or unresolved questions would force architectural guessing."
  ].join(" ");
}

function buildReconPrompt(config: ExecuteSpecWorkflowConfig): string {
  return renderPrompt([
    body("Run read-only reconnaissance on the repository before mutating code."),
    section("Objective", formatBrief(config.brief)),
    section("Current Context", [
      "Use the spec packet and readiness result in context."
    ]),
    section("Quality Bar", [
      "Identify likely impact areas, file boundaries, conventions, tests, and operational constraints."
    ]),
    section("Output Contract", [
      "Write `recon-notes.md` to the output directory."
    ])
  ]);
}

function buildPlanPrompt(config: ExecuteSpecWorkflowConfig): string {
  return renderPrompt([
    body("Turn the execution packet into a concrete implementation plan."),
    section("Objective", formatBrief(config.brief)),
    section("Current Context", [
      "Use the spec packet, readiness result, and any reconnaissance notes in context."
    ]),
    section("Allowed Sources and Tools", formatContextPolicy(config.context_policy)),
    section("Quality Bar", [
      "Because this workflow is single-writer, produce an ordered implementation plan rather than parallel work packets.",
      "Make mutation boundaries, validation plan, and file ownership explicit."
    ]),
    section("Output Contract", [
      "Write `execution-plan.md`, `file-plan.md`, `mutation-boundary.md`, `validation-plan.md`, `workflow-plan.md`, and `workflow-plan.json` to the output directory.",
      "Use this JSON schema exactly for `workflow-plan.json`:",
      '{"ordered_steps":["..."],"mutation_boundary":["..."],"validation_plan":["..."],"known_risks":["..."]}'
    ])
  ]);
}

function buildPlanCheckpointPrompt(): string {
  return renderPrompt([
    body("Review the execution plan before any mutating implementation begins."),
    section("Quality Bar", [
      "Pass when the execution plan, file plan, mutation boundary, and validation plan are concrete enough to implement safely.",
      "Deny when mutation scope or validation ownership still needs clarification."
    ]),
    section("Blocker and Escalation Rules", [
      "When denying, explain the concrete correction needed before code changes start."
    ])
  ]);
}

function buildImplementPrompt(config: ExecuteSpecWorkflowConfig): string {
  return renderPrompt([
    body("Implement the spec in the repository."),
    section("Objective", formatBrief(config.brief)),
    section("Current Context", [
      "Use the spec packet, execution plan, file plan, and mutation boundary in context."
    ]),
    section("Quality Bar", [
      "Follow repository conventions and keep changes within the declared mutation boundary unless the packet proves a small extension is necessary.",
      "Do not redesign the system during execution."
    ]),
    section("Output Contract", [
      "Write `implementation-notes.md` to the output directory."
    ]),
    section("Allowed Sources and Tools", [
      ...formatContextPolicy(config.context_policy),
      "",
      ...formatValidation(config.validation)
    ])
  ]);
}

function buildRepairPrompt(config: ExecuteSpecWorkflowConfig): string {
  return renderPrompt([
    body("Stabilize the current implementation against the concrete validation failures."),
    section("Objective", formatBrief(config.brief)),
    section("Current Context", [
      "Use the spec packet, execution plan, mutation boundary, implementation notes, and latest failed validation result in context."
    ]),
    section("Quality Bar", [
      "Make only the smallest changes needed to satisfy the spec and the validation gate.",
      "Do not broaden the scope during repair."
    ]),
    section("Output Contract", [
      "Write `repair-notes.md` to the output directory."
    ]),
    section("Allowed Sources and Tools", formatValidation(config.validation))
  ]);
}

function buildFinalizePrompt(config: ExecuteSpecWorkflowConfig, outputs: OutputDefinition[]): string {
  return renderPrompt([
    body("Publish the final execution handoff and workflow status artifacts."),
    section("Objective", formatBrief(config.brief)),
    section("Current Context", [
      "Use the spec packet, latest plan artifacts, implementation notes, latest passed validation result, and latest passed repair notes in context."
    ]),
    section("Output Contract", outputs.map((output) => `- \`${output.path}\``)),
    section("Quality Bar", [
      "Summarize what changed, what validation proved, and what residual risks remain without inventing new design decisions."
    ])
  ]);
}

export function buildExecuteSpecWorkflow(config: ExecuteSpecWorkflowConfig): SequenceNode {
  const shared = sharedNodeBase(config);
  const workflowId = workflowNodeId(config.id, "workflow");

  const ingestId = workflowNodeId(config.id, "ingest_spec");
  const readinessId = workflowNodeId(config.id, "assess_spec_readiness");
  const reconId = workflowNodeId(config.id, "read_only_recon");
  const planId = workflowNodeId(config.id, "plan_execution");
  const planCheckpointId = workflowNodeId(config.id, "approve_execution_plan");
  const planLoopId = workflowNodeId(config.id, "plan_approval_loop");
  const planBodyId = workflowNodeId(config.id, "plan_approval_body");
  const implementId = workflowNodeId(config.id, "implement_spec");
  const repairLoopId = workflowNodeId(config.id, "repair_loop");
  const repairBodyId = workflowNodeId(config.id, "repair_body");
  const repairId = workflowNodeId(config.id, "repair_implementation");
  const validationId = workflowNodeId(config.id, "validation_gate");

  const sourceMaterials = resolveSpecSourceMaterials(config.spec_source);

  const steps: SequenceNode["steps"] = [
    {
      type: "agent",
      id: ingestId,
      label: "Ingest Spec",
      ...shared,
      inputs: [...(config.inputs ?? []), ...sourceMaterials.inputs],
      context_from: [...(config.context_from ?? []), ...sourceMaterials.context_from],
      outputs: [
        attemptOutput("spec_packet", "spec-packet.json", true),
        workflowBriefOutput()
      ],
      prompt: buildIngestPrompt(config)
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
        attemptOutput("spec_readiness", "result.json", true)
      ],
      prompt: buildReadinessPrompt(config),
      rubric: buildReadinessRubric(config)
    }
  ];

  if (config.strategy.allow_readonly_recon) {
    steps.push({
      type: "agent",
      id: reconId,
      label: "Read-only Reconnaissance",
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
        attemptOutput("recon_notes", "recon-notes.md", true)
      ],
      prompt: buildReconPrompt(config)
    });
  }

  const planContext: ContextReference[] = [
    {
      node: ingestId,
      include: "output",
      output: "spec_packet"
    },
    {
      node: readinessId,
      include: "result"
    },
    ...(config.strategy.allow_readonly_recon
      ? [
          {
            node: reconId,
            include: "output",
            output: "recon_notes"
          } satisfies ContextReference
        ]
      : [])
  ];

  if (config.approval_policy.require_execution_plan_approval) {
    steps.push({
      type: "repeat",
      id: planLoopId,
      label: "Execution Plan Approval Loop",
      max_attempts: 3,
      body: {
        type: "sequence",
        id: planBodyId,
        label: "Execution Plan Approval Body",
        steps: [
          {
            type: "agent",
            id: planId,
            label: "Plan Execution",
            ...shared,
            sandbox: "read-only",
            context_from: [
              ...planContext,
              {
                node: planCheckpointId,
                include: "output",
                output: "operator_feedback",
                iteration: "latest_failed",
                optional: true
              }
            ],
            outputs: [
              attemptOutput("execution_plan", "execution-plan.md", true),
              attemptOutput("file_plan", "file-plan.md", true),
              attemptOutput("mutation_boundary", "mutation-boundary.md", true),
              attemptOutput("validation_plan", "validation-plan.md", true),
              workflowPlanMarkdownOutput(),
              workflowPlanJsonOutput()
            ],
            prompt: buildPlanPrompt(config)
          },
          {
            type: "checkpoint",
            id: planCheckpointId,
            label: "Approve Execution Plan",
            ...shared,
            context_from: [
              {
                node: planId,
                include: "output",
                output: "file_plan"
              },
              {
                node: planId,
                include: "output",
                output: "validation_plan"
              }
            ],
            review_from: {
              node: planId,
              include: "output",
              output: "execution_plan"
            },
            prompt: buildPlanCheckpointPrompt()
          }
        ]
      },
      until: {
        node: planCheckpointId
      }
    } satisfies RepeatNode);
  } else {
    steps.push({
      type: "agent",
      id: planId,
      label: "Plan Execution",
      ...shared,
      sandbox: "read-only",
      context_from: planContext,
      outputs: [
        attemptOutput("execution_plan", "execution-plan.md", true),
        attemptOutput("file_plan", "file-plan.md", true),
        attemptOutput("mutation_boundary", "mutation-boundary.md", true),
        attemptOutput("validation_plan", "validation-plan.md", true),
        workflowPlanMarkdownOutput(),
        workflowPlanJsonOutput()
      ],
      prompt: buildPlanPrompt(config)
    });
  }

  const latestPlanRefs: ContextReference[] = [
    {
      node: planId,
      include: "output",
      output: "execution_plan",
      ...(config.approval_policy.require_execution_plan_approval ? { iteration: "latest_passed" as const } : {})
    },
    {
      node: planId,
      include: "output",
      output: "file_plan",
      ...(config.approval_policy.require_execution_plan_approval ? { iteration: "latest_passed" as const } : {})
    },
    {
      node: planId,
      include: "output",
      output: "mutation_boundary",
      ...(config.approval_policy.require_execution_plan_approval ? { iteration: "latest_passed" as const } : {})
    },
    {
      node: planId,
      include: "output",
      output: "validation_plan",
      ...(config.approval_policy.require_execution_plan_approval ? { iteration: "latest_passed" as const } : {})
    }
  ];

  steps.push({
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
      ...latestPlanRefs
    ],
    outputs: [
      attemptOutput("implementation_notes", "implementation-notes.md", true)
    ],
    prompt: buildImplementPrompt(config)
  });

  steps.push({
    type: "repeat",
    id: repairLoopId,
    label: "Repair Loop",
    max_attempts: config.strategy.max_repair_cycles ?? 2,
    body: {
      type: "sequence",
      id: repairBodyId,
      label: "Repair Body",
      steps: [
        {
          type: "agent",
          id: repairId,
          label: "Repair Implementation",
          ...shared,
          sandbox: "workspace-write",
          context_from: [
            {
              node: ingestId,
              include: "output",
              output: "spec_packet"
            },
            ...latestPlanRefs,
            {
              node: implementId,
              include: "output",
              output: "implementation_notes"
            },
            {
              node: validationId,
              include: "result",
              iteration: "latest_failed",
              optional: true
            }
          ],
          outputs: [
            attemptOutput("repair_notes", "repair-notes.md", true)
          ],
          prompt: buildRepairPrompt(config)
        },
        {
          type: "check",
          id: validationId,
          label: "Validation Gate",
          ...shared,
          check_kind: "deterministic",
          command: "sh",
          args: ["-lc", buildValidationGateScript(config.validation.commands)],
          pass_if: {
            exit_code: 0
          }
        }
      ]
    },
    until: {
      node: validationId
    }
  } satisfies RepeatNode);

  let finalOutputs: OutputDefinition[] = config.outputs && config.outputs.length > 0 ? config.outputs : [];

  if (config.delivery.write_handoff !== false) {
    finalOutputs = appendOutput(finalOutputs, attemptOutput("handoff", "handoff.md", true));
  }

  if (config.delivery.write_validation_ledger !== false) {
    finalOutputs = appendOutput(finalOutputs, attemptOutput("validation_ledger", "validation-ledger.json", true));
  }

  if (config.delivery.write_repair_log !== false) {
    finalOutputs = appendOutput(finalOutputs, attemptOutput("repair_log", "repair-log.md", true));
  }

  finalOutputs = appendOutput(finalOutputs, attemptOutput("execution_plan", "execution-plan.md", true));
  finalOutputs = appendOutput(finalOutputs, attemptOutput("file_plan", "file-plan.md", true));
  finalOutputs = appendOutput(finalOutputs, attemptOutput("mutation_boundary", "mutation-boundary.md", true));
  finalOutputs = appendOutput(finalOutputs, attemptOutput("validation_plan", "validation-plan.md", true));
  finalOutputs = appendOutput(finalOutputs, workflowStatusOutput());
  finalOutputs = appendOutput(finalOutputs, workflowEventsOutput());

  steps.push({
    type: "agent",
    id: config.id,
    ...(config.label ? { label: config.label } : { label: "Publish Execution Handoff" }),
    ...shared,
    sandbox: "read-only",
    context_from: [
      {
        node: ingestId,
        include: "output",
        output: "spec_packet"
      },
      ...latestPlanRefs,
      {
        node: implementId,
        include: "output",
        output: "implementation_notes"
      },
      {
        node: repairId,
        include: "output",
        output: "repair_notes",
        iteration: "latest_passed"
      },
      {
        node: validationId,
        include: "result",
        iteration: "latest_passed"
      }
    ],
    outputs: finalOutputs,
    prompt: buildFinalizePrompt(config, finalOutputs)
  });

  return {
    type: "sequence",
    id: workflowId,
    label: config.label ? `${config.label} Workflow` : "Execute Spec Workflow",
    steps
  };
}

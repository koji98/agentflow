import { managedWorkflowKinds } from "../graph/schema.js";
import type { ManagedWorkflowKind } from "../graph/schema.js";
import type { ManagedWorkflowDescriptor, ManagedWorkflowRegistry } from "./types.js";

function defineWorkflow(descriptor: ManagedWorkflowDescriptor): ManagedWorkflowDescriptor {
  return descriptor;
}

export const managedWorkflowDescriptors = [
  defineWorkflow({
    kind: "deep_research",
    label: "Deep Research",
    summary:
      "Multi-agent research workflow with clarification, decomposition, parallel investigation, contradiction handling, council synthesis, and report delivery.",
    authored_contract_status: "implemented",
    runtime_shape: "compiled-subgraph",
    orchestration: {
      summary:
        "Clarify the ask, plan the work, fan out parallel researchers, reconcile disagreements, and synthesize a cited report through a council stage.",
      planner: true,
      fan_out: true,
      council: true,
      validation: true
    },
    phases: [
      {
        id: "clarify",
        label: "Clarify Goal",
        summary: "Tighten the research ask, assumptions, and scope before work begins.",
        mode: "single-agent"
      },
      {
        id: "plan",
        label: "Plan Research",
        summary: "Decompose the question into subtopics, source strategy, and evidence requirements.",
        mode: "single-agent"
      },
      {
        id: "investigate",
        label: "Investigate In Parallel",
        summary: "Run multiple research workers against disjoint subtopics or source clusters.",
        mode: "parallel-agents"
      },
      {
        id: "reconcile",
        label: "Reconcile Contradictions",
        summary: "Spot disagreements, missing evidence, and unresolved claims before synthesis.",
        mode: "deterministic-check"
      },
      {
        id: "council",
        label: "Council Synthesis",
        summary: "Merge worker findings through a synthesis council before writing the final report.",
        mode: "council"
      },
      {
        id: "deliver",
        label: "Deliver Report",
        summary: "Produce the final report and supporting artifacts.",
        mode: "single-agent"
      }
    ]
  }),
  defineWorkflow({
    kind: "spec_design",
    label: "Spec Design",
    summary:
      "Architecture and design workflow that clarifies the problem, explores options, critiques tradeoffs, and emits an implementation-ready spec.",
    authored_contract_status: "implemented",
    runtime_shape: "compiled-subgraph",
    orchestration: {
      summary:
        "Clarify the problem, inspect the codebase, fan out option exploration, compare tradeoffs, and finalize a design through a critique pass.",
      planner: true,
      fan_out: true,
      council: true,
      validation: true
    },
    phases: [
      {
        id: "clarify",
        label: "Clarify Problem",
        summary: "Convert the idea or issue into a precise design brief.",
        mode: "single-agent"
      },
      {
        id: "inspect",
        label: "Inspect Existing System",
        summary: "Read the current implementation, constraints, and surrounding docs.",
        mode: "single-agent"
      },
      {
        id: "explore",
        label: "Explore Options",
        summary: "Fan out multiple design options, alternatives, or architecture cuts in parallel.",
        mode: "parallel-agents"
      },
      {
        id: "tradeoffs",
        label: "Compare Tradeoffs",
        summary: "Critique the explored options and rank them against constraints.",
        mode: "council"
      },
      {
        id: "draft",
        label: "Draft Spec",
        summary: "Write the recommended design, constraints, and implementation plan.",
        mode: "single-agent"
      },
      {
        id: "critique",
        label: "Critique Draft",
        summary: "Review the draft for weak assumptions, missing risks, and unclear decisions.",
        mode: "deterministic-check"
      }
    ]
  }),
  defineWorkflow({
    kind: "execute_spec",
    label: "Execute Spec",
    summary:
      "Implementation workflow that starts from an existing spec, plans execution, applies changes, validates them, repairs failures, and hands off results.",
    authored_contract_status: "implemented",
    runtime_shape: "compiled-subgraph",
    orchestration: {
      summary:
        "Translate an existing spec into an execution plan, implement it with a single writer, validate it, and repair failures until the exit criteria pass.",
      planner: true,
      fan_out: false,
      council: false,
      validation: true
    },
    phases: [
      {
        id: "ingest",
        label: "Ingest Spec",
        summary: "Resolve the structured spec source into an execution packet.",
        mode: "single-agent"
      },
      {
        id: "readiness",
        label: "Assess Readiness",
        summary: "Gate execution on whether the spec is concrete enough to implement safely.",
        mode: "deterministic-check"
      },
      {
        id: "plan",
        label: "Plan Execution",
        summary: "Translate the spec into an ordered single-writer implementation plan.",
        mode: "single-agent"
      },
      {
        id: "implement",
        label: "Implement",
        summary: "Apply the code changes with one writer aligned to the spec and repo conventions.",
        mode: "single-agent"
      },
      {
        id: "validate",
        label: "Validate",
        summary: "Run the declared checks and collect failures as structured repair input.",
        mode: "deterministic-check"
      },
      {
        id: "repair",
        label: "Repair Loop",
        summary: "Retry implementation against concrete failures until the validation gate passes.",
        mode: "repair-loop"
      },
      {
        id: "handoff",
        label: "Handoff",
        summary: "Summarize the changes, checks, residual risks, and next steps.",
        mode: "single-agent"
      }
    ]
  }),
  defineWorkflow({
    kind: "review_change",
    label: "Review Change",
    summary:
      "Multi-reviewer workflow that inspects a diff or artifact, gathers independent findings, reconciles severity, and publishes a final review artifact.",
    authored_contract_status: "implemented",
    runtime_shape: "compiled-subgraph",
    orchestration: {
      summary:
        "Load the change, fan out specialized reviewers, merge and normalize findings, and deliver a review artifact with consistent severity.",
      planner: false,
      fan_out: true,
      council: true,
      validation: true
    },
    phases: [
      {
        id: "prepare",
        label: "Prepare Review",
        summary: "Load the target diff, patch, or artifact and establish review focus.",
        mode: "single-agent"
      },
      {
        id: "reviewers",
        label: "Parallel Reviewers",
        summary: "Run multiple reviewers against correctness, tests, regressions, and maintainability.",
        mode: "parallel-agents"
      },
      {
        id: "merge",
        label: "Merge Findings",
        summary: "Use a council pass to merge duplicate or conflicting findings.",
        mode: "council"
      },
      {
        id: "normalize",
        label: "Normalize Severity",
        summary: "Ensure the final findings are scoped, prioritized, and free of obvious false positives.",
        mode: "deterministic-check"
      },
      {
        id: "deliver",
        label: "Deliver Review",
        summary: "Publish the final review artifact and machine-readable findings.",
        mode: "single-agent"
      }
    ]
  })
] as const satisfies readonly ManagedWorkflowDescriptor[];

function buildRegistry(): ManagedWorkflowRegistry {
  const by_kind = Object.fromEntries(
    managedWorkflowDescriptors.map((descriptor) => [descriptor.kind, descriptor])
  ) as Record<ManagedWorkflowKind, ManagedWorkflowDescriptor>;

  const missingKinds = managedWorkflowKinds.filter((kind) => !by_kind[kind]);

  if (missingKinds.length > 0) {
    throw new Error(`Managed workflow registry is missing definitions for: ${missingKinds.join(", ")}.`);
  }

  return {
    descriptors: [...managedWorkflowDescriptors],
    by_kind
  };
}

export const managedWorkflowRegistry = buildRegistry();

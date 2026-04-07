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
      "Plan-led research workflow that clarifies the ask, builds a research plan, fans out investigators, consolidates evidence, and publishes a sourced final report.",
    authored_contract_status: "implemented",
    runtime_shape: "compiled-subgraph",
    orchestration: {
      summary:
        "Clarify the question, plan research intent, optionally gate the plan with a checkpoint, run parallel investigators, consolidate findings, and publish a cited report.",
      planner: true,
      fan_out: true,
      council: false,
      validation: true
    },
    phases: [
      {
        id: "brief",
        label: "Clarify Brief",
        summary: "Rewrite the ask into a concrete research brief with scope and success criteria.",
        mode: "single-agent"
      },
      {
        id: "plan",
        label: "Plan Research",
        summary: "Draft the research plan and optionally pause for plan approval.",
        mode: "single-agent"
      },
      {
        id: "investigate",
        label: "Investigate",
        summary: "Derive track briefs and fan out parallel research workers across the approved plan.",
        mode: "parallel-agents"
      },
      {
        id: "followup",
        label: "Follow-up Passes",
        summary: "Run targeted follow-up passes when contradictions or evidence gaps remain.",
        mode: "parallel-agents"
      },
      {
        id: "consolidate",
        label: "Consolidate Findings",
        summary: "Aggregate interim findings, provenance, and uncertainty artifacts.",
        mode: "single-agent"
      },
      {
        id: "deliver",
        label: "Deliver Report",
        summary: "Publish the final report and optionally run a final critique gate.",
        mode: "single-agent"
      }
    ]
  }),
  defineWorkflow({
    kind: "spec_design",
    label: "Spec Design",
    summary:
      "Repo-first design workflow that clarifies the problem, inspects the current system, chooses a direction, and publishes an implementation-ready design package.",
    authored_contract_status: "implemented",
    runtime_shape: "compiled-subgraph",
    orchestration: {
      summary:
        "Clarify the design brief, inspect the repo, optionally do targeted external research, fan out options, optionally gate the chosen direction, then revise to a quality bar.",
      planner: true,
      fan_out: true,
      council: false,
      validation: true
    },
    phases: [
      {
        id: "brief",
        label: "Clarify Brief",
        summary: "Turn the problem into a precise design brief with scope and decision drivers.",
        mode: "single-agent"
      },
      {
        id: "inspect",
        label: "Inspect Existing System",
        summary: "Read the relevant repository surfaces and capture the current system shape.",
        mode: "single-agent"
      },
      {
        id: "research",
        label: "Gap Analysis and Research",
        summary: "Identify missing context and optionally run targeted external research.",
        mode: "parallel-agents"
      },
      {
        id: "options",
        label: "Generate Options",
        summary: "Fan out distinct design options before selecting a direction.",
        mode: "parallel-agents"
      },
      {
        id: "direction",
        label: "Choose Direction",
        summary: "Recommend a direction, publish a tradeoff matrix, and optionally gate the choice with a checkpoint.",
        mode: "single-agent"
      },
      {
        id: "draft",
        label: "Draft Spec",
        summary: "Draft the initial spec from the approved or autonomous direction.",
        mode: "single-agent"
      },
      {
        id: "revise",
        label: "Revise to Quality Bar",
        summary: "Run critique profiles, merge feedback, and iterate until the quality review passes.",
        mode: "repair-loop"
      },
      {
        id: "deliver",
        label: "Publish Design Package",
        summary: "Publish the final design spec, decision log, and implementation-readiness outputs.",
        mode: "single-agent"
      }
    ]
  }),
  defineWorkflow({
    kind: "execute_spec",
    label: "Execute Spec",
    summary:
      "Single-writer implementation workflow that ingests a spec source, plans execution, applies changes, validates them, repairs failures, and publishes a handoff bundle.",
    authored_contract_status: "implemented",
    runtime_shape: "compiled-subgraph",
    orchestration: {
      summary:
        "Normalize the spec into an execution packet, optionally gate the execution plan with a checkpoint, implement with a single writer, and close through deterministic validation and repair.",
      planner: true,
      fan_out: false,
      council: false,
      validation: true
    },
    phases: [
      {
        id: "ingest",
        label: "Ingest Spec",
        summary: "Resolve the structured spec source into a normalized execution packet.",
        mode: "single-agent"
      },
      {
        id: "readiness",
        label: "Assess Readiness",
        summary: "Gate execution on whether the spec packet is concrete enough to implement safely.",
        mode: "deterministic-check"
      },
      {
        id: "recon",
        label: "Reconnaissance",
        summary: "Optionally inspect the repo read-only before planning mutations.",
        mode: "single-agent"
      },
      {
        id: "plan",
        label: "Plan Execution",
        summary: "Build the execution plan, file plan, mutation boundary, and validation plan, with optional checkpoint approval.",
        mode: "single-agent"
      },
      {
        id: "implement",
        label: "Implement",
        summary: "Apply the code changes with one writer aligned to the spec and repo conventions.",
        mode: "single-agent"
      },
      {
        id: "repair",
        label: "Repair Loop",
        summary: "Run deterministic validation and bounded repair cycles against concrete failures.",
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
      "Structured review workflow that prepares a review packet, fans out reviewer roles, calibrates findings, and publishes a final review bundle.",
    authored_contract_status: "implemented",
    runtime_shape: "compiled-subgraph",
    orchestration: {
      summary:
        "Prepare the review packet, plan reviewer focus, fan out specialized reviewers, aggregate and calibrate findings, and publish a low-noise review output.",
      planner: true,
      fan_out: true,
      council: false,
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
        id: "plan",
        label: "Plan Review",
        summary: "Turn the review packet into explicit reviewer focus and evidence expectations.",
        mode: "single-agent"
      },
      {
        id: "reviewers",
        label: "Parallel Reviewers",
        summary: "Run multiple reviewers against correctness, tests, regressions, and maintainability.",
        mode: "parallel-agents"
      },
      {
        id: "aggregate",
        label: "Aggregate Raw Findings",
        summary: "Collect raw reviewer outputs into one combined findings set.",
        mode: "single-agent"
      },
      {
        id: "merge",
        label: "Merge Findings",
        summary: "De-duplicate overlap while preserving the strongest evidence.",
        mode: "single-agent"
      },
      {
        id: "calibrate",
        label: "Calibrate Findings",
        summary: "Calibrate severity, confidence, and false positives before publication.",
        mode: "single-agent"
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

import { managedPatternKinds } from "../graph/schema.js";
import type { ManagedPatternKind } from "../graph/schema.js";
import type { ManagedPatternDescriptor, ManagedPatternRegistry } from "./types.js";

function definePattern(descriptor: ManagedPatternDescriptor): ManagedPatternDescriptor {
  return descriptor;
}

export const managedPatternDescriptors = [
  definePattern({
    kind: "pattern_deep_research",
    label: "Pattern Deep Research",
    summary:
      "Plan-led research pattern that clarifies the ask, builds a research plan, fans out investigators, consolidates evidence, and publishes a sourced report plus machine packet.",
    authored_contract_status: "implemented",
    runtime_shape: "compiled-subgraph",
    orchestration: {
      summary:
        "Clarify the question, plan research intent, optionally gate the plan with a checkpoint, run parallel investigators, consolidate findings, and publish a cited report and packet.",
      planner: true,
      fan_out: true,
      council: false,
      validation: true
    },
    phases: [
      { id: "brief", label: "Clarify Brief", summary: "Rewrite the ask into a concrete research brief.", mode: "single-agent" },
      { id: "plan", label: "Plan Research", summary: "Draft the research plan and optionally pause for plan approval.", mode: "single-agent" },
      { id: "investigate", label: "Investigate", summary: "Derive track briefs and fan out parallel research workers.", mode: "parallel-agents" },
      { id: "followup", label: "Follow-up Passes", summary: "Run targeted follow-up passes when contradictions or evidence gaps remain.", mode: "parallel-agents" },
      { id: "consolidate", label: "Consolidate Findings", summary: "Aggregate interim findings, provenance, and uncertainty artifacts.", mode: "single-agent" },
      { id: "deliver", label: "Deliver Research Package", summary: "Publish the final report, packet, and evidence bundle.", mode: "single-agent" }
    ]
  }),
  definePattern({
    kind: "pattern_spec_design",
    label: "Pattern Spec Design",
    summary:
      "Repo-first design pattern that clarifies the problem, inspects the current system, chooses a direction, and publishes an implementation-ready design package plus machine packet.",
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
      { id: "brief", label: "Clarify Brief", summary: "Turn the problem into a precise design brief with scope and decision drivers.", mode: "single-agent" },
      { id: "inspect", label: "Inspect Existing System", summary: "Read the relevant repository surfaces and capture the current system shape.", mode: "single-agent" },
      { id: "research", label: "Gap Analysis and Research", summary: "Identify missing context and optionally run targeted external research.", mode: "parallel-agents" },
      { id: "options", label: "Generate Options", summary: "Fan out distinct design options before selecting a direction.", mode: "parallel-agents" },
      { id: "direction", label: "Choose Direction", summary: "Recommend a direction, publish a tradeoff matrix, and optionally gate the choice with a checkpoint.", mode: "single-agent" },
      { id: "draft", label: "Draft Spec", summary: "Draft the initial spec from the approved or autonomous direction.", mode: "single-agent" },
      { id: "revise", label: "Revise to Quality Bar", summary: "Run critique profiles, merge feedback, and iterate until the quality review passes.", mode: "repair-loop" },
      { id: "deliver", label: "Publish Design Package", summary: "Publish the final design spec, design packet, and readiness artifacts.", mode: "single-agent" }
    ]
  }),
  definePattern({
    kind: "pattern_generate_evaluate_fix",
    label: "Pattern Generate Evaluate Fix",
    summary:
      "Narrow implementation pattern that consumes a prepared task packet, generates or fixes code changes, evaluates concrete commands independently, and publishes a change summary plus machine packet.",
    authored_contract_status: "implemented",
    runtime_shape: "compiled-subgraph",
    orchestration: {
      summary:
        "Prepare the task packet, generate or fix the change, run evaluator commands independently, aggregate their results, optionally repeat until the hard gate passes, and publish a change package.",
      planner: false,
      fan_out: true,
      council: false,
      validation: true
    },
    phases: [
      { id: "prepare", label: "Prepare Task Packet", summary: "Resolve the task source into one execution-ready task packet.", mode: "single-agent" },
      { id: "generate", label: "Generate or Fix Change", summary: "Apply or revise the code change against the prepared task packet and prior evaluator feedback.", mode: "single-agent" },
      { id: "evaluate", label: "Evaluator Panel", summary: "Run evaluator commands independently and preserve every result.", mode: "parallel-agents" },
      { id: "aggregate", label: "Aggregate Evaluations", summary: "Write a machine-readable evaluation ledger from the evaluator results.", mode: "single-agent" },
      { id: "gate", label: "Evaluation Gate", summary: "Hard-gate retries on the aggregated evaluation ledger when evaluation is required.", mode: "repair-loop" },
      { id: "deliver", label: "Publish Change Package", summary: "Publish the change summary, machine packet, evaluation ledger, and fix log.", mode: "single-agent" }
    ]
  }),
  definePattern({
    kind: "pattern_review_change",
    label: "Pattern Review Change",
    summary:
      "Structured review pattern that prepares a review packet, fans out reviewer roles, calibrates findings, and publishes a final review summary plus machine bundle.",
    authored_contract_status: "implemented",
    runtime_shape: "compiled-subgraph",
    orchestration: {
      summary:
        "Prepare the review packet, plan reviewer focus, fan out specialized reviewers, aggregate and calibrate findings, and publish a low-noise review output.",
      planner: true,
      fan_out: true,
      council: true,
      validation: true
    },
    phases: [
      { id: "prepare", label: "Prepare Review", summary: "Load the target diff, packet, or artifact and establish review focus.", mode: "single-agent" },
      { id: "plan", label: "Plan Review", summary: "Turn the review packet into explicit reviewer focus and evidence expectations.", mode: "single-agent" },
      { id: "reviewers", label: "Parallel Reviewers", summary: "Run multiple reviewers against correctness, tests, regressions, and maintainability.", mode: "parallel-agents" },
      { id: "aggregate", label: "Aggregate Raw Findings", summary: "Collect raw reviewer artifacts into one combined findings set.", mode: "single-agent" },
      { id: "merge", label: "Merge Findings", summary: "Deduplicate overlap while preserving the strongest evidence.", mode: "single-agent" },
      { id: "calibrate", label: "Calibrate Findings", summary: "Calibrate severity, confidence, and false positives before publication.", mode: "single-agent" },
      { id: "deliver", label: "Deliver Review", summary: "Publish the final review summary and machine-readable bundle.", mode: "single-agent" }
    ]
  })
] as const satisfies readonly ManagedPatternDescriptor[];

function buildRegistry(): ManagedPatternRegistry {
  const by_kind = Object.fromEntries(
    managedPatternDescriptors.map((descriptor) => [descriptor.kind, descriptor])
  ) as Record<ManagedPatternKind, ManagedPatternDescriptor>;

  const missingKinds = managedPatternKinds.filter((kind) => !by_kind[kind]);

  if (missingKinds.length > 0) {
    throw new Error(`Managed pattern registry is missing definitions for: ${missingKinds.join(", ")}.`);
  }

  return {
    descriptors: [...managedPatternDescriptors],
    by_kind
  };
}

export const managedPatternRegistry = buildRegistry();

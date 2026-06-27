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
      "Parallel angle-based research pattern that gathers evidence, synthesizes balanced batches, and publishes one complete sourced research report.",
    contract_status: "implemented",
    runtime_shape: "compiled-subgraph",
    orchestration: {
      summary:
        "Run authored research angles in parallel, synthesize at most three reports at a time in balanced batches, then publish the declared final artifacts.",
      planner: false,
      fan_out: true,
      council: false,
      validation: true
    },
    phases: [
      { id: "angles", label: "Research Angles", summary: "Run each authored angle independently in parallel.", mode: "parallel-agents" },
      { id: "synthesis", label: "Balanced Synthesis", summary: "Collapse redundancy while preserving major findings, provenance, uncertainty, and conflicts.", mode: "parallel-agents" },
      { id: "publish", label: "Publish Research", summary: "Write one complete public research report from accepted angle and synthesis evidence.", mode: "single-agent" }
    ]
  }),
  definePattern({
    kind: "pattern_deep_work",
    label: "Pattern Deep Work",
    summary:
      "Bounded work pattern that iterates implementation, deterministic checks, rubric grading, and artifact grading until the completion scorecard passes.",
    contract_status: "implemented",
    runtime_shape: "compiled-subgraph",
    orchestration: {
      summary:
        "Plan the next cycle, generate and validate the candidate, evaluate completion criteria, aggregate a deterministic scorecard, repeat with feedback when criteria miss, then write the runtime packet and promote declared user artifacts.",
      planner: true,
      fan_out: true,
      council: false,
      validation: true
    },
    phases: [
      { id: "plan", label: "Plan Work", summary: "Plan the work needed to satisfy the full task from current state without editing.", mode: "single-agent" },
      { id: "generate_validate", label: "Generate And Validate", summary: "Do or revise the work, run focused validation when feasible, and draft user-authored final artifacts.", mode: "single-agent" },
      { id: "criteria", label: "Completion Criteria", summary: "Run command criteria and targeted rubric checks in parallel.", mode: "parallel-agents" },
      { id: "gate", label: "Completion Gate", summary: "Aggregate a deterministic weighted scorecard and loop on misses.", mode: "repair-loop" },
      { id: "publish", label: "Finalize Work", summary: "Write the runtime-owned packet and promote accepted user-authored drafts from the latest passing cycle.", mode: "deterministic-check" }
    ]
  }),
  definePattern({
    kind: "pattern_work_list",
    label: "Pattern Work List",
    summary:
      "Managed work-list pattern that plans a finite ordered list, freezes it, executes items sequentially with an agent or deep-work item worker, verifies item completion, and publishes stable work-item evidence.",
    contract_status: "implemented",
    runtime_shape: "compiled-subgraph",
    orchestration: {
      summary:
        "Plan the ordered item list, deterministically freeze it, launch one managed execution per frozen item, verify all items completed, then publish stable work-items artifacts and any user-authored finals.",
      planner: true,
      fan_out: false,
      council: false,
      validation: true
    },
    phases: [
      { id: "plan", label: "Plan Work List", summary: "Discover the finite ordered list of work items needed for the node contract.", mode: "single-agent" },
      { id: "freeze", label: "Freeze Work List", summary: "Validate and freeze sequential item ids, concrete item goals, and acceptance criteria.", mode: "deterministic-check" },
      { id: "run_items", label: "Run Items", summary: "Launch one managed item execution per frozen item and aggregate accepted structured item results.", mode: "single-agent" },
      { id: "criteria", label: "Item Criteria", summary: "When deep_work is selected, run command criteria and targeted rubric checks for the current item.", mode: "parallel-agents" },
      { id: "gate", label: "Item Gate", summary: "When deep_work is selected, aggregate a per-item scorecard and retry only that item on misses.", mode: "repair-loop" },
      { id: "verify", label: "Verify Item Ledger", summary: "Deterministically verify every frozen item completed before publication.", mode: "deterministic-check" },
      { id: "publish", label: "Publish Work List", summary: "Skip by default; write user-authored final artifacts from the verified item ledger when declared.", mode: "single-agent" }
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

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
      "Parallel angle-based research pattern that gathers evidence, synthesizes balanced batches, and publishes a sourced summary plus machine packet.",
    contract_status: "implemented",
    runtime_shape: "compiled-subgraph",
    orchestration: {
      summary:
        "Run authored research angles in parallel, synthesize at most three reports at a time in balanced batches, then publish the declared public artifacts.",
      planner: false,
      fan_out: true,
      council: false,
      validation: true
    },
    phases: [
      { id: "angles", label: "Research Angles", summary: "Run each authored angle independently in parallel.", mode: "parallel-agents" },
      { id: "synthesis", label: "Balanced Synthesis", summary: "Collapse redundancy while preserving major findings, provenance, uncertainty, and conflicts.", mode: "parallel-agents" },
      { id: "publish", label: "Publish Research", summary: "Write the declared public summary, packet, and any authored artifacts.", mode: "single-agent" }
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
        "Plan the next cycle, generate and validate the candidate, evaluate completion criteria, aggregate a deterministic scorecard, repeat with feedback when criteria miss, then publish declared artifacts.",
      planner: true,
      fan_out: true,
      council: false,
      validation: true
    },
    phases: [
      { id: "plan", label: "Plan Cycle", summary: "Plan the smallest credible next move from context, scorecards, and prior feedback without editing.", mode: "single-agent" },
      { id: "generate_validate", label: "Generate And Validate", summary: "Do or revise the work, run focused validation when feasible, and draft public artifacts.", mode: "single-agent" },
      { id: "criteria", label: "Completion Criteria", summary: "Run command criteria and targeted rubric checks in parallel.", mode: "parallel-agents" },
      { id: "gate", label: "Completion Gate", summary: "Aggregate a deterministic weighted scorecard and loop on misses.", mode: "repair-loop" },
      { id: "publish", label: "Publish Work", summary: "Write final declared artifacts from the latest passing cycle.", mode: "single-agent" }
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

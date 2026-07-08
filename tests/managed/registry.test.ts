import { describe, expect, it } from "vitest";

import { managedPatternKinds } from "../../src/graph/schema.js";
import { managedPatternDescriptors, managedPatternRegistry } from "../../src/managed/index.js";

describe("managed pattern registry", () => {
  it("defines the canonical managed patterns", () => {
    expect(managedPatternDescriptors.map((descriptor) => descriptor.kind)).toEqual(managedPatternKinds);
  });

  it("tracks implementation status while exposing orchestration metadata", () => {
    const statuses = Object.fromEntries(
      managedPatternDescriptors.map((descriptor) => [descriptor.kind, descriptor.contract_status])
    );

    expect(statuses).toEqual({
      pattern_deep_research: "implemented",
      pattern_deep_work: "implemented",
      pattern_work_list: "implemented",
      pattern_map_reduce: "implemented",
      pattern_candidate_selection: "implemented"
    });

    managedPatternDescriptors.forEach((descriptor) => {
      expect(descriptor.runtime_shape).toBe("compiled-subgraph");
      expect(descriptor.phases.length).toBeGreaterThanOrEqual(3);
      expect(descriptor.orchestration.summary.length).toBeGreaterThan(0);
    });
  });

  it("indexes every descriptor by kind", () => {
    managedPatternKinds.forEach((kind) => {
      expect(managedPatternRegistry.by_kind[kind]).toEqual(
        expect.objectContaining({
          kind
        })
      );
    });
  });
});

import { describe, expect, it } from "vitest";

import { managedWorkflowKinds } from "../../src/graph/schema.js";
import { managedWorkflowDescriptors, managedWorkflowRegistry } from "../../src/managed/index.js";

describe("managed workflow registry", () => {
  it("defines the four canonical managed workflows", () => {
    expect(managedWorkflowDescriptors.map((descriptor) => descriptor.kind)).toEqual(managedWorkflowKinds);
  });

  it("tracks implementation status while exposing orchestration metadata", () => {
    const statuses = Object.fromEntries(
      managedWorkflowDescriptors.map((descriptor) => [descriptor.kind, descriptor.authored_contract_status])
    );

    expect(statuses).toEqual({
      deep_research: "implemented",
      spec_design: "implemented",
      execute_spec: "implemented",
      review_change: "implemented"
    });

    managedWorkflowDescriptors.forEach((descriptor) => {
      expect(descriptor.runtime_shape).toBe("compiled-subgraph");
      expect(descriptor.phases.length).toBeGreaterThanOrEqual(4);
      expect(descriptor.orchestration.summary.length).toBeGreaterThan(0);
    });
  });

  it("indexes every descriptor by kind", () => {
    managedWorkflowKinds.forEach((kind) => {
      expect(managedWorkflowRegistry.by_kind[kind]).toEqual(
        expect.objectContaining({
          kind
        })
      );
    });
  });
});

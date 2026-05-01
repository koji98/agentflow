import { describe, expect, it } from "vitest";

describe("validate:smoke contract", () => {
  it("pins canonical docs, deterministic npm checks, and built CLI smoke coverage", async () => {
    const scriptModule = await import("../../scripts/validate-smoke.mjs");

    expect(scriptModule.canonicalDocs).toEqual([
      "README.md",
      "docs/README.md",
      "docs/product/README.md",
      "docs/product/scope.md",
      "docs/product/operations.md",
      "docs/product/evals.md",
      "docs/product/managed-patterns.md",
      "docs/product/plugins.md",
      "docs/product/patterns/README.md",
      "docs/product/patterns/deep-research.md",
      "docs/product/patterns/spec-design.md",
      "docs/product/patterns/generate-evaluate-fix.md",
      "docs/product/patterns/review-change.md",
      "docs/technical/README.md",
      "docs/technical/architecture.md",
      "docs/technical/runtime-lifecycle.md",
      "docs/technical/context-and-artifacts.md",
      "docs/technical/runtime-tooling.md",
      "docs/technical/outcome-verification.md",
      "docs/technical/node-workspace-snapshots.md",
      "docs/technical/prompt-iteration-report.md",
      "docs/examples/README.md"
    ]);
    expect(scriptModule.commandChecks).toEqual([
      { name: "typecheck", script: "typecheck" },
      { name: "tests", script: "test" },
      { name: "build", script: "build" },
      { name: "skill pack", script: "validate:skills" }
    ]);
    expect(scriptModule.builtCliSmokeContract).toEqual({
      builtCliRelativePath: "dist/cli/index.js",
      fixtureGraphRelativePath: "tests/graph/fixtures/repeat.graph.json",
      fixtureGraphId: "repeat-graph",
      fixtureCommands: ["validate", "validate --show-compiled", "validate --review", "validate --diagram"],
      runHarnessAdapters: ["codex-cli", "cursor-cli"],
      runWorkspaceBackends: ["inplace", "worktree"]
    });
    expect(scriptModule.smokeResidualRisks).toEqual([
      "measured coverage floors are not part of validate:smoke",
      "manual run-artifact inspection is not part of validate:smoke",
      "real Codex or Cursor installs are not exercised by validate:smoke",
      "abrupt packaged-CLI death or host restart recovery beyond the deterministic suite remains unproven"
    ]);
  });
});

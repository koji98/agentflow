import { describe, expect, it } from "vitest";

describe("validate:smoke contract", () => {
  it("pins canonical docs, deterministic npm checks, and built CLI smoke coverage", async () => {
    const scriptModule = await import("../../scripts/validate-smoke.mjs");

    expect(scriptModule.canonicalDocs).toEqual([
      "README.md",
      "docs/SCOPE.md",
      "docs/DEFERRED.md",
      "docs/ARCHITECTURE.md",
      "docs/OPERATIONS.md",
      "docs/MANAGED_WORKFLOWS.md",
      "docs/SPEC_DESIGN_WORKFLOW.md",
      "docs/EXECUTE_SPEC_WORKFLOW.md",
      "docs/REVIEW_CHANGE_WORKFLOW.md"
    ]);
    expect(scriptModule.commandChecks).toEqual([
      { name: "typecheck", script: "typecheck" },
      { name: "tests", script: "test" },
      { name: "build", script: "build" }
    ]);
    expect(scriptModule.builtCliSmokeContract).toEqual({
      builtCliRelativePath: "dist/cli/index.js",
      fixtureGraphRelativePath: "tests/graph/fixtures/repeat.graph.json",
      fixtureGraphId: "repeat-graph",
      fixtureCommands: ["validate", "compile"],
      runHarnessAdapters: ["codex-cli", "cursor-cli"],
      runWorkspaceBackends: ["inplace", "worktree"]
    });
    expect(scriptModule.alphaResidualRisks).toEqual([
      "measured coverage floors are not part of validate:smoke",
      "manual run-artifact inspection is not part of validate:smoke",
      "real Codex or Cursor installs are not exercised by validate:smoke",
      "abrupt packaged-CLI death or host restart recovery beyond the deterministic suite remains unproven"
    ]);
  });
});

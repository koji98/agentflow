import { describe, expect, it } from "vitest";

describe("validate:smoke contract", () => {
  it("pins canonical docs, deterministic npm checks, and built CLI smoke coverage", async () => {
    const scriptModule = await import("../../scripts/validate-smoke.mjs");

    expect(scriptModule.canonicalDocs).toEqual([
      "README.md",
      "docs/SCOPE.md",
      "docs/ARCHITECTURE.md",
      "docs/OPERATIONS.md",
      "docs/EVALS.md",
      "docs/MANAGED_PATTERNS.md",
      "docs/PLUGINS.md",
      "docs/PATTERN_DEEP_RESEARCH.md",
      "docs/PATTERN_SPEC_DESIGN.md",
      "docs/PATTERN_GENERATE_EVALUATE_FIX.md",
      "docs/PATTERN_REVIEW_CHANGE.md"
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

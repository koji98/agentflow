import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("validate:confidence contract", () => {
  it("pins layered CLI confidence checks plus the coverage contract", async () => {
    const confidenceModule = await import("../../scripts/validate-confidence.mjs");
    const coverageModule = await import("../../scripts/test-coverage.mjs");

    expect(confidenceModule.confidenceCommandChecks).toEqual([
      { name: "smoke gate", script: "validate:smoke" },
      { name: "coverage policy", script: "test:coverage" }
    ]);
    expect(confidenceModule.confidenceResidualRisks).toEqual([
      "operator artifact inspection remains unproven beyond deterministic file and JSON assertions",
      "real harness behavior stays unproven unless validate:real-harness is also run",
      "abrupt packaged-CLI death and reopen behavior remains unproven end to end",
      "machine-specific git, filesystem, auth, and repo-topology variation remains only partially represented"
    ]);
    expect(coverageModule.coverageReporters).toEqual(["text-summary", "json-summary", "lcov"]);
    expect(coverageModule.coverageInclude).toEqual(["src/**/*.ts"]);
    expect(coverageModule.coverageScopeNotes).toEqual({
      measured: ["src/**/*.ts"],
      notMeasured: []
    });
    expect(coverageModule.coveragePolicy).toEqual({
      global: {
        lines: 81,
        statements: 81,
        functions: 82,
        branches: 72
      },
      criticalSurfaces: [
        {
          name: "src/graph",
          pathPrefix: "src/graph/",
          thresholds: {
            lines: 77,
            statements: 77,
            functions: 96,
            branches: 75
          }
        },
        {
          name: "src/runtime/core",
          pathPrefix: "src/runtime/core/",
          thresholds: {
            lines: 88,
            statements: 88,
            functions: 90,
            branches: 79
          }
        },
        {
          name: "src/runtime/workspace",
          pathPrefix: "src/runtime/workspace/",
          thresholds: {
            lines: 75,
            statements: 75,
            functions: 80,
            branches: 66
          }
        },
        {
          name: "src/artifacts",
          pathPrefix: "src/artifacts/",
          thresholds: {
            lines: 86,
            statements: 86,
            functions: 96,
            branches: 71
          }
        }
      ]
    });
  });

  it("exposes the confidence entrypoints in package scripts", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8")
    ) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts.test).toBe("vitest run");
    expect(packageJson.scripts["test:coverage"]).toBe("node scripts/test-coverage.mjs");
    expect(packageJson.scripts["validate:smoke"]).toBe("node scripts/validate-smoke.mjs");
    expect(packageJson.scripts["validate:confidence"]).toBe("node scripts/validate-confidence.mjs");
    expect(packageJson.scripts["validate:real-harness"]).toBe("node scripts/validate-real-harness.mjs");
  });
});

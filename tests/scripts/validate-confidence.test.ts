import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("validate:confidence contract", () => {
  it("pins layered confidence checks plus the coverage and browser contracts", async () => {
    const confidenceModule = await import("../../scripts/validate-confidence.mjs");
    const coverageModule = await import("../../scripts/test-coverage.mjs");
    const browserModule = await import("../../scripts/test-browser.mjs");

    expect(confidenceModule.confidenceCommandChecks).toEqual([
      { name: "smoke gate", script: "validate:smoke" },
      { name: "coverage policy", script: "test:coverage" },
      { name: "browser smoke", script: "test:browser" }
    ]);
    expect(confidenceModule.confidenceResidualRisks).toEqual([
      "browser proof remains limited to a completed Chromium smoke rather than live active-run updates or multi-browser behavior",
      "real harness behavior stays unproven unless validate:real-harness is also run",
      "abrupt packaged-CLI death and reopen behavior remains unproven end to end",
      "machine-specific git, filesystem, auth, and repo-topology variation remains only partially represented"
    ]);
    expect(coverageModule.coverageReporters).toEqual(["text-summary", "json-summary", "lcov"]);
    expect(coverageModule.coverageInclude).toEqual([
      "src/**/*.ts",
      "web-app/server/**/*.ts",
      "web-app/client/src/app.tsx",
      "web-app/client/src/components/**/*.tsx",
      "web-app/client/src/lib/**/*.ts"
    ]);
    expect(coverageModule.coverageScopeNotes).toEqual({
      measured: [
        "src/**/*.ts",
        "web-app/server/**/*.ts",
        "web-app/client/src/app.tsx",
        "web-app/client/src/components/**/*.tsx",
        "web-app/client/src/lib/**/*.ts"
      ],
      notMeasured: [
        "web-app/client/src/hooks/use_run_events.ts remains browser-level proof because live event streaming depends on runtime browser primitives.",
        "web-app/client/src/main.tsx is bootstrap-only and stays outside the measured floors."
      ]
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
        },
        {
          name: "web-app/server",
          pathPrefix: "web-app/server/",
          thresholds: {
            lines: 81,
            statements: 81,
            functions: 89,
            branches: 67
          }
        },
        {
          name: "web-app/client/app-shell",
          pathPrefix: "web-app/client/src/app.tsx",
          thresholds: {
            lines: 51,
            statements: 51,
            functions: 21,
            branches: 72
          }
        },
        {
          name: "web-app/client/components",
          pathPrefix: "web-app/client/src/components/",
          thresholds: {
            lines: 84,
            statements: 84,
            functions: 33,
            branches: 59
          }
        },
        {
          name: "web-app/client/lib",
          pathPrefix: "web-app/client/src/lib/",
          thresholds: {
            lines: 71,
            statements: 71,
            functions: 78,
            branches: 63
          }
        }
      ]
    });
    expect(browserModule.browserSmokeContract).toEqual({
      builtCliRelativePath: "dist/cli/index.js",
      builtClientIndexRelativePath: "web-app/dist/client/index.html",
      builtServerRelativePath: "web-app/dist/server-build/web-app/server/index.js",
      packageStartCommand: "npm run start --workspace web-app",
      browserBinary: "playwright-chromium",
      browserBootstrap: "install-if-missing",
      requiredRoutes: ["launchpad", "run-monitor"],
      requiredSurfaces: ["recent-runs", "event-timeline", "node-inspector", "logs-and-artifacts"],
      operatorFlow: [
        "choose graph",
        "inspect known run set",
        "compile graph",
        "open recent run",
        "render core monitor surfaces",
        "read node stdout and artifact"
      ]
    });
  });

  it("exposes the confidence entrypoints in package scripts", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../../package.json", import.meta.url), "utf8")
    ) as {
      scripts: Record<string, string>;
    };
    const webPackageJson = JSON.parse(
      await readFile(new URL("../../web-app/package.json", import.meta.url), "utf8")
    ) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts.test).toBe("vitest run");
    expect(packageJson.scripts["test:coverage"]).toBe("node scripts/test-coverage.mjs");
    expect(packageJson.scripts["test:browser"]).toBe("node scripts/test-browser.mjs");
    expect(packageJson.scripts["validate:smoke"]).toBe("node scripts/validate-smoke.mjs");
    expect(packageJson.scripts["validate:confidence"]).toBe("node scripts/validate-confidence.mjs");
    expect(packageJson.scripts["validate:real-harness"]).toBe("node scripts/validate-real-harness.mjs");
    expect(webPackageJson.scripts["build:server"]).toBe("tsc -p tsconfig.server.build.json");
    expect(webPackageJson.scripts.build).toBe("tsc --noEmit -p tsconfig.json && npm run build:server && vite build");
    expect(webPackageJson.scripts.start).toBe("node dist/server-build/web-app/server/index.js");
  });
});

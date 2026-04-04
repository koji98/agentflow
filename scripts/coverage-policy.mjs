export const coverageReporters = ["text-summary", "json-summary", "lcov"];

export const coverageInclude = [
  "src/**/*.ts",
  "web-app/server/**/*.ts",
  "web-app/client/src/app.tsx",
  "web-app/client/src/components/**/*.tsx",
  "web-app/client/src/lib/**/*.ts"
];

export const coverageScopeNotes = {
  measured: coverageInclude,
  notMeasured: [
    "web-app/client/src/hooks/use_run_events.ts remains browser-level proof because live event streaming depends on runtime browser primitives.",
    "web-app/client/src/main.tsx is bootstrap-only and stays outside the measured floors."
  ]
};

export const coverageSummaryRelativePath = "coverage/coverage-summary.json";

export const coveragePolicy = {
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
};

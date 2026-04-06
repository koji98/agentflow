export const coverageReporters = ["text-summary", "json-summary", "lcov"];

export const coverageInclude = ["src/**/*.ts"];

export const coverageScopeNotes = {
  measured: coverageInclude,
  notMeasured: []
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
  ]
};

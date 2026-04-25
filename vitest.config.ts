import { defineConfig } from "vitest/config";

import { coverageInclude, coverageReporters } from "./scripts/coverage-policy.mjs";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    passWithNoTests: false,
    testTimeout: 30000,
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: coverageReporters,
      reportsDirectory: "coverage",
      include: coverageInclude,
      all: true
    }
  }
});

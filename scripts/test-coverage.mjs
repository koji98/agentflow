import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  coverageInclude,
  coveragePolicy,
  coverageReporters,
  coverageScopeNotes,
  coverageSummaryRelativePath
} from "./coverage-policy.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const jsonMode = process.argv.includes("--json");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const commandTimeoutMs = 60 * 60 * 1000;
const coverageMetricKeys = ["lines", "statements", "functions", "branches"];

function stripAnsi(text) {
  return text.replace(/\u001B\[[0-9;]*m/g, "");
}

function summarizeOutput(output) {
  const lines = stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return "no output";
  }

  const excerpt = lines.slice(-8).join(" | ");
  return excerpt.length <= 600 ? excerpt : `...${excerpt.slice(-597)}`;
}

function runCommand(command, args, displayName) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    env: { ...process.env, CI: process.env.CI ?? "1" },
    maxBuffer: 10 * 1024 * 1024,
    timeout: commandTimeoutMs
  });

  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");

  if (result.error) {
    return {
      passed: false,
      reason: `${displayName} failed to start: ${result.error.message}`
    };
  }

  if (result.signal) {
    return {
      passed: false,
      reason: `${displayName} terminated with signal ${result.signal}: ${summarizeOutput(output)}`
    };
  }

  if (result.status !== 0) {
    return {
      passed: false,
      reason: `${displayName} failed with exit code ${result.status}: ${summarizeOutput(output)}`
    };
  }

  return {
    passed: true,
    reason: `${displayName} passed.`
  };
}

function emptyMetricTotals() {
  return {
    total: 0,
    covered: 0,
    skipped: 0,
    pct: 100
  };
}

function emptyTotals() {
  return {
    lines: emptyMetricTotals(),
    statements: emptyMetricTotals(),
    functions: emptyMetricTotals(),
    branches: emptyMetricTotals()
  };
}

function addMetricTotals(target, source) {
  target.total += Number(source?.total ?? 0);
  target.covered += Number(source?.covered ?? 0);
  target.skipped += Number(source?.skipped ?? 0);
  target.pct = target.total === 0 ? 100 : Number(((target.covered / target.total) * 100).toFixed(1));
}

function normalizeSummaryPath(filePath) {
  const normalized = isAbsolute(filePath)
    ? relative(rootDir, filePath)
    : filePath;

  return normalized.replace(/\\/g, "/");
}

function aggregateCoverage(summary, pathPrefix) {
  const aggregate = emptyTotals();
  let matchedFiles = 0;

  for (const [filePath, metrics] of Object.entries(summary)) {
    if (filePath === "total") {
      continue;
    }

    if (!normalizeSummaryPath(filePath).startsWith(pathPrefix)) {
      continue;
    }

    matchedFiles += 1;

    for (const metricKey of coverageMetricKeys) {
      addMetricTotals(aggregate[metricKey], metrics?.[metricKey]);
    }
  }

  return {
    matchedFiles,
    metrics: aggregate
  };
}

function formatPct(value) {
  return `${Number(value).toFixed(1)}%`;
}

function formatSurfaceSummary(name, metrics) {
  return `${name}: ` +
    coverageMetricKeys.map((metricKey) => `${metricKey} ${formatPct(metrics[metricKey].pct)}`).join(", ");
}

function evaluateThresholds(name, measuredMetrics, thresholds) {
  const failures = [];

  for (const metricKey of coverageMetricKeys) {
    const actualPct = Number(measuredMetrics[metricKey].pct ?? 0);
    const requiredPct = thresholds[metricKey];

    if (actualPct < requiredPct) {
      failures.push(
        `${name} ${metricKey} ${formatPct(actualPct)} is below the ${formatPct(requiredPct)} floor`
      );
    }
  }

  return failures;
}

async function readCoverageSummary() {
  const summaryPath = resolve(rootDir, coverageSummaryRelativePath);
  const summaryText = await readFile(summaryPath, "utf8");
  return JSON.parse(summaryText);
}

async function main() {
  const coverageRun = runCommand(
    npmCommand,
    ["run", "test", "--", "--coverage.enabled=true"],
    "coverage test run"
  );

  if (!coverageRun.passed) {
    const payload = {
      passed: false,
      reasons: [coverageRun.reason]
    };

    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      console.log("Coverage policy FAIL");
      console.log(`[fail] ${coverageRun.reason}`);
    }

    process.exitCode = 1;
    return;
  }

  let summary;

  try {
    summary = await readCoverageSummary();
  } catch (error) {
    const reason = `Coverage summary is missing or unreadable at ${coverageSummaryRelativePath}: ${error instanceof Error ? error.message : String(error)}`;
    const payload = {
      passed: false,
      reasons: [reason]
    };

    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      console.log("Coverage policy FAIL");
      console.log(`[fail] ${reason}`);
    }

    process.exitCode = 1;
    return;
  }

  const globalMetrics = summary?.total;
  const failures = [];

  if (!globalMetrics) {
    failures.push(`Coverage summary at ${coverageSummaryRelativePath} did not contain a total section.`);
  } else {
    failures.push(...evaluateThresholds("global", globalMetrics, coveragePolicy.global));
  }

  const criticalSurfaces = coveragePolicy.criticalSurfaces.map((surface) => {
    const aggregate = aggregateCoverage(summary, surface.pathPrefix);

    if (aggregate.matchedFiles === 0) {
      failures.push(`Coverage surface ${surface.name} matched no files for prefix ${surface.pathPrefix}.`);
      return {
        name: surface.name,
        matchedFiles: 0,
        metrics: emptyTotals()
      };
    }

    failures.push(...evaluateThresholds(surface.name, aggregate.metrics, surface.thresholds));
    return {
      name: surface.name,
      matchedFiles: aggregate.matchedFiles,
      metrics: aggregate.metrics
    };
  });

  const passed = failures.length === 0;
  const payload = {
    passed,
    include: coverageInclude,
    reporters: coverageReporters,
    scope_notes: coverageScopeNotes,
    policy: coveragePolicy,
    summary: {
      global: globalMetrics,
      critical_surfaces: criticalSurfaces
    },
    reasons: passed
      ? [
          [
            formatSurfaceSummary("global", globalMetrics),
            ...criticalSurfaces.map((surface) => formatSurfaceSummary(surface.name, surface.metrics))
          ].join(" | ")
        ]
      : failures
  };

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    console.log(`Coverage policy ${passed ? "PASS" : "FAIL"}`);

    if (passed) {
      console.log(`[pass] ${payload.reasons[0]}`);
    } else {
      for (const reason of failures) {
        console.log(`[fail] ${reason}`);
      }
    }
  }

  process.exitCode = passed ? 0 : 1;
}

const invokedScript = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;

if (invokedScript === import.meta.url) {
  await main();
}

export {
  commandTimeoutMs,
  coverageInclude,
  coveragePolicy,
  coverageReporters,
  coverageScopeNotes,
  coverageSummaryRelativePath
};

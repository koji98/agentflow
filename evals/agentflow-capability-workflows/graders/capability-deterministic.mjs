import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative } from "node:path";

const packet = JSON.parse(readFileSync(process.env.AGENTFLOW_EVAL_TRACE_PACKET_FILE, "utf8"));
const scenarioId = process.env.AGENTFLOW_EVAL_SCENARIO_ID;
const suiteDir = process.cwd();
const suite = JSON.parse(readFileSync(join(suiteDir, "eval.json"), "utf8"));
const trialRoot = dirname(dirname(process.env.AGENTFLOW_EVAL_OUTPUT_DIR));
const repoRoot = join(trialRoot, "workspace", "repo");

const expectedChangedFiles = {
  "01-config-deep-merge": [
    "src/config.js"
  ],
  "02-cache-ttl-regression": [
    "src/cache.js"
  ],
  "03-api-client-docs-migration": [
    "src/client.js"
  ],
  "04-ui-accessibility": [
    "src/renderButton.js"
  ],
  "05-design-token-scope": [
    "src/tokens.js"
  ],
  "06-data-normalization": [
    "src/normalizeRows.js"
  ],
  "07-noisy-monorepo-targeting": [
    "packages/billing/src/invoice.js"
  ],
  "08-tool-guided-discovery": [
    ".fixture-tool-used.json",
    "src/feature.js"
  ],
  "09-cli-error-discipline": [
    "src/cli.js"
  ],
  "10-no-edit-audit": [],
  "11-forbidden-scope-guard": [
    "src/sanitize.js"
  ],
  "12-sequence-research-implement": [
    "src/rounding.js"
  ],
  "13-worktree-change-capture": [],
  "14-stale-docs-conflict": [
    "src/mode.js"
  ],
  "15-supervisor-retry-envelope": [],
  "16-terminal-repeated-failure": []
};

function loadScenario(id) {
  for (const ref of suite.scenarios) {
    const scenario = JSON.parse(readFileSync(join(suiteDir, ref), "utf8"));
    if (scenario.id === id) return scenario;
  }
  throw new Error(`Unknown scenario ${id}`);
}

const scenario = loadScenario(scenarioId);
const expectedStatus = scenario.expected.final_outcome ?? "passed";
const artifacts = packet.artifacts ?? [];
const handoff = artifacts.find((artifact) => artifact.name === "handoff");
const handoffText = String(handoff?.content ?? "");
const placeholderPattern = /todo|tbd|lorem ipsum|placeholder|not implemented/i;
const manifest = packet.delivery?.manifest;
const assertions = [];

function assert(id, passed, evidence) {
  assertions.push({ id, passed, evidence });
}

assert("expected_status", packet.outcome.status === expectedStatus, `expected=${expectedStatus}; actual=${packet.outcome.status}`);
if (expectedStatus === "passed") {
  assert("handoff_exists", Boolean(handoff), handoff?.path ?? "missing");
  assert("handoff_has_validation", /Validation:/i.test(handoffText), "handoff validation section");
  assert("handoff_has_scenario", handoffText.includes("Scenario:"), "handoff scenario section");
  assert("handoff_not_placeholder", !placeholderPattern.test(handoffText), "placeholder scan");
}
assert("delivery_manifest", Boolean(packet.delivery?.manifest_path && manifest), packet.delivery?.manifest_path ?? "missing");

function gitChangedFiles() {
  if (!existsSync(join(repoRoot, ".git"))) {
    return [];
  }
  const stdout = execFileSync("git", ["-C", repoRoot, "status", "--short"], { encoding: "utf8" });
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((line) => line.includes(" -> ") ? line.split(" -> ").at(-1) : line)
    .sort();
}

function assertChangedFiles() {
  const expected = expectedChangedFiles[scenarioId];
  if (!expected) return;
  const actual = gitChangedFiles();
  const expectedSorted = [...expected].sort();
  assert(
    "changed_files_scoped",
    JSON.stringify(actual) === JSON.stringify(expectedSorted),
    `expected=${expectedSorted.join(",") || "none"}; actual=${actual.join(",") || "none"}; repo=${relative(trialRoot, repoRoot)}`
  );
}

assertChangedFiles();

if (scenarioId === "08-tool-guided-discovery") {
  assert("tool_marker", existsSync(join(repoRoot, ".fixture-tool-used.json")), "fixture tool marker in trial repo");
}

if (scenarioId === "03-api-client-docs-migration" || scenarioId === "14-stale-docs-conflict") {
  assert("handoff_cites_docs", /docs|fixture|http:\/\/127\.0\.0\.1|stable-v2|2026-04/i.test(handoffText), "handoff cites current docs evidence");
}

if (scenarioId === "15-supervisor-retry-envelope") {
  assert("supervisor_intervention", (packet.supervisor?.intervention_count ?? 0) > 0, "intervention count");
  assert("retry_attempts", (packet.metrics?.attempts ?? 0) >= 2, "attempt count");
}

if (scenarioId === "16-terminal-repeated-failure") {
  assert("terminal_failed", packet.outcome.status === "failed", "expected terminal failure");
  assert("failure_attempts", (packet.metrics?.attempts ?? 0) >= 2, "attempt count");
}

const passed = assertions.every((entry) => entry.passed);
console.log(JSON.stringify({
  passed,
  score: passed ? 5 : 1,
  summary: passed ? "Capability workflow deterministic checks passed." : "Capability workflow deterministic checks failed.",
  assertions,
  metrics: {
    attempts: packet.metrics?.attempts ?? 0,
    recovery_cycles: packet.metrics?.recovery_cycles ?? 0,
    artifacts: artifacts.length
  }
}));

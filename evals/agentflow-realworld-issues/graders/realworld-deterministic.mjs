import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const packet = JSON.parse(readFileSync(process.env.AGENTFLOW_EVAL_TRACE_PACKET_FILE, "utf8"));
const scenarioId = process.env.AGENTFLOW_EVAL_SCENARIO_ID;
const suiteDir = process.cwd();
const suite = JSON.parse(readFileSync(join(suiteDir, "eval.json"), "utf8"));
const trialRoot = dirname(dirname(process.env.AGENTFLOW_EVAL_OUTPUT_DIR));
const repoRoot = join(trialRoot, "workspace", "repo");

function loadScenario(id) {
  for (const ref of suite.scenarios) {
    const scenario = JSON.parse(readFileSync(join(suiteDir, ref), "utf8"));
    if (scenario.id === id) return scenario;
  }
  throw new Error(`Unknown scenario ${id}`);
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
}

function globToRegExp(glob) {
  let pattern = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    const next = glob[index + 1];
    if (char === "*" && next === "*") {
      const after = glob[index + 2];
      if (after === "/") {
        pattern += "(?:.*/)?";
        index += 2;
      } else {
        pattern += ".*";
        index += 1;
      }
    } else if (char === "*") {
      pattern += "[^/]*";
    } else {
      pattern += escapeRegExp(char);
    }
  }
  return new RegExp(`^${pattern}$`, "u");
}

function matchesAny(path, globs) {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

function gitChangedFiles() {
  if (!existsSync(join(repoRoot, ".git"))) {
    return [];
  }
  const stdout = execFileSync("git", ["-C", repoRoot, "status", "--short", "--untracked-files=all"], { encoding: "utf8" });
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((line) => line.includes(" -> ") ? line.split(" -> ").at(-1) : line)
    .sort();
}

function findFiles(root, basename, limit = 20) {
  const found = [];
  const stack = [root];
  while (stack.length > 0 && found.length < limit) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (entry.isFile() && entry.name === basename) {
        found.push(path);
      }
    }
  }
  return found;
}

function runFocusedCommand(command) {
  try {
    execFileSync("sh", ["-lc", command], {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${join(repoRoot, "node_modules", ".bin")}:${process.env.PATH ?? ""}`
      },
      encoding: "utf8",
      stdio: "pipe",
      timeout: 300_000,
      maxBuffer: 1024 * 1024 * 16
    });
    return { passed: true, evidence: command };
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr) : "";
    const stdout = error?.stdout ? String(error.stdout) : "";
    return {
      passed: false,
      evidence: `${command}\n${stdout}\n${stderr}`.slice(0, 4000)
    };
  }
}

function hasHandoffSection(text, sectionName) {
  const escaped = escapeRegExp(sectionName);
  return new RegExp(`(^|\\n)(#{1,6}\\s+${escaped}\\b|${escaped}:)`, "iu").test(text);
}

const scenario = loadScenario(scenarioId);
const realworld = scenario.metadata?.realworld;
if (!realworld) {
  throw new Error(`Scenario ${scenarioId} is missing metadata.realworld.`);
}

const assertions = [];
function assert(id, passed, evidence) {
  assertions.push({ id, passed, evidence });
}

const artifacts = packet.artifacts ?? [];
const handoff = artifacts.find((artifact) => artifact.name === "handoff");
const handoffText = String(handoff?.content ?? "");
const changedFiles = gitChangedFiles();
const changedAllowed = changedFiles.every((file) => matchesAny(file, realworld.allowed_changed_globs));
const changedForbidden = changedFiles.filter((file) =>
  matchesAny(file, [
    "package.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    ...realworld.forbidden_changed_globs
  ])
);
const focused = runFocusedCommand(realworld.focused_test_command);
const promptFiles = findFiles(process.env.AGENTFLOW_EVAL_RUN_ROOT, "prompt.md");

assert("expected_status", packet.outcome.status === "passed", `actual=${packet.outcome.status}`);
assert("handoff_exists", Boolean(handoff), handoff?.path ?? "missing");
assert("handoff_has_validation", hasHandoffSection(handoffText, "Validation"), "handoff validation section");
assert("handoff_has_scenario", hasHandoffSection(handoffText, "Scenario"), "handoff scenario section");
assert("focused_regression_passes", focused.passed, focused.evidence);
assert("changed_files_present", changedFiles.length > 0, changedFiles.join(",") || "no changed files");
assert(
  "changed_files_allowed",
  changedAllowed,
  `allowed=${realworld.allowed_changed_globs.join(",")}; actual=${changedFiles.join(",")}`
);
assert(
  "forbidden_files_unchanged",
  changedForbidden.length === 0,
  changedForbidden.length === 0 ? "none" : changedForbidden.join(",")
);
assert("delivery_manifest", Boolean(packet.delivery?.manifest_path && packet.delivery?.manifest), packet.delivery?.manifest_path ?? "missing");
assert("prompt_artifacts", promptFiles.length > 0, promptFiles.map((path) => relative(process.env.AGENTFLOW_EVAL_RUN_ROOT, path)).join(","));

const passed = assertions.every((entry) => entry.passed);
console.log(JSON.stringify({
  passed,
  score: passed ? 5 : 1,
  summary: passed ? "Real-world issue deterministic checks passed." : "Real-world issue deterministic checks failed.",
  assertions,
  metrics: {
    changed_files: changedFiles.length,
    focused_command: realworld.focused_test_command,
    prompt_files: promptFiles.length
  }
}));

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const jsonMode = process.argv.includes("--json");
const releaseMode = process.argv.includes("--release");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const defaultCommandTimeoutMs = 30 * 60 * 1000;
const releaseCommandTimeoutMs = 60 * 60 * 1000;
const releaseEvalTimeoutMs = 12 * 60 * 60 * 1000;

export const confidenceCommandChecks = [
  { name: "smoke gate", script: "validate:smoke" },
  { name: "coverage policy", script: "test:coverage" }
];

export const releaseConfidenceCommandChecks = [
  { name: "typecheck", command: "npm run typecheck", executable: "npm", args: ["run", "typecheck"], timeout_ms: releaseCommandTimeoutMs },
  { name: "unit and runtime tests", command: "npm test", executable: "npm", args: ["test"], timeout_ms: releaseCommandTimeoutMs },
  { name: "build", command: "npm run build", executable: "npm", args: ["run", "build"], timeout_ms: releaseCommandTimeoutMs },
  { name: "smoke gate", command: "npm run validate:smoke", executable: "npm", args: ["run", "validate:smoke"], timeout_ms: releaseCommandTimeoutMs },
  { name: "coverage policy", command: "npm run test:coverage", executable: "npm", args: ["run", "test:coverage"], timeout_ms: releaseCommandTimeoutMs },
  { name: "prompt regression", command: "npm run validate:prompts", executable: "npm", args: ["run", "validate:prompts"], timeout_ms: releaseCommandTimeoutMs },
  { name: "validation eval setup", command: "npm run setup:validation-evals", executable: "npm", args: ["run", "setup:validation-evals"], timeout_ms: releaseCommandTimeoutMs },
  {
    name: "validation sentinel graph validation",
    command: "node dist/cli/index.js eval validate evals/agentflow-validation",
    executable: "node",
    args: ["dist/cli/index.js", "eval", "validate", "evals/agentflow-validation"],
    timeout_ms: releaseCommandTimeoutMs
  },
  {
    name: "validation sentinel release sweep",
    command: "node dist/cli/index.js eval run evals/agentflow-validation --variant current --scenario all --trials 3 --concurrency 2",
    executable: "node",
    args: ["dist/cli/index.js", "eval", "run", "evals/agentflow-validation", "--variant", "current", "--scenario", "all", "--trials", "3", "--concurrency", "2"],
    timeout_ms: releaseEvalTimeoutMs
  }
];

export const confidenceResidualRisks = [
  "operator artifact inspection remains unproven beyond deterministic file and JSON assertions",
  "real harness behavior stays unproven unless validate:real-harness is also run",
  "abrupt packaged-CLI death and reopen behavior remains unproven end to end",
  "machine-specific git, filesystem, auth, and repo-topology variation remains only partially represented"
];

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

function parseJsonOutput(commandName, stdout) {
  const trimmed = stripAnsi(stdout).trim();

  if (trimmed.length === 0) {
    throw new Error(`${commandName} returned no JSON output.`);
  }

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `${commandName} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function runCommand(command, args, displayName, timeoutMs = defaultCommandTimeoutMs) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    encoding: "utf8",
    env: { ...process.env, CI: process.env.CI ?? "1" },
    maxBuffer: 10 * 1024 * 1024,
    timeout: timeoutMs
  });

  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");

  if (result.error) {
    return {
      status: "failed",
      reason: `${displayName} failed to start: ${result.error.message}`,
      stdout: result.stdout ?? ""
    };
  }

  if (result.signal) {
    return {
      status: "failed",
      reason: `${displayName} terminated with signal ${result.signal}: ${summarizeOutput(output)}`,
      stdout: result.stdout ?? ""
    };
  }

  if (result.status !== 0) {
    return {
      status: "failed",
      reason: `${displayName} failed with exit code ${result.status}: ${summarizeOutput(output)}`,
      stdout: result.stdout ?? ""
    };
  }

  return {
    status: "passed",
    reason: `${displayName} passed.`,
    stdout: result.stdout ?? ""
  };
}

function runNpmScript(scriptName) {
  return runCommand(npmCommand, ["run", scriptName], scriptName);
}

function runNpmJsonScript(scriptName) {
  return runCommand(npmCommand, ["run", "--silent", scriptName, "--", "--json"], `${scriptName} --json`);
}

function executableForCheck(check) {
  if (check.executable === "npm") {
    return npmCommand;
  }
  if (check.executable === "node") {
    return process.execPath;
  }
  return check.executable;
}

function summarizeJsonPayloadReason(payload, fallbackReason) {
  if (Array.isArray(payload?.reasons) && typeof payload.reasons[0] === "string") {
    return payload.reasons[0];
  }

  return fallbackReason;
}

function runJsonCheck(check) {
  const command = `npm run ${check.script} -- --json`;
  const result = runNpmJsonScript(check.script);

  try {
    const payload = parseJsonOutput(`${check.script} --json`, result.stdout);
    return {
      name: check.name,
      script: check.script,
      command,
      status: result.status,
      reason: summarizeJsonPayloadReason(payload, result.reason),
      details: payload
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    return {
      name: check.name,
      script: check.script,
      command,
      status: "failed",
      reason,
      details: {
        parse_error: reason
      }
    };
  }
}

function runReleaseCheck(check) {
  const result = runCommand(
    executableForCheck(check),
    check.args,
    check.command,
    check.timeout_ms ?? defaultCommandTimeoutMs
  );

  return {
    name: check.name,
    command: check.command,
    status: result.status,
    reason: result.reason
  };
}

function skippedReleaseCheck(check, priorFailure) {
  return {
    name: check.name,
    command: check.command,
    status: "skipped",
    reason: `Skipped because ${priorFailure.name} failed.`
  };
}

function iconForStatus(status) {
  if (status === "passed") {
    return "[pass]";
  }

  if (status === "skipped") {
    return "[skip]";
  }

  return "[fail]";
}

async function runNormalConfidence() {
  const checks = [];
  const smokeCheck = confidenceCommandChecks[0];
  const smokeResult = runJsonCheck(smokeCheck);
  checks.push(smokeResult);

  if (smokeResult.status !== "passed") {
    checks.push({
      name: confidenceCommandChecks[1].name,
      script: confidenceCommandChecks[1].script,
      command: `npm run ${confidenceCommandChecks[1].script} -- --json`,
      status: "skipped",
      reason: "validate:smoke failed, so the coverage policy did not run."
    });
  } else {
    for (const check of confidenceCommandChecks.slice(1)) {
      checks.push(runJsonCheck(check));
    }
  }

  const passedChecks = checks.filter((check) => check.status === "passed").length;
  const passed = checks.every((check) => check.status === "passed");
  const score = Number((passedChecks / checks.length).toFixed(2));
  const reasons = checks.filter((check) => check.status !== "passed").map((check) => check.reason);
  const payload = {
    mode: "normal",
    release: false,
    passed,
    score,
    commands_run: checks
      .filter((check) => check.status !== "skipped")
      .map((check) => check.command),
    planned_commands: checks.map((check) => check.command),
    checks,
    residual_risks: confidenceResidualRisks,
    reasons: reasons.length > 0 ? reasons : [`Confidence validation passed across ${checks.length} checks.`]
  };

  return payload;
}

async function runReleaseConfidence() {
  const checks = [];
  let priorFailure;

  for (const check of releaseConfidenceCommandChecks) {
    if (priorFailure) {
      checks.push(skippedReleaseCheck(check, priorFailure));
      continue;
    }

    const result = runReleaseCheck(check);
    checks.push(result);
    if (result.status !== "passed") {
      priorFailure = result;
    }
  }

  const passedChecks = checks.filter((check) => check.status === "passed").length;
  const passed = checks.every((check) => check.status === "passed");
  const score = Number((passedChecks / checks.length).toFixed(2));
  const reasons = checks.filter((check) => check.status !== "passed").map((check) => check.reason);

  return {
    mode: "release",
    release: true,
    passed,
    score,
    commands_run: checks
      .filter((check) => check.status !== "skipped")
      .map((check) => check.command),
    planned_commands: releaseConfidenceCommandChecks.map((check) => check.command),
    checks,
    residual_risks: [
      "real Cursor harness behavior remains unproven unless validate:real-harness is also run against Cursor on a machine with Cursor installed",
      "machine-specific git, filesystem, auth, and repo-topology variation remains partially represented even after the release sentinel sweep"
    ],
    reasons: reasons.length > 0 ? reasons : [`Release confidence validation passed across ${checks.length} checks.`]
  };
}

async function main() {
  const payload = releaseMode
    ? await runReleaseConfidence()
    : await runNormalConfidence();

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    console.log(`${payload.mode === "release" ? "Release confidence" : "Confidence"} validation ${payload.passed ? "PASS" : "FAIL"} (score ${payload.score})`);

    for (const check of payload.checks) {
      console.log(`${iconForStatus(check.status)} ${check.name}: ${check.reason}`);
    }
  }

  process.exitCode = payload.passed ? 0 : 1;
}

const invokedScript = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;

if (invokedScript === import.meta.url) {
  await main();
}

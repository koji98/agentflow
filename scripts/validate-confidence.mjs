import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const jsonMode = process.argv.includes("--json");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const commandTimeoutMs = 15 * 60 * 1000;

export const confidenceCommandChecks = [
  { name: "smoke gate", script: "validate:smoke" },
  { name: "coverage policy", script: "test:coverage" },
  { name: "browser smoke", script: "test:browser" }
];

export const confidenceResidualRisks = [
  "browser proof remains limited to a completed Chromium smoke rather than live active-run updates or multi-browser behavior",
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

function iconForStatus(status) {
  if (status === "passed") {
    return "[pass]";
  }

  if (status === "skipped") {
    return "[skip]";
  }

  return "[fail]";
}

async function main() {
  const checks = [];
  const alphaCheck = confidenceCommandChecks[0];
  const alphaResult = runJsonCheck(alphaCheck);
  checks.push(alphaResult);

  if (alphaResult.status !== "passed") {
    checks.push({
      name: confidenceCommandChecks[1].name,
      script: confidenceCommandChecks[1].script,
      command: `npm run ${confidenceCommandChecks[1].script} -- --json`,
      status: "skipped",
      reason: "validate:smoke failed, so the coverage policy did not run."
    });
    checks.push({
      name: confidenceCommandChecks[2].name,
      script: confidenceCommandChecks[2].script,
      command: `npm run ${confidenceCommandChecks[2].script} -- --json`,
      status: "skipped",
      reason: "validate:smoke failed, so the browser smoke checks did not run."
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
    passed,
    score,
    commands_run: checks
      .filter((check) => check.status !== "skipped")
      .map((check) => check.command),
    checks,
    residual_risks: confidenceResidualRisks,
    reasons: reasons.length > 0 ? reasons : [`Confidence validation passed across ${checks.length} checks.`]
  };

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    console.log(`Confidence validation ${passed ? "PASS" : "FAIL"} (score ${score})`);

    for (const check of checks) {
      console.log(`${iconForStatus(check.status)} ${check.name}: ${check.reason}`);
    }
  }

  process.exitCode = passed ? 0 : 1;
}

const invokedScript = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;

if (invokedScript === import.meta.url) {
  await main();
}

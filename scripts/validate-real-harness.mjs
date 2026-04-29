import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { access, mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const argv = process.argv.slice(2);
const jsonMode = argv.includes("--json");
const commandTimeoutMs = 20 * 60 * 1000;
const builtCliRelativePath = "dist/cli/index.js";

export const realHarnessSpecs = [
  {
    kind: "codex-cli",
    envVar: "AGENTFLOW_CODEX_CLI_BIN",
    defaultBinary: "codex",
    modelEnvVar: "AGENTFLOW_CODEX_MODEL",
    defaultModel: "gpt-5.4-mini",
    sandbox: "workspace-write"
  },
  {
    kind: "cursor-cli",
    envVar: "AGENTFLOW_CURSOR_CLI_BIN",
    defaultBinary: "agent",
    modelEnvVar: "AGENTFLOW_CURSOR_MODEL",
    defaultModel: "gpt-5.4-mini-medium",
    sandbox: "workspace-write"
  }
];

export const realHarnessContract = {
  builtCliRelativePath,
  selectionEnvVar: "AGENTFLOW_REAL_HARNESS",
  smokeGraph: {
    workspaceBackend: "inplace",
    nodeKind: "agent",
    timeoutSec: 180
  },
  artifactChecks: [
    "run.json status",
    "state.json status",
    "summary.md status",
    "run.completed event",
    "agent_response artifact"
  ],
  scenarios: ["smoke", "supervisor-recovery"],
  supportedHarnesses: realHarnessSpecs.map((spec) => ({
    kind: spec.kind,
    envVar: spec.envVar,
    defaultBinary: spec.defaultBinary,
    modelEnvVar: spec.modelEnvVar
  }))
};

export function extractSummaryDiagnostics(summaryText) {
  const lines = summaryText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const diagnosticsHeading = lines.findIndex((line) => line === "## Diagnostics");

  if (diagnosticsHeading < 0) {
    return [];
  }

  const diagnostics = [];

  for (const line of lines.slice(diagnosticsHeading + 1)) {
    if (line.startsWith("## ")) {
      break;
    }

    if (line.startsWith("- ")) {
      diagnostics.push(line.slice(2));
    }
  }

  return diagnostics;
}

export function summarizeHarnessFailure(options) {
  const details = [];

  if (options.diagnostics.length > 0) {
    details.push(`Diagnostics: ${options.diagnostics.slice(0, 3).join(" | ")}`);
  } else if (options.message) {
    details.push(options.message);
  }

  if (options.summaryFile) {
    details.push(`summary.md: ${options.summaryFile}`);
  }

  if (options.runRoot) {
    details.push(`run_root: ${options.runRoot}`);
  }

  return `${options.harnessKind} smoke failed against ${options.detectedBinaryPath}: ${details.join(" | ")}`;
}

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

function summarizeHarnessStderr(stderrText) {
  const messageMatch = stderrText.match(/"message":\s*"([^"]+)"/);

  if (messageMatch?.[1]) {
    return messageMatch[1];
  }

  const errorLine = stripAnsi(stderrText)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("ERROR: "));

  if (errorLine) {
    return errorLine.slice("ERROR: ".length);
  }

  return summarizeOutput(stderrText);
}

function runCommand(command, args, displayName, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    encoding: "utf8",
    env: { ...process.env, CI: process.env.CI ?? "1", ...(options.env ?? {}) },
    maxBuffer: 10 * 1024 * 1024,
    timeout: options.timeoutMs ?? commandTimeoutMs
  });

  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");

  if (result.error) {
    return {
      passed: false,
      reason: `${displayName} failed to start: ${result.error.message}`,
      stdout: result.stdout ?? ""
    };
  }

  if (result.signal) {
    return {
      passed: false,
      reason: `${displayName} terminated with signal ${result.signal}: ${summarizeOutput(output)}`,
      stdout: result.stdout ?? ""
    };
  }

  if (result.status !== 0) {
    return {
      passed: false,
      reason: `${displayName} failed with exit code ${result.status}: ${summarizeOutput(output)}`,
      stdout: result.stdout ?? ""
    };
  }

  return {
    passed: true,
    reason: `${displayName} passed.`,
    stdout: result.stdout ?? ""
  };
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

function expectRecord(value, fieldName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object.`);
  }

  return value;
}

function expectString(value, fieldName) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }

  return value;
}

function canAccessExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    if (process.platform !== "win32") {
      return false;
    }

    try {
      accessSync(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

export function executableCandidates(binary, env = process.env) {
  if (binary.length === 0) {
    return [];
  }

  if (binary.includes("/") || binary.includes("\\") || isAbsolute(binary)) {
    return [binary];
  }

  const pathEntries = (env.PATH ?? "")
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  const pathExtensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .map((value) => value.trim())
          .filter(Boolean)
      : [""];

  return pathEntries.flatMap((entry) => pathExtensions.map((extension) => join(entry, `${binary}${extension}`)));
}

function normalizeRequestedHarness(value) {
  const trimmed = value.trim();

  if (trimmed === "all" || trimmed === "*") {
    return realHarnessSpecs.map((spec) => spec.kind);
  }

  if (!trimmed) {
    return [];
  }

  return trimmed.split(",").map((item) => item.trim()).filter(Boolean);
}

export function parseRequestedHarnessKinds(argvInput = argv, env = process.env) {
  const cliKinds = [];

  for (let index = 0; index < argvInput.length; index += 1) {
    const argument = argvInput[index];

    if (argument === "--json" || argument === "--help") {
      continue;
    }

    if (argument === "--scenario") {
      const value = argvInput[index + 1];

      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --scenario. Use smoke or supervisor-recovery.");
      }

      index += 1;
      continue;
    }

    if (argument.startsWith("--scenario=")) {
      continue;
    }

    if (argument === "--harness") {
      const value = argvInput[index + 1];

      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --harness. Use codex-cli, cursor-cli, or all.");
      }

      cliKinds.push(...normalizeRequestedHarness(value));
      index += 1;
      continue;
    }

    if (argument.startsWith("--harness=")) {
      cliKinds.push(...normalizeRequestedHarness(argument.slice("--harness=".length)));
      continue;
    }

    throw new Error(`Unknown argument "${argument}". Use --harness, --scenario, --json, or --help.`);
  }

  const requestedKinds =
    cliKinds.length > 0
      ? cliKinds
      : normalizeRequestedHarness(env[realHarnessContract.selectionEnvVar] ?? "");
  const fallbackKinds = realHarnessSpecs.map((spec) => spec.kind);
  const selectedKinds = requestedKinds.length > 0 ? requestedKinds : fallbackKinds;
  const supportedKinds = new Set(fallbackKinds);

  for (const kind of selectedKinds) {
    if (!supportedKinds.has(kind)) {
      throw new Error(`Unsupported harness "${kind}". Use codex-cli, cursor-cli, or all.`);
    }
  }

  return [...new Set(selectedKinds)];
}

export function parseRequestedScenario(argvInput = argv, env = process.env) {
  let scenario = env.AGENTFLOW_REAL_HARNESS_SCENARIO?.trim() || "smoke";

  for (let index = 0; index < argvInput.length; index += 1) {
    const argument = argvInput[index];

    if (argument === "--scenario") {
      const value = argvInput[index + 1];

      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --scenario. Use smoke or supervisor-recovery.");
      }

      scenario = value.trim();
      index += 1;
      continue;
    }

    if (argument.startsWith("--scenario=")) {
      scenario = argument.slice("--scenario=".length).trim();
    }
  }

  if (!realHarnessContract.scenarios.includes(scenario)) {
    throw new Error(`Unsupported scenario "${scenario}". Use smoke or supervisor-recovery.`);
  }

  return scenario;
}

export function inspectHarnessBinary(spec, env = process.env) {
  const configuredBinary = env[spec.envVar]?.trim();
  const binary = configuredBinary || spec.defaultBinary;
  const detectedPath = executableCandidates(binary, env).find((candidate) => canAccessExecutable(candidate));

  return {
    kind: spec.kind,
    envVar: spec.envVar,
    binary,
    binarySource: configuredBinary ? "env-override" : "path-default",
    available: Boolean(detectedPath),
    ...(detectedPath ? { detectedPath } : {})
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

function renderUsage() {
  return [
    "Usage: npm run validate:real-harness -- [--harness codex-cli|cursor-cli|all] [--scenario smoke|supervisor-recovery] [--json]",
    "",
    "Selection rules:",
    "- When --harness is omitted, AGENTFLOW_REAL_HARNESS is used if set.",
    "- When neither is set, the command inspects both supported harness binaries on PATH.",
    "- Missing harness binaries are reported as skipped instead of failing the deterministic gates.",
    "- --scenario supervisor-recovery currently requires --harness codex-cli and validates the supervisor recovery loop against a local HTTP docs fixture.",
    "",
    "Binary overrides:",
    "- AGENTFLOW_CODEX_CLI_BIN",
    "- AGENTFLOW_CURSOR_CLI_BIN",
    "",
    "Model overrides:",
    "- AGENTFLOW_CODEX_MODEL",
    "- AGENTFLOW_CURSOR_MODEL"
  ].join("\n");
}

async function fileExists(relativePath) {
  try {
    await access(resolve(rootDir, relativePath), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function initializeGitRepo(repoDir) {
  const steps = [
    ["init"],
    ["config", "user.email", "agentflow@example.com"],
    ["config", "user.name", "Agentflow Real Harness Smoke"]
  ];

  for (const args of steps) {
    const result = runCommand("git", args, `git ${args.join(" ")}`, { cwd: repoDir });

    if (!result.passed) {
      throw new Error(result.reason);
    }
  }

  await writeFile(join(repoDir, "README.md"), "real harness smoke\n");

  for (const args of [["add", "README.md"], ["commit", "-m", "init"]]) {
    const result = runCommand("git", args, `git ${args.join(" ")}`, { cwd: repoDir });

    if (!result.passed) {
      throw new Error(result.reason);
    }
  }
}

function buildSmokePrompt(harnessKind) {
  return [
    `Agentflow real harness smoke for ${harnessKind}.`,
    "Return a brief acknowledgement that the smoke path is connected.",
    "Do not modify repository files.",
    "Do not install dependencies."
  ].join(" ");
}

export function resolveHarnessModel(spec, env = process.env) {
  const configuredModel = spec.modelEnvVar ? env[spec.modelEnvVar]?.trim() : "";
  return configuredModel || spec.defaultModel;
}

export function buildSmokeGraphDocument(spec, env = process.env) {
  const timeoutSec = realHarnessContract.smokeGraph.timeoutSec;
  return {
    version: "1",
    graph_id: `real-harness-${spec.kind}`,
    intent: {
      goal: `Validate the ${spec.kind} real harness adapter.`,
      acceptance_criteria: [
        "The harness launches through the built Agentflow CLI.",
        "The node returns a captured final response."
      ],
      constraints: ["Do not perform external side effects during real harness validation."]
    },
    repos: {
      main: {
        path: "./repo"
      }
    },
    defaults: {
      launch_profile: "default",
      workspace_backend: realHarnessContract.smokeGraph.workspaceBackend
    },
    profiles: {
      default: {
        harness: spec.kind,
        model: resolveHarnessModel(spec, env),
        sandbox: spec.sandbox,
        timeout_sec: timeoutSec
      }
    },
    graph: {
      type: "sequence",
      id: "root",
      steps: [
        {
          type: "agent",
          id: "real-smoke-agent",
          repo: "main",
          goal: buildSmokePrompt(spec.kind)
        }
      ]
    }
  };
}

export function buildSupervisorRecoveryGraphDocument(spec, docsUrl, env = process.env) {
  const timeoutSec = realHarnessContract.smokeGraph.timeoutSec;
  return {
    version: "1",
    graph_id: `real-harness-supervisor-recovery-${spec.kind}`,
    intent: {
      goal: "Validate that supervisor recovery can gather external context and retry a failed real harness node.",
      acceptance_criteria: [
        "The first node attempt is rejected.",
        "The supervisor writes a case file, external evidence patch, recovery plan, and recovery envelope.",
        "The retried node uses the recovery envelope and local docs fixture to pass.",
        "The inactive fallback sentence containing `INTENTIONAL_FAILURE_DO_NOT_ACCEPT` is an intentional failed attempt and must not be accepted as terminal success."
      ],
      constraints: ["External context is read-only and must not change graph intent or declared artifacts."]
    },
    supervision: {
      actions: {
        semantic_evaluation: { max_uses: 2 },
        rebuild_context: { max_uses: 2 },
        retry_with_guidance: { max_uses: 2 },
        run_diagnostic: { max_uses: 2 },
        pause_for_human: { max_uses: 1 }
      },
      max_total_interventions: 4,
      policy: {
        pause_on_policy_risk: true,
        pause_on_repeated_recovery: true,
        drift_score_threshold: 0.8
      }
    },
    repos: {
      main: {
        path: "./repo"
      }
    },
    defaults: {
      launch_profile: "default",
      workspace_backend: realHarnessContract.smokeGraph.workspaceBackend
    },
    profiles: {
      default: {
        harness: spec.kind,
        model: resolveHarnessModel(spec, env),
        sandbox: spec.sandbox,
        timeout_sec: timeoutSec
      }
    },
    graph: {
      type: "sequence",
      id: "root",
      steps: [
        {
          type: "agent",
          id: "supervisor-recovery-agent",
          repo: "main",
          goal: [
            "This is a supervisor recovery validation scenario.",
            "Run `af supervision show` before deciding what to do.",
            "If it reports active=false, intentionally fail the node by finishing with exactly this sentence and no extra evidence: `INTENTIONAL_FAILURE_DO_NOT_ACCEPT: missing dependency docs for package fixturelib; please retry after supervisor gathers external context`.",
            `If it reports active=true, read the supervisor recovery envelope, fetch or read the local official docs fixture at ${docsUrl}, and finish with the exact phrase: fixturelib token is RECOVERED-FIXTURE-42.`,
            "Do not change repository files."
          ].join(" "),
          acceptance_criteria: [
            "Final response includes `fixturelib token is RECOVERED-FIXTURE-42`.",
            "The final attempt used an active supervisor recovery envelope.",
            `The final attempt cites or uses the local docs fixture at ${docsUrl}.`,
            "The inactive fallback sentence containing `INTENTIONAL_FAILURE_DO_NOT_ACCEPT` is deliberately non-compliant and must be rejected when it appears without an active recovery envelope."
          ]
        }
      ]
    }
  };
}

async function startDocsFixtureServer() {
  const body = [
    "# fixturelib official docs",
    "",
    "When supervisor recovery asks for external context, use token RECOVERED-FIXTURE-42.",
    "This local fixture is intentionally stable and read-only."
  ].join("\n");
  const bodyBuffer = Buffer.from(body, "utf8");
  const server = createServer((request, response) => {
    if (request.url === "/fixturelib" || request.url === "/fixturelib/") {
      response.writeHead(200, {
        "connection": "close",
        "content-length": String(bodyBuffer.length),
        "content-type": "text/markdown; charset=utf-8"
      });
      response.end(bodyBuffer);
      return;
    }

    response.writeHead(404, {
      "connection": "close",
      "content-length": "9",
      "content-type": "text/plain; charset=utf-8"
    });
    response.end("not found");
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();

  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to start local docs fixture server.");
  }

  return {
    url: `http://127.0.0.1:${address.port}/fixturelib`,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose()))
  };
}

async function createSmokeFixture(spec) {
  const tempRoot = await mkdtemp(join(tmpdir(), `agentflow-real-harness-${spec.kind}-`));
  const launchRoot = join(tempRoot, "launch");
  const repoDir = join(tempRoot, "repo");
  const graphPath = join(tempRoot, "agentflow.graph.json");
  const graphDocument = buildSmokeGraphDocument(spec);

  await mkdir(launchRoot, { recursive: true });
  await mkdir(repoDir, { recursive: true });
  const canonicalLaunchRoot = await realpath(launchRoot);
  await initializeGitRepo(repoDir);
  await writeFile(graphPath, `${JSON.stringify(graphDocument, null, 2)}\n`);

  return {
    tempRoot,
    launchRoot: canonicalLaunchRoot,
    graphPath,
    runsRoot: join(await realpath(tempRoot), ".agentflow", "runs")
  };
}

async function createSupervisorRecoveryFixture(spec) {
  const docsServer = await startDocsFixtureServer();
  const tempRoot = await mkdtemp(join(tmpdir(), `agentflow-real-harness-supervisor-recovery-${spec.kind}-`));
  const launchRoot = join(tempRoot, "launch");
  const repoDir = join(tempRoot, "repo");
  const graphPath = join(tempRoot, "agentflow.graph.json");
  const graphDocument = buildSupervisorRecoveryGraphDocument(spec, docsServer.url);

  await mkdir(launchRoot, { recursive: true });
  await mkdir(repoDir, { recursive: true });
  const canonicalLaunchRoot = await realpath(launchRoot);
  await initializeGitRepo(repoDir);
  await writeFile(graphPath, `${JSON.stringify(graphDocument, null, 2)}\n`);

  return {
    tempRoot,
    launchRoot: canonicalLaunchRoot,
    graphPath,
    runsRoot: join(await realpath(tempRoot), ".agentflow", "runs"),
    docsUrl: docsServer.url,
    close: docsServer.close
  };
}

async function readLatestExecutionFailure(runRoot) {
  const nodesRoot = join(runRoot, "nodes");
  const nodeEntries = await readdir(nodesRoot, {
    withFileTypes: true
  }).catch(() => []);
  const executions = [];

  for (const nodeEntry of nodeEntries) {
    if (!nodeEntry.isDirectory()) {
      continue;
    }

    const executionsRoot = join(nodesRoot, nodeEntry.name, "executions");
    const executionEntries = await readdir(executionsRoot, {
      withFileTypes: true
    }).catch(() => []);

    for (const executionEntry of executionEntries) {
      if (!executionEntry.isDirectory()) {
        continue;
      }

      const executionPath = join(executionsRoot, executionEntry.name, "execution.json");

      try {
        const executionRecord = expectRecord(
          JSON.parse(await readFile(executionPath, "utf8")),
          `execution record (${executionPath})`
        );
        executions.push(executionRecord);
      } catch {
        // Ignore unreadable execution records and keep looking for a usable failure summary.
      }
    }
  }

  const failedExecutions = executions
    .filter((execution) => execution.status === "failed")
    .sort((left, right) =>
      String(right.ended_at ?? right.started_at ?? "").localeCompare(String(left.ended_at ?? left.started_at ?? ""))
    );
  const latest = failedExecutions[0];

  if (!latest) {
    return undefined;
  }

  const stderrSummary =
    typeof latest.stderr_log_path === "string"
      ? summarizeHarnessStderr(await readFile(latest.stderr_log_path, "utf8").catch(() => ""))
      : "no output";

  if (stderrSummary === "no output") {
    return undefined;
  }

  return {
    compiledId: typeof latest.compiled_id === "string" ? latest.compiled_id : "unknown-node",
    executionId: typeof latest.execution_id === "string" ? latest.execution_id : "unknown-execution",
    stderrSummary
  };
}

async function readExecutionRecords(runRoot) {
  const nodesRoot = join(runRoot, "nodes");
  const nodeEntries = await readdir(nodesRoot, {
    withFileTypes: true
  }).catch(() => []);
  const executions = [];

  for (const nodeEntry of nodeEntries) {
    if (!nodeEntry.isDirectory()) {
      continue;
    }

    const executionsRoot = join(nodesRoot, nodeEntry.name, "executions");
    const executionEntries = await readdir(executionsRoot, {
      withFileTypes: true
    }).catch(() => []);

    for (const executionEntry of executionEntries) {
      if (!executionEntry.isDirectory()) {
        continue;
      }

      const executionDir = join(executionsRoot, executionEntry.name);
      const executionPath = join(executionDir, "execution.json");

      try {
        const record = expectRecord(
          JSON.parse(await readFile(executionPath, "utf8")),
          `execution record (${executionPath})`
        );
        executions.push({ ...record, execution_dir: executionDir });
      } catch {
        // Ignore unreadable execution records.
      }
    }
  }

  return executions;
}

async function verifyRunArtifacts(runRoot, expectedRunId, options = {}) {
  const agentId = options.agentId ?? "real-smoke-agent";
  const runRecord = expectRecord(
    JSON.parse(await readFile(join(runRoot, "run.json"), "utf8")),
    "run.json"
  );
  const state = expectRecord(
    JSON.parse(await readFile(join(runRoot, "state.json"), "utf8")),
    "state.json"
  );
  const summary = await readFile(join(runRoot, "summary.md"), "utf8");
  const events = (await readFile(join(runRoot, "events.jsonl"), "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  if (runRecord.run_id !== expectedRunId) {
    throw new Error(`run.json run_id must equal ${expectedRunId}.`);
  }

  if (runRecord.status !== "passed") {
    throw new Error("run.json status must equal \"passed\".");
  }

  if (state.run_id !== expectedRunId) {
    throw new Error(`state.json run_id must equal ${expectedRunId}.`);
  }

  if (state.status !== "passed") {
    throw new Error("state.json status must equal \"passed\".");
  }

  if (!summary.includes("- Status: `passed`") && !summary.includes("- Control-flow status: `passed`")) {
    throw new Error("summary.md must record a passed terminal status.");
  }

  if (!events.some((event) => event?.type === "run.completed")) {
    throw new Error("events.jsonl must contain a run.completed event.");
  }

  const executions = await readExecutionRecords(runRoot);
  const agentExecution = executions.find((execution) => execution.authored_id === agentId);
  if (!agentExecution) {
    throw new Error(`${agentId} execution record must exist.`);
  }

  const artifacts = expectRecord(agentExecution.artifacts, `${agentId} artifacts`);
  const agentResponsePath = expectString(artifacts.agent_response, `${agentId} agent_response artifact`);
  const agentResponse = await readFile(agentResponsePath, "utf8");

  if (agentResponse.trim().length === 0) {
    throw new Error("agent_response artifact must be non-empty.");
  }
}

async function findFiles(root, filename) {
  const found = [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    const path = join(root, entry.name);

    if (entry.isDirectory()) {
      found.push(...await findFiles(path, filename));
      continue;
    }

    if (entry.isFile() && entry.name === filename) {
      found.push(path);
    }
  }

  return found;
}

async function verifySupervisorRecoveryArtifacts(runRoot, expectedRunId) {
  await verifyRunArtifacts(runRoot, expectedRunId, { agentId: "supervisor-recovery-agent" });
  const events = (await readFile(join(runRoot, "events.jsonl"), "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const executions = await readExecutionRecords(runRoot);
  const nodeAttempts = executions.filter((execution) => execution.authored_id === "supervisor-recovery-agent");

  if (nodeAttempts.length < 2) {
    throw new Error("supervisor recovery scenario must execute the node at least twice.");
  }

  if (!nodeAttempts.some((execution) => execution.status === "failed")) {
    throw new Error("supervisor recovery scenario must record a failed first attempt.");
  }

  if (!events.some((event) => event?.type === "supervisor.retry_scheduled")) {
    throw new Error("events.jsonl must contain supervisor.retry_scheduled.");
  }

  const caseFiles = await findFiles(runRoot, "case-file.json");
  const evidencePatches = await findFiles(runRoot, "evidence-patch.json");
  const recoveryPlans = await findFiles(runRoot, "recovery-plan.json");
  const recoveryEnvelopes = await findFiles(runRoot, "recovery-envelope.json");

  if (caseFiles.length === 0) {
    throw new Error("supervisor recovery scenario must write a case-file.json.");
  }

  if (recoveryPlans.length === 0) {
    throw new Error("supervisor recovery scenario must write a recovery-plan.json.");
  }

  if (recoveryEnvelopes.length === 0) {
    throw new Error("supervisor recovery scenario must write a recovery-envelope.json.");
  }

  const externalEvidence = [];
  for (const patchPath of evidencePatches) {
    const patch = JSON.parse(await readFile(patchPath, "utf8"));
    if (patch?.kind === "external_context") {
      externalEvidence.push(patchPath);
    }
  }

  if (externalEvidence.length === 0) {
    throw new Error("supervisor recovery scenario must write an external_context evidence patch.");
  }

  const retryAttempt = nodeAttempts.find((execution) => typeof execution.prompt_path === "string" && execution.prompt_path.length > 0 && execution.attempt_index > 1);
  if (!retryAttempt) {
    throw new Error("retried node attempt must record prompt_path.");
  }

  const retryPrompt = await readFile(retryAttempt.prompt_path, "utf8");
  const retryPromptSha256 = createHash("sha256").update(retryPrompt).digest("hex");
  if (retryAttempt.prompt_sha256 !== retryPromptSha256) {
    throw new Error("retried node attempt must record prompt_sha256 for the exact prompt.");
  }
  if (!retryPrompt.includes("## Supervisor Recovery Envelope")) {
    throw new Error("second node attempt must receive the supervisor recovery envelope.");
  }

  const finalAttempt = nodeAttempts.at(-1);
  const artifacts = expectRecord(finalAttempt.artifacts, "supervisor-recovery-agent artifacts");
  const agentResponsePath = expectString(artifacts.agent_response, "supervisor-recovery-agent agent_response artifact");
  const agentResponse = await readFile(agentResponsePath, "utf8");
  if (!agentResponse.includes("RECOVERED-FIXTURE-42")) {
    throw new Error("final agent response must include the recovered fixture token.");
  }
}

async function canonicalizeExistingPath(absolutePath) {
  return await realpath(absolutePath).catch(() => resolve(absolutePath));
}

function renderSkipReason(spec, inspection) {
  return `${spec.kind} binary "${inspection.binary}" is unavailable. Set ${spec.envVar} or install it on PATH. The smoke would have run the built CLI against a one-node real harness graph and verified durable passed artifacts and captured agent response.`;
}

async function describeFailedRun(spec, inspection, runResult) {
  try {
    const payload = expectRecord(
      parseJsonOutput(`real harness smoke (${spec.kind})`, runResult.stdout),
      `run payload (${spec.kind})`
    );
    const artifacts = payload.artifacts && typeof payload.artifacts === "object" && !Array.isArray(payload.artifacts)
      ? payload.artifacts
      : undefined;
    const summaryFile =
      artifacts && typeof artifacts.summary_file === "string" && artifacts.summary_file.length > 0
        ? artifacts.summary_file
        : undefined;
    const runRoot = typeof payload.run_root === "string" ? payload.run_root : undefined;
    const executionFailure = runRoot ? await readLatestExecutionFailure(runRoot) : undefined;
    const diagnostics = [
      ...(executionFailure
        ? [
            `\`${executionFailure.compiledId}\` (${executionFailure.executionId}): ${executionFailure.stderrSummary}`
          ]
        : []),
      ...(summaryFile ? extractSummaryDiagnostics(await readFile(summaryFile, "utf8")) : [])
    ];
    const reason = summarizeHarnessFailure({
      harnessKind: spec.kind,
      detectedBinaryPath: inspection.detectedPath,
      message: typeof payload.message === "string" ? payload.message : runResult.reason,
      diagnostics,
      summaryFile,
      runRoot
    });

    return {
      reason,
      ...(runRoot ? { run_root: runRoot } : {}),
      ...(summaryFile ? { summary_file: summaryFile } : {})
    };
  } catch {
    return {
      reason: runResult.reason
    };
  }
}

async function runRealHarnessSmoke(spec, builtCliPath, inspection) {
  if (!inspection.available) {
    return {
      harness: spec.kind,
      status: "skipped",
      reason: renderSkipReason(spec, inspection),
      binary: inspection.binary,
      binary_source: inspection.binarySource
    };
  }

  const fixture = await createSmokeFixture(spec);
  const startedAt = Date.now();
  let shouldCleanup = true;

  try {
    const env =
      {
        [spec.envVar]: inspection.detectedPath
      };
    const runResult = runCommand(
      process.execPath,
      [builtCliPath, "run", "--graph", fixture.graphPath],
      `real harness smoke (${spec.kind})`,
      {
        cwd: fixture.launchRoot,
        env
      }
    );

    if (!runResult.passed) {
      shouldCleanup = false;
      const failedRun = await describeFailedRun(spec, inspection, runResult);

      return {
        harness: spec.kind,
        status: "failed",
        reason: failedRun.reason,
        binary: inspection.binary,
        binary_source: inspection.binarySource,
        detected_binary_path: inspection.detectedPath,
        ...(failedRun.run_root ? { run_root: failedRun.run_root } : {}),
        ...(failedRun.summary_file ? { summary_file: failedRun.summary_file } : {})
      };
    }

    const payload = expectRecord(
      parseJsonOutput(`real harness smoke (${spec.kind})`, runResult.stdout),
      `run payload (${spec.kind})`
    );
    const runId = expectString(payload.run_id, `run payload.run_id (${spec.kind})`);
    const runRoot = expectString(payload.run_root, `run payload.run_root (${spec.kind})`);

    if (payload.command !== "run") {
      throw new Error(`run payload.command must equal "run" for ${spec.kind}.`);
    }

    if (payload.status !== "passed") {
      throw new Error(`run payload.status must equal "passed" for ${spec.kind}.`);
    }

    const actualRunsRoot = await canonicalizeExistingPath(payload.runs_root);
    const expectedRunsRoot = await canonicalizeExistingPath(fixture.runsRoot);

    if (actualRunsRoot !== expectedRunsRoot) {
      throw new Error(`run payload.runs_root must equal ${fixture.runsRoot} for ${spec.kind}.`);
    }

    await verifyRunArtifacts(runRoot, runId);

    return {
      harness: spec.kind,
      status: "passed",
      reason: `${spec.kind} smoke passed against ${inspection.detectedPath}.`,
      binary: inspection.binary,
      binary_source: inspection.binarySource,
      detected_binary_path: inspection.detectedPath,
      runs_root: fixture.runsRoot,
      run_root: runRoot,
      duration_ms: Date.now() - startedAt
    };
  } catch (error) {
    shouldCleanup = false;
    return {
      harness: spec.kind,
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
      binary: inspection.binary,
      binary_source: inspection.binarySource,
      ...(inspection.detectedPath ? { detected_binary_path: inspection.detectedPath } : {})
    };
  } finally {
    if (shouldCleanup) {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  }
}

async function runRealHarnessSupervisorRecovery(spec, builtCliPath, inspection) {
  if (!inspection.available) {
    return {
      harness: spec.kind,
      scenario: "supervisor-recovery",
      status: "skipped",
      reason: renderSkipReason(spec, inspection),
      binary: inspection.binary,
      binary_source: inspection.binarySource
    };
  }

  if (spec.kind !== "codex-cli") {
    return {
      harness: spec.kind,
      scenario: "supervisor-recovery",
      status: "skipped",
      reason: "supervisor-recovery real harness scenario currently requires codex-cli.",
      binary: inspection.binary,
      binary_source: inspection.binarySource
    };
  }

  const fixture = await createSupervisorRecoveryFixture(spec);
  const startedAt = Date.now();
  let shouldCleanup = true;

  try {
    const env = {
      [spec.envVar]: inspection.detectedPath
    };
    const runResult = runCommand(
      process.execPath,
      [builtCliPath, "run", "--graph", fixture.graphPath],
      `real harness supervisor recovery (${spec.kind})`,
      {
        cwd: fixture.launchRoot,
        env
      }
    );

    if (!runResult.passed) {
      shouldCleanup = false;
      const failedRun = await describeFailedRun(spec, inspection, runResult);

      return {
        harness: spec.kind,
        scenario: "supervisor-recovery",
        status: "failed",
        reason: failedRun.reason,
        binary: inspection.binary,
        binary_source: inspection.binarySource,
        detected_binary_path: inspection.detectedPath,
        ...(failedRun.run_root ? { run_root: failedRun.run_root } : {}),
        ...(failedRun.summary_file ? { summary_file: failedRun.summary_file } : {})
      };
    }

    const payload = expectRecord(
      parseJsonOutput(`real harness supervisor recovery (${spec.kind})`, runResult.stdout),
      `run payload (${spec.kind})`
    );
    const runId = expectString(payload.run_id, `run payload.run_id (${spec.kind})`);
    const runRoot = expectString(payload.run_root, `run payload.run_root (${spec.kind})`);

    if (payload.status !== "passed") {
      throw new Error(`run payload.status must equal "passed" for ${spec.kind}.`);
    }

    await verifySupervisorRecoveryArtifacts(runRoot, runId);

    return {
      harness: spec.kind,
      scenario: "supervisor-recovery",
      status: "passed",
      reason: `${spec.kind} supervisor recovery scenario passed against ${inspection.detectedPath}.`,
      binary: inspection.binary,
      binary_source: inspection.binarySource,
      detected_binary_path: inspection.detectedPath,
      docs_url: fixture.docsUrl,
      runs_root: fixture.runsRoot,
      run_root: runRoot,
      duration_ms: Date.now() - startedAt
    };
  } catch (error) {
    shouldCleanup = false;
    return {
      harness: spec.kind,
      scenario: "supervisor-recovery",
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
      binary: inspection.binary,
      binary_source: inspection.binarySource,
      ...(inspection.detectedPath ? { detected_binary_path: inspection.detectedPath } : {})
    };
  } finally {
    await fixture.close();
    if (shouldCleanup) {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  }
}

async function main() {
  if (argv.includes("--help")) {
    process.stdout.write(`${renderUsage()}\n`);
    return;
  }

  let requestedKinds;
  let requestedScenario;

  try {
    requestedKinds = parseRequestedHarnessKinds();
    requestedScenario = parseRequestedScenario();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    if (jsonMode) {
      process.stdout.write(
        `${JSON.stringify({ status: "failed", results: [], reasons: [reason] }, null, 2)}\n`
      );
    } else {
      console.log(`Real harness validation FAIL`);
      console.log(`[fail] usage: ${reason}`);
      console.log(renderUsage());
    }

    process.exitCode = 2;
    return;
  }

  const selectedSpecs = requestedKinds.map((kind) => {
    const spec = realHarnessSpecs.find((entry) => entry.kind === kind);

    if (!spec) {
      throw new Error(`Unsupported harness "${kind}".`);
    }

    return spec;
  });
  const inspections = selectedSpecs.map((spec) => ({
    spec,
    inspection: inspectHarnessBinary(spec)
  }));
  const availableInspections = inspections.filter((entry) => entry.inspection.available);

  if (availableInspections.length === 0) {
    const results = inspections.map(({ spec, inspection }) => ({
      harness: spec.kind,
      status: "skipped",
      reason: renderSkipReason(spec, inspection),
      binary: inspection.binary,
      binary_source: inspection.binarySource
    }));
    const payload = {
      status: "skipped",
      attempted_harnesses: 0,
      passed_harnesses: 0,
      skipped_harnesses: results.length,
      results,
      reasons: ["No configured real harness binaries were available, so the optional smoke did not run."]
    };

    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      console.log("Real harness validation SKIP");

      for (const result of results) {
        console.log(`${iconForStatus(result.status)} ${result.harness}: ${result.reason}`);
      }
    }

    return;
  }

  if (!(await fileExists(builtCliRelativePath))) {
    const payload = {
      status: "failed",
      attempted_harnesses: 0,
      passed_harnesses: 0,
      skipped_harnesses: inspections.length - availableInspections.length,
      results: [],
      reasons: [
        `Missing built CLI at ${builtCliRelativePath}. Run npm run build or npm run validate:smoke before validate:real-harness.`
      ]
    };

    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      console.log("Real harness validation FAIL");
      console.log(`[fail] built CLI: ${payload.reasons[0]}`);
    }

    process.exitCode = 1;
    return;
  }

  const builtCliPath = resolve(rootDir, builtCliRelativePath);
  const results = [];

  for (const { spec, inspection } of inspections) {
    results.push(
      requestedScenario === "supervisor-recovery"
        ? await runRealHarnessSupervisorRecovery(spec, builtCliPath, inspection)
        : await runRealHarnessSmoke(spec, builtCliPath, inspection)
    );
  }

  const failedCount = results.filter((result) => result.status === "failed").length;
  const passedCount = results.filter((result) => result.status === "passed").length;
  const skippedCount = results.filter((result) => result.status === "skipped").length;
  const status = failedCount > 0 ? "failed" : passedCount > 0 ? "passed" : "skipped";
  const payload = {
    status,
    attempted_harnesses: passedCount + failedCount,
    passed_harnesses: passedCount,
    skipped_harnesses: skippedCount,
    results,
    reasons:
      status === "failed"
      ? results.filter((result) => result.status === "failed").map((result) => result.reason)
      : status === "passed"
          ? [`Real harness ${requestedScenario} scenario passed for ${passedCount} harness${passedCount === 1 ? "" : "es"}.`]
          : ["No configured real harness binaries were available, so the optional smoke did not run."]
  };

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    console.log(`Real harness validation ${status.toUpperCase()}`);

    for (const result of results) {
      console.log(`${iconForStatus(result.status)} ${result.harness}: ${result.reason}`);
    }
  }

  process.exitCode = status === "failed" ? 1 : 0;
}

const invokedScript = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;

if (invokedScript === import.meta.url) {
  await main();
}

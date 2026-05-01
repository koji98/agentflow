import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const jsonMode = process.argv.includes("--json");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const commandTimeoutMs = 30 * 60 * 1000;
const builtCliRelativePath = "dist/cli/index.js";
const fixtureGraphRelativePath = "tests/graph/fixtures/repeat.graph.json";
const fixtureGraphId = "repeat-graph";
const builtCliFixtureCommands = ["validate", "validate --show-compiled", "validate --review", "validate --diagram"];
const builtCliRunHarnessAdapters = ["codex-cli", "cursor-cli"];
const builtCliRunWorkspaceBackends = ["inplace", "worktree"];

export const canonicalDocs = [
  "README.md",
  "docs/README.md",
  "docs/product/README.md",
  "docs/product/scope.md",
  "docs/product/operations.md",
  "docs/product/evals.md",
  "docs/product/managed-patterns.md",
  "docs/product/plugins.md",
  "docs/product/patterns/README.md",
  "docs/product/patterns/deep-research.md",
  "docs/product/patterns/spec-design.md",
  "docs/product/patterns/generate-evaluate-fix.md",
  "docs/product/patterns/review-change.md",
  "docs/technical/README.md",
  "docs/technical/architecture.md",
  "docs/technical/runtime-lifecycle.md",
  "docs/technical/context-and-artifacts.md",
  "docs/technical/runtime-tooling.md",
  "docs/technical/outcome-verification.md",
  "docs/technical/node-workspace-snapshots.md",
  "docs/technical/prompt-iteration-report.md",
  "docs/examples/README.md"
];

export const commandChecks = [
  { name: "typecheck", script: "typecheck" },
  { name: "tests", script: "test" },
  { name: "build", script: "build" },
  { name: "skill pack", script: "validate:skills" }
];

export const builtCliSmokeContract = {
  builtCliRelativePath,
  fixtureGraphRelativePath,
  fixtureGraphId,
  fixtureCommands: builtCliFixtureCommands,
  runHarnessAdapters: builtCliRunHarnessAdapters,
  runWorkspaceBackends: builtCliRunWorkspaceBackends
};

export const smokeResidualRisks = [
  "measured coverage floors are not part of validate:smoke",
  "manual run-artifact inspection is not part of validate:smoke",
  "real Codex or Cursor installs are not exercised by validate:smoke",
  "abrupt packaged-CLI death or host restart recovery beyond the deterministic suite remains unproven"
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

async function fileExists(relativePath) {
  try {
    await access(resolve(rootDir, relativePath), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(absolutePath) {
  try {
    await access(absolutePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function runCommand(command, args, displayName, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    encoding: "utf8",
    env: { ...process.env, CI: process.env.CI ?? "1", ...(options.env ?? {}) },
    maxBuffer: 10 * 1024 * 1024,
    timeout: commandTimeoutMs
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

function runNpmScript(scriptName) {
  return runCommand(npmCommand, ["run", scriptName], scriptName);
}

function ensureCommandPassed(command, args, displayName, options = {}) {
  const result = runCommand(command, args, displayName, options);

  if (!result.passed) {
    throw new Error(result.reason);
  }
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

function expectNumber(value, fieldName) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`${fieldName} must be a number.`);
  }

  return value;
}

function expectString(value, fieldName) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }

  return value;
}

async function initializeGitRepo(repoDir) {
  ensureCommandPassed("git", ["init"], "validate:smoke git init", {
    cwd: repoDir
  });
  ensureCommandPassed("git", ["config", "user.email", "agentflow@example.com"], "validate:smoke git config email", {
    cwd: repoDir
  });
  ensureCommandPassed("git", ["config", "user.name", "Agentflow Validate Smoke"], "validate:smoke git config name", {
    cwd: repoDir
  });
  await writeFile(join(repoDir, "README.md"), "seed\n");
  ensureCommandPassed("git", ["add", "README.md"], "validate:smoke git add", {
    cwd: repoDir
  });
  ensureCommandPassed("git", ["commit", "-m", "init"], "validate:smoke git commit", {
    cwd: repoDir
  });
}

async function createMockCodexBinary(tempRoot) {
  const binaryPath = join(tempRoot, "mock-codex.mjs");
  const source = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const outputIndex = args.findIndex((arg) => arg === "--output-last-message");
  const lastMessagePath = outputIndex >= 0 ? args[outputIndex + 1] : undefined;

  if (lastMessagePath) {
    writeFileSync(lastMessagePath, JSON.stringify({ passed: true, summary: "codex smoke ok", findings: [] }));
  }

  process.stdout.write('{"passed":true,"summary":"codex smoke ok","findings":[]}');
});
`;

  await writeFile(binaryPath, source);
  await chmod(binaryPath, 0o755);
  return binaryPath;
}

async function createMockCursorBinary(tempRoot) {
  const binaryPath = join(tempRoot, "mock-agent.mjs");
  const source = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: JSON.stringify({ passed: true, summary: "cursor smoke ok", findings: [] }),
  session_id: "validate-smoke"
}));
`;

  await writeFile(binaryPath, source);
  await chmod(binaryPath, 0o755);
  return binaryPath;
}

async function createRunSmokeFixture(harnessKind, workspaceBackend) {
  const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-validate-smoke-run-"));
  const repoDir = join(tempRoot, "repo");
  const graphPath = join(tempRoot, "agentflow.graph.json");
  const launchRoot = await realpath(tempRoot);

  await mkdir(repoDir, { recursive: true });
  await initializeGitRepo(repoDir);

  const binaryPath =
    harnessKind === "codex-cli"
      ? await createMockCodexBinary(tempRoot)
      : await createMockCursorBinary(tempRoot);

  const graphDocument = {
    version: "1",
    graph_id: `validate-smoke-${harnessKind}`,
    intent: {
      goal: `Run the built CLI smoke graph through ${harnessKind}.`,
      acceptance_criteria: [
        "The harness adapter launches successfully.",
        "The runtime writes terminal run and delivery artifacts."
      ],
      constraints: ["Do not perform external side effects during smoke validation."]
    },
    repos: {
      main: {
        path: "./repo"
      }
    },
    defaults: {
      launch_profile: "default",
      workspace_backend: workspaceBackend
    },
    profiles: {
      default: {
        harness: harnessKind,
        model: harnessKind === "codex-cli" ? "gpt-5-codex" : "gpt-5-cursor",
        sandbox: harnessKind === "codex-cli" ? "workspace-write" : "read-only",
        timeout_sec: 30
      }
    },
    graph: {
      type: "sequence",
      id: "root",
      steps: [
        {
          type: "agent",
          id: "smoke-agent",
          repo: "main",
          goal: `Run the ${harnessKind} smoke test.`
        }
      ]
    }
  };

  await writeFile(graphPath, `${JSON.stringify(graphDocument, null, 2)}\n`);

  return {
    tempRoot,
    launchRoot,
    graphPath,
    runsRoot: join(tempRoot, ".agentflow", "runs"),
    harnessKind,
    workspaceBackend,
    repoDir,
    env:
      harnessKind === "codex-cli"
        ? {
            AGENTFLOW_CODEX_CLI_BIN: binaryPath
          }
        : {
            AGENTFLOW_CURSOR_CLI_BIN: binaryPath
          }
  };
}

async function checkCanonicalDocs() {
  const missingDocs = (
    await Promise.all(
      canonicalDocs.map(async (relativePath) => ({
        relativePath,
        exists: await fileExists(relativePath)
      }))
    )
  )
    .filter((entry) => !entry.exists)
    .map((entry) => entry.relativePath);

  if (missingDocs.length > 0) {
    return {
      name: "canonical docs",
      passed: false,
      reason: `Missing canonical operating docs: ${missingDocs.join(", ")}`,
      details: {
        canonical_docs: canonicalDocs
      }
    };
  }

  return {
    name: "canonical docs",
    passed: true,
    reason: `All ${canonicalDocs.length} canonical operating docs are present.`,
    details: {
      canonical_docs: canonicalDocs
    }
  };
}

async function checkBuiltCliSmoke() {
  if (!(await fileExists(builtCliRelativePath))) {
    return {
      name: "built CLI smoke",
      passed: false,
      reason: `Missing built CLI at ${builtCliRelativePath}. Run the build before smoke checks.`
    };
  }

  const builtCliPath = resolve(rootDir, builtCliRelativePath);
  const fixtureGraphPath = resolve(rootDir, fixtureGraphRelativePath);
  const smokeFailures = [];

  const validateResult = runCommand(
    process.execPath,
    [builtCliPath, "validate", "--graph", fixtureGraphRelativePath],
    "built CLI validate"
  );

  if (!validateResult.passed) {
    smokeFailures.push(validateResult.reason);
  } else {
    try {
      const payload = expectRecord(
        parseJsonOutput("built CLI validate", validateResult.stdout),
        "validate payload"
      );

      if (payload.command !== "validate") {
        throw new Error("validate payload.command must equal \"validate\".");
      }

      if (payload.status !== "passed") {
        throw new Error("validate payload.status must equal \"passed\".");
      }

      if (payload.graph_path !== fixtureGraphPath) {
        throw new Error(`validate payload.graph_path must equal ${fixtureGraphPath}.`);
      }

      const compiledSummary = expectRecord(payload.compiled_summary, "validate payload.compiled_summary");

      if (expectNumber(compiledSummary.node_count, "validate payload.compiled_summary.node_count") < 1) {
        throw new Error("validate payload.compiled_summary.node_count must be at least 1.");
      }
    } catch (error) {
      smokeFailures.push(error instanceof Error ? error.message : String(error));
    }
  }

  const showCompiledResult = runCommand(
    process.execPath,
    [builtCliPath, "validate", "--graph", fixtureGraphRelativePath, "--show-compiled"],
    "built CLI validate --show-compiled"
  );

  if (!showCompiledResult.passed) {
    smokeFailures.push(showCompiledResult.reason);
  } else {
    try {
      const payload = expectRecord(
        parseJsonOutput("built CLI validate --show-compiled", showCompiledResult.stdout),
        "validate --show-compiled payload"
      );

      if (payload.command !== "validate") {
        throw new Error("validate --show-compiled payload.command must equal \"validate\".");
      }

      if (payload.status !== "passed") {
        throw new Error("validate --show-compiled payload.status must equal \"passed\".");
      }

      const compiledGraph = expectRecord(
        payload.compiled_graph,
        "validate --show-compiled payload.compiled_graph"
      );

      if (compiledGraph.graph_id !== fixtureGraphId) {
        throw new Error(
          `validate --show-compiled payload.compiled_graph.graph_id must equal ${fixtureGraphId}.`
        );
      }

      const nodes = compiledGraph.nodes;

      if (!Array.isArray(nodes) || nodes.length < 1) {
        throw new Error("validate --show-compiled payload.compiled_graph.nodes must be a non-empty array.");
      }
    } catch (error) {
      smokeFailures.push(error instanceof Error ? error.message : String(error));
    }
  }

  const reviewResult = runCommand(
    process.execPath,
    [builtCliPath, "validate", "--graph", fixtureGraphRelativePath, "--review"],
    "built CLI validate --review"
  );

  if (!reviewResult.passed) {
    smokeFailures.push(reviewResult.reason);
  } else {
    try {
      const payload = expectRecord(
        parseJsonOutput("built CLI validate --review", reviewResult.stdout),
        "validate --review payload"
      );
      const authoringReview = expectRecord(
        payload.authoring_review,
        "validate --review payload.authoring_review"
      );

      if (authoringReview.mode !== "review") {
        throw new Error("validate --review payload.authoring_review.mode must equal \"review\".");
      }

      if (!Array.isArray(authoringReview.findings)) {
        throw new Error("validate --review payload.authoring_review.findings must be an array.");
      }
    } catch (error) {
      smokeFailures.push(error instanceof Error ? error.message : String(error));
    }
  }

  const diagramResult = runCommand(
    process.execPath,
    [builtCliPath, "validate", "--graph", fixtureGraphRelativePath, "--diagram"],
    "built CLI validate --diagram"
  );

  if (!diagramResult.passed) {
    smokeFailures.push(diagramResult.reason);
  } else {
    try {
      const payload = expectRecord(
        parseJsonOutput("built CLI validate --diagram", diagramResult.stdout),
        "validate --diagram payload"
      );
      const diagram = expectRecord(payload.diagram, "validate --diagram payload.diagram");

      if (diagram.format !== "mermaid") {
        throw new Error("validate --diagram payload.diagram.format must equal \"mermaid\".");
      }

      if (!expectString(diagram.graph, "validate --diagram payload.diagram.graph").includes("flowchart TD")) {
        throw new Error("validate --diagram payload.diagram.graph must include Mermaid flowchart syntax.");
      }
    } catch (error) {
      smokeFailures.push(error instanceof Error ? error.message : String(error));
    }
  }

  for (const harnessKind of builtCliRunHarnessAdapters) {
    for (const workspaceBackend of builtCliRunWorkspaceBackends) {
      const fixture = await createRunSmokeFixture(harnessKind, workspaceBackend);

      try {
        const runResult = runCommand(
          process.execPath,
          [builtCliPath, "run", "--graph", fixture.graphPath],
          `built CLI run (${harnessKind}, ${workspaceBackend})`,
          {
            cwd: fixture.launchRoot,
            env: fixture.env
          }
        );

        if (!runResult.passed) {
          smokeFailures.push(runResult.reason);
          continue;
        }

        try {
          const payload = expectRecord(
            parseJsonOutput(`built CLI run (${harnessKind}, ${workspaceBackend})`, runResult.stdout),
            `run payload (${harnessKind}, ${workspaceBackend})`
          );

          if (payload.command !== "run") {
            throw new Error(`run payload.command must equal "run" for ${harnessKind}/${workspaceBackend}.`);
          }

          if (payload.status !== "passed") {
            throw new Error(`run payload.status must equal "passed" for ${harnessKind}/${workspaceBackend}.`);
          }

          if (payload.graph_path !== fixture.graphPath) {
            throw new Error(`run payload.graph_path must equal ${fixture.graphPath} for ${harnessKind}/${workspaceBackend}.`);
          }

          if (payload.runs_root !== fixture.runsRoot) {
            throw new Error(`run payload.runs_root must equal ${fixture.runsRoot} for ${harnessKind}/${workspaceBackend}.`);
          }

          if (payload.runs_root_source !== "graph-directory-default") {
            throw new Error(`run payload.runs_root_source must equal "graph-directory-default" for ${harnessKind}/${workspaceBackend}.`);
          }

          if (payload.launch?.workspace_backend !== workspaceBackend) {
            throw new Error(`run payload.launch.workspace_backend must equal ${workspaceBackend} for ${harnessKind}.`);
          }

          const runId = expectString(
            payload.run_id,
            `run payload.run_id (${harnessKind}, ${workspaceBackend})`
          );

          if (payload.run_root !== join(fixture.runsRoot, runId)) {
            throw new Error(`run payload.run_root must equal ${join(fixture.runsRoot, runId)} for ${harnessKind}/${workspaceBackend}.`);
          }

          const counts = expectRecord(
            payload.counts,
            `run payload.counts (${harnessKind}, ${workspaceBackend})`
          );

          if (expectNumber(counts.passed, `run payload.counts.passed (${harnessKind}, ${workspaceBackend})`) < 1) {
            throw new Error(`run payload.counts.passed must be at least 1 for ${harnessKind}/${workspaceBackend}.`);
          }

          const artifacts = expectRecord(
            payload.artifacts,
            `run payload.artifacts (${harnessKind}, ${workspaceBackend})`
          );
          const runFile = expectString(
            artifacts.run_file,
            `run payload.artifacts.run_file (${harnessKind}, ${workspaceBackend})`
          );
          const stateFile = expectString(
            artifacts.state_file,
            `run payload.artifacts.state_file (${harnessKind}, ${workspaceBackend})`
          );
          const summaryFile = expectString(
            artifacts.summary_file,
            `run payload.artifacts.summary_file (${harnessKind}, ${workspaceBackend})`
          );

          if (!(await pathExists(runFile))) {
            throw new Error(`run artifact file is missing for ${harnessKind}/${workspaceBackend}: ${runFile}`);
          }

          if (!(await pathExists(summaryFile))) {
            throw new Error(`run summary file is missing for ${harnessKind}/${workspaceBackend}: ${summaryFile}`);
          }

          const state = expectRecord(
            JSON.parse(await readFile(stateFile, "utf8")),
            `run state (${harnessKind}, ${workspaceBackend})`
          );

          if (state.status !== "passed") {
            throw new Error(`run state.status must equal "passed" for ${harnessKind}/${workspaceBackend}.`);
          }

          if (workspaceBackend === "worktree") {
            const repoWorkspaces = expectRecord(
              payload.repo_workspaces,
              `run payload.repo_workspaces (${harnessKind}, ${workspaceBackend})`
            );
            const mainWorkspace = expectRecord(
              repoWorkspaces.main,
              `run payload.repo_workspaces.main (${harnessKind}, ${workspaceBackend})`
            );
            const workspacePath = expectString(
              mainWorkspace.workspace_path,
              `run payload.repo_workspaces.main.workspace_path (${harnessKind}, ${workspaceBackend})`
            );
            const worktreeList = runCommand(
              "git",
              ["worktree", "list", "--porcelain"],
              `git worktree list (${harnessKind}, ${workspaceBackend})`,
              {
                cwd: fixture.repoDir
              }
            );

            if (!worktreeList.passed) {
              throw new Error(worktreeList.reason);
            }

            if (await pathExists(workspacePath)) {
              throw new Error(`worktree workspace path was not cleaned up for ${harnessKind}/${workspaceBackend}: ${workspacePath}`);
            }

            if (worktreeList.stdout.includes(workspacePath)) {
              throw new Error(`git worktree list still referenced ${workspacePath} for ${harnessKind}/${workspaceBackend}.`);
            }
          }
        } catch (error) {
          smokeFailures.push(error instanceof Error ? error.message : String(error));
        }
      } finally {
        await rm(fixture.tempRoot, { recursive: true, force: true });
      }
    }
  }

  if (smokeFailures.length > 0) {
    return {
      name: "built CLI smoke",
      passed: false,
      reason: `Built CLI smoke failed for ${fixtureGraphRelativePath}: ${smokeFailures.join("; ")}`,
      details: {
        built_cli: builtCliRelativePath,
        fixture_graph: fixtureGraphRelativePath,
        commands_run: [
          `node ${builtCliRelativePath} validate --graph ${fixtureGraphRelativePath}`,
          `node ${builtCliRelativePath} validate --graph ${fixtureGraphRelativePath} --show-compiled`,
          `node ${builtCliRelativePath} validate --graph ${fixtureGraphRelativePath} --review`,
          `node ${builtCliRelativePath} validate --graph ${fixtureGraphRelativePath} --diagram`,
          ...builtCliRunHarnessAdapters.flatMap((harnessKind) =>
            builtCliRunWorkspaceBackends.map((workspaceBackend) =>
              `node ${builtCliRelativePath} run --graph <temporary ${harnessKind} ${workspaceBackend} smoke fixture>`
            )
          )
        ]
      }
    };
  }

  return {
    name: "built CLI smoke",
    passed: true,
    reason:
      `Built CLI ${builtCliFixtureCommands.join(", ")} commands passed against ${fixtureGraphRelativePath}, ` +
      `and built CLI run passed through ${builtCliRunHarnessAdapters.join(" and ")} smoke fixtures across ${builtCliRunWorkspaceBackends.join(" and ")} workspace backends.`,
    details: {
        built_cli: builtCliRelativePath,
        fixture_graph: fixtureGraphRelativePath,
        commands_run: [
          `node ${builtCliRelativePath} validate --graph ${fixtureGraphRelativePath}`,
          `node ${builtCliRelativePath} validate --graph ${fixtureGraphRelativePath} --show-compiled`,
          `node ${builtCliRelativePath} validate --graph ${fixtureGraphRelativePath} --review`,
          `node ${builtCliRelativePath} validate --graph ${fixtureGraphRelativePath} --diagram`,
          ...builtCliRunHarnessAdapters.flatMap((harnessKind) =>
            builtCliRunWorkspaceBackends.map((workspaceBackend) =>
              `node ${builtCliRelativePath} run --graph <temporary ${harnessKind} ${workspaceBackend} smoke fixture>`
          )
        )
      ]
    }
  };
}

async function main() {
  const checks = [];

  checks.push(await checkCanonicalDocs());

  let buildPassed = false;

  for (const { name, script } of commandChecks) {
    const result = runNpmScript(script);
    checks.push({
      name,
      ...result,
      command: `npm run ${script}`
    });

    if (script === "build") {
      buildPassed = result.passed;
    }
  }

  checks.push(
    buildPassed
      ? await checkBuiltCliSmoke()
      : {
          name: "built CLI smoke",
          passed: false,
          reason: "build failed, so the built CLI smoke checks did not run.",
          details: {
            built_cli: builtCliRelativePath
          }
        }
  );

  const passedChecks = checks.filter((check) => check.passed).length;
  const passed = checks.every((check) => check.passed);
  const score = Number((passedChecks / checks.length).toFixed(2));
  const reasons = checks.filter((check) => !check.passed).map((check) => check.reason);

  const payload = {
    passed,
    score,
    commands_run: checks.flatMap((check) => {
      const commands = [];

      if (typeof check.command === "string") {
        commands.push(check.command);
      }

      if (Array.isArray(check.details?.commands_run)) {
        commands.push(...check.details.commands_run);
      }

      return commands;
    }),
    checks: checks.map((check) => ({
      name: check.name,
      status: check.passed ? "passed" : "failed",
      reason: check.reason,
      ...(typeof check.command === "string" ? { command: check.command } : {}),
      ...(check.details ? { details: check.details } : {})
    })),
    residual_risks: smokeResidualRisks,
    reasons: reasons.length > 0 ? reasons : [`Smoke validation passed across ${checks.length} checks.`]
  };

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    const statusLabel = passed ? "PASS" : "FAIL";
    console.log(`Smoke validation ${statusLabel} (score ${score})`);

    for (const check of checks) {
      const icon = check.passed ? "[pass]" : "[fail]";
      console.log(`${icon} ${check.name}: ${check.reason}`);
    }
  }

  process.exitCode = passed ? 0 : 1;
}

const invokedScript = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;

if (invokedScript === import.meta.url) {
  await main();
}

import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const argv = process.argv.slice(2);
const jsonMode = argv.includes("--json");
const harnessArgIndex = argv.indexOf("--harness");
const harness = harnessArgIndex >= 0 ? argv[harnessArgIndex + 1] : "codex-cli";
const builtCliPath = resolve(rootDir, "dist/cli/index.js");

function stripAnsi(text) {
  return text.replace(/\u001B\[[0-9;]*m/g, "");
}

function summarize(output) {
  const lines = stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-8).join(" | ");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? rootDir,
    env: { ...process.env, CI: process.env.CI ?? "1", ...(options.env ?? {}) },
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: options.timeoutMs ?? 30 * 60 * 1000
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");

  return {
    passed: result.status === 0 && !result.signal && !result.error,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    output,
    reason: result.error
      ? result.error.message
      : result.signal
        ? `terminated with ${result.signal}`
        : result.status === 0
          ? "passed"
          : summarize(output)
  };
}

function commandExists(command) {
  const found = run("sh", ["-lc", `command -v ${command}`]);
  return found.passed ? found.stdout.trim() : undefined;
}

function canExecute(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function detectHarnessBinary() {
  if (harness === "codex-cli") {
    const fromEnv = process.env.AGENTFLOW_CODEX_CLI_BIN;
    if (fromEnv && canExecute(fromEnv)) {
      return fromEnv;
    }
    return commandExists("codex");
  }

  if (harness === "cursor-cli") {
    const fromEnv = process.env.AGENTFLOW_CURSOR_CLI_BIN;
    if (fromEnv && canExecute(fromEnv)) {
      return fromEnv;
    }
    return commandExists("agent");
  }

  throw new Error(`Unsupported harness: ${harness}`);
}

async function writeRealEvalSuite(tempRoot) {
  const suiteDir = join(tempRoot, "suite");
  const scenarioIds = ["declared-artifact", "missing-docs", "semantic-failure"];
  await mkdir(join(suiteDir, "variants"), { recursive: true });
  await mkdir(join(suiteDir, "judges"), { recursive: true });
  await mkdir(join(suiteDir, "graders"), { recursive: true });
  await writeFile(join(suiteDir, "variants", "current.json"), JSON.stringify({
    id: "current",
    description: "Current real harness prompt behavior.",
    env: { AGENTFLOW_EVAL_PROMPT_PACK: "current" }
  }, null, 2));
  await writeFile(join(suiteDir, "judges", "quality.md"), [
    "Grade whether this real Agentflow workflow trial preserved the graph contract, produced useful artifacts, and left auditable evidence.",
    "Return strict JSON with passed_quality_bar, score, dimension_scores, blockers, rationale, and prompt_feedback."
  ].join("\n"));
  await writeFile(join(suiteDir, "graders", "packet.mjs"), [
    "import { readFileSync } from 'node:fs';",
    "const packet = JSON.parse(readFileSync(process.env.AGENTFLOW_EVAL_TRACE_PACKET_FILE, 'utf8'));",
    "const hasArtifact = packet.artifacts.some((artifact) => artifact.name === 'handoff' && String(artifact.content ?? '').toLowerCase().includes('validation'));",
    "const passed = packet.outcome.status === 'passed' && hasArtifact && Boolean(packet.delivery?.manifest_path);",
    "console.log(JSON.stringify({ passed, score: passed ? 5 : 1, summary: passed ? 'real eval packet ok' : 'missing real eval evidence', assertions: [{ id: 'packet', passed, evidence: process.env.AGENTFLOW_EVAL_TRACE_PACKET_FILE }], metrics: { attempts: packet.metrics.attempts } }));"
  ].join("\n"));

  for (const id of scenarioIds) {
    const scenarioDir = join(suiteDir, "scenarios", id);
    await mkdir(join(scenarioDir, "repo"), { recursive: true });
    await mkdir(join(scenarioDir, "docs"), { recursive: true });
    await writeFile(join(scenarioDir, "repo", "README.md"), `# ${id}\n`);
    await writeFile(join(scenarioDir, "docs", "index.md"), "Use stableMethod(). Do not use oldMethod().\n");
    await writeFile(join(scenarioDir, "graph.template.json"), JSON.stringify({
      version: "1",
      graph_id: `real-eval-${id}-{{variant.id}}-{{trial.index}}`,
      intent: {
        goal: `Complete the ${id} real eval workflow and publish a handoff.`,
        acceptance_criteria: ["handoff artifact includes validation evidence"],
        constraints: ["Use only the local repo and local docs fixture."]
      },
      repos: { main: { path: "{{fixture.repo}}" } },
      defaults: { launch_profile: "default", workspace_backend: "inplace" },
      profiles: {
        default: {
          harness,
          model: process.env.AGENTFLOW_CODEX_MODEL ?? "gpt-5.4-mini",
          sandbox: "workspace-write",
          timeout_sec: 240
        }
      },
      graph: {
        type: "sequence",
        id: "root",
        steps: [{
          type: "agent",
          id: "complete",
          repo: "main",
          goal: `Write the handoff artifact at the declared path. The artifact must include the exact word "validation" and mention this local docs URL: {{fixture.docs_url}}`,
          artifacts: {
            handoff: {
              from: "output_dir",
              path: "handoff.md",
              description: "Real eval handoff with validation evidence."
            }
          }
        }]
      }
    }, null, 2));
    await writeFile(join(scenarioDir, "scenario.json"), JSON.stringify({
      id,
      bucket: "valid-hard-execution",
      difficulty: "medium",
      description: `Real ${harness} eval scenario ${id}.`,
      fixture: { repo: "repo", docs: "docs", init_git: true },
      workflow: { graph_template: "graph.template.json", harness, workspace_backend: "inplace" },
      expected: {
        final_outcome: "passed",
        required_artifacts: [{ name: "handoff" }],
        forbidden_edits: ["forbidden.txt"]
      },
      grading: { dimensions: ["artifact_quality", "delivery_auditability"] }
    }, null, 2));
  }

  await writeFile(join(suiteDir, "eval.json"), JSON.stringify({
    version: "2",
    suite_id: "real-evals-smoke",
    objective: `Validate real ${harness} workflow eval plumbing.`,
    default_trials: 1,
    scenarios: scenarioIds.map((id) => `scenarios/${id}/scenario.json`),
    variants: ["variants/current.json"],
    graders: [{ id: "packet", kind: "script", command: "node graders/packet.mjs" }],
    judges: [{
      id: "quality",
      rubric: "judges/quality.md",
      harness,
      model: harness === "codex-cli"
        ? process.env.AGENTFLOW_CODEX_MODEL ?? "gpt-5.4-mini"
        : process.env.AGENTFLOW_CURSOR_MODEL ?? "auto",
      ...(harness === "codex-cli" ? { reasoning_effort: "low" } : {}),
      required: false
    }],
    thresholds: { pass_rate: 1, max_blocker_rate: 0, min_average_score: 1 }
  }, null, 2));

  return suiteDir;
}

async function main() {
  if (harness !== "codex-cli" && harness !== "cursor-cli") {
    throw new Error("--harness must be codex-cli or cursor-cli");
  }

  const binary = detectHarnessBinary();
  if (!binary) {
    const payload = {
      status: "skipped",
      harness,
      reason: `${harness} binary is unavailable.`
    };
    if (jsonMode) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Real eval validation skipped: ${payload.reason}`);
    }
    return;
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "agentflow-real-evals-"));
  try {
    const suiteDir = await writeRealEvalSuite(tempRoot);
    const evalRoot = join(tempRoot, "eval-output");
    const result = run(process.execPath, [
      builtCliPath,
      "eval",
      "run",
      suiteDir,
      "--eval-root",
      evalRoot,
      "--trials",
      "1",
      "--variant",
      "current",
      "--concurrency",
      "3"
    ], {
      env: harness === "codex-cli"
        ? { AGENTFLOW_CODEX_CLI_BIN: binary }
        : { AGENTFLOW_CURSOR_CLI_BIN: binary },
      timeoutMs: 45 * 60 * 1000
    });

    if (!result.passed) {
      throw new Error(`real eval run failed: ${result.reason}`);
    }

    const ledger = JSON.parse(await readFile(join(evalRoot, "evaluation-ledger.json"), "utf8"));
    const scorecards = await Promise.all(
      ledger.results.map((entry) => readFile(entry.scorecard_file, "utf8").then((text) => JSON.parse(text)))
    );
    const passed =
      ledger.benchmark.total_trials === 3 &&
      ledger.results.every((entry) => entry.trace_packet_file && entry.scorecard_file) &&
      scorecards.every((scorecard) => scorecard.deterministic?.passed === true) &&
      scorecards.every((scorecard) => Array.isArray(scorecard.judges) && scorecard.judges.length >= 1) &&
      scorecards.every((scorecard) => scorecard.judges.every((judge) => judge.status !== "errored"));

    const payload = {
      status: passed ? "passed" : "failed",
      harness,
      binary,
      eval_root: evalRoot,
      benchmark: ledger.benchmark
    };

    if (!passed) {
      throw new Error("real eval artifacts were incomplete");
    }

    if (jsonMode) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Real eval validation PASS for ${harness}: ${evalRoot}`);
    }
  } finally {
    if (!process.env.AGENTFLOW_KEEP_REAL_EVALS) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  const payload = {
    status: "failed",
    harness,
    message: error instanceof Error ? error.message : String(error)
  };
  if (jsonMode) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.error(`Real eval validation FAIL: ${payload.message}`);
  }
  process.exitCode = 1;
});

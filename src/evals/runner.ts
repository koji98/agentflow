import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { access, chmod, cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import { runCommand } from "../cli/commands/run.js";
import type {
  EvalBenchmark,
  EvalBenchmarkVariant,
  EvalDeterministicResult,
  EvalRunLedger,
  EvalScenario,
  EvalScorecard,
  EvalSuiteThresholds,
  EvalTemplateFixtureContext,
  EvalTrialResult,
  EvalTrialStatus,
  EvalVariant,
  LoadedEvalSuite
} from "./types.js";
import { runEvalJudge, runScriptGrader } from "./graders.js";
import { renderGraphTemplate } from "./suite.js";
import { buildEvalTracePacket, writeEvalTrace } from "./trace.js";

const execFileAsync = promisify(execFile);

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function sanitizePathSegment(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

  return sanitized || "eval";
}

export function createEvalRootPath(options: {
  currentWorkingDirectory: string;
  suite_id: string;
  label?: string;
  eval_root?: string;
}): string {
  if (options.eval_root) {
    if (!isAbsolute(options.eval_root)) {
      throw new Error(`--eval-root must be an absolute path. Received: ${options.eval_root}`);
    }

    return options.eval_root;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const suiteSegment = sanitizePathSegment(options.suite_id);
  const labelSegment = options.label ? `-${sanitizePathSegment(options.label)}` : "";

  return resolve(
    options.currentWorkingDirectory,
    ".agentflow",
    "evals",
    `${timestamp}-${suiteSegment}${labelSegment}`
  );
}

function writeJson(path: string, value: unknown): Promise<void> {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function initGitRepoIfNeeded(repoDir: string): Promise<void> {
  if (await pathExists(join(repoDir, ".git"))) {
    return;
  }

  await execFileAsync("git", ["init"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.email", "agentflow@example.com"], { cwd: repoDir });
  await execFileAsync("git", ["config", "user.name", "Agentflow Eval"], { cwd: repoDir });
  await execFileAsync("git", ["add", "."], { cwd: repoDir });
  await execFileAsync("git", ["commit", "-m", "eval fixture init"], { cwd: repoDir });
}

async function serveStaticFile(root: string, pathname: string): Promise<{
  status: number;
  body: Buffer | string;
  content_type: string;
}> {
  const decoded = decodeURIComponent(pathname.replace(/^\/+/u, ""));
  const target = resolve(root, decoded || "index.html");
  const rootWithSep = root.endsWith("/") ? root : `${root}/`;

  if (!target.startsWith(rootWithSep) && target !== root) {
    return { status: 403, body: "forbidden", content_type: "text/plain" };
  }

  try {
    const info = await stat(target);
    const filePath = info.isDirectory() ? join(target, "index.html") : target;
    return {
      status: 200,
      body: await readFile(filePath),
      content_type: filePath.endsWith(".json") ? "application/json" : "text/plain"
    };
  } catch {
    return { status: 404, body: "not found", content_type: "text/plain" };
  }
}

async function startDocsServer(docsPath: string): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = createServer((request, response) => {
    void serveStaticFile(docsPath, request.url ?? "/").then((result) => {
      response.writeHead(result.status, { "content-type": result.content_type });
      response.end(result.body);
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : undefined;

  if (!port) {
    throw new Error("Docs fixture server did not expose a port.");
  }

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      (server as Server).close((error) => {
        if (error) {
          rejectClose(error);
        } else {
          resolveClose();
        }
      });
    })
  };
}

async function prepareTrialFixture(options: {
  scenario: EvalScenario;
  trial_root: string;
}): Promise<{
  fixture: EvalTemplateFixtureContext;
  close: () => Promise<void>;
}> {
  const workspaceRoot = join(options.trial_root, "workspace");
  const repoPath = join(workspaceRoot, "repo");
  await mkdir(workspaceRoot, { recursive: true });
  await cp(options.scenario.fixture.repo_path, repoPath, { recursive: true });

  if (options.scenario.fixture.init_git) {
    await initGitRepoIfNeeded(repoPath);
  }

  const docsServer = options.scenario.fixture.docs_path
    ? await startDocsServer(options.scenario.fixture.docs_path)
    : undefined;
  const toolsPath = options.scenario.fixture.tools_path
    ? join(workspaceRoot, "tools")
    : undefined;

  if (options.scenario.fixture.tools_path && toolsPath) {
    await cp(options.scenario.fixture.tools_path, toolsPath, { recursive: true });
    await chmodToolFixtures(toolsPath);
  }

  return {
    fixture: {
      repo: repoPath,
      ...(docsServer ? { docs_url: docsServer.url } : {}),
      ...(toolsPath ? { tools: toolsPath } : {}),
      trial_root: options.trial_root
    },
    close: async () => {
      await docsServer?.close();
    }
  };
}

async function chmodToolFixtures(toolsPath: string): Promise<void> {
  const entries = await readdir(toolsPath, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(toolsPath, entry.name);
      if (entry.isDirectory()) {
        await chmodToolFixtures(entryPath);
        return;
      }

      if (entry.isFile()) {
        await chmod(entryPath, 0o755);
      }
    })
  );
}

async function runGraphForTrial(options: {
  currentWorkingDirectory: string;
  rendered_graph_file: string;
  graph_runs_root: string;
  label: string;
  env: Record<string, string>;
  signal?: AbortSignal;
}): Promise<{
  output?: Record<string, unknown>;
  exit_code: number;
  run_root?: string;
  status?: string;
  error?: string;
}> {
  await mkdir(options.graph_runs_root, { recursive: true });

  try {
    const result = await runCommand.run(
      {
        graph: options.rendered_graph_file,
        label: options.label,
        "runs-root": options.graph_runs_root
      },
      options.currentWorkingDirectory,
      options.signal,
      [],
      {
        ...process.env,
        ...options.env
      },
      options.env
    );
    const output =
      result.output && typeof result.output === "object" && !Array.isArray(result.output)
        ? result.output as Record<string, unknown>
        : undefined;
    const run_root = typeof output?.run_root === "string" ? output.run_root : undefined;
    const status = typeof output?.status === "string" ? output.status : undefined;

    return {
      ...(run_root ? { run_root } : {}),
      ...(status ? { status } : {}),
      ...(output ? { output } : {}),
      exit_code: result.exitCode,
      ...(output && typeof output.message === "string" ? { error: output.message } : {})
    };
  } catch (error) {
    return {
      exit_code: 1,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function includesContent(content: string | undefined, needles: string[] | undefined): boolean {
  if (!needles || needles.length === 0) {
    return true;
  }

  if (content === undefined) {
    return false;
  }

  return needles.every((needle) => content.includes(needle));
}

async function evaluateDeterministic(options: {
  scenario: EvalScenario;
  graphStatus?: string;
  tracePacket?: Awaited<ReturnType<typeof buildEvalTracePacket>>;
  fixture?: EvalTemplateFixtureContext;
}): Promise<EvalDeterministicResult> {
  const assertions: EvalDeterministicResult["assertions"] = [];
  const blockers: string[] = [];
  const expectedStatus = options.scenario.expected.final_outcome;
  const statusPassed = options.graphStatus === expectedStatus;

  assertions.push({
    id: "final_outcome",
    passed: statusPassed,
    evidence: `expected=${expectedStatus}; actual=${options.graphStatus ?? "not-run"}`
  });
  if (!statusPassed) {
    blockers.push(`Expected final outcome ${expectedStatus}, got ${options.graphStatus ?? "not-run"}.`);
  }

  for (const artifact of options.scenario.expected.required_artifacts) {
    const matched = options.tracePacket?.artifacts.find((entry) => entry.name === artifact.name);
    const artifactPassed = Boolean(matched && includesContent(matched.content, artifact.contains));
    assertions.push({
      id: `required_artifact:${artifact.name}`,
      passed: artifactPassed,
      evidence: matched?.path ?? "artifact missing"
    });
    if (!artifactPassed) {
      blockers.push(`Required artifact "${artifact.name}" was missing or did not contain expected content.`);
    }
  }

  for (const relativePath of options.scenario.expected.forbidden_edits) {
    const forbiddenPath = options.fixture?.repo ? resolve(options.fixture.repo, relativePath) : undefined;
    const exists = forbiddenPath ? await pathExists(forbiddenPath) : false;
    assertions.push({
      id: `forbidden_edit:${relativePath}`,
      passed: !exists,
      evidence: forbiddenPath ?? "repo unavailable"
    });
    if (exists) {
      blockers.push(`Forbidden path exists after trial: ${relativePath}.`);
    }
  }

  for (const classification of options.scenario.expected.supervisor.classifications ?? []) {
    const passed = options.tracePacket?.supervisor.classifications.includes(classification) ?? false;
    assertions.push({ id: `supervisor_classification:${classification}`, passed });
    if (!passed) {
      blockers.push(`Expected supervisor classification "${classification}" was not observed.`);
    }
  }

  for (const gatherer of options.scenario.expected.supervisor.gatherers ?? []) {
    const passed = options.tracePacket?.supervisor.gatherers.includes(gatherer) ?? false;
    assertions.push({ id: `supervisor_gatherer:${gatherer}`, passed });
    if (!passed) {
      blockers.push(`Expected supervisor gatherer "${gatherer}" was not observed.`);
    }
  }

  for (const action of options.scenario.expected.supervisor.apply_actions ?? []) {
    const passed = options.tracePacket?.supervisor.apply_actions.includes(action) ?? false;
    assertions.push({ id: `supervisor_apply_action:${action}`, passed });
    if (!passed) {
      blockers.push(`Expected supervisor apply action "${action}" was not observed.`);
    }
  }

  const deliveryPassed = Boolean(options.tracePacket?.delivery.manifest_path && options.tracePacket.delivery.manifest);
  assertions.push({
    id: "delivery_manifest",
    passed: deliveryPassed,
    evidence: options.tracePacket?.delivery.manifest_path ?? "missing"
  });
  if (!deliveryPassed && options.graphStatus === "passed") {
    blockers.push("Delivery manifest was missing for a completed run.");
  }

  return {
    passed: blockers.length === 0,
    blockers,
    assertions
  };
}

function mergePromptFeedback(judges: EvalScorecard["judges"]): EvalScorecard["prompt_feedback"] {
  return {
    helpful_sections: [...new Set(judges.flatMap((judge) => judge.prompt_feedback.helpful_sections))],
    noisy_sections: [...new Set(judges.flatMap((judge) => judge.prompt_feedback.noisy_sections))],
    missing_guidance: [...new Set(judges.flatMap((judge) => judge.prompt_feedback.missing_guidance))]
  };
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildScorecard(options: {
  suite_id: string;
  scenario: EvalScenario;
  variant: EvalVariant;
  trial_id: string;
  deterministic: EvalDeterministicResult;
  graders: EvalScorecard["graders"];
  judges: EvalScorecard["judges"];
  tracePacket?: Awaited<ReturnType<typeof buildEvalTracePacket>>;
  error?: string;
}): EvalScorecard {
  const requiredGradersPassed = options.graders.every((grader) => !grader.required || grader.status === "passed");
  const requiredJudgesPassed = options.judges.every((judge) => !judge.required || judge.status === "passed");
  const passed = options.deterministic.blockers.length === 0 && requiredGradersPassed && requiredJudgesPassed && !options.error;
  const graderScores = options.graders
    .map((grader) => typeof grader.score === "number" ? grader.score : undefined)
    .filter((score): score is number => score !== undefined)
    .map((score) => score <= 1 ? score * 5 : score);
  const judgeScores = options.judges.map((judge) => judge.score);
  const deterministicScore = options.deterministic.blockers.length === 0 ? 5 : 1;
  const dimensions: Record<string, number> = {};

  for (const judge of options.judges) {
    for (const [dimension, score] of Object.entries(judge.dimension_scores)) {
      dimensions[dimension] = score;
    }
  }

  const scoreValues = [deterministicScore, ...graderScores, ...judgeScores];

  return {
    schema_version: "2",
    suite_id: options.suite_id,
    scenario_id: options.scenario.id,
    variant_id: options.variant.id,
    trial_id: options.trial_id,
    status: options.error ? "errored" : passed ? "passed" : "failed",
    passed,
    deterministic: options.deterministic,
    graders: options.graders,
    judges: options.judges,
    scores: {
      average: Number(average(scoreValues).toFixed(4)),
      dimensions
    },
    metrics: {
      attempts: options.tracePacket?.metrics.attempts ?? 0,
      recovery_cycles: options.tracePacket?.metrics.recovery_cycles ?? 0,
      ...(options.tracePacket?.metrics.duration_ms !== undefined ? { duration_ms: options.tracePacket.metrics.duration_ms } : {}),
      blockers: options.deterministic.blockers.length
    },
    prompt_feedback: mergePromptFeedback(options.judges),
    ...(options.error ? { error: options.error } : {})
  };
}

async function runTrial(options: {
  currentWorkingDirectory: string;
  loaded: LoadedEvalSuite;
  eval_root: string;
  scenario: EvalScenario;
  variant: EvalVariant;
  trial_index: number;
  signal?: AbortSignal;
}): Promise<EvalTrialResult> {
  const trialId = `trial-${String(options.trial_index).padStart(3, "0")}`;
  const trialRoot = join(
    options.eval_root,
    "scenarios",
    sanitizePathSegment(options.scenario.id),
    sanitizePathSegment(options.variant.id),
    trialId
  );
  const renderedGraphFile = join(trialRoot, "rendered-graph.json");
  const trialFile = join(trialRoot, "trial.json");
  const runRootFile = join(trialRoot, "run-root.txt");
  const traceFile = join(trialRoot, "trace.jsonl");
  const tracePacketFile = join(trialRoot, "trace-packet.json");
  const deterministicFile = join(trialRoot, "deterministic-results.json");
  const scorecardFile = join(trialRoot, "scorecard.json");
  const summaryFile = join(trialRoot, "summary.md");
  let fixtureState: Awaited<ReturnType<typeof prepareTrialFixture>> | undefined;

  await mkdir(trialRoot, { recursive: true });

  try {
    fixtureState = await prepareTrialFixture({
      scenario: options.scenario,
      trial_root: trialRoot
    });

    const rendered = await renderGraphTemplate({
      suite_dir: options.loaded.suite_dir,
      template_path: options.variant.graph_template_path ?? options.scenario.workflow.graph_template_path,
      scenario: options.scenario,
      variant: options.variant,
      trial: {
        id: trialId,
        index: options.trial_index,
        root: trialRoot
      },
      fixture: {
        ...fixtureState.fixture,
        eval_root: options.eval_root
      }
    });

    await writeJson(trialFile, {
      scenario_id: options.scenario.id,
      variant_id: options.variant.id,
      trial_id: trialId,
      trial_index: options.trial_index,
      root: trialRoot,
      fixture: fixtureState.fixture
    });
    await writeJson(renderedGraphFile, rendered.graph);

    if (rendered.diagnostics.length > 0) {
      const error = rendered.diagnostics.map((diagnostic) => diagnostic.message).join(" ");
      const deterministic: EvalDeterministicResult = {
        passed: false,
        blockers: [error],
        assertions: [{ id: "render_graph", passed: false, evidence: error }]
      };
      const scorecard = buildScorecard({
        suite_id: options.loaded.suite.suite_id,
        scenario: options.scenario,
        variant: options.variant,
        trial_id: trialId,
        deterministic,
        graders: [],
        judges: [],
        error
      });
      await Promise.all([
        writeJson(deterministicFile, deterministic),
        writeJson(scorecardFile, scorecard),
        writeFile(summaryFile, `# Eval Trial ${trialId}\n\n${error}\n`, "utf8")
      ]);

      return {
        scenario_id: options.scenario.id,
        variant_id: options.variant.id,
        trial_id: trialId,
        trial_index: options.trial_index,
        status: "errored",
        passed: false,
        rendered_graph_file: renderedGraphFile,
        trial_file: trialFile,
        scorecard_file: scorecardFile,
        summary_file: summaryFile,
        error,
        scorecard
      };
    }

    const env = {
      ...options.variant.env,
      ...(options.variant.prompt_pack ? { AGENTFLOW_EVAL_PROMPT_PACK: options.variant.prompt_pack } : {}),
      ...(fixtureState.fixture.tools
        ? { PATH: `${fixtureState.fixture.tools}:${process.env.PATH ?? ""}` }
        : {})
    };
    const graphRun = await runGraphForTrial({
      currentWorkingDirectory: trialRoot,
      rendered_graph_file: renderedGraphFile,
      graph_runs_root: join(trialRoot, "runs"),
      label: `${options.scenario.id}-${options.variant.id}-${trialId}`,
      env,
      ...(options.signal ? { signal: options.signal } : {})
    });
    let tracePacket: Awaited<ReturnType<typeof buildEvalTracePacket>> | undefined;

    if (graphRun.run_root) {
      await writeFile(runRootFile, `${graphRun.run_root}\n`, "utf8");
      await writeEvalTrace({ run_root: graphRun.run_root, trace_file: traceFile });
      tracePacket = await buildEvalTracePacket({ run_root: graphRun.run_root });
      await writeJson(tracePacketFile, tracePacket);
    }

    const deterministic = await evaluateDeterministic({
      scenario: options.scenario,
      ...(graphRun.status ? { graphStatus: graphRun.status } : {}),
      ...(tracePacket ? { tracePacket } : {}),
      fixture: fixtureState.fixture
    });
    await writeJson(deterministicFile, deterministic);

    const graders = graphRun.run_root && tracePacket
      ? await Promise.all(options.loaded.graders.map((grader) =>
          runScriptGrader({
            grader,
            suite_dir: options.loaded.suite_dir,
            scenario: options.scenario,
            variant_id: options.variant.id,
            trial_id: trialId,
            run_root: graphRun.run_root!,
            trace_file: traceFile,
            trace_packet_file: tracePacketFile,
            scorecard_file: scorecardFile,
            output_dir: join(trialRoot, "graders", sanitizePathSegment(grader.id)),
            ...(options.signal ? { signal: options.signal } : {})
          })
        ))
      : [];
    const judges = graphRun.run_root && tracePacket
      ? await Promise.all(options.loaded.judges.map((judge) =>
          runEvalJudge({
            judge,
            suite_dir: options.loaded.suite_dir,
            scenario: options.scenario,
            anonymized_variant_label: `variant-${String(options.loaded.variants.findIndex((entry) => entry.id === options.variant.id) + 1).padStart(2, "0")}`,
            trial_id: trialId,
            run_root: graphRun.run_root!,
            trace_packet: tracePacket!,
            trace_packet_file: tracePacketFile,
            output_dir: join(trialRoot, "judge-results", sanitizePathSegment(judge.id)),
            ...(options.signal ? { signal: options.signal } : {})
          })
        ))
      : [];
    const scorecard = buildScorecard({
      suite_id: options.loaded.suite.suite_id,
      scenario: options.scenario,
      variant: options.variant,
      trial_id: trialId,
      deterministic,
      graders,
      judges,
      ...(tracePacket ? { tracePacket } : {}),
      ...(!graphRun.run_root && graphRun.error ? { error: graphRun.error } : {})
    });

    await Promise.all([
      writeJson(scorecardFile, scorecard),
      writeFile(
        summaryFile,
        [
          `# Eval Trial ${options.scenario.id} / ${options.variant.id} / ${trialId}`,
          "",
          `- Status: ${scorecard.status}`,
          `- Passed: ${scorecard.passed ? "yes" : "no"}`,
          `- Score: ${scorecard.scores.average.toFixed(2)}`,
          `- Graph status: ${graphRun.status ?? "not-run"}`,
          ...(graphRun.run_root ? [`- Run root: ${graphRun.run_root}`] : []),
          "",
          "## Blockers",
          ...(scorecard.deterministic.blockers.length > 0
            ? scorecard.deterministic.blockers.map((blocker) => `- ${blocker}`)
            : ["- none"])
        ].join("\n"),
        "utf8"
      )
    ]);

    return {
      scenario_id: options.scenario.id,
      variant_id: options.variant.id,
      trial_id: trialId,
      trial_index: options.trial_index,
      status: scorecard.status,
      passed: scorecard.passed,
      rendered_graph_file: renderedGraphFile,
      trial_file: trialFile,
      ...(graphRun.run_root ? { run_root: graphRun.run_root } : {}),
      ...(graphRun.run_root ? { trace_file: traceFile, trace_packet_file: tracePacketFile } : {}),
      scorecard_file: scorecardFile,
      summary_file: summaryFile,
      ...(scorecard.error ? { error: scorecard.error } : {}),
      scorecard
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const deterministic: EvalDeterministicResult = {
      passed: false,
      blockers: [message],
      assertions: [{ id: "trial_error", passed: false, evidence: message }]
    };
    const scorecard = buildScorecard({
      suite_id: options.loaded.suite.suite_id,
      scenario: options.scenario,
      variant: options.variant,
      trial_id: trialId,
      deterministic,
      graders: [],
      judges: [],
      error: message
    });

    await Promise.all([
      writeJson(deterministicFile, deterministic),
      writeJson(scorecardFile, scorecard),
      writeFile(summaryFile, `# Eval Trial ${trialId}\n\n${message}\n`, "utf8")
    ]);

    return {
      scenario_id: options.scenario.id,
      variant_id: options.variant.id,
      trial_id: trialId,
      trial_index: options.trial_index,
      status: "errored",
      passed: false,
      rendered_graph_file: renderedGraphFile,
      trial_file: trialFile,
      scorecard_file: scorecardFile,
      summary_file: summaryFile,
      error: message,
      scorecard
    };
  } finally {
    await fixtureState?.close();
  }
}

function variance(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
}

function computeVariantBenchmark(variantId: string, results: EvalTrialResult[]): EvalBenchmarkVariant {
  const variantResults = results.filter((result) => result.variant_id === variantId && result.status !== "skipped");
  const total = variantResults.length;
  const passed = variantResults.filter((result) => result.status === "passed").length;
  const errored = variantResults.filter((result) => result.status === "errored").length;
  const failed = variantResults.filter((result) => result.status === "failed").length;
  const blockers = variantResults.reduce((sum, result) => sum + (result.scorecard?.deterministic.blockers.length ?? 0), 0);
  const scores = variantResults.map((result) => result.scorecard?.scores.average ?? 0);

  return {
    variant_id: variantId,
    total_trials: total,
    passed,
    failed,
    errored,
    pass_rate: total > 0 ? passed / total : 0,
    blocker_rate: total > 0 ? blockers / total : 0,
    average_score: scores.length > 0 ? Number((scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(4)) : 0
  };
}

function computeBenchmark(
  results: EvalTrialResult[],
  variants: EvalVariant[],
  thresholds: EvalSuiteThresholds
): EvalBenchmark {
  const total = results.filter((result) => result.status !== "skipped").length;
  const passed = results.filter((result) => result.status === "passed").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const errored = results.filter((result) => result.status === "errored").length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  const blockers = results.reduce((sum, result) => sum + (result.scorecard?.deterministic.blockers.length ?? 0), 0);
  const scores = results.map((result) => result.scorecard?.scores.average ?? 0).filter((score) => score > 0);
  const passRate = total > 0 ? passed / total : 0;
  const blockerRate = total > 0 ? blockers / total : 0;
  const averageScore = scores.length > 0 ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0;
  const firstTrials = new Map<string, EvalTrialResult>();

  for (const result of results) {
    const key = `${result.scenario_id}::${result.variant_id}`;
    const current = firstTrials.get(key);
    if (!current || result.trial_index < current.trial_index) {
      firstTrials.set(key, result);
    }
  }

  const passAt1Results = [...firstTrials.values()];
  const scenarioVariantKeys = new Set(results.map((result) => `${result.scenario_id}::${result.variant_id}`));
  const passAtK = [...scenarioVariantKeys].filter((key) =>
    results.some((result) => `${result.scenario_id}::${result.variant_id}` === key && result.passed)
  ).length;

  return {
    total_trials: total,
    passed,
    failed,
    errored,
    skipped,
    pass_rate: passRate,
    blocker_rate: blockerRate,
    average_score: Number(averageScore.toFixed(4)),
    score_variance: Number(variance(scores).toFixed(4)),
    pass_at_1: passAt1Results.length > 0
      ? passAt1Results.filter((result) => result.passed).length / passAt1Results.length
      : 0,
    pass_at_k: scenarioVariantKeys.size > 0 ? passAtK / scenarioVariantKeys.size : 0,
    threshold_passed:
      passRate >= (thresholds.pass_rate ?? 0) &&
      blockerRate <= (thresholds.max_blocker_rate ?? Number.POSITIVE_INFINITY) &&
      averageScore >= (thresholds.min_average_score ?? 0),
    variants: variants.map((variant) => computeVariantBenchmark(variant.id, results))
  };
}

export async function runEvalSuite(options: {
  currentWorkingDirectory: string;
  loaded: LoadedEvalSuite;
  eval_root: string;
  scenario_id?: string;
  variant_id?: string;
  trials?: number;
  concurrency?: number;
  signal?: AbortSignal;
}): Promise<{
  ledger: EvalRunLedger;
  infrastructure_failed: boolean;
}> {
  const started_at = new Date().toISOString();
  const scenarios = options.loaded.scenarios.filter((scenario) => !options.scenario_id || options.scenario_id === "all" || scenario.id === options.scenario_id);
  const variants = options.loaded.variants.filter((variant) => !options.variant_id || options.variant_id === "all" || variant.id === options.variant_id);
  const trials = options.trials ?? options.loaded.suite.default_trials;

  if (scenarios.length === 0) {
    throw new Error(options.scenario_id ? `No eval scenario matched ${options.scenario_id}.` : "Eval suite has no scenarios.");
  }

  if (variants.length === 0) {
    throw new Error(options.variant_id ? `No eval variant matched ${options.variant_id}.` : "Eval suite has no variants.");
  }

  await mkdir(options.eval_root, { recursive: true });
  await writeJson(join(options.eval_root, "suite-snapshot.json"), {
    suite: options.loaded.suite,
    scenarios,
    variants,
    graders: options.loaded.graders,
      judges: options.loaded.judges
  });

  const jobs: Array<{
    scenario: EvalScenario;
    variant: EvalVariant;
    trial_index: number;
  }> = [];

  for (const scenario of scenarios) {
    for (const variant of variants) {
      for (let trialIndex = 1; trialIndex <= trials; trialIndex += 1) {
        jobs.push({ scenario, variant, trial_index: trialIndex });
      }
    }
  }

  const concurrency = Math.max(1, Math.min(options.concurrency ?? 1, jobs.length));
  const results = new Array<EvalTrialResult>(jobs.length);
  let nextJobIndex = 0;

  async function runWorker(): Promise<void> {
    while (nextJobIndex < jobs.length) {
      if (options.signal?.aborted) {
        throw new Error("Eval run canceled.");
      }

      const jobIndex = nextJobIndex;
      nextJobIndex += 1;
      const job = jobs[jobIndex]!;

      results[jobIndex] = await runTrial({
          currentWorkingDirectory: options.currentWorkingDirectory,
          loaded: {
            ...options.loaded,
            variants
          },
          eval_root: options.eval_root,
          scenario: job.scenario,
          variant: job.variant,
          trial_index: job.trial_index,
          ...(options.signal ? { signal: options.signal } : {})
      });
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => runWorker()));

  const orderedResults = results.filter((result): result is EvalTrialResult => Boolean(result));
  const benchmark = computeBenchmark(orderedResults, variants, options.loaded.suite.thresholds);
  const ended_at = new Date().toISOString();
  const ledger: EvalRunLedger = {
    version: "2",
    suite_id: options.loaded.suite.suite_id,
    eval_root: options.eval_root,
    suite_path: options.loaded.suite_path,
    source_reference: options.loaded.suite.source_reference,
    started_at,
    ended_at,
    status: benchmark.threshold_passed ? "passed" : "failed",
    filters: {
      ...(options.scenario_id ? { scenario_id: options.scenario_id } : {}),
      ...(options.variant_id ? { variant_id: options.variant_id } : {})
    },
    trials_per_scenario: trials,
    thresholds: options.loaded.suite.thresholds,
    benchmark,
    results: orderedResults
  };

  await Promise.all([
    writeJson(join(options.eval_root, "eval-run.json"), {
      suite_id: options.loaded.suite.suite_id,
      suite_path: options.loaded.suite_path,
      started_at,
      ended_at,
      filters: ledger.filters,
      trials_per_scenario: trials
    }),
    writeJson(join(options.eval_root, "evaluation-ledger.json"), ledger),
    writeJson(join(options.eval_root, "benchmark.json"), benchmark),
    writeFile(join(options.eval_root, "report.md"), renderEvalReport(ledger), "utf8")
  ]);

  return {
    ledger,
    infrastructure_failed: results.some((result) => result.status === "errored")
  };
}

export async function readEvalLedger(evalRoot: string): Promise<EvalRunLedger> {
  return JSON.parse(await readFile(join(evalRoot, "evaluation-ledger.json"), "utf8")) as EvalRunLedger;
}

export function renderEvalReport(ledger: EvalRunLedger): string {
  return [
    `# Eval Suite ${ledger.suite_id}`,
    "",
    `- Status: ${ledger.status}`,
    `- Source: ${ledger.source_reference}`,
    `- Total trials: ${ledger.benchmark.total_trials}`,
    `- Pass rate: ${ledger.benchmark.pass_rate.toFixed(3)}`,
    `- Blocker rate: ${ledger.benchmark.blocker_rate.toFixed(3)}`,
    `- Average score: ${ledger.benchmark.average_score.toFixed(3)}`,
    "",
    "## Variants",
    ...ledger.benchmark.variants.map((variant) =>
      `- ${variant.variant_id}: pass_rate=${variant.pass_rate.toFixed(3)}, average_score=${variant.average_score.toFixed(3)}, blocker_rate=${variant.blocker_rate.toFixed(3)}`
    ),
    "",
    "## Trials",
    ...ledger.results.map((result) =>
      `- ${result.scenario_id} / ${result.variant_id} / ${result.trial_id}: ${result.status} score=${(result.scorecard?.scores.average ?? 0).toFixed(2)}`
    )
  ].join("\n");
}

export async function inspectEvalTrial(options: {
  eval_root: string;
  scenario_id: string;
  variant_id: string;
  trial_index: number;
}): Promise<{
  trial?: unknown;
  trace_packet?: unknown;
  scorecard?: EvalScorecard;
}> {
  const trialId = `trial-${String(options.trial_index).padStart(3, "0")}`;
  const trialRoot = join(
    options.eval_root,
    "scenarios",
    sanitizePathSegment(options.scenario_id),
    sanitizePathSegment(options.variant_id),
    trialId
  );

  return {
    trial: JSON.parse(await readFile(join(trialRoot, "trial.json"), "utf8")) as unknown,
    ...(await pathExists(join(trialRoot, "trace-packet.json"))
      ? { trace_packet: JSON.parse(await readFile(join(trialRoot, "trace-packet.json"), "utf8")) as unknown }
      : {}),
    scorecard: JSON.parse(await readFile(join(trialRoot, "scorecard.json"), "utf8")) as EvalScorecard
  };
}

function aggregateVariant(ledger: EvalRunLedger, variantId: string): EvalBenchmarkVariant {
  return ledger.benchmark.variants.find((variant) => variant.variant_id === variantId) ?? {
    variant_id: variantId,
    total_trials: 0,
    passed: 0,
    failed: 0,
    errored: 0,
    pass_rate: 0,
    blocker_rate: 0,
    average_score: 0
  };
}

export function compareEvalVariants(options: {
  ledger: EvalRunLedger;
  baseline: string;
  candidate: string;
}): {
  baseline: EvalBenchmarkVariant;
  candidate: EvalBenchmarkVariant;
  delta: {
    pass_rate: number;
    blocker_rate: number;
    average_score: number;
  };
  candidate_beats_baseline: boolean;
} {
  const baseline = aggregateVariant(options.ledger, options.baseline);
  const candidate = aggregateVariant(options.ledger, options.candidate);
  const delta = {
    pass_rate: Number((candidate.pass_rate - baseline.pass_rate).toFixed(4)),
    blocker_rate: Number((candidate.blocker_rate - baseline.blocker_rate).toFixed(4)),
    average_score: Number((candidate.average_score - baseline.average_score).toFixed(4))
  };

  return {
    baseline,
    candidate,
    delta,
    candidate_beats_baseline:
      candidate.blocker_rate <= baseline.blocker_rate &&
      candidate.pass_rate >= baseline.pass_rate &&
      candidate.average_score > baseline.average_score
  };
}

export async function listEvalScenarioIds(evalRoot: string): Promise<string[]> {
  const scenariosRoot = join(evalRoot, "scenarios");
  if (!await pathExists(scenariosRoot)) {
    return [];
  }

  return (await readdir(scenariosRoot)).sort();
}

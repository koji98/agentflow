import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { access, chmod, cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import { runCommand } from "../cli/commands/run.js";
import type {
  EvalAssertionResult,
  EvalBenchmark,
  EvalBenchmarkCriterion,
  EvalBenchmarkVariant,
  EvalCriterion,
  EvalCriterionResult,
  EvalRunLedger,
  EvalScenario,
  EvalTemplateEnvironmentContext,
  EvalTracePacket,
  EvalTrialResult,
  EvalSuiteThresholds,
  EvalVariant,
  LoadedEvalSuite
} from "./types.js";
import { runQualityCriterion, runScriptCriterion } from "./graders.js";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
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
  const target = resolve(root, decoded);
  const rootWithSep = root.endsWith("/") ? root : `${root}/`;

  if (!target.startsWith(rootWithSep) && target !== root) {
    return { status: 403, body: "forbidden", content_type: "text/plain" };
  }

  try {
    const info = await stat(target);
    let filePath = target;
    if (info.isDirectory()) {
      const htmlIndex = join(target, "index.html");
      const markdownIndex = join(target, "index.md");
      filePath = await pathExists(htmlIndex) ? htmlIndex : markdownIndex;
    }
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
    throw new Error("Docs environment server did not expose a port.");
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

function renderSimulationProxyScript(options: {
  command: string;
  rules: Array<Record<string, unknown>>;
  seed: string;
  eventsFile: string;
}): string {
  return `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const config = ${JSON.stringify(options, null, 2)};
const argv = process.argv.slice(2);
const cwd = process.cwd();

function hash(value) {
  let output = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    output ^= value.charCodeAt(index);
    output = Math.imul(output, 16777619);
  }
  return output >>> 0;
}

function probabilityAllows(rule) {
  if (typeof rule.probability !== "number") return true;
  const normalized = hash([config.seed, rule.id, cwd, ...argv].join("\\0")) / 0xffffffff;
  return normalized <= rule.probability;
}

function matches(rule) {
  const match = rule.match || {};
  if (Array.isArray(match.argv_exact) && JSON.stringify(match.argv_exact) !== JSON.stringify(argv)) {
    return false;
  }
  if (Array.isArray(match.argv_contains) && !match.argv_contains.every((part) => argv.includes(part))) {
    return false;
  }
  if (typeof match.cwd_contains === "string" && !cwd.includes(match.cwd_contains)) {
    return false;
  }
  return probabilityAllows(rule);
}

function log(event) {
  appendFileSync(config.eventsFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    command: config.command,
    argv,
    cwd,
    ...event
  }) + "\\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  const rule = config.rules.find(matches);
  if (!rule) {
    log({ matched: false, exit_code: 127, reason: "no_simulation_rule_matched" });
    process.stderr.write("No eval simulation rule matched " + config.command + " " + argv.join(" ") + "\\n");
    process.exit(127);
  }

  if (typeof rule.latency_ms === "number" && rule.latency_ms > 0) {
    await sleep(rule.latency_ms);
  }

  if (rule.error) {
    const exitCode = Number.isInteger(rule.error.exit_code) ? rule.error.exit_code : 1;
    log({ matched: true, rule_id: rule.id, exit_code: exitCode, injected_error: true });
    process.stderr.write(rule.error.stderr || "simulated tool error");
    process.exit(exitCode);
  }

  let response = rule.response || {};
  if (rule.response_file_path) {
    response = { ...response, stdout: readFileSync(rule.response_file_path, "utf8") };
  }
  const exitCode = Number.isInteger(response.exit_code) ? response.exit_code : 0;
  log({ matched: true, rule_id: rule.id, exit_code: exitCode });
  if (typeof response.stdout === "string") process.stdout.write(response.stdout);
  if (typeof response.stderr === "string") process.stderr.write(response.stderr);
  process.exit(exitCode);
})().catch((error) => {
  log({ matched: false, exit_code: 1, error: error && error.message ? error.message : String(error) });
  process.stderr.write(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
`;
}

async function createSimulationProxies(options: {
  scenario: EvalScenario;
  trial_root: string;
}): Promise<{
  bin_path?: string;
  events_file?: string;
}> {
  const simulation = options.scenario.environment.simulation;
  if (!simulation || simulation.tool_calls.length === 0) {
    return {};
  }

  const binPath = join(options.trial_root, "simulation-bin");
  const eventsFile = join(options.trial_root, "simulation-events.jsonl");
  await mkdir(binPath, { recursive: true });
  await writeFile(eventsFile, "", "utf8");

  const rulesByCommand = new Map<string, Array<Record<string, unknown>>>();
  for (const rule of simulation.tool_calls) {
    const rules = rulesByCommand.get(rule.command) ?? [];
    rules.push(rule as unknown as Record<string, unknown>);
    rulesByCommand.set(rule.command, rules);
  }

  for (const [command, rules] of rulesByCommand) {
    const scriptPath = join(binPath, command);
    await writeFile(
      scriptPath,
      renderSimulationProxyScript({
        command,
        rules,
        seed: simulation.seed ?? options.scenario.id,
        eventsFile
      }),
      "utf8"
    );
    await chmod(scriptPath, 0o755);
  }

  return {
    bin_path: binPath,
    events_file: eventsFile
  };
}

async function prepareTrialEnvironment(options: {
  scenario: EvalScenario;
  trial_root: string;
}): Promise<{
  environment: EvalTemplateEnvironmentContext;
  simulation_events_file?: string;
  path_entries: string[];
  close: () => Promise<void>;
}> {
  const workspaceRoot = join(options.trial_root, "workspace");
  const repoPath = join(workspaceRoot, "repo");
  await mkdir(workspaceRoot, { recursive: true });
  await cp(options.scenario.environment.repo_path, repoPath, { recursive: true, verbatimSymlinks: true });

  if (options.scenario.environment.init_git) {
    await initGitRepoIfNeeded(repoPath);
  }

  const docsServer = options.scenario.environment.docs_path
    ? await startDocsServer(options.scenario.environment.docs_path)
    : undefined;
  const toolsPath = options.scenario.environment.tools_path
    ? join(workspaceRoot, "tools")
    : undefined;

  if (options.scenario.environment.tools_path && toolsPath) {
    await cp(options.scenario.environment.tools_path, toolsPath, { recursive: true, verbatimSymlinks: true });
    await chmodToolFixtures(toolsPath);
  }

  const simulation = await createSimulationProxies({
    scenario: options.scenario,
    trial_root: options.trial_root
  });
  const pathEntries = [
    ...(simulation.bin_path ? [simulation.bin_path] : []),
    ...(toolsPath ? [toolsPath] : [])
  ];

  return {
    environment: {
      repo: repoPath,
      ...(docsServer ? { docs_url: docsServer.url } : {}),
      ...(toolsPath ? { tools: toolsPath } : {}),
      ...(simulation.events_file ? { simulation_events_file: simulation.events_file } : {}),
      trial_root: options.trial_root
    },
    ...(simulation.events_file ? { simulation_events_file: simulation.events_file } : {}),
    path_entries: pathEntries,
    close: async () => {
      await docsServer?.close();
    }
  };
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
    const runRoot = typeof output?.run_root === "string" ? output.run_root : undefined;
    const status = typeof output?.status === "string" ? output.status : undefined;

    return {
      ...(runRoot ? { run_root: runRoot } : {}),
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

function readCriterionConfig(scenario: EvalScenario, criterion: EvalCriterion): Record<string, unknown> {
  return scenario.criteria[criterion.id] ?? {};
}

function readRequiredArtifacts(config: Record<string, unknown>): Array<{ name: string; contains?: string[] }> {
  const raw = Array.isArray(config.required) ? config.required : [];
  return raw
    .filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.name === "string")
    .map((item) => ({
      name: item.name as string,
      ...(Array.isArray(item.contains)
        ? { contains: item.contains.filter((part): part is string => typeof part === "string") }
        : {})
    }));
}

function criterionResult(options: {
  criterion: EvalCriterion;
  passed: boolean;
  assertions: EvalAssertionResult[];
  blockers?: string[];
  score?: number;
  metrics?: Record<string, unknown>;
  rationale?: string;
}): EvalCriterionResult {
  const blockers = options.blockers ?? [];
  return {
    id: options.criterion.id,
    kind: options.criterion.kind,
    required: options.criterion.required,
    status: options.passed ? "passed" : "failed",
    passed: options.passed,
    blockers,
    assertions: options.assertions,
    ...(options.score !== undefined ? { score: options.score } : {}),
    ...(options.metrics ? { metrics: options.metrics } : {}),
    ...(options.rationale ? { rationale: options.rationale } : {})
  };
}

async function evaluateOutcomeCriterion(options: {
  criterion: EvalCriterion;
  scenario: EvalScenario;
  graphStatus?: string;
}): Promise<EvalCriterionResult> {
  const config = readCriterionConfig(options.scenario, options.criterion);
  const expectedStatus = readString(config.status) ?? "passed";
  const passed = options.graphStatus === expectedStatus;
  const evidence = `expected=${expectedStatus}; actual=${options.graphStatus ?? "not-run"}`;

  return criterionResult({
    criterion: options.criterion,
    passed,
    assertions: [{ id: "final_outcome", passed, evidence }],
    blockers: passed ? [] : [`Expected final outcome ${expectedStatus}, got ${options.graphStatus ?? "not-run"}.`]
  });
}

async function evaluateArtifactCriterion(options: {
  criterion: EvalCriterion;
  scenario: EvalScenario;
  tracePacket?: EvalTracePacket;
}): Promise<EvalCriterionResult> {
  const config = readCriterionConfig(options.scenario, options.criterion);
  const artifacts = readRequiredArtifacts(config);
  const assertions: EvalAssertionResult[] = [];
  const blockers: string[] = [];

  for (const artifact of artifacts) {
    const matched = options.tracePacket?.artifacts.find((entry) => entry.name === artifact.name);
    const passed = Boolean(matched && includesContent(matched.content, artifact.contains));
    assertions.push({
      id: `required_artifact:${artifact.name}`,
      passed,
      evidence: matched?.path ?? "artifact missing"
    });
    if (!passed) {
      blockers.push(`Required artifact "${artifact.name}" was missing or did not contain expected content.`);
    }
  }

  return criterionResult({
    criterion: options.criterion,
    passed: blockers.length === 0,
    assertions,
    blockers
  });
}

async function evaluateWorkspaceCriterion(options: {
  criterion: EvalCriterion;
  scenario: EvalScenario;
  environment?: EvalTemplateEnvironmentContext;
}): Promise<EvalCriterionResult> {
  const config = readCriterionConfig(options.scenario, options.criterion);
  const forbiddenEdits = readStringArray(config.forbidden_edits);
  const assertions: EvalAssertionResult[] = [];
  const blockers: string[] = [];

  for (const relativePath of forbiddenEdits) {
    const forbiddenPath = options.environment?.repo ? resolve(options.environment.repo, relativePath) : undefined;
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

  return criterionResult({
    criterion: options.criterion,
    passed: blockers.length === 0,
    assertions,
    blockers
  });
}

async function evaluateSupervisorCriterion(options: {
  criterion: EvalCriterion;
  scenario: EvalScenario;
  tracePacket?: EvalTracePacket;
}): Promise<EvalCriterionResult> {
  const config = readCriterionConfig(options.scenario, options.criterion);
  const supervisor = isRecord(config) ? config : {};
  const assertions: EvalAssertionResult[] = [];
  const blockers: string[] = [];

  for (const classification of readStringArray(supervisor.classifications)) {
    const passed = options.tracePacket?.supervisor.classifications.includes(classification) ?? false;
    assertions.push({ id: `supervisor_classification:${classification}`, passed });
    if (!passed) {
      blockers.push(`Expected supervisor classification "${classification}" was not observed.`);
    }
  }

  for (const gatherer of readStringArray(supervisor.gatherers)) {
    const passed = options.tracePacket?.supervisor.gatherers.includes(gatherer) ?? false;
    assertions.push({ id: `supervisor_gatherer:${gatherer}`, passed });
    if (!passed) {
      blockers.push(`Expected supervisor gatherer "${gatherer}" was not observed.`);
    }
  }

  for (const action of readStringArray(supervisor.apply_actions)) {
    const passed = options.tracePacket?.supervisor.apply_actions.includes(action) ?? false;
    assertions.push({ id: `supervisor_apply_action:${action}`, passed });
    if (!passed) {
      blockers.push(`Expected supervisor apply action "${action}" was not observed.`);
    }
  }

  return criterionResult({
    criterion: options.criterion,
    passed: blockers.length === 0,
    assertions,
    blockers
  });
}

function matchesTrajectoryEvent(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, expectedValue]) => {
    if (expectedValue === undefined) {
      return true;
    }

    return JSON.stringify(actual[key]) === JSON.stringify(expectedValue);
  });
}

function trajectoryContainsOrdered(
  trajectory: Array<Record<string, unknown>>,
  expected: Array<Record<string, unknown>>
): boolean {
  let offset = 0;
  for (const item of trajectory) {
    const next = expected[offset];
    if (next && matchesTrajectoryEvent(item, next)) {
      offset += 1;
    }
    if (offset === expected.length) {
      return true;
    }
  }
  return expected.length === 0;
}

async function evaluateTrajectoryCriterion(options: {
  criterion: EvalCriterion;
  scenario: EvalScenario;
  tracePacket?: EvalTracePacket;
}): Promise<EvalCriterionResult> {
  const config = readCriterionConfig(options.scenario, options.criterion);
  const matchMode = readString(config.match) ?? "contains_ordered";
  const rawEvents = Array.isArray(config.events) ? config.events : [];
  const expectedEvents = rawEvents.filter((entry): entry is Record<string, unknown> => isRecord(entry));
  const trajectory = (options.tracePacket?.trajectory ?? []) as Array<Record<string, unknown>>;
  let passed = true;

  if (matchMode === "exact_order") {
    passed =
      trajectory.length === expectedEvents.length &&
      expectedEvents.every((expected, index) => matchesTrajectoryEvent(trajectory[index] ?? {}, expected));
  } else if (matchMode === "contains_any_order") {
    passed = expectedEvents.every((expected) => trajectory.some((event) => matchesTrajectoryEvent(event, expected)));
  } else if (matchMode === "forbid") {
    passed = expectedEvents.every((expected) => !trajectory.some((event) => matchesTrajectoryEvent(event, expected)));
  } else {
    passed = trajectoryContainsOrdered(trajectory, expectedEvents);
  }

  return criterionResult({
    criterion: options.criterion,
    passed,
    assertions: [{
      id: `trajectory:${matchMode}`,
      passed,
      evidence: `expected_events=${expectedEvents.length}; actual_events=${trajectory.length}`
    }],
    blockers: passed ? [] : [`Trajectory criterion "${options.criterion.id}" did not satisfy ${matchMode}.`]
  });
}

async function evaluateDeliveryCriterion(options: {
  criterion: EvalCriterion;
  scenario: EvalScenario;
  tracePacket?: EvalTracePacket;
  graphStatus?: string;
}): Promise<EvalCriterionResult> {
  const config = readCriterionConfig(options.scenario, options.criterion);
  const required = typeof config.required === "boolean" ? config.required : true;
  const passed = !required || Boolean(options.tracePacket?.delivery.manifest_path && options.tracePacket.delivery.manifest);
  const blockers = passed || options.graphStatus !== "passed" ? [] : ["Delivery manifest was missing for a completed run."];

  return criterionResult({
    criterion: options.criterion,
    passed,
    assertions: [{
      id: "delivery_manifest",
      passed,
      evidence: options.tracePacket?.delivery.manifest_path ?? "missing"
    }],
    blockers
  });
}

function unavailableCriterionResult(options: {
  criterion: EvalCriterion;
  reason: string;
}): EvalCriterionResult {
  const result: EvalCriterionResult = {
    id: options.criterion.id,
    kind: options.criterion.kind,
    required: options.criterion.required,
    status: options.criterion.required ? "errored" : "skipped",
    passed: !options.criterion.required,
    blockers: options.criterion.required ? [options.reason] : [],
    assertions: [{ id: "criterion_unavailable", passed: !options.criterion.required, evidence: options.reason }]
  };

  if (options.criterion.required) {
    result.error = options.reason;
  }

  return result;
}

async function evaluateCriteria(options: {
  loaded: LoadedEvalSuite;
  scenario: EvalScenario;
  variant: EvalVariant;
  trial_id: string;
  trial_root: string;
  run_root?: string;
  graphStatus?: string;
  trace_file: string;
  trace_packet_file: string;
  scorecard_file: string;
  tracePacket?: EvalTracePacket;
  environment?: EvalTemplateEnvironmentContext;
  signal?: AbortSignal;
}): Promise<EvalCriterionResult[]> {
  const results: EvalCriterionResult[] = [];
  const anonymizedVariantLabel = `variant-${String(options.loaded.variants.findIndex((entry) => entry.id === options.variant.id) + 1).padStart(2, "0")}`;

  for (const criterion of options.loaded.criteria) {
    if (criterion.kind === "outcome") {
      results.push(await evaluateOutcomeCriterion({
        criterion,
        scenario: options.scenario,
        ...(options.graphStatus ? { graphStatus: options.graphStatus } : {})
      }));
      continue;
    }

    if (criterion.kind === "artifact") {
      results.push(await evaluateArtifactCriterion({
        criterion,
        scenario: options.scenario,
        ...(options.tracePacket ? { tracePacket: options.tracePacket } : {})
      }));
      continue;
    }

    if (criterion.kind === "workspace") {
      results.push(await evaluateWorkspaceCriterion({
        criterion,
        scenario: options.scenario,
        ...(options.environment ? { environment: options.environment } : {})
      }));
      continue;
    }

    if (criterion.kind === "supervisor") {
      results.push(await evaluateSupervisorCriterion({
        criterion,
        scenario: options.scenario,
        ...(options.tracePacket ? { tracePacket: options.tracePacket } : {})
      }));
      continue;
    }

    if (criterion.kind === "trajectory") {
      results.push(await evaluateTrajectoryCriterion({
        criterion,
        scenario: options.scenario,
        ...(options.tracePacket ? { tracePacket: options.tracePacket } : {})
      }));
      continue;
    }

    if (criterion.kind === "delivery") {
      results.push(await evaluateDeliveryCriterion({
        criterion,
        scenario: options.scenario,
        ...(options.tracePacket ? { tracePacket: options.tracePacket } : {}),
        ...(options.graphStatus ? { graphStatus: options.graphStatus } : {})
      }));
      continue;
    }

    if (!options.run_root || !options.tracePacket) {
      results.push(unavailableCriterionResult({
        criterion,
        reason: "Criterion requires a completed Agentflow run root and trace packet."
      }));
      continue;
    }

    if (criterion.kind === "custom_script") {
      results.push(await runScriptCriterion({
        criterion,
        suite_dir: options.loaded.suite_dir,
        scenario: options.scenario,
        variant_id: options.variant.id,
        trial_id: options.trial_id,
        run_root: options.run_root,
        trace_file: options.trace_file,
        trace_packet_file: options.trace_packet_file,
        scorecard_file: options.scorecard_file,
        output_dir: join(options.trial_root, "criteria", sanitizePathSegment(criterion.id)),
        ...(options.signal ? { signal: options.signal } : {})
      }));
      continue;
    }

    results.push(await runQualityCriterion({
      criterion,
      suite_dir: options.loaded.suite_dir,
      scenario: options.scenario,
      anonymized_variant_label: anonymizedVariantLabel,
      trial_id: options.trial_id,
      run_root: options.run_root,
      trace_packet: options.tracePacket,
      trace_packet_file: options.trace_packet_file,
      output_dir: join(options.trial_root, "judge-results", sanitizePathSegment(criterion.id)),
      ...(options.signal ? { signal: options.signal } : {})
    }));
  }

  return results;
}

function mergePromptFeedback(criteriaResults: EvalCriterionResult[]): EvalScorecardPromptFeedback {
  const quality = criteriaResults.filter((result) => result.prompt_feedback);
  return {
    helpful_sections: [...new Set(quality.flatMap((result) => result.prompt_feedback?.helpful_sections ?? []))],
    noisy_sections: [...new Set(quality.flatMap((result) => result.prompt_feedback?.noisy_sections ?? []))],
    missing_guidance: [...new Set(quality.flatMap((result) => result.prompt_feedback?.missing_guidance ?? []))]
  };
}

type EvalScorecardPromptFeedback = {
  helpful_sections: string[];
  noisy_sections: string[];
  missing_guidance: string[];
};

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
  criteria_results: EvalCriterionResult[];
  tracePacket?: EvalTracePacket;
  error?: string;
}): EvalTrialResult["scorecard"] {
  const requiredPassed = options.criteria_results.every((result) => !result.required || result.status === "passed");
  const passed = requiredPassed && !options.error;
  const scores = options.criteria_results.map((result) => {
    if (typeof result.score === "number") {
      return result.score <= 1 ? result.score * 5 : result.score;
    }
    return result.passed ? 5 : 1;
  });
  const dimensions: Record<string, number> = {};

  for (const result of options.criteria_results) {
    for (const [dimension, score] of Object.entries(result.dimension_scores ?? {})) {
      dimensions[dimension] = score;
    }
  }

  const blockerCount = options.criteria_results.reduce((sum, result) => sum + result.blockers.length, 0);

  return {
    schema_version: "1",
    suite_id: options.suite_id,
    scenario_id: options.scenario.id,
    variant_id: options.variant.id,
    trial_id: options.trial_id,
    status: options.error ? "errored" : passed ? "passed" : "failed",
    passed,
    criteria_results: options.criteria_results,
    scores: {
      average: Number(average(scores).toFixed(4)),
      dimensions
    },
    metrics: {
      attempts: options.tracePacket?.metrics.attempts ?? 0,
      recovery_cycles: options.tracePacket?.metrics.recovery_cycles ?? 0,
      ...(options.tracePacket?.metrics.duration_ms !== undefined ? { duration_ms: options.tracePacket.metrics.duration_ms } : {}),
      blockers: blockerCount
    },
    prompt_feedback: mergePromptFeedback(options.criteria_results),
    ...(options.error ? { error: options.error } : {})
  };
}

function errorCriterionResult(message: string): EvalCriterionResult {
  return {
    id: "infrastructure",
    kind: "outcome",
    required: true,
    status: "errored",
    passed: false,
    blockers: [message],
    assertions: [{ id: "infrastructure_error", passed: false, evidence: message }],
    error: message
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
  const criteriaResultsFile = join(trialRoot, "criteria-results.json");
  const scorecardFile = join(trialRoot, "scorecard.json");
  const summaryFile = join(trialRoot, "summary.md");
  let environmentState: Awaited<ReturnType<typeof prepareTrialEnvironment>> | undefined;

  await mkdir(trialRoot, { recursive: true });

  try {
    environmentState = await prepareTrialEnvironment({
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
      environment: {
        ...environmentState.environment,
        eval_root: options.eval_root
      }
    });

    await writeJson(trialFile, {
      scenario_id: options.scenario.id,
      variant_id: options.variant.id,
      trial_id: trialId,
      trial_index: options.trial_index,
      root: trialRoot,
      environment: environmentState.environment
    });
    await writeJson(renderedGraphFile, rendered.graph);

    if (rendered.diagnostics.length > 0) {
      const error = rendered.diagnostics.map((diagnostic) => diagnostic.message).join(" ");
      const scorecard = buildScorecard({
        suite_id: options.loaded.suite.suite_id,
        scenario: options.scenario,
        variant: options.variant,
        trial_id: trialId,
        criteria_results: [errorCriterionResult(error)],
        error
      })!;
      await Promise.all([
        writeJson(criteriaResultsFile, scorecard.criteria_results),
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
      ...(environmentState.path_entries.length > 0
        ? { PATH: `${environmentState.path_entries.join(":")}:${process.env.PATH ?? ""}` }
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
    let tracePacket: EvalTracePacket | undefined;

    if (graphRun.run_root) {
      await writeFile(runRootFile, `${graphRun.run_root}\n`, "utf8");
      await writeEvalTrace({ run_root: graphRun.run_root, trace_file: traceFile });
      tracePacket = await buildEvalTracePacket({
        run_root: graphRun.run_root,
        ...(environmentState.simulation_events_file ? { simulation_events_file: environmentState.simulation_events_file } : {})
      });
      await writeJson(tracePacketFile, tracePacket);
    }

    const criteriaResults = await evaluateCriteria({
      loaded: options.loaded,
      scenario: options.scenario,
      variant: options.variant,
      trial_id: trialId,
      trial_root: trialRoot,
      ...(graphRun.run_root ? { run_root: graphRun.run_root } : {}),
      ...(graphRun.status ? { graphStatus: graphRun.status } : {}),
      trace_file: traceFile,
      trace_packet_file: tracePacketFile,
      scorecard_file: scorecardFile,
      ...(tracePacket ? { tracePacket } : {}),
      environment: environmentState.environment,
      ...(options.signal ? { signal: options.signal } : {})
    });
    await writeJson(criteriaResultsFile, criteriaResults);

    const scorecard = buildScorecard({
      suite_id: options.loaded.suite.suite_id,
      scenario: options.scenario,
      variant: options.variant,
      trial_id: trialId,
      criteria_results: criteriaResults,
      ...(tracePacket ? { tracePacket } : {}),
      ...(!graphRun.run_root && graphRun.error ? { error: graphRun.error } : {})
    })!;
    const blockers = scorecard.criteria_results.flatMap((result) => result.blockers);

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
          "## Criteria",
          ...scorecard.criteria_results.map((result) =>
            `- ${result.id} (${result.kind}): ${result.status}${result.score !== undefined ? ` score=${result.score}` : ""}`
          ),
          "",
          "## Blockers",
          ...(blockers.length > 0 ? blockers.map((blocker) => `- ${blocker}`) : ["- none"])
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
    const scorecard = buildScorecard({
      suite_id: options.loaded.suite.suite_id,
      scenario: options.scenario,
      variant: options.variant,
      trial_id: trialId,
      criteria_results: [errorCriterionResult(message)],
      error: message
    })!;

    await Promise.all([
      writeJson(criteriaResultsFile, scorecard.criteria_results),
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
    await environmentState?.close();
  }
}

function variance(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
}

function aggregateCriteria(results: EvalTrialResult[], criteria: EvalCriterion[]): EvalBenchmarkCriterion[] {
  return criteria.map((criterion) => {
    const criterionResults = results
      .filter((result) => result.status !== "skipped")
      .map((result) => result.scorecard?.criteria_results.find((entry) => entry.id === criterion.id))
      .filter((result): result is EvalCriterionResult => Boolean(result));
    const total = criterionResults.length;
    const passed = criterionResults.filter((result) => result.status === "passed").length;
    const failed = criterionResults.filter((result) => result.status === "failed").length;
    const errored = criterionResults.filter((result) => result.status === "errored").length;
    const blockers = criterionResults.reduce((sum, result) => sum + result.blockers.length, 0);
    const scores = criterionResults
      .map((result) => typeof result.score === "number" ? result.score : result.passed ? 5 : 1)
      .filter((score) => Number.isFinite(score));

    return {
      criterion_id: criterion.id,
      kind: criterion.kind,
      required: criterion.required,
      total_trials: total,
      passed,
      failed,
      errored,
      pass_rate: total > 0 ? passed / total : 0,
      blocker_count: blockers,
      average_score: scores.length > 0 ? Number((scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(4)) : 0
    };
  });
}

function computeVariantBenchmark(variantId: string, results: EvalTrialResult[], criteria: EvalCriterion[]): EvalBenchmarkVariant {
  const variantResults = results.filter((result) => result.variant_id === variantId && result.status !== "skipped");
  const total = variantResults.length;
  const passed = variantResults.filter((result) => result.status === "passed").length;
  const errored = variantResults.filter((result) => result.status === "errored").length;
  const failed = variantResults.filter((result) => result.status === "failed").length;
  const blockers = variantResults.reduce((sum, result) => sum + (result.scorecard?.metrics.blockers ?? 0), 0);
  const scores = variantResults.map((result) => result.scorecard?.scores.average ?? 0);

  return {
    variant_id: variantId,
    total_trials: total,
    passed,
    failed,
    errored,
    pass_rate: total > 0 ? passed / total : 0,
    blocker_rate: total > 0 ? blockers / total : 0,
    average_score: scores.length > 0 ? Number((scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(4)) : 0,
    criteria: aggregateCriteria(variantResults, criteria)
  };
}

function computeBenchmark(
  results: EvalTrialResult[],
  variants: EvalVariant[],
  criteria: EvalCriterion[],
  thresholds: EvalSuiteThresholds
): EvalBenchmark {
  const total = results.filter((result) => result.status !== "skipped").length;
  const passed = results.filter((result) => result.status === "passed").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const errored = results.filter((result) => result.status === "errored").length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  const blockers = results.reduce((sum, result) => sum + (result.scorecard?.metrics.blockers ?? 0), 0);
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
    variants: variants.map((variant) => computeVariantBenchmark(variant.id, results, criteria)),
    criteria: aggregateCriteria(results, criteria)
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
  const startedAt = new Date().toISOString();
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
    criteria: options.loaded.criteria
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
  const benchmark = computeBenchmark(orderedResults, variants, options.loaded.criteria, options.loaded.suite.thresholds);
  const endedAt = new Date().toISOString();
  const ledger: EvalRunLedger = {
    version: "1",
    suite_id: options.loaded.suite.suite_id,
    eval_root: options.eval_root,
    suite_path: options.loaded.suite_path,
    source_reference: options.loaded.suite.source_reference,
    started_at: startedAt,
    ended_at: endedAt,
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
      started_at: startedAt,
      ended_at: endedAt,
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
    "## Criteria",
    ...ledger.benchmark.criteria.map((criterion) =>
      `- ${criterion.criterion_id} (${criterion.kind}): pass_rate=${criterion.pass_rate.toFixed(3)}, average_score=${criterion.average_score.toFixed(3)}, blockers=${criterion.blocker_count}`
    ),
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
  scorecard?: EvalTrialResult["scorecard"];
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
    scorecard: JSON.parse(await readFile(join(trialRoot, "scorecard.json"), "utf8")) as EvalTrialResult["scorecard"]
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
    average_score: 0,
    criteria: []
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
  criteria_delta: Array<{
    criterion_id: string;
    pass_rate: number;
    blocker_count: number;
    average_score: number;
  }>;
  candidate_beats_baseline: boolean;
} {
  const baseline = aggregateVariant(options.ledger, options.baseline);
  const candidate = aggregateVariant(options.ledger, options.candidate);
  const delta = {
    pass_rate: Number((candidate.pass_rate - baseline.pass_rate).toFixed(4)),
    blocker_rate: Number((candidate.blocker_rate - baseline.blocker_rate).toFixed(4)),
    average_score: Number((candidate.average_score - baseline.average_score).toFixed(4))
  };
  const baselineCriteria = new Map(baseline.criteria.map((criterion) => [criterion.criterion_id, criterion]));
  const candidateCriteria = new Map(candidate.criteria.map((criterion) => [criterion.criterion_id, criterion]));
  const criterionIds = new Set([...baselineCriteria.keys(), ...candidateCriteria.keys()]);
  const criteriaDelta = [...criterionIds].map((criterionId) => {
    const base = baselineCriteria.get(criterionId);
    const next = candidateCriteria.get(criterionId);
    return {
      criterion_id: criterionId,
      pass_rate: Number(((next?.pass_rate ?? 0) - (base?.pass_rate ?? 0)).toFixed(4)),
      blocker_count: (next?.blocker_count ?? 0) - (base?.blocker_count ?? 0),
      average_score: Number(((next?.average_score ?? 0) - (base?.average_score ?? 0)).toFixed(4))
    };
  });

  return {
    baseline,
    candidate,
    delta,
    criteria_delta: criteriaDelta,
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

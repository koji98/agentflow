import { access, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { harnessNames, reasoningEfforts } from "../graph/schema.js";
import type {
  EvalDiagnostic,
  EvalExpectedArtifact,
  EvalJudge,
  EvalScenario,
  EvalScenarioExpected,
  EvalScenarioFixture,
  EvalScenarioGrading,
  EvalScenarioMetadata,
  EvalScenarioRealWorldMetadata,
  EvalScenarioWorkflow,
  EvalScriptGrader,
  EvalSuite,
  EvalSuiteThresholds,
  EvalTemplateFixtureContext,
  EvalTemplateTrialContext,
  EvalVariant,
  LoadedEvalSuite
} from "./types.js";
import { evalSourceReference } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function resolveSuitePath(suiteDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(suiteDir, path);
}

function resolveScenarioPath(scenarioDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(scenarioDir, path);
}

async function resolveSuiteInput(currentWorkingDirectory: string, suiteInput: string): Promise<{
  suite_path: string;
  suite_dir: string;
}> {
  const resolved = resolve(currentWorkingDirectory, suiteInput);

  try {
    const info = await stat(resolved);
    if (info.isDirectory()) {
      return {
        suite_path: resolve(resolved, "eval.json"),
        suite_dir: resolved
      };
    }
  } catch {
    // Let the read step produce the final diagnostic.
  }

  return {
    suite_path: resolved,
    suite_dir: dirname(resolved)
  };
}

function normalizeThresholds(value: unknown, diagnostics: EvalDiagnostic[]): EvalSuiteThresholds {
  if (value === undefined) {
    return {};
  }

  if (!isRecord(value)) {
    diagnostics.push({ path: "$.thresholds", message: "Eval thresholds must be an object." });
    return {};
  }

  const pass_rate = readNumber(value.pass_rate);
  const max_blocker_rate = readNumber(value.max_blocker_rate);
  const min_average_score = readNumber(value.min_average_score);
  const thresholds: EvalSuiteThresholds = {};

  if (value.pass_rate !== undefined && (pass_rate === undefined || pass_rate < 0 || pass_rate > 1)) {
    diagnostics.push({ path: "$.thresholds.pass_rate", message: "pass_rate threshold must be a number between 0 and 1." });
  } else if (pass_rate !== undefined) {
    thresholds.pass_rate = pass_rate;
  }

  if (
    value.max_blocker_rate !== undefined &&
    (max_blocker_rate === undefined || max_blocker_rate < 0 || max_blocker_rate > 1)
  ) {
    diagnostics.push({
      path: "$.thresholds.max_blocker_rate",
      message: "max_blocker_rate threshold must be a number between 0 and 1."
    });
  } else if (max_blocker_rate !== undefined) {
    thresholds.max_blocker_rate = max_blocker_rate;
  }

  if (
    value.min_average_score !== undefined &&
    (min_average_score === undefined || min_average_score < 1 || min_average_score > 5)
  ) {
    diagnostics.push({
      path: "$.thresholds.min_average_score",
      message: "min_average_score threshold must be a number between 1 and 5."
    });
  } else if (min_average_score !== undefined) {
    thresholds.min_average_score = min_average_score;
  }

  return thresholds;
}

function normalizeScriptGrader(value: unknown, path: string, diagnostics: EvalDiagnostic[]): EvalScriptGrader | undefined {
  if (!isRecord(value)) {
    diagnostics.push({ path, message: "Eval grader must be an object." });
    return undefined;
  }

  const id = readString(value.id);
  const kind = readString(value.kind);
  const command = readString(value.command);
  const required = readBoolean(value.required);
  const timeout_sec = readNumber(value.timeout_sec);

  if (!id) {
    diagnostics.push({ path: `${path}.id`, message: "Eval grader requires non-empty id." });
  }

  if (kind !== "script") {
    diagnostics.push({ path: `${path}.kind`, message: 'Eval grader kind must be "script".' });
  }

  if (!command) {
    diagnostics.push({ path: `${path}.command`, message: "Script grader requires non-empty command." });
  }

  if (!id || kind !== "script" || !command) {
    return undefined;
  }

  return {
    id,
    kind,
    command,
    required: required ?? true,
    ...(timeout_sec !== undefined ? { timeout_sec } : {})
  };
}

function normalizeSuite(value: unknown, diagnostics: EvalDiagnostic[]): EvalSuite | undefined {
  if (!isRecord(value)) {
    diagnostics.push({ path: "$", message: "Eval suite must be a JSON object." });
    return undefined;
  }

  const version = value.version;
  const suite_id = readString(value.suite_id);
  const objective = readString(value.objective);
  const default_trials = readNumber(value.default_trials);
  const scenarios = Array.isArray(value.scenarios) ? value.scenarios.filter((item): item is string => typeof item === "string") : [];
  const variants = Array.isArray(value.variants) ? value.variants.filter((item): item is string => typeof item === "string") : [];
  const graders = Array.isArray(value.graders)
    ? value.graders
        .map((grader, index) => normalizeScriptGrader(grader, `$.graders[${index}]`, diagnostics))
        .filter((grader): grader is EvalScriptGrader => grader !== undefined)
    : [];
  const thresholds = normalizeThresholds(value.thresholds, diagnostics);

  if (version !== "2") {
    diagnostics.push({ path: "$.version", message: 'Eval suite version must be "2".' });
  }

  if (!suite_id) {
    diagnostics.push({ path: "$.suite_id", message: "Eval suite requires non-empty suite_id." });
  }

  if (!objective) {
    diagnostics.push({ path: "$.objective", message: "Eval suite requires non-empty objective." });
  }

  if (default_trials === undefined || !Number.isInteger(default_trials) || default_trials < 1) {
    diagnostics.push({ path: "$.default_trials", message: "default_trials must be a positive integer." });
  }

  if (!Array.isArray(value.scenarios) || scenarios.length === 0) {
    diagnostics.push({ path: "$.scenarios", message: "Eval suite requires at least one scenario path." });
  }

  if (!Array.isArray(value.variants) || variants.length === 0) {
    diagnostics.push({ path: "$.variants", message: "Eval suite requires at least one variant path." });
  }

  if (value.judges !== undefined && !Array.isArray(value.judges)) {
    diagnostics.push({ path: "$.judges", message: "Eval judges must be an array." });
  }

  if (value.graders !== undefined && !Array.isArray(value.graders)) {
    diagnostics.push({ path: "$.graders", message: "Eval graders must be an array." });
  }

  if (version !== "2" || !suite_id || !objective) {
    return undefined;
  }

  return {
    version,
    suite_id,
    objective,
    source_reference: evalSourceReference,
    default_trials: default_trials !== undefined && Number.isInteger(default_trials) && default_trials > 0
      ? default_trials
      : 1,
    scenarios,
    variants,
    graders,
    judges: [],
    thresholds
  };
}

function normalizeVariant(value: unknown, variantPath: string, diagnostics: EvalDiagnostic[]): EvalVariant | undefined {
  if (!isRecord(value)) {
    diagnostics.push({ path: `variant:${variantPath}`, message: "Eval variant must be an object." });
    return undefined;
  }

  const id = readString(value.id);
  const description = readString(value.description);
  const graph_template = readString(value.graph_template);
  const prompt_pack = readString(value.prompt_pack);
  const envValue = value.env;
  const env =
    isRecord(envValue)
      ? Object.fromEntries(Object.entries(envValue).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};

  if (!id) {
    diagnostics.push({ path: `variant:${variantPath}.id`, message: "Eval variant requires non-empty id." });
  }

  if (!description) {
    diagnostics.push({ path: `variant:${variantPath}.description`, message: "Eval variant requires non-empty description." });
  }

  if (envValue !== undefined && !isRecord(envValue)) {
    diagnostics.push({ path: `variant:${variantPath}.env`, message: "Eval variant env must be an object of string values." });
  }

  if (!id || !description) {
    return undefined;
  }

  return {
    id,
    description,
    variant_path: variantPath,
    ...(graph_template ? { graph_template } : {}),
    ...(prompt_pack ? { prompt_pack } : {}),
    env
  };
}

function normalizeExpectedArtifact(value: unknown): EvalExpectedArtifact | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const name = readString(value.name);
  if (!name) {
    return undefined;
  }

  const contains = Array.isArray(value.contains)
    ? value.contains.filter((item): item is string => typeof item === "string")
    : undefined;

  return {
    name,
    ...(contains && contains.length > 0 ? { contains } : {})
  };
}

function normalizeExpected(value: unknown): EvalScenarioExpected {
  const record = isRecord(value) ? value : {};
  const supervisor = isRecord(record.supervisor) ? record.supervisor : {};

  return {
    final_outcome:
      record.final_outcome === "failed" ||
      record.final_outcome === "paused" ||
      record.final_outcome === "canceled"
        ? record.final_outcome
        : "passed",
    required_artifacts: Array.isArray(record.required_artifacts)
      ? record.required_artifacts
          .map(normalizeExpectedArtifact)
          .filter((artifact): artifact is EvalExpectedArtifact => artifact !== undefined)
      : [],
    forbidden_edits: Array.isArray(record.forbidden_edits)
      ? record.forbidden_edits.filter((item): item is string => typeof item === "string")
      : [],
    supervisor: {
      classifications: Array.isArray(supervisor.classifications)
        ? supervisor.classifications.filter((item): item is string => typeof item === "string")
        : [],
      gatherers: Array.isArray(supervisor.gatherers)
        ? supervisor.gatherers.filter((item): item is string => typeof item === "string")
        : [],
      apply_actions: Array.isArray(supervisor.apply_actions)
        ? supervisor.apply_actions.filter((item): item is string => typeof item === "string")
        : []
    },
    ...(typeof record.expected_pause === "boolean" ? { expected_pause: record.expected_pause } : {})
  };
}

function isValidUrl(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname === "github.com";
  } catch {
    return false;
  }
}

function isFullGitSha(value: string | undefined): boolean {
  return Boolean(value && /^[a-f0-9]{40}$/u.test(value));
}

function normalizeRealWorldMetadata(
  value: unknown,
  scenarioDir: string,
  path: string,
  diagnostics: EvalDiagnostic[]
): EvalScenarioRealWorldMetadata | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    diagnostics.push({ path, message: "Real-world eval metadata must be an object." });
    return undefined;
  }

  const source_repo = readString(value.source_repo);
  const license = readString(value.license);
  const base_sha = readString(value.base_sha);
  const issue_url = readString(value.issue_url);
  const pr_url = readString(value.pr_url);
  const oracle_commit_sha = readString(value.oracle_commit_sha);
  const package_manager = readString(value.package_manager);
  const regression_patch = readString(value.regression_patch);
  const setup_command = readString(value.setup_command);
  const focused_test_command = readString(value.focused_test_command);
  const allowed_changed_globs = readStringArray(value.allowed_changed_globs);
  const forbidden_changed_globs = readStringArray(value.forbidden_changed_globs);
  const hidden_oracle_changed_files = readStringArray(value.hidden_oracle_changed_files);

  if (!source_repo) {
    diagnostics.push({ path: `${path}.source_repo`, message: "Real-world metadata requires source_repo." });
  }

  if (license !== "MIT") {
    diagnostics.push({ path: `${path}.license`, message: 'Real-world metadata license must be "MIT".' });
  }

  if (!isFullGitSha(base_sha)) {
    diagnostics.push({ path: `${path}.base_sha`, message: "Real-world metadata base_sha must be a full 40-character git SHA." });
  }

  if (!isValidUrl(issue_url)) {
    diagnostics.push({ path: `${path}.issue_url`, message: "Real-world metadata issue_url must be a GitHub https URL." });
  }

  if (!isValidUrl(pr_url)) {
    diagnostics.push({ path: `${path}.pr_url`, message: "Real-world metadata pr_url must be a GitHub https URL." });
  }

  if (!isFullGitSha(oracle_commit_sha)) {
    diagnostics.push({
      path: `${path}.oracle_commit_sha`,
      message: "Real-world metadata oracle_commit_sha must be a full 40-character git SHA."
    });
  }

  if (!package_manager) {
    diagnostics.push({ path: `${path}.package_manager`, message: "Real-world metadata requires package_manager." });
  }

  if (!regression_patch) {
    diagnostics.push({ path: `${path}.regression_patch`, message: "Real-world metadata requires regression_patch." });
  }

  if (!setup_command) {
    diagnostics.push({ path: `${path}.setup_command`, message: "Real-world metadata requires setup_command." });
  }

  if (!focused_test_command) {
    diagnostics.push({ path: `${path}.focused_test_command`, message: "Real-world metadata requires focused_test_command." });
  }

  if (allowed_changed_globs.length === 0) {
    diagnostics.push({
      path: `${path}.allowed_changed_globs`,
      message: "Real-world metadata requires at least one allowed_changed_glob."
    });
  }

  if (
    !source_repo ||
    license !== "MIT" ||
    !isFullGitSha(base_sha) ||
    !isValidUrl(issue_url) ||
    !isValidUrl(pr_url) ||
    !isFullGitSha(oracle_commit_sha) ||
    !package_manager ||
    !regression_patch ||
    !setup_command ||
    !focused_test_command ||
    allowed_changed_globs.length === 0
  ) {
    return undefined;
  }

  return {
    source_repo,
    license,
    base_sha: base_sha!,
    issue_url: issue_url!,
    pr_url: pr_url!,
    oracle_commit_sha: oracle_commit_sha!,
    package_manager,
    regression_patch,
    regression_patch_path: resolveScenarioPath(scenarioDir, regression_patch),
    setup_command,
    focused_test_command,
    allowed_changed_globs,
    forbidden_changed_globs,
    hidden_oracle_changed_files
  };
}

function normalizeScenarioMetadata(
  value: unknown,
  scenarioDir: string,
  path: string,
  diagnostics: EvalDiagnostic[]
): EvalScenarioMetadata {
  if (value === undefined) {
    return {};
  }

  if (!isRecord(value)) {
    diagnostics.push({ path, message: "Eval scenario metadata must be an object." });
    return {};
  }

  const metadata: EvalScenarioMetadata = { ...value };
  const realworld = normalizeRealWorldMetadata(value.realworld, scenarioDir, `${path}.realworld`, diagnostics);
  if (realworld) {
    metadata.realworld = realworld;
  } else {
    delete metadata.realworld;
  }

  return metadata;
}

function normalizeScenario(
  value: unknown,
  scenarioPath: string,
  suiteDir: string,
  diagnostics: EvalDiagnostic[]
): EvalScenario | undefined {
  if (!isRecord(value)) {
    diagnostics.push({ path: `scenario:${scenarioPath}`, message: "Eval scenario must be an object." });
    return undefined;
  }

  const scenarioDir = dirname(scenarioPath);
  const id = readString(value.id);
  const bucket = readString(value.bucket);
  const difficulty = readString(value.difficulty);
  const description = readString(value.description);
  const fixtureRecord = isRecord(value.fixture) ? value.fixture : undefined;
  const workflowRecord = isRecord(value.workflow) ? value.workflow : undefined;
  const repo = fixtureRecord ? readString(fixtureRecord.repo) : undefined;
  const docs = fixtureRecord ? readString(fixtureRecord.docs) : undefined;
  const tools = fixtureRecord ? readString(fixtureRecord.tools) : undefined;
  const graph_template = workflowRecord ? readString(workflowRecord.graph_template) : undefined;
  const harness = workflowRecord ? readString(workflowRecord.harness) : undefined;
  const workspace_backend = workflowRecord?.workspace_backend === "worktree" ? "worktree" : "inplace";
  const launch_profile = workflowRecord ? readString(workflowRecord.launch_profile) : undefined;
  const gradingRecord = isRecord(value.grading) ? value.grading : {};
  const metadata = normalizeScenarioMetadata(value.metadata, scenarioDir, `scenario:${scenarioPath}.metadata`, diagnostics);

  if (!id) {
    diagnostics.push({ path: `scenario:${scenarioPath}.id`, message: "Eval scenario requires non-empty id." });
  }

  if (!bucket) {
    diagnostics.push({ path: `scenario:${scenarioPath}.bucket`, message: "Eval scenario requires non-empty bucket." });
  }

  if (!difficulty) {
    diagnostics.push({ path: `scenario:${scenarioPath}.difficulty`, message: "Eval scenario requires non-empty difficulty." });
  }

  if (!description) {
    diagnostics.push({ path: `scenario:${scenarioPath}.description`, message: "Eval scenario requires non-empty description." });
  }

  if (!repo) {
    diagnostics.push({ path: `scenario:${scenarioPath}.fixture.repo`, message: "Eval scenario fixture requires repo." });
  }

  if (!graph_template) {
    diagnostics.push({ path: `scenario:${scenarioPath}.workflow.graph_template`, message: "Eval scenario workflow requires graph_template." });
  }

  if (!harness || !(harnessNames as readonly string[]).includes(harness)) {
    diagnostics.push({ path: `scenario:${scenarioPath}.workflow.harness`, message: "Eval scenario workflow harness must be codex-cli or cursor-cli." });
  }

  if (!id || !bucket || !difficulty || !description || !repo || !graph_template || !harness) {
    return undefined;
  }

  const repoPath = resolveScenarioPath(scenarioDir, repo);
  const docsPath = docs ? resolveScenarioPath(scenarioDir, docs) : undefined;
  const toolsPath = tools ? resolveScenarioPath(scenarioDir, tools) : undefined;
  const graphTemplatePath = resolveScenarioPath(scenarioDir, graph_template);
  const dimensions = Array.isArray(gradingRecord.dimensions)
    ? gradingRecord.dimensions.filter((item): item is string => typeof item === "string")
    : [];

  const fixture: EvalScenarioFixture = {
    repo,
    repo_path: repoPath,
    init_git: readBoolean(fixtureRecord?.init_git) ?? true
  };

  if (docs && docsPath) {
    fixture.docs = docs;
    fixture.docs_path = docsPath;
  }

  if (tools && toolsPath) {
    fixture.tools = tools;
    fixture.tools_path = toolsPath;
  }

  const workflow: EvalScenarioWorkflow = {
    graph_template,
    graph_template_path: graphTemplatePath,
    harness: harness as EvalScenarioWorkflow["harness"],
    workspace_backend
  };

  if (launch_profile) {
    workflow.launch_profile = launch_profile;
  }

  return {
    id,
    bucket,
    difficulty,
    description,
    scenario_dir: scenarioDir,
    graph_template_path: graphTemplatePath,
    fixture,
    workflow,
    expected: normalizeExpected(value.expected),
    grading: {
      dimensions
    } satisfies EvalScenarioGrading,
    metadata
  };
}

function normalizeJudge(
  value: unknown,
  suiteDir: string,
  path: string,
  diagnostics: EvalDiagnostic[]
): EvalJudge | undefined {
  if (!isRecord(value)) {
    diagnostics.push({ path, message: "Eval judge must be an object." });
    return undefined;
  }

  const id = readString(value.id);
  const rubric = readString(value.rubric);
  const harness = readString(value.harness) ?? "codex-cli";
  const model = readString(value.model);
  const reasoning_effort = value.reasoning_effort;
  const required = readBoolean(value.required);
  const timeout_sec = readNumber(value.timeout_sec);

  if (!id) {
    diagnostics.push({ path: `${path}.id`, message: "Eval judge requires non-empty id." });
  }

  if (!rubric) {
    diagnostics.push({ path: `${path}.rubric`, message: "Eval judge requires non-empty rubric path." });
  }

  if (!(harnessNames as readonly string[]).includes(harness)) {
    diagnostics.push({ path: `${path}.harness`, message: "Eval judge harness must be codex-cli or cursor-cli." });
  }

  if (reasoning_effort !== undefined && !(reasoningEfforts as readonly unknown[]).includes(reasoning_effort)) {
    diagnostics.push({ path: `${path}.reasoning_effort`, message: "Eval judge has invalid reasoning_effort." });
  }

  if (harness === "cursor-cli" && reasoning_effort !== undefined) {
    diagnostics.push({
      path: `${path}.reasoning_effort`,
      message: "Cursor eval judges cannot set reasoning_effort; choose the appropriate Cursor model id instead."
    });
  }

  if (!id || !rubric || !(harnessNames as readonly string[]).includes(harness)) {
    return undefined;
  }

  const judge: EvalJudge = {
    id,
    rubric,
    rubric_path: resolveSuitePath(suiteDir, rubric),
    required: required ?? true,
    harness: harness as EvalJudge["harness"]
  };

  if (model) {
    judge.model = model;
  }

  if (typeof reasoning_effort === "string" && (reasoningEfforts as readonly string[]).includes(reasoning_effort)) {
    judge.reasoning_effort = reasoning_effort as NonNullable<EvalJudge["reasoning_effort"]>;
  }

  if (timeout_sec !== undefined) {
    judge.timeout_sec = timeout_sec;
  }

  return judge;
}

function emptySuite(suitePath: string, suiteDir: string): LoadedEvalSuite {
  return {
    suite: {
      version: "2",
      suite_id: "invalid",
      objective: "invalid",
      source_reference: evalSourceReference,
      default_trials: 1,
      scenarios: [],
      variants: [],
      graders: [],
      judges: [],
      thresholds: {}
    },
    suite_path: suitePath,
    suite_dir: suiteDir,
    scenarios: [],
    variants: [],
    graders: [],
    judges: [],
    diagnostics: []
  };
}

async function readJson(path: string, diagnostics: EvalDiagnostic[], diagnosticPath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    diagnostics.push({
      path: diagnosticPath,
      message: `JSON file could not be loaded: ${error instanceof Error ? error.message : String(error)}`
    });
    return undefined;
  }
}

async function validateLoadedPaths(loaded: LoadedEvalSuite): Promise<void> {
  const diagnostics = loaded.diagnostics;
  const seenScenarioIds = new Set<string>();
  const seenVariantIds = new Set<string>();
  const seenGraderIds = new Set<string>();
  const seenJudgeIds = new Set<string>();

  for (const scenario of loaded.scenarios) {
    if (seenScenarioIds.has(scenario.id)) {
      diagnostics.push({ path: `scenario:${scenario.id}`, message: `Duplicate scenario id "${scenario.id}".` });
    }
    seenScenarioIds.add(scenario.id);

    if (!await pathExists(scenario.fixture.repo_path)) {
      diagnostics.push({
        path: `scenario:${scenario.id}.fixture.repo`,
        message: `Fixture repo path does not exist: ${scenario.fixture.repo_path}`
      });
    }

    if (scenario.fixture.docs_path && !await pathExists(scenario.fixture.docs_path)) {
      diagnostics.push({
        path: `scenario:${scenario.id}.fixture.docs`,
        message: `Fixture docs path does not exist: ${scenario.fixture.docs_path}`
      });
    }

    if (scenario.fixture.tools_path && !await pathExists(scenario.fixture.tools_path)) {
      diagnostics.push({
        path: `scenario:${scenario.id}.fixture.tools`,
        message: `Fixture tools path does not exist: ${scenario.fixture.tools_path}`
      });
    }

    if (!await pathExists(scenario.workflow.graph_template_path)) {
      diagnostics.push({
        path: `scenario:${scenario.id}.workflow.graph_template`,
        message: `Graph template does not exist: ${scenario.workflow.graph_template_path}`
      });
    }

    if (scenario.metadata.realworld && !await pathExists(scenario.metadata.realworld.regression_patch_path)) {
      diagnostics.push({
        path: `scenario:${scenario.id}.metadata.realworld.regression_patch`,
        message: `Real-world regression patch does not exist: ${scenario.metadata.realworld.regression_patch_path}`
      });
    }
  }

  for (const variant of loaded.variants) {
    if (seenVariantIds.has(variant.id)) {
      diagnostics.push({ path: `variant:${variant.id}`, message: `Duplicate variant id "${variant.id}".` });
    }
    seenVariantIds.add(variant.id);

    if (variant.graph_template) {
      variant.graph_template_path = resolveSuitePath(loaded.suite_dir, variant.graph_template);
      if (!await pathExists(variant.graph_template_path)) {
        diagnostics.push({
          path: `variant:${variant.id}.graph_template`,
          message: `Variant graph template does not exist: ${variant.graph_template_path}`
        });
      }
    }
  }

  for (const grader of loaded.graders) {
    if (seenGraderIds.has(grader.id)) {
      diagnostics.push({ path: `grader:${grader.id}`, message: `Duplicate grader id "${grader.id}".` });
    }
    seenGraderIds.add(grader.id);
  }

  for (const judge of loaded.judges) {
    if (seenJudgeIds.has(judge.id)) {
      diagnostics.push({ path: `judge:${judge.id}`, message: `Duplicate judge id "${judge.id}".` });
    }
    seenJudgeIds.add(judge.id);

    if (!await pathExists(judge.rubric_path)) {
      diagnostics.push({ path: `judge:${judge.id}.rubric`, message: `Judge rubric path does not exist: ${judge.rubric_path}` });
    }
  }

  for (const scenario of loaded.scenarios) {
    for (const variant of loaded.variants) {
      if (!await pathExists(variant.graph_template_path ?? scenario.workflow.graph_template_path)) {
        continue;
      }
      const rendered = await renderGraphTemplate({
        suite_dir: loaded.suite_dir,
        template_path: variant.graph_template_path ?? scenario.workflow.graph_template_path,
        scenario,
        variant,
        trial: { id: "trial-001", index: 1, root: "/tmp/agentflow-eval-trial" },
        fixture: {
          repo: scenario.fixture.repo_path,
          ...(scenario.fixture.docs_path ? { docs_url: "http://127.0.0.1:1" } : {}),
          ...(scenario.fixture.tools_path ? { tools: scenario.fixture.tools_path } : {})
        }
      });

      diagnostics.push(
        ...rendered.diagnostics.map((diagnostic) => ({
          path: `scenario:${scenario.id}.variant:${variant.id}.${diagnostic.path}`,
          message: diagnostic.message
        }))
      );
    }
  }
}

export async function loadEvalSuite(
  currentWorkingDirectory: string,
  suiteInput: string
): Promise<LoadedEvalSuite> {
  const { suite_path, suite_dir } = await resolveSuiteInput(currentWorkingDirectory, suiteInput);
  const loaded = emptySuite(suite_path, suite_dir);
  const rawSuite = await readJson(suite_path, loaded.diagnostics, "$");

  if (rawSuite === undefined) {
    return loaded;
  }

  const suite = normalizeSuite(rawSuite, loaded.diagnostics);
  if (!suite) {
    return loaded;
  }

  loaded.suite = suite;

  const rawSuiteRecord = isRecord(rawSuite) ? rawSuite : {};
  const judgeValues = Array.isArray(rawSuiteRecord.judges) ? rawSuiteRecord.judges : [];
  loaded.judges = judgeValues
    .map((judge, index) => normalizeJudge(judge, suite_dir, `$.judges[${index}]`, loaded.diagnostics))
    .filter((judge): judge is EvalJudge => judge !== undefined);
  loaded.suite.judges = loaded.judges;
  loaded.graders = suite.graders;

  for (const scenarioRef of suite.scenarios) {
    const scenarioPath = resolveSuitePath(suite_dir, scenarioRef);
    const rawScenario = await readJson(scenarioPath, loaded.diagnostics, `scenario:${scenarioRef}`);
    const scenario = normalizeScenario(rawScenario, scenarioPath, suite_dir, loaded.diagnostics);
    if (scenario) {
      loaded.scenarios.push(scenario);
    }
  }

  for (const variantRef of suite.variants) {
    const variantPath = resolveSuitePath(suite_dir, variantRef);
    const rawVariant = await readJson(variantPath, loaded.diagnostics, `variant:${variantRef}`);
    const variant = normalizeVariant(rawVariant, variantPath, loaded.diagnostics);
    if (variant) {
      loaded.variants.push(variant);
    }
  }

  await validateLoadedPaths(loaded);

  return loaded;
}

function stringifyTemplateValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return JSON.stringify(value);
}

function readPathValue(value: unknown, segments: string[]): unknown {
  return segments.reduce<unknown>((current, segment) => {
    if (current === undefined || current === null) {
      return undefined;
    }

    if (Array.isArray(current)) {
      const index = Number(segment);
      return Number.isInteger(index) ? current[index] : undefined;
    }

    if (isRecord(current)) {
      return current[segment];
    }

    return undefined;
  }, value);
}

function resolveTemplatePlaceholder(options: {
  suite_dir: string;
  scenario: EvalScenario;
  variant: EvalVariant;
  trial: EvalTemplateTrialContext;
  fixture: EvalTemplateFixtureContext;
  placeholder: string;
}): string | undefined {
  const normalized = options.placeholder.trim();

  if (normalized === "suite.dir") {
    return options.suite_dir;
  }

  if (normalized.startsWith("scenario.")) {
    const value = readPathValue(options.scenario, normalized.slice("scenario.".length).split("."));
    return value === undefined ? undefined : stringifyTemplateValue(value);
  }

  if (normalized.startsWith("variant.")) {
    const value = readPathValue(options.variant, normalized.slice("variant.".length).split("."));
    return value === undefined ? undefined : stringifyTemplateValue(value);
  }

  if (normalized.startsWith("trial.")) {
    const value = readPathValue(options.trial, normalized.slice("trial.".length).split("."));
    return value === undefined ? undefined : stringifyTemplateValue(value);
  }

  if (normalized.startsWith("fixture.")) {
    const value = readPathValue(options.fixture, normalized.slice("fixture.".length).split("."));
    return value === undefined ? undefined : stringifyTemplateValue(value);
  }

  if (normalized.startsWith("workflow.")) {
    const value = readPathValue(options.scenario.workflow, normalized.slice("workflow.".length).split("."));
    return value === undefined ? undefined : stringifyTemplateValue(value);
  }

  if (normalized.startsWith("expected.")) {
    const value = readPathValue(options.scenario.expected, normalized.slice("expected.".length).split("."));
    return value === undefined ? undefined : stringifyTemplateValue(value);
  }

  return undefined;
}

function renderTemplateValue(value: unknown, options: {
  suite_dir: string;
  scenario: EvalScenario;
  variant: EvalVariant;
  trial: EvalTemplateTrialContext;
  fixture: EvalTemplateFixtureContext;
  diagnostics: EvalDiagnostic[];
  path: string;
}): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/gu, (match, placeholder: string) => {
      const resolved = resolveTemplatePlaceholder({ ...options, placeholder });

      if (resolved === undefined) {
        options.diagnostics.push({
          path: options.path,
          message: `Unknown graph template placeholder "${match}".`
        });
        return match;
      }

      return resolved;
    });
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => renderTemplateValue(item, {
      ...options,
      path: `${options.path}[${index}]`
    }));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        renderTemplateValue(nestedValue, {
          ...options,
          path: `${options.path}.${key}`
        })
      ])
    );
  }

  return value;
}

export async function renderGraphTemplate(options: {
  suite_dir: string;
  template_path: string;
  scenario: EvalScenario;
  variant: EvalVariant;
  trial: EvalTemplateTrialContext;
  fixture: EvalTemplateFixtureContext;
}): Promise<{
  graph: unknown;
  diagnostics: EvalDiagnostic[];
}> {
  const diagnostics: EvalDiagnostic[] = [];
  let parsed: unknown;

  try {
    parsed = JSON.parse(await readFile(options.template_path, "utf8"));
  } catch (error) {
    return {
      graph: undefined,
      diagnostics: [
        {
          path: "$",
          message: `Graph template could not be parsed as JSON: ${error instanceof Error ? error.message : String(error)}`
        }
      ]
    };
  }

  return {
    graph: renderTemplateValue(parsed, {
      ...options,
      diagnostics,
      path: "$"
    }),
    diagnostics
  };
}

export interface ParsedJudgeResult {
  passed_quality_bar: boolean;
  score: number;
  dimension_scores: Record<string, number>;
  blockers: string[];
  rationale: string;
  prompt_feedback: {
    helpful_sections: string[];
    noisy_sections: string[];
    missing_guidance: string[];
  };
}

export function parseJudgeResult(text: string): {
  result?: ParsedJudgeResult;
  error?: string;
} {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text.trim());
  } catch {
    const objectMatch = text.match(/\{[\s\S]*\}/u);
    if (!objectMatch) {
      return { error: "Judge output was not valid JSON." };
    }
    try {
      parsed = JSON.parse(objectMatch[0]);
    } catch {
      return { error: "Judge output was not valid JSON." };
    }
  }

  if (!isRecord(parsed)) {
    return { error: "Judge output must be a JSON object." };
  }

  if (typeof parsed.passed_quality_bar !== "boolean") {
    return { error: "Judge output must include boolean passed_quality_bar." };
  }

  const score = readNumber(parsed.score);
  if (score === undefined || score < 1 || score > 5) {
    return { error: "Judge output score must be a number between 1 and 5." };
  }

  if (parsed.blockers !== undefined && !Array.isArray(parsed.blockers)) {
    return { error: "Judge output blockers must be an array." };
  }

  const dimension_scores =
    isRecord(parsed.dimension_scores)
      ? Object.fromEntries(
          Object.entries(parsed.dimension_scores).filter((entry): entry is [string, number] =>
            typeof entry[1] === "number" && entry[1] >= 1 && entry[1] <= 5
          )
        )
      : {};
  const promptFeedback = isRecord(parsed.prompt_feedback) ? parsed.prompt_feedback : {};
  const stringArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

  return {
    result: {
      passed_quality_bar: parsed.passed_quality_bar,
      score,
      dimension_scores,
      blockers: stringArray(parsed.blockers),
      rationale: typeof parsed.rationale === "string" ? parsed.rationale : "",
      prompt_feedback: {
        helpful_sections: stringArray(promptFeedback.helpful_sections),
        noisy_sections: stringArray(promptFeedback.noisy_sections),
        missing_guidance: stringArray(promptFeedback.missing_guidance)
      }
    }
  };
}

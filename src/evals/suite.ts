import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { harnessNames, reasoningEfforts } from "../graph/schema.js";
import {
  readSkillSourceDeclarations,
  loadResolvedSkillSources,
  resolveSkillSourcesForGraph
} from "../skills/sources.js";
import { expandPluginWorkflows, resolvePluginsForGraph } from "../plugins/workflows.js";
import { validateAuthoredGraphDocument } from "../graph/validate.js";
import type {
  EvalCriterion,
  EvalCriterionKind,
  EvalCheckpointDecisionScript,
  EvalCheckpointScript,
  EvalDiagnostic,
  EvalEnvironmentSimulation,
  EvalJudgePayload,
  EvalScenario,
  EvalScenarioEnvironment,
  EvalScenarioMeasurement,
  EvalScenarioMetadata,
  EvalScenarioRealWorldMetadata,
  EvalSupervisorResumeScript,
  EvalScenarioWorkflow,
  EvalSimulationMatch,
  EvalSimulationRule,
  EvalSuite,
  EvalSuiteThresholds,
  EvalTemplateEnvironmentContext,
  EvalTemplateTrialContext,
  EvalVariant,
  LoadedEvalSuite
} from "./types.js";
import { evalSourceReference } from "./types.js";

const criterionKinds = new Set<EvalCriterionKind>([
  "outcome",
  "artifact",
  "workspace",
  "supervisor",
  "trajectory",
  "quality",
  "delivery",
  "custom_script"
]);

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

function pushUnknownFieldDiagnostics(
  value: Record<string, unknown>,
  path: string,
  allowedFields: readonly string[],
  diagnostics: EvalDiagnostic[]
): void {
  const allowed = new Set(allowedFields);
  Object.keys(value)
    .filter((key) => !allowed.has(key))
    .sort((left, right) => left.localeCompare(right))
    .forEach((key) => {
      diagnostics.push({
        path: `${path}.${key}`,
        message: `Unknown field "${key}" is not part of the eval contract.`
      });
    });
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
    // Let readJson produce the final diagnostic.
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

  const thresholds: EvalSuiteThresholds = {};
  const passRate = readNumber(value.pass_rate);
  const maxBlockerRate = readNumber(value.max_blocker_rate);
  const minAverageScore = readNumber(value.min_average_score);

  if (value.pass_rate !== undefined && (passRate === undefined || passRate < 0 || passRate > 1)) {
    diagnostics.push({ path: "$.thresholds.pass_rate", message: "pass_rate threshold must be a number between 0 and 1." });
  } else if (passRate !== undefined) {
    thresholds.pass_rate = passRate;
  }

  if (value.max_blocker_rate !== undefined && (maxBlockerRate === undefined || maxBlockerRate < 0 || maxBlockerRate > 1)) {
    diagnostics.push({
      path: "$.thresholds.max_blocker_rate",
      message: "max_blocker_rate threshold must be a number between 0 and 1."
    });
  } else if (maxBlockerRate !== undefined) {
    thresholds.max_blocker_rate = maxBlockerRate;
  }

  if (value.min_average_score !== undefined && (minAverageScore === undefined || minAverageScore < 1 || minAverageScore > 5)) {
    diagnostics.push({
      path: "$.thresholds.min_average_score",
      message: "min_average_score threshold must be a number between 1 and 5."
    });
  } else if (minAverageScore !== undefined) {
    thresholds.min_average_score = minAverageScore;
  }

  return thresholds;
}

function normalizeCriterion(
  value: unknown,
  suiteDir: string,
  path: string,
  diagnostics: EvalDiagnostic[]
): EvalCriterion | undefined {
  if (!isRecord(value)) {
    diagnostics.push({ path, message: "Eval criterion must be an object." });
    return undefined;
  }

  const id = readString(value.id);
  const kind = readString(value.kind);
  const required = readBoolean(value.required);
  const description = readString(value.description);
  const command = readString(value.command);
  const rubric = readString(value.rubric);
  const dimensions = readStringArray(value.dimensions);
  const threshold = readNumber(value.threshold);
  const harness = readString(value.harness) ?? "codex-cli";
  const model = readString(value.model);
  const reasoningEffort = value.reasoning_effort;
  const timeoutSec = readNumber(value.timeout_sec);

  if (!id) {
    diagnostics.push({ path: `${path}.id`, message: "Eval criterion requires non-empty id." });
  }

  if (!kind || !criterionKinds.has(kind as EvalCriterionKind)) {
    diagnostics.push({
      path: `${path}.kind`,
      message: `Eval criterion kind must be one of ${[...criterionKinds].join(", ")}.`
    });
  }

  if (kind === "custom_script" && !command) {
    diagnostics.push({ path: `${path}.command`, message: "custom_script criteria require non-empty command." });
  }

  if (kind === "quality") {
    if (!rubric) {
      diagnostics.push({ path: `${path}.rubric`, message: "quality criteria require non-empty rubric path." });
    }

    if (!(harnessNames as readonly string[]).includes(harness)) {
      diagnostics.push({ path: `${path}.harness`, message: "quality criterion harness must be codex-cli or cursor-cli." });
    }

    if (reasoningEffort !== undefined && !(reasoningEfforts as readonly unknown[]).includes(reasoningEffort)) {
      diagnostics.push({ path: `${path}.reasoning_effort`, message: "quality criterion has invalid reasoning_effort." });
    }

    if (harness === "cursor-cli" && reasoningEffort !== undefined) {
      diagnostics.push({
        path: `${path}.reasoning_effort`,
        message: "Cursor quality criteria cannot set reasoning_effort; choose the appropriate Cursor model id instead."
      });
    }

    if (threshold !== undefined && (threshold < 1 || threshold > 5)) {
      diagnostics.push({ path: `${path}.threshold`, message: "quality criterion threshold must be between 1 and 5." });
    }
  }

  if (!id || !kind || !criterionKinds.has(kind as EvalCriterionKind)) {
    return undefined;
  }

  if (kind === "custom_script" && !command) {
    return undefined;
  }

  if (
    kind === "quality" &&
    (!rubric || !(harnessNames as readonly string[]).includes(harness) ||
      (reasoningEffort !== undefined && !(reasoningEfforts as readonly unknown[]).includes(reasoningEffort)))
  ) {
    return undefined;
  }

  const criterion: EvalCriterion = {
    id,
    kind: kind as EvalCriterionKind,
    required: required ?? true
  };

  if (description) {
    criterion.description = description;
  }

  if (command) {
    criterion.command = command;
  }

  if (rubric) {
    criterion.rubric = rubric;
    criterion.rubric_path = resolveSuitePath(suiteDir, rubric);
  }

  if (dimensions.length > 0) {
    criterion.dimensions = dimensions;
  }

  if (threshold !== undefined) {
    criterion.threshold = threshold;
  }

  if (kind === "quality") {
    criterion.harness = harness as NonNullable<EvalCriterion["harness"]>;
  }

  if (model) {
    criterion.model = model;
  }

  if (typeof reasoningEffort === "string" && (reasoningEfforts as readonly string[]).includes(reasoningEffort)) {
    criterion.reasoning_effort = reasoningEffort as NonNullable<EvalCriterion["reasoning_effort"]>;
  }

  if (timeoutSec !== undefined) {
    criterion.timeout_sec = timeoutSec;
  }

  return criterion;
}

function normalizeSuite(value: unknown, suiteDir: string, diagnostics: EvalDiagnostic[]): EvalSuite | undefined {
  if (!isRecord(value)) {
    diagnostics.push({ path: "$", message: "Eval suite must be a JSON object." });
    return undefined;
  }

  pushUnknownFieldDiagnostics(
    value,
    "$",
    ["version", "suite_id", "objective", "default_trials", "scenarios", "variants", "criteria", "thresholds"],
    diagnostics
  );

  const version = value.version;
  const suiteId = readString(value.suite_id);
  const objective = readString(value.objective);
  const defaultTrials = readNumber(value.default_trials);
  const scenarios = Array.isArray(value.scenarios) ? value.scenarios.filter((item): item is string => typeof item === "string") : [];
  const variants = Array.isArray(value.variants) ? value.variants.filter((item): item is string => typeof item === "string") : [];
  const criteria = Array.isArray(value.criteria)
    ? value.criteria
        .map((criterion, index) => normalizeCriterion(criterion, suiteDir, `$.criteria[${index}]`, diagnostics))
        .filter((criterion): criterion is EvalCriterion => criterion !== undefined)
    : [];
  const thresholds = normalizeThresholds(value.thresholds, diagnostics);

  if (version !== "1") {
    diagnostics.push({ path: "$.version", message: 'Eval suite version must be "1".' });
  }

  if (!suiteId) {
    diagnostics.push({ path: "$.suite_id", message: "Eval suite requires non-empty suite_id." });
  }

  if (!objective) {
    diagnostics.push({ path: "$.objective", message: "Eval suite requires non-empty objective." });
  }

  if (defaultTrials === undefined || !Number.isInteger(defaultTrials) || defaultTrials < 1) {
    diagnostics.push({ path: "$.default_trials", message: "default_trials must be a positive integer." });
  }

  if (!Array.isArray(value.scenarios) || scenarios.length === 0) {
    diagnostics.push({ path: "$.scenarios", message: "Eval suite requires at least one scenario path." });
  }

  if (!Array.isArray(value.variants) || variants.length === 0) {
    diagnostics.push({ path: "$.variants", message: "Eval suite requires at least one variant path." });
  }

  if (!Array.isArray(value.criteria) || criteria.length === 0) {
    diagnostics.push({ path: "$.criteria", message: "Eval suite requires at least one criterion." });
  }

  if (version !== "1" || !suiteId || !objective) {
    return undefined;
  }

  return {
    version,
    suite_id: suiteId,
    objective,
    source_reference: evalSourceReference,
    default_trials: defaultTrials !== undefined && Number.isInteger(defaultTrials) && defaultTrials > 0 ? defaultTrials : 1,
    scenarios,
    variants,
    criteria,
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
  const graphTemplate = readString(value.graph_template);
  const promptPack = readString(value.prompt_pack);
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
    ...(graphTemplate ? { graph_template: graphTemplate } : {}),
    ...(promptPack ? { prompt_pack: promptPack } : {}),
    env
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

  const sourceRepo = readString(value.source_repo);
  const license = readString(value.license);
  const baseSha = readString(value.base_sha);
  const issueUrl = readString(value.issue_url);
  const prUrl = readString(value.pr_url);
  const oracleCommitSha = readString(value.oracle_commit_sha);
  const packageManager = readString(value.package_manager);
  const regressionPatch = readString(value.regression_patch);
  const setupCommand = readString(value.setup_command);
  const focusedTestCommand = readString(value.focused_test_command);
  const allowedChangedGlobs = readStringArray(value.allowed_changed_globs);
  const forbiddenChangedGlobs = readStringArray(value.forbidden_changed_globs);
  const hiddenOracleChangedFiles = readStringArray(value.hidden_oracle_changed_files);

  if (!sourceRepo) {
    diagnostics.push({ path: `${path}.source_repo`, message: "Real-world metadata requires source_repo." });
  }

  if (license !== "MIT") {
    diagnostics.push({ path: `${path}.license`, message: 'Real-world metadata license must be "MIT".' });
  }

  if (!isFullGitSha(baseSha)) {
    diagnostics.push({ path: `${path}.base_sha`, message: "Real-world metadata base_sha must be a full 40-character git SHA." });
  }

  if (!isValidUrl(issueUrl)) {
    diagnostics.push({ path: `${path}.issue_url`, message: "Real-world metadata issue_url must be a GitHub https URL." });
  }

  if (!isValidUrl(prUrl)) {
    diagnostics.push({ path: `${path}.pr_url`, message: "Real-world metadata pr_url must be a GitHub https URL." });
  }

  if (!isFullGitSha(oracleCommitSha)) {
    diagnostics.push({
      path: `${path}.oracle_commit_sha`,
      message: "Real-world metadata oracle_commit_sha must be a full 40-character git SHA."
    });
  }

  if (!packageManager) {
    diagnostics.push({ path: `${path}.package_manager`, message: "Real-world metadata requires package_manager." });
  }

  if (!regressionPatch) {
    diagnostics.push({ path: `${path}.regression_patch`, message: "Real-world metadata requires regression_patch." });
  }

  if (!setupCommand) {
    diagnostics.push({ path: `${path}.setup_command`, message: "Real-world metadata requires setup_command." });
  }

  if (!focusedTestCommand) {
    diagnostics.push({ path: `${path}.focused_test_command`, message: "Real-world metadata requires focused_test_command." });
  }

  if (allowedChangedGlobs.length === 0) {
    diagnostics.push({
      path: `${path}.allowed_changed_globs`,
      message: "Real-world metadata requires at least one allowed_changed_glob."
    });
  }

  if (
    !sourceRepo ||
    license !== "MIT" ||
    !isFullGitSha(baseSha) ||
    !isValidUrl(issueUrl) ||
    !isValidUrl(prUrl) ||
    !isFullGitSha(oracleCommitSha) ||
    !packageManager ||
    !regressionPatch ||
    !setupCommand ||
    !focusedTestCommand ||
    allowedChangedGlobs.length === 0
  ) {
    return undefined;
  }

  return {
    source_repo: sourceRepo,
    license,
    base_sha: baseSha!,
    issue_url: issueUrl!,
    pr_url: prUrl!,
    oracle_commit_sha: oracleCommitSha!,
    package_manager: packageManager,
    regression_patch: regressionPatch,
    regression_patch_path: resolveScenarioPath(scenarioDir, regressionPatch),
    setup_command: setupCommand,
    focused_test_command: focusedTestCommand,
    allowed_changed_globs: allowedChangedGlobs,
    forbidden_changed_globs: forbiddenChangedGlobs,
    hidden_oracle_changed_files: hiddenOracleChangedFiles
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

function normalizeSimulationMatch(value: unknown, path: string, diagnostics: EvalDiagnostic[]): EvalSimulationMatch {
  if (value === undefined) {
    return {};
  }

  if (!isRecord(value)) {
    diagnostics.push({ path, message: "Simulation match must be an object." });
    return {};
  }

  const argvExact = readStringArray(value.argv_exact);
  const argvContains = readStringArray(value.argv_contains);
  const cwdContains = readString(value.cwd_contains);
  const match: EvalSimulationMatch = {};

  if (value.argv_exact !== undefined && !Array.isArray(value.argv_exact)) {
    diagnostics.push({ path: `${path}.argv_exact`, message: "argv_exact must be an array of strings." });
  }

  if (value.argv_contains !== undefined && !Array.isArray(value.argv_contains)) {
    diagnostics.push({ path: `${path}.argv_contains`, message: "argv_contains must be an array of strings." });
  }

  if (argvExact.length > 0) {
    match.argv_exact = argvExact;
  }

  if (argvContains.length > 0) {
    match.argv_contains = argvContains;
  }

  if (cwdContains) {
    match.cwd_contains = cwdContains;
  }

  return match;
}

function normalizeSimulationRule(
  value: unknown,
  scenarioDir: string,
  path: string,
  diagnostics: EvalDiagnostic[]
): EvalSimulationRule | undefined {
  if (!isRecord(value)) {
    diagnostics.push({ path, message: "Simulation tool call rule must be an object." });
    return undefined;
  }

  const id = readString(value.id);
  const command = readString(value.command);
  const match = normalizeSimulationMatch(value.match, `${path}.match`, diagnostics);
  const responseRecord = isRecord(value.response) ? value.response : undefined;
  const errorRecord = isRecord(value.error) ? value.error : undefined;
  const responseFile = readString(value.response_file);
  const latencyMs = readNumber(value.latency_ms);
  const probability = readNumber(value.probability);

  if (!id) {
    diagnostics.push({ path: `${path}.id`, message: "Simulation tool call rule requires non-empty id." });
  }

  if (!command) {
    diagnostics.push({ path: `${path}.command`, message: "Simulation tool call rule requires non-empty command." });
  } else if (command.includes("/") || command.includes("\\")) {
    diagnostics.push({ path: `${path}.command`, message: "Simulation command must be a command name, not a path." });
  }

  if (value.response !== undefined && !responseRecord) {
    diagnostics.push({ path: `${path}.response`, message: "Simulation response must be an object." });
  }

  if (value.error !== undefined && !errorRecord) {
    diagnostics.push({ path: `${path}.error`, message: "Simulation error must be an object." });
  }

  if (!responseRecord && !errorRecord && !responseFile) {
    diagnostics.push({ path, message: "Simulation rule requires response, response_file, or error." });
  }

  if (responseRecord && errorRecord) {
    diagnostics.push({ path, message: "Simulation rule cannot define both response and error." });
  }

  if (latencyMs !== undefined && (latencyMs < 0 || !Number.isInteger(latencyMs))) {
    diagnostics.push({ path: `${path}.latency_ms`, message: "Simulation latency_ms must be a non-negative integer." });
  }

  if (probability !== undefined && (probability < 0 || probability > 1)) {
    diagnostics.push({ path: `${path}.probability`, message: "Simulation probability must be between 0 and 1." });
  }

  if (!id || !command || command.includes("/") || command.includes("\\") || (!responseRecord && !errorRecord && !responseFile) || (responseRecord && errorRecord)) {
    return undefined;
  }

  const rule: EvalSimulationRule = {
    id,
    command,
    match
  };

  if (responseRecord) {
    rule.response = {
      ...(typeof responseRecord.stdout === "string" ? { stdout: responseRecord.stdout } : {}),
      ...(typeof responseRecord.stderr === "string" ? { stderr: responseRecord.stderr } : {}),
      ...(typeof responseRecord.exit_code === "number" && Number.isInteger(responseRecord.exit_code)
        ? { exit_code: responseRecord.exit_code }
        : {})
    };
  }

  if (responseFile) {
    rule.response_file = responseFile;
    rule.response_file_path = resolveScenarioPath(scenarioDir, responseFile);
  }

  if (errorRecord) {
    rule.error = {
      stderr: typeof errorRecord.stderr === "string" ? errorRecord.stderr : "simulated tool error",
      ...(typeof errorRecord.exit_code === "number" && Number.isInteger(errorRecord.exit_code)
        ? { exit_code: errorRecord.exit_code }
        : {})
    };
  }

  if (latencyMs !== undefined && Number.isInteger(latencyMs) && latencyMs >= 0) {
    rule.latency_ms = latencyMs;
  }

  if (probability !== undefined && probability >= 0 && probability <= 1) {
    rule.probability = probability;
  }

  return rule;
}

function normalizeSimulation(
  value: unknown,
  scenarioDir: string,
  path: string,
  diagnostics: EvalDiagnostic[]
): EvalEnvironmentSimulation | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    diagnostics.push({ path, message: "Eval environment simulation must be an object." });
    return undefined;
  }

  const seedValue = readString(value.seed) ?? (typeof value.seed === "number" ? String(value.seed) : undefined);
  const rawToolCalls = Array.isArray(value.tool_calls) ? value.tool_calls : [];

  if (!Array.isArray(value.tool_calls)) {
    diagnostics.push({ path: `${path}.tool_calls`, message: "Environment simulation requires tool_calls array." });
  }

  const toolCalls = rawToolCalls
    .map((rule, index) => normalizeSimulationRule(rule, scenarioDir, `${path}.tool_calls[${index}]`, diagnostics))
    .filter((rule): rule is EvalSimulationRule => rule !== undefined);

  return {
    ...(seedValue ? { seed: seedValue } : {}),
    tool_calls: toolCalls
  };
}

function normalizeScriptedCheckpoints(
  value: unknown,
  path: string,
  diagnostics: EvalDiagnostic[]
): EvalCheckpointScript | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    diagnostics.push({ path, message: "scripted_checkpoints must be an object." });
    return undefined;
  }

  const rawDecisions = Array.isArray(value.decisions) ? value.decisions : [];
  if (!Array.isArray(value.decisions) || rawDecisions.length === 0) {
    diagnostics.push({ path: `${path}.decisions`, message: "scripted_checkpoints requires a non-empty decisions array." });
  }

  const decisions: EvalCheckpointDecisionScript[] = [];
  rawDecisions.forEach((decisionValue, index) => {
    const decisionPath = `${path}.decisions[${index}]`;
    if (!isRecord(decisionValue)) {
      diagnostics.push({ path: decisionPath, message: "Checkpoint decision entries must be objects." });
      return;
    }

    const decision = readString(decisionValue.decision);
    const feedback = typeof decisionValue.feedback === "string" ? decisionValue.feedback.trim() : undefined;
    if (decision !== "pass" && decision !== "deny" && decision !== "abort") {
      diagnostics.push({ path: `${decisionPath}.decision`, message: "Checkpoint decision must be pass, deny, or abort." });
      return;
    }

    if (decision === "deny" && !feedback) {
      diagnostics.push({ path: `${decisionPath}.feedback`, message: "Deny checkpoint decisions require feedback." });
      return;
    }

    decisions.push({
      decision,
      ...(feedback ? { feedback } : {})
    });
  });

  return decisions.length > 0 ? { decisions } : undefined;
}

function normalizeScriptedResume(
  value: unknown,
  path: string,
  diagnostics: EvalDiagnostic[]
): EvalSupervisorResumeScript | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    diagnostics.push({ path, message: "scripted_resume must be an object." });
    return undefined;
  }

  const humanAction = readString(value.human_action);
  const allowedActions = new Set(["approve", "fail", "add_context", "retry_with_guidance", "rebuild_context_then_retry"]);
  if (!humanAction || !allowedActions.has(humanAction)) {
    diagnostics.push({
      path: `${path}.human_action`,
      message: "scripted_resume human_action must be approve, fail, add_context, retry_with_guidance, or rebuild_context_then_retry."
    });
    return undefined;
  }

  const humanNote = typeof value.human_note === "string" ? value.human_note.trim() : undefined;
  const resetSupervisorBudget = readBoolean(value.reset_supervisor_budget);
  if (value.reset_supervisor_budget !== undefined && resetSupervisorBudget === undefined) {
    diagnostics.push({ path: `${path}.reset_supervisor_budget`, message: "scripted_resume reset_supervisor_budget must be boolean." });
  }

  return {
    human_action: humanAction as EvalSupervisorResumeScript["human_action"],
    ...(humanNote ? { human_note: humanNote } : {}),
    ...(resetSupervisorBudget !== undefined ? { reset_supervisor_budget: resetSupervisorBudget } : {})
  };
}

function normalizeScenarioCriteria(value: unknown, path: string, diagnostics: EvalDiagnostic[]): Record<string, Record<string, unknown>> {
  if (!isRecord(value)) {
    diagnostics.push({ path, message: "Eval scenario requires criteria object keyed by criterion id." });
    return {};
  }

  const entries: Array<[string, Record<string, unknown>]> = [];
  for (const [id, config] of Object.entries(value)) {
    if (!isRecord(config)) {
      diagnostics.push({ path: `${path}.${id}`, message: "Scenario criterion config must be an object." });
      continue;
    }
    entries.push([id, config]);
  }

  return Object.fromEntries(entries);
}

function normalizeScenarioMeasurement(
  value: unknown,
  path: string,
  diagnostics: EvalDiagnostic[]
): EvalScenarioMeasurement | undefined {
  if (!isRecord(value)) {
    diagnostics.push({ path, message: "Eval scenario requires measurement object." });
    return undefined;
  }

  const claim = readString(value.claim);
  const scenarioType = readString(value.scenario_type);
  const metrics = readStringArray(value.metrics);
  const expectedFailureModes = readStringArray(value.expected_failure_modes);
  const tweakSignal = readString(value.tweak_signal);

  if (!claim) {
    diagnostics.push({ path: `${path}.claim`, message: "Eval scenario measurement requires non-empty claim." });
  }

  if (!scenarioType) {
    diagnostics.push({ path: `${path}.scenario_type`, message: "Eval scenario measurement requires non-empty scenario_type." });
  }

  if (!Array.isArray(value.metrics) || metrics.length === 0) {
    diagnostics.push({ path: `${path}.metrics`, message: "Eval scenario measurement requires at least one metric." });
  }

  if (!Array.isArray(value.expected_failure_modes) || expectedFailureModes.length === 0) {
    diagnostics.push({
      path: `${path}.expected_failure_modes`,
      message: "Eval scenario measurement requires at least one expected_failure_mode."
    });
  }

  if (!tweakSignal) {
    diagnostics.push({ path: `${path}.tweak_signal`, message: "Eval scenario measurement requires non-empty tweak_signal." });
  }

  if (!claim || !scenarioType || metrics.length === 0 || expectedFailureModes.length === 0 || !tweakSignal) {
    return undefined;
  }

  return {
    claim,
    scenario_type: scenarioType,
    metrics,
    expected_failure_modes: expectedFailureModes,
    tweak_signal: tweakSignal
  };
}

function normalizeScenario(
  value: unknown,
  scenarioPath: string,
  diagnostics: EvalDiagnostic[]
): EvalScenario | undefined {
  if (!isRecord(value)) {
    diagnostics.push({ path: `scenario:${scenarioPath}`, message: "Eval scenario must be an object." });
    return undefined;
  }

  pushUnknownFieldDiagnostics(
    value,
    `scenario:${scenarioPath}`,
    ["id", "bucket", "difficulty", "description", "measurement", "workflow", "environment", "criteria", "metadata"],
    diagnostics
  );

  const scenarioDir = dirname(scenarioPath);
  const id = readString(value.id);
  const bucket = readString(value.bucket);
  const difficulty = readString(value.difficulty);
  const description = readString(value.description);
  const environmentRecord = isRecord(value.environment) ? value.environment : undefined;
  const workflowRecord = isRecord(value.workflow) ? value.workflow : undefined;
  const repo = environmentRecord ? readString(environmentRecord.repo) : undefined;
  const docs = environmentRecord ? readString(environmentRecord.docs) : undefined;
  const tools = environmentRecord ? readString(environmentRecord.tools) : undefined;
  const graphTemplate = workflowRecord ? readString(workflowRecord.graph_template) : undefined;
  const harness = workflowRecord ? readString(workflowRecord.harness) : undefined;
  const workspaceBackend = workflowRecord?.workspace_backend === "worktree" ? "worktree" : "inplace";
  const launchProfile = workflowRecord ? readString(workflowRecord.launch_profile) : undefined;
  const measurement = normalizeScenarioMeasurement(
    value.measurement,
    `scenario:${scenarioPath}.measurement`,
    diagnostics
  );
  const criteria = normalizeScenarioCriteria(value.criteria, `scenario:${scenarioPath}.criteria`, diagnostics);
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

  if (!isRecord(value.environment)) {
    diagnostics.push({ path: `scenario:${scenarioPath}.environment`, message: "Eval scenario requires environment object." });
  }

  if (!repo) {
    diagnostics.push({ path: `scenario:${scenarioPath}.environment.repo`, message: "Eval scenario environment requires repo." });
  }

  if (!graphTemplate) {
    diagnostics.push({ path: `scenario:${scenarioPath}.workflow.graph_template`, message: "Eval scenario workflow requires graph_template." });
  }

  if (!harness || !(harnessNames as readonly string[]).includes(harness)) {
    diagnostics.push({ path: `scenario:${scenarioPath}.workflow.harness`, message: "Eval scenario workflow harness must be codex-cli or cursor-cli." });
  }

  if (!id || !bucket || !difficulty || !description || !repo || !graphTemplate || !harness) {
    return undefined;
  }

  const repoPath = resolveScenarioPath(scenarioDir, repo);
  const docsPath = docs ? resolveScenarioPath(scenarioDir, docs) : undefined;
  const toolsPath = tools ? resolveScenarioPath(scenarioDir, tools) : undefined;
  const graphTemplatePath = resolveScenarioPath(scenarioDir, graphTemplate);
  const environment: EvalScenarioEnvironment = {
    repo,
    repo_path: repoPath,
    init_git: readBoolean(environmentRecord?.init_git) ?? true
  };
  const simulation = normalizeSimulation(environmentRecord?.simulation, scenarioDir, `scenario:${scenarioPath}.environment.simulation`, diagnostics);
  const scriptedCheckpoints = normalizeScriptedCheckpoints(
    environmentRecord?.scripted_checkpoints,
    `scenario:${scenarioPath}.environment.scripted_checkpoints`,
    diagnostics
  );
  const scriptedResume = normalizeScriptedResume(
    environmentRecord?.scripted_resume,
    `scenario:${scenarioPath}.environment.scripted_resume`,
    diagnostics
  );

  if (docs && docsPath) {
    environment.docs = docs;
    environment.docs_path = docsPath;
  }

  if (tools && toolsPath) {
    environment.tools = tools;
    environment.tools_path = toolsPath;
  }

  if (simulation) {
    environment.simulation = simulation;
  }

  if (scriptedCheckpoints) {
    environment.scripted_checkpoints = scriptedCheckpoints;
  }

  if (scriptedResume) {
    environment.scripted_resume = scriptedResume;
  }

  const workflow: EvalScenarioWorkflow = {
    graph_template: graphTemplate,
    graph_template_path: graphTemplatePath,
    harness: harness as EvalScenarioWorkflow["harness"],
    workspace_backend: workspaceBackend
  };

  if (launchProfile) {
    workflow.launch_profile = launchProfile;
  }

  return {
    id,
    bucket,
    difficulty,
    description,
    measurement: measurement ?? {
      claim: description,
      scenario_type: "invalid",
      metrics: ["invalid measurement contract"],
      expected_failure_modes: ["missing or invalid measurement contract"],
      tweak_signal: "Fix the scenario measurement contract before interpreting this eval."
    },
    scenario_dir: scenarioDir,
    graph_template_path: graphTemplatePath,
    environment,
    workflow,
    criteria,
    metadata
  };
}

function emptySuite(suitePath: string, suiteDir: string): LoadedEvalSuite {
  return {
    suite: {
      version: "1",
      suite_id: "invalid",
      objective: "invalid",
      source_reference: evalSourceReference,
      default_trials: 1,
      scenarios: [],
      variants: [],
      criteria: [],
      thresholds: {}
    },
    suite_path: suitePath,
    suite_dir: suiteDir,
    scenarios: [],
    variants: [],
    criteria: [],
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

async function validateRenderedGraphContract(options: {
  graph: unknown;
}): Promise<EvalDiagnostic[]> {
  const diagnostics: EvalDiagnostic[] = [];
  const validationDir = await mkdtemp(join(tmpdir(), "agentflow-eval-rendered-"));
  const graphPath = join(validationDir, "rendered-graph.json");

  try {
    await writeFile(graphPath, `${JSON.stringify(options.graph, null, 2)}\n`, "utf8");
    const [pluginResolution, skillResolution] = await Promise.all([
      resolvePluginsForGraph(validationDir, graphPath),
      resolveSkillSourcesForGraph(validationDir, graphPath)
    ]);

    diagnostics.push(...pluginResolution.diagnostics);
    diagnostics.push(...skillResolution.diagnostics);

    if (diagnostics.length > 0) {
      return diagnostics;
    }

    const skillSourceDiagnostics: EvalDiagnostic[] = [];
    const skillSourceDeclarations = readSkillSourceDeclarations(options.graph, skillSourceDiagnostics);
    const resolvedSkillSources = await loadResolvedSkillSources(
      graphPath,
      skillSourceDeclarations,
      skillSourceDiagnostics
    );
    const pluginExpansion = await expandPluginWorkflows(graphPath, options.graph);
    const graphDiagnostics = await validateAuthoredGraphDocument(pluginExpansion.document, {
      resolved_plugins: pluginExpansion.resolved_plugins,
      resolved_skill_sources: resolvedSkillSources,
      graph_dir: validationDir
    });

    diagnostics.push(...skillSourceDiagnostics);
    diagnostics.push(...pluginExpansion.diagnostics);
    diagnostics.push(...graphDiagnostics);
    return diagnostics;
  } finally {
    await rm(validationDir, { recursive: true, force: true });
  }
}

async function validateLoadedPaths(loaded: LoadedEvalSuite): Promise<void> {
  const diagnostics = loaded.diagnostics;
  const seenScenarioIds = new Set<string>();
  const seenVariantIds = new Set<string>();
  const seenCriteriaIds = new Set<string>();
  const criteriaIds = new Set(loaded.criteria.map((criterion) => criterion.id));

  for (const criterion of loaded.criteria) {
    if (seenCriteriaIds.has(criterion.id)) {
      diagnostics.push({ path: `criterion:${criterion.id}`, message: `Duplicate criterion id "${criterion.id}".` });
    }
    seenCriteriaIds.add(criterion.id);

    if (criterion.kind === "quality" && criterion.rubric_path && !await pathExists(criterion.rubric_path)) {
      diagnostics.push({
        path: `criterion:${criterion.id}.rubric`,
        message: `Quality criterion rubric path does not exist: ${criterion.rubric_path}`
      });
    }
  }

  for (const scenario of loaded.scenarios) {
    if (seenScenarioIds.has(scenario.id)) {
      diagnostics.push({ path: `scenario:${scenario.id}`, message: `Duplicate scenario id "${scenario.id}".` });
    }
    seenScenarioIds.add(scenario.id);

    if (!await pathExists(scenario.environment.repo_path)) {
      diagnostics.push({
        path: `scenario:${scenario.id}.environment.repo`,
        message: `Environment repo path does not exist: ${scenario.environment.repo_path}`
      });
    }

    if (scenario.environment.docs_path && !await pathExists(scenario.environment.docs_path)) {
      diagnostics.push({
        path: `scenario:${scenario.id}.environment.docs`,
        message: `Environment docs path does not exist: ${scenario.environment.docs_path}`
      });
    }

    if (scenario.environment.tools_path && !await pathExists(scenario.environment.tools_path)) {
      diagnostics.push({
        path: `scenario:${scenario.id}.environment.tools`,
        message: `Environment tools path does not exist: ${scenario.environment.tools_path}`
      });
    }

    for (const rule of scenario.environment.simulation?.tool_calls ?? []) {
      if (rule.response_file_path && !await pathExists(rule.response_file_path)) {
        diagnostics.push({
          path: `scenario:${scenario.id}.environment.simulation.tool_calls.${rule.id}.response_file`,
          message: `Simulation response file does not exist: ${rule.response_file_path}`
        });
      }
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

    for (const criterionId of Object.keys(scenario.criteria)) {
      if (!criteriaIds.has(criterionId)) {
        diagnostics.push({
          path: `scenario:${scenario.id}.criteria.${criterionId}`,
          message: `Scenario references unknown criterion "${criterionId}".`
        });
      }
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
        environment: {
          repo: scenario.environment.repo_path,
          ...(scenario.environment.docs_path ? { docs_url: "http://127.0.0.1:1" } : {}),
          ...(scenario.environment.tools_path ? { tools: scenario.environment.tools_path } : {})
        }
      });

      diagnostics.push(
        ...rendered.diagnostics.map((diagnostic) => ({
          path: `scenario:${scenario.id}.variant:${variant.id}.${diagnostic.path}`,
          message: diagnostic.message
        }))
      );

      if (rendered.diagnostics.length === 0) {
        const graphDiagnostics = await validateRenderedGraphContract({
          graph: rendered.graph
        });
        diagnostics.push(
          ...graphDiagnostics.map((diagnostic) => ({
            path: `scenario:${scenario.id}.variant:${variant.id}.rendered_graph${diagnostic.path.startsWith("$") ? diagnostic.path.slice(1) : `.${diagnostic.path}`}`,
            message: diagnostic.message
          }))
        );
      }
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

  const suite = normalizeSuite(rawSuite, suite_dir, loaded.diagnostics);
  if (!suite) {
    return loaded;
  }

  loaded.suite = suite;
  loaded.criteria = suite.criteria;

  for (const scenarioRef of suite.scenarios) {
    const scenarioPath = resolveSuitePath(suite_dir, scenarioRef);
    const rawScenario = await readJson(scenarioPath, loaded.diagnostics, `scenario:${scenarioRef}`);
    const scenario = normalizeScenario(rawScenario, scenarioPath, loaded.diagnostics);
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
  environment: EvalTemplateEnvironmentContext;
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

  if (normalized.startsWith("environment.")) {
    const value = readPathValue(options.environment, normalized.slice("environment.".length).split("."));
    return value === undefined ? undefined : stringifyTemplateValue(value);
  }

  if (normalized.startsWith("workflow.")) {
    const value = readPathValue(options.scenario.workflow, normalized.slice("workflow.".length).split("."));
    return value === undefined ? undefined : stringifyTemplateValue(value);
  }

  if (normalized.startsWith("criteria.")) {
    const value = readPathValue(options.scenario.criteria, normalized.slice("criteria.".length).split("."));
    return value === undefined ? undefined : stringifyTemplateValue(value);
  }

  return undefined;
}

function renderTemplateValue(value: unknown, options: {
  suite_dir: string;
  scenario: EvalScenario;
  variant: EvalVariant;
  trial: EvalTemplateTrialContext;
  environment: EvalTemplateEnvironmentContext;
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
  environment: EvalTemplateEnvironmentContext;
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

export function parseJudgeResult(text: string): {
  result?: EvalJudgePayload;
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

  const dimensionScores =
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
      dimension_scores: dimensionScores,
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

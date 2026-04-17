import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { reasoningEfforts } from "../graph/schema.js";
import type {
  EvalAiRubricGrader,
  EvalCase,
  EvalDiagnostic,
  EvalGrader,
  EvalScriptGrader,
  EvalSuite,
  EvalSuiteThresholds,
  EvalSuiteVariant,
  EvalVariantResolution,
  LoadedEvalSuite
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isReasoningEffort(value: unknown): value is EvalAiRubricGrader["reasoning_effort"] {
  return typeof value === "string" && (reasoningEfforts as readonly string[]).includes(value);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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

function resolveSuitePath(suiteDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(suiteDir, path);
}

function normalizeGrader(value: unknown, path: string, diagnostics: EvalDiagnostic[]): EvalGrader | undefined {
  if (!isRecord(value)) {
    diagnostics.push({ path, message: "Eval grader must be an object." });
    return undefined;
  }

  const id = readString(value.id);
  const kind = readString(value.kind);
  const required = readBoolean(value.required);
  const timeout_sec = readNumber(value.timeout_sec);

  if (!id) {
    diagnostics.push({ path: `${path}.id`, message: "Eval grader requires non-empty id." });
  }

  if (kind === "script") {
    const command = readString(value.command);

    if (!command) {
      diagnostics.push({ path: `${path}.command`, message: "Script grader requires non-empty command." });
    }

    if (!id || !command) {
      return undefined;
    }

    return {
      id,
      kind,
      command,
      ...(required !== undefined ? { required } : {}),
      ...(timeout_sec !== undefined ? { timeout_sec } : {})
    } satisfies EvalScriptGrader;
  }

  if (kind === "ai_rubric") {
    const rubric = readString(value.rubric);
    const model = readString(value.model);
    const reasoning_effort = value.reasoning_effort;

    if (!rubric) {
      diagnostics.push({ path: `${path}.rubric`, message: "AI rubric grader requires non-empty rubric path." });
    }

    if (reasoning_effort !== undefined && !isReasoningEffort(reasoning_effort)) {
      diagnostics.push({ path: `${path}.reasoning_effort`, message: "AI rubric grader has invalid reasoning_effort." });
    }

    if (!id || !rubric || (reasoning_effort !== undefined && !isReasoningEffort(reasoning_effort))) {
      return undefined;
    }

    return {
      id,
      kind,
      rubric,
      ...(required !== undefined ? { required } : {}),
      ...(model ? { model } : {}),
      ...(reasoning_effort ? { reasoning_effort } : {}),
      ...(timeout_sec !== undefined ? { timeout_sec } : {})
    } satisfies EvalAiRubricGrader;
  }

  diagnostics.push({ path: `${path}.kind`, message: 'Eval grader kind must be "script" or "ai_rubric".' });
  return undefined;
}

function normalizeThresholds(
  value: unknown,
  path: string,
  diagnostics: EvalDiagnostic[]
): EvalSuiteThresholds {
  if (value === undefined) {
    return {};
  }

  if (!isRecord(value)) {
    diagnostics.push({ path, message: "Eval thresholds must be an object." });
    return {};
  }

  const pass_rate = readNumber(value.pass_rate);
  const critical_failures = readNumber(value.critical_failures);

  if (value.pass_rate !== undefined && (pass_rate === undefined || pass_rate < 0 || pass_rate > 1)) {
    diagnostics.push({ path: `${path}.pass_rate`, message: "pass_rate threshold must be a number between 0 and 1." });
  }

  if (
    value.critical_failures !== undefined &&
    (critical_failures === undefined || critical_failures < 0 || !Number.isInteger(critical_failures))
  ) {
    diagnostics.push({
      path: `${path}.critical_failures`,
      message: "critical_failures threshold must be a non-negative integer."
    });
  }

  return {
    ...(pass_rate !== undefined && pass_rate >= 0 && pass_rate <= 1 ? { pass_rate } : {}),
    ...(critical_failures !== undefined && critical_failures >= 0 && Number.isInteger(critical_failures)
      ? { critical_failures }
      : {})
  };
}

function normalizeVariants(
  value: unknown,
  path: string,
  diagnostics: EvalDiagnostic[]
): Record<string, EvalSuiteVariant> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    diagnostics.push({ path, message: "Eval variants must be an object." });
    return undefined;
  }

  const variants: Record<string, EvalSuiteVariant> = {};

  Object.entries(value).forEach(([id, variant], index) => {
    const variantPath = `${path}.${id || index}`;

    if (!id.trim()) {
      diagnostics.push({ path: variantPath, message: "Variant id must be non-empty." });
      return;
    }

    if (!isRecord(variant)) {
      diagnostics.push({ path: variantPath, message: "Variant must be an object." });
      return;
    }

    const graph_template = readString(variant.graph_template);
    const optional = readBoolean(variant.optional);

    variants[id] = {
      ...(graph_template ? { graph_template } : {}),
      ...(optional !== undefined ? { optional } : {})
    };
  });

  return variants;
}

function normalizeSuite(value: unknown, diagnostics: EvalDiagnostic[]): EvalSuite | undefined {
  if (!isRecord(value)) {
    diagnostics.push({ path: "$", message: "Eval suite must be a JSON object." });
    return undefined;
  }

  const version = value.version;
  const suite_id = readString(value.suite_id);
  const cases = readString(value.cases);
  const target = value.target;
  const gradersValue = value.graders;

  if (version !== "1") {
    diagnostics.push({ path: "$.version", message: 'Eval suite version must be "1".' });
  }

  if (!suite_id) {
    diagnostics.push({ path: "$.suite_id", message: "Eval suite requires non-empty suite_id." });
  }

  if (!cases) {
    diagnostics.push({ path: "$.cases", message: "Eval suite requires non-empty cases path." });
  }

  let graph_template: string | undefined;
  if (!isRecord(target)) {
    diagnostics.push({ path: "$.target", message: "Eval suite target must be an object." });
  } else {
    graph_template = readString(target.graph_template);
    if (!graph_template) {
      diagnostics.push({ path: "$.target.graph_template", message: "Eval suite target requires graph_template." });
    }
  }

  let graders: EvalGrader[] | undefined;
  if (gradersValue !== undefined) {
    if (!Array.isArray(gradersValue)) {
      diagnostics.push({ path: "$.graders", message: "Eval graders must be an array." });
    } else {
      graders = gradersValue
        .map((grader, index) => normalizeGrader(grader, `$.graders[${index}]`, diagnostics))
        .filter((grader): grader is EvalGrader => grader !== undefined);
    }
  }

  const variants = normalizeVariants(value.variants, "$.variants", diagnostics);
  const thresholds = normalizeThresholds(value.thresholds, "$.thresholds", diagnostics);

  if (version !== "1" || !suite_id || !cases || !graph_template) {
    return undefined;
  }

  return {
    version,
    suite_id,
    target: {
      graph_template
    },
    cases,
    ...(variants ? { variants } : {}),
    ...(graders ? { graders } : {}),
    ...(Object.keys(thresholds).length > 0 ? { thresholds } : {})
  };
}

function normalizeCase(value: unknown, path: string, diagnostics: EvalDiagnostic[]): EvalCase | undefined {
  if (!isRecord(value)) {
    diagnostics.push({ path, message: "Eval case must be an object." });
    return undefined;
  }

  const id = readString(value.id);
  const task = readString(value.task);

  if (!id) {
    diagnostics.push({ path: `${path}.id`, message: "Eval case requires non-empty id." });
  }

  if (!task) {
    diagnostics.push({ path: `${path}.task`, message: "Eval case requires non-empty task." });
  }

  if (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string"))) {
    diagnostics.push({ path: `${path}.tags`, message: "Eval case tags must be an array of strings." });
  }

  if (
    value.fixtures !== undefined &&
    !(
      Array.isArray(value.fixtures) && value.fixtures.every((fixture) => typeof fixture === "string") ||
      isRecord(value.fixtures) && Object.values(value.fixtures).every((fixture) => typeof fixture === "string")
    )
  ) {
    diagnostics.push({
      path: `${path}.fixtures`,
      message: "Eval case fixtures must be an array of paths or an object of named paths."
    });
  }

  if (
    value.repos !== undefined &&
    !(
      isRecord(value.repos) &&
      Object.values(value.repos).every(
        (repo) => typeof repo === "string" || isRecord(repo) && typeof repo.path === "string"
      )
    )
  ) {
    diagnostics.push({
      path: `${path}.repos`,
      message: "Eval case repos must be an object of repo aliases to paths or { path } objects."
    });
  }

  if (!id || !task) {
    return undefined;
  }

  return {
    ...value,
    id,
    task
  } as EvalCase;
}

async function loadCases(casesPath: string, diagnostics: EvalDiagnostic[]): Promise<EvalCase[]> {
  let contents: string;

  try {
    contents = await readFile(casesPath, "utf8");
  } catch (error) {
    diagnostics.push({
      path: "$.cases",
      message: `Eval cases could not be read: ${error instanceof Error ? error.message : String(error)}`
    });
    return [];
  }

  const cases: EvalCase[] = [];
  const seen = new Set<string>();

  contents.split(/\r?\n/u).forEach((rawLine, index) => {
    const line = rawLine.trim();
    const path = `${casesPath}:${index + 1}`;

    if (!line) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      diagnostics.push({
        path,
        message: `Eval case line is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      });
      return;
    }

    const evalCase = normalizeCase(parsed, path, diagnostics);
    if (!evalCase) {
      return;
    }

    if (seen.has(evalCase.id)) {
      diagnostics.push({ path, message: `Duplicate eval case id "${evalCase.id}".` });
      return;
    }

    seen.add(evalCase.id);
    cases.push(evalCase);
  });

  if (cases.length === 0) {
    diagnostics.push({ path: "$.cases", message: "Eval suite must include at least one case." });
  }

  return cases;
}

async function validateFixturePaths(
  suiteDir: string,
  cases: EvalCase[],
  diagnostics: EvalDiagnostic[]
): Promise<void> {
  for (const evalCase of cases) {
    const fixtures = evalCase.fixtures;
    const fixtureEntries = Array.isArray(fixtures)
      ? fixtures.map((fixture, index) => [`${index}`, fixture] as const)
      : fixtures && typeof fixtures === "object"
        ? Object.entries(fixtures)
        : [];

    for (const [key, fixturePath] of fixtureEntries) {
      const absolutePath = resolveSuitePath(suiteDir, fixturePath);

      if (!await pathExists(absolutePath)) {
        diagnostics.push({
          path: `case:${evalCase.id}.fixtures.${key}`,
          message: `Fixture path does not exist: ${absolutePath}`
        });
      }
    }
  }
}

export function resolveEvalVariants(
  suite: EvalSuite,
  suiteDir: string,
  requestedVariant?: string
): EvalVariantResolution[] {
  const variants = suite.variants ?? {
    candidate: {}
  };

  return Object.entries(variants)
    .filter(([id]) => !requestedVariant || id === requestedVariant)
    .map(([id, variant]) => {
      const graphTemplate = variant.graph_template ?? suite.target.graph_template;
      const graphTemplatePath = resolveSuitePath(suiteDir, graphTemplate);

      return {
        id,
        graph_template: graphTemplate,
        graph_template_path: graphTemplatePath,
        optional: variant.optional ?? false
      };
    });
}

async function validateVariantTemplates(
  suite: EvalSuite,
  suiteDir: string,
  cases: EvalCase[],
  diagnostics: EvalDiagnostic[]
): Promise<void> {
  const variants = resolveEvalVariants(suite, suiteDir);
  const seenGraderIds = new Set<string>();

  suite.graders?.forEach((grader) => {
    if (seenGraderIds.has(grader.id)) {
      diagnostics.push({ path: "$.graders", message: `Duplicate grader id "${grader.id}".` });
    }
    seenGraderIds.add(grader.id);
  });

  for (const grader of suite.graders ?? []) {
    if (grader.kind === "ai_rubric") {
      const rubricPath = resolveSuitePath(suiteDir, grader.rubric);
      if (!await pathExists(rubricPath)) {
        diagnostics.push({ path: `grader:${grader.id}.rubric`, message: `Rubric path does not exist: ${rubricPath}` });
      }
    }
  }

  for (const variant of variants) {
    if (!await pathExists(variant.graph_template_path)) {
      if (!variant.optional) {
        diagnostics.push({
          path: `variant:${variant.id}.graph_template`,
          message: `Graph template does not exist: ${variant.graph_template_path}`
        });
      }
      continue;
    }

    for (const evalCase of cases) {
      const rendered = await renderGraphTemplate({
        suite_dir: suiteDir,
        template_path: variant.graph_template_path,
        case: evalCase
      });

      diagnostics.push(
        ...rendered.diagnostics.map((diagnostic) => ({
          path: `case:${evalCase.id}.variant:${variant.id}.${diagnostic.path}`,
          message: diagnostic.message
        }))
      );
    }
  }
}

export async function loadEvalSuite(
  currentWorkingDirectory: string,
  suitePath: string
): Promise<LoadedEvalSuite> {
  const suite_path = resolve(currentWorkingDirectory, suitePath);
  const suite_dir = dirname(suite_path);
  const diagnostics: EvalDiagnostic[] = [];
  let rawSuite: unknown;

  try {
    rawSuite = JSON.parse(await readFile(suite_path, "utf8"));
  } catch (error) {
    return {
      suite: {
        version: "1",
        suite_id: "invalid",
        target: { graph_template: "" },
        cases: ""
      },
      suite_path,
      suite_dir,
      cases: [],
      diagnostics: [
        {
          path: "$",
          message: `Eval suite could not be loaded: ${error instanceof Error ? error.message : String(error)}`
        }
      ]
    };
  }

  const suite = normalizeSuite(rawSuite, diagnostics);
  const cases = suite ? await loadCases(resolveSuitePath(suite_dir, suite.cases), diagnostics) : [];

  if (suite) {
    await validateFixturePaths(suite_dir, cases, diagnostics);
    await validateVariantTemplates(suite, suite_dir, cases, diagnostics);
  }

  return {
    suite: suite ?? {
      version: "1",
      suite_id: "invalid",
      target: { graph_template: "" },
      cases: ""
    },
    suite_path,
    suite_dir,
    cases,
    diagnostics
  };
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

function readCasePathValue(value: unknown, segments: string[]): unknown {
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
  case: EvalCase;
  placeholder: string;
}): string | undefined {
  const normalized = options.placeholder.trim();

  if (normalized === "suite.dir") {
    return options.suite_dir;
  }

  if (normalized === "case.fixtures.root") {
    return resolve(options.suite_dir, "fixtures");
  }

  if (normalized.startsWith("case.repos.") && normalized.endsWith(".path")) {
    const alias = normalized.slice("case.repos.".length, -".path".length);
    const repo = options.case.repos?.[alias];
    const repoPath = typeof repo === "string" ? repo : repo?.path;
    return repoPath ? resolveSuitePath(options.suite_dir, repoPath) : undefined;
  }

  if (normalized.startsWith("case.fixtures.")) {
    const key = normalized.slice("case.fixtures.".length);
    const fixtures = options.case.fixtures;
    const value = Array.isArray(fixtures)
      ? fixtures[Number(key)]
      : fixtures && typeof fixtures === "object"
        ? fixtures[key]
        : undefined;

    return typeof value === "string" ? resolveSuitePath(options.suite_dir, value) : undefined;
  }

  if (normalized.startsWith("case.")) {
    const value = readCasePathValue(options.case, normalized.slice("case.".length).split("."));
    return value === undefined ? undefined : stringifyTemplateValue(value);
  }

  return undefined;
}

function renderTemplateValue(value: unknown, options: {
  suite_dir: string;
  case: EvalCase;
  diagnostics: EvalDiagnostic[];
  path: string;
}): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/gu, (match, placeholder: string) => {
      const resolved = resolveTemplatePlaceholder({
        suite_dir: options.suite_dir,
        case: options.case,
        placeholder
      });

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
  case: EvalCase;
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
      suite_dir: options.suite_dir,
      case: options.case,
      diagnostics,
      path: "$"
    }),
    diagnostics
  };
}

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { runsRootEnvironmentVariable } from "../artifacts/paths.js";
import { runCommand } from "../cli/commands/run.js";
import type {
  EvalBenchmark,
  EvalCase,
  EvalCaseVariantResult,
  EvalGraderResult,
  EvalRunLedger,
  EvalSuiteThresholds,
  LoadedEvalSuite
} from "./types.js";
import { runEvalGrader } from "./graders.js";
import { renderGraphTemplate, resolveEvalVariants } from "./suite.js";
import { writeEvalTrace } from "./trace.js";

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
  evals_root?: string;
}): string {
  if (options.evals_root) {
    if (!isAbsolute(options.evals_root)) {
      throw new Error(`--evals-root must be an absolute path. Received: ${options.evals_root}`);
    }

    return options.evals_root;
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

async function runGraphForCase(options: {
  currentWorkingDirectory: string;
  rendered_graph_file: string;
  graph_runs_root: string;
  label: string;
  signal?: AbortSignal;
}): Promise<{
  output?: Record<string, unknown>;
  exit_code: number;
  run_root?: string;
  status?: string;
  error?: string;
}> {
  await mkdir(options.graph_runs_root, { recursive: true });
  const previousRunsRoot = process.env[runsRootEnvironmentVariable];
  process.env[runsRootEnvironmentVariable] = options.graph_runs_root;

  try {
    const result = await runCommand.run(
      {
        graph: options.rendered_graph_file,
        label: options.label
      },
      options.currentWorkingDirectory,
      options.signal
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
  } finally {
    if (previousRunsRoot === undefined) {
      delete process.env[runsRootEnvironmentVariable];
    } else {
      process.env[runsRootEnvironmentVariable] = previousRunsRoot;
    }
  }
}

function resultPassed(options: {
  graphStatus?: string;
  graders: EvalGraderResult[];
}): boolean {
  if (options.graphStatus !== "passed") {
    return false;
  }

  return options.graders.every((grader) => !grader.required || grader.status === "passed");
}

function resultStatus(options: {
  graphStatus?: string;
  graders: EvalGraderResult[];
  error?: string;
}): EvalCaseVariantResult["status"] {
  if (options.error && !options.graphStatus) {
    return "errored";
  }

  if (options.graders.some((grader) => grader.required && grader.status === "errored")) {
    return "errored";
  }

  return resultPassed({
    ...(options.graphStatus ? { graphStatus: options.graphStatus } : {}),
    graders: options.graders
  })
    ? "passed"
    : "failed";
}

async function runCaseVariant(options: {
  currentWorkingDirectory: string;
  loaded: LoadedEvalSuite;
  eval_root: string;
  case: EvalCase;
  variant_id: string;
  graph_template_path: string;
  signal?: AbortSignal;
}): Promise<EvalCaseVariantResult> {
  const variantRoot = join(options.eval_root, "cases", sanitizePathSegment(options.case.id), sanitizePathSegment(options.variant_id));
  const renderedGraphFile = join(variantRoot, "rendered_graph.json");
  const caseFile = join(variantRoot, "case.json");
  const runRootFile = join(variantRoot, "run-root.txt");
  const traceFile = join(variantRoot, "trace.jsonl");
  const gradingFile = join(variantRoot, "grading.json");
  const summaryFile = join(variantRoot, "summary.md");

  await mkdir(variantRoot, { recursive: true });
  await writeJson(caseFile, options.case);

  const rendered = await renderGraphTemplate({
    suite_dir: options.loaded.suite_dir,
    template_path: options.graph_template_path,
    case: options.case
  });

  if (rendered.diagnostics.length > 0) {
    const error = rendered.diagnostics.map((diagnostic) => diagnostic.message).join(" ");
    const result: EvalCaseVariantResult = {
      case_id: options.case.id,
      variant_id: options.variant_id,
      status: "errored",
      passed: false,
      rendered_graph_file: renderedGraphFile,
      grading_file: gradingFile,
      summary_file: summaryFile,
      graders: [],
      error
    };

    await Promise.all([
      writeJson(gradingFile, result),
      writeFile(summaryFile, `# Eval Case ${options.case.id}\n\n${error}\n`, "utf8")
    ]);

    return result;
  }

  await writeJson(renderedGraphFile, rendered.graph);

  const graphRun = await runGraphForCase({
    currentWorkingDirectory: options.currentWorkingDirectory,
    rendered_graph_file: renderedGraphFile,
    graph_runs_root: join(variantRoot, "runs"),
    label: `${options.case.id}-${options.variant_id}`,
    ...(options.signal ? { signal: options.signal } : {})
  });

  const graders: EvalGraderResult[] = [];
  let run_root = graphRun.run_root;

  if (run_root) {
    await writeFile(runRootFile, `${run_root}\n`, "utf8");
    await writeEvalTrace({
      run_root,
      trace_file: traceFile
    });

    for (const grader of options.loaded.suite.graders ?? []) {
      graders.push(await runEvalGrader({
        grader,
        suite_dir: options.loaded.suite_dir,
        case: options.case,
        case_file: caseFile,
        run_root,
        trace_file: traceFile,
        variant_id: options.variant_id,
        output_dir: join(variantRoot, "graders", sanitizePathSegment(grader.id)),
        ...(options.signal ? { signal: options.signal } : {})
      }));
    }
  }

  const status = resultStatus({
    ...(graphRun.status ? { graphStatus: graphRun.status } : {}),
    graders,
    ...(graphRun.error && !run_root ? { error: graphRun.error } : {})
  });
  const passed = resultPassed({
    ...(graphRun.status ? { graphStatus: graphRun.status } : {}),
    graders
  });
  const result: EvalCaseVariantResult = {
    case_id: options.case.id,
    variant_id: options.variant_id,
    status,
    passed,
    ...(graphRun.status ? { graph_status: graphRun.status } : {}),
    rendered_graph_file: renderedGraphFile,
    ...(run_root ? { run_root } : {}),
    ...(run_root ? { trace_file: traceFile } : {}),
    grading_file: gradingFile,
    summary_file: summaryFile,
    graders,
    ...(graphRun.error && !run_root ? { error: graphRun.error } : {})
  };

  await Promise.all([
    writeJson(gradingFile, result),
    writeFile(
      summaryFile,
      [
        `# Eval Case ${options.case.id}`,
        "",
        `- Variant: ${options.variant_id}`,
        `- Status: ${status}`,
        `- Graph status: ${graphRun.status ?? "not-run"}`,
        `- Passed: ${passed ? "yes" : "no"}`,
        ...(run_root ? [`- Run root: ${run_root}`] : []),
        ...(graphRun.error && !run_root ? [`- Error: ${graphRun.error}`] : []),
        "",
        "## Graders",
        ...(graders.length > 0
          ? graders.map((grader) => `- ${grader.id}: ${grader.status}${grader.summary ? ` - ${grader.summary}` : ""}`)
          : ["- none"])
      ].join("\n"),
      "utf8"
    )
  ]);

  return result;
}

function computeBenchmark(results: EvalCaseVariantResult[], thresholds: EvalSuiteThresholds): EvalBenchmark {
  const total = results.filter((result) => result.status !== "skipped").length;
  const passed = results.filter((result) => result.status === "passed").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const errored = results.filter((result) => result.status === "errored").length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  const pass_rate = total > 0 ? passed / total : 0;
  const critical_failures = errored;
  const threshold_passed =
    pass_rate >= (thresholds.pass_rate ?? 0) &&
    critical_failures <= (thresholds.critical_failures ?? Number.POSITIVE_INFINITY);

  return {
    total,
    passed,
    failed,
    errored,
    skipped,
    pass_rate,
    threshold_passed,
    critical_failures
  };
}

export async function runEvalSuite(options: {
  currentWorkingDirectory: string;
  loaded: LoadedEvalSuite;
  eval_root: string;
  case_id?: string;
  variant_id?: string;
  signal?: AbortSignal;
}): Promise<{
  ledger: EvalRunLedger;
  infrastructure_failed: boolean;
}> {
  const started_at = new Date().toISOString();
  const results: EvalCaseVariantResult[] = [];
  const cases = options.loaded.cases.filter((evalCase) => !options.case_id || evalCase.id === options.case_id);
  const variants = resolveEvalVariants(options.loaded.suite, options.loaded.suite_dir, options.variant_id);
  const thresholds = options.loaded.suite.thresholds ?? {};

  await mkdir(options.eval_root, { recursive: true });

  if (cases.length === 0) {
    throw new Error(options.case_id ? `No eval case matched --case ${options.case_id}.` : "Eval suite has no cases.");
  }

  if (variants.length === 0) {
    throw new Error(options.variant_id ? `No eval variant matched --variant ${options.variant_id}.` : "Eval suite has no variants.");
  }

  for (const variant of variants) {
    const templateExists = await pathExists(variant.graph_template_path);

    if (!templateExists && variant.optional) {
      for (const evalCase of cases) {
        const variantRoot = join(options.eval_root, "cases", sanitizePathSegment(evalCase.id), sanitizePathSegment(variant.id));
        const gradingFile = join(variantRoot, "grading.json");
        const summaryFile = join(variantRoot, "summary.md");
        const result: EvalCaseVariantResult = {
          case_id: evalCase.id,
          variant_id: variant.id,
          status: "skipped",
          passed: false,
          grading_file: gradingFile,
          summary_file: summaryFile,
          graders: [],
          error: `Optional variant graph template missing: ${variant.graph_template_path}`
        };

        await mkdir(variantRoot, { recursive: true });
        await Promise.all([
          writeJson(gradingFile, result),
          writeFile(summaryFile, `# Eval Case ${evalCase.id}\n\nSkipped optional variant ${variant.id}.\n`, "utf8")
        ]);
        results.push(result);
      }
      continue;
    }

    if (!templateExists) {
      throw new Error(`Variant "${variant.id}" graph template does not exist: ${variant.graph_template_path}`);
    }

    for (const evalCase of cases) {
      results.push(await runCaseVariant({
        currentWorkingDirectory: options.currentWorkingDirectory,
        loaded: options.loaded,
        eval_root: options.eval_root,
        case: evalCase,
        variant_id: variant.id,
        graph_template_path: variant.graph_template_path,
        ...(options.signal ? { signal: options.signal } : {})
      }));
    }
  }

  const benchmark = computeBenchmark(results, thresholds);
  const ended_at = new Date().toISOString();
  const ledger: EvalRunLedger = {
    version: "1",
    suite_id: options.loaded.suite.suite_id,
    eval_root: options.eval_root,
    suite_path: options.loaded.suite_path,
    started_at,
    ended_at,
    status: benchmark.threshold_passed ? "passed" : "failed",
    filters: {
      ...(options.case_id ? { case_id: options.case_id } : {}),
      ...(options.variant_id ? { variant_id: options.variant_id } : {})
    },
    thresholds,
    benchmark,
    results
  };

  await Promise.all([
    writeJson(join(options.eval_root, "eval-run.json"), {
      suite_id: options.loaded.suite.suite_id,
      suite_path: options.loaded.suite_path,
      started_at,
      ended_at,
      filters: ledger.filters
    }),
    writeJson(join(options.eval_root, "evaluation-ledger.json"), ledger),
    writeJson(join(options.eval_root, "benchmark.json"), benchmark),
    writeFile(
      join(options.eval_root, "summary.md"),
      [
        `# Eval Suite ${options.loaded.suite.suite_id}`,
        "",
        `- Status: ${ledger.status}`,
        `- Pass rate: ${benchmark.pass_rate.toFixed(3)}`,
        `- Passed: ${benchmark.passed}/${benchmark.total}`,
        `- Failed: ${benchmark.failed}`,
        `- Errored: ${benchmark.errored}`,
        `- Skipped: ${benchmark.skipped}`,
        "",
        "## Results",
        ...results.map((result) => `- ${result.case_id} / ${result.variant_id}: ${result.status}`)
      ].join("\n"),
      "utf8"
    )
  ]);

  return {
    ledger,
    infrastructure_failed: results.some((result) => result.status === "errored")
  };
}

export async function readEvalLedger(evalRoot: string): Promise<EvalRunLedger> {
  return JSON.parse(await readFile(join(evalRoot, "evaluation-ledger.json"), "utf8")) as EvalRunLedger;
}

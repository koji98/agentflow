import { join } from "node:path";

import { loadEvalSuite } from "../../evals/suite.js";
import {
  compareEvalVariants,
  createEvalRootPath,
  inspectEvalTrial,
  readEvalLedger,
  renderEvalReport,
  runEvalSuite
} from "../../evals/runner.js";
import {
  renderCommandUsageError
} from "../command_support.js";

function renderEvalUsageError(message: string): string {
  return renderCommandUsageError({
    message,
    commandName: "eval",
    usage: evalCommand.usage
  });
}

function renderEvalHelp(): string {
  return [
    "eval: Validate, run, inspect, and compare workflow eval suites.",
    "",
    `Usage: ${evalCommand.usage}`,
    "",
    "Subcommands:",
    "  validate <suite-dir-or-eval.json>",
    "  run <suite-dir-or-eval.json> [--scenario <id|all>] [--variant <id|all>] [--trials <n>] [--eval-root <abs path>] [--concurrency <n>]",
    "  report <eval-root> [--format json|markdown]",
    "  inspect <eval-root> --scenario <id> --variant <id> --trial <n>",
    "  compare <eval-root> --baseline <variant> --candidate <variant>",
    "",
    "Notes:",
    "- Eval suites are local workflow benchmarks using version 2 eval.json files.",
    "- Eval trials run normal Agentflow graphs and grade complete workflow traces.",
    "- The eval architecture follows Anthropic's Demystifying evals for AI agents article: tasks/scenarios, trials, graders, traces, outcomes, and aggregate reports."
  ].join("\n");
}

function unexpectedEvalOptions(
  options: Record<string, string | boolean | string[] | undefined>,
  allowed: readonly string[]
): string[] {
  const allowedSet = new Set(allowed);
  return Object.keys(options).filter((optionName) => !allowedSet.has(optionName));
}

function renderUnexpectedEvalOptions(unexpected: string[]): string {
  return renderEvalUsageError(
    `Unexpected option(s) for eval subcommand: ${unexpected.map((optionName) => `--${optionName}`).join(", ")}`
  );
}

function readPositiveInteger(value: string | boolean | string[] | undefined, fallback: number): number {
  if (typeof value !== "string") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function requireSingleTarget(positionals: readonly string[], subcommand: string): {
  target?: string;
  error?: string;
} {
  if (positionals.length < 2) {
    return { error: `Missing ${subcommand} target.` };
  }

  if (positionals.length > 2) {
    return { error: `Unexpected eval positional arguments: ${positionals.slice(2).join(", ")}` };
  }

  const target = positionals[1];
  return target ? { target } : { error: `Missing ${subcommand} target.` };
}

export const evalCommand = {
  name: "eval",
  summary: "Validate and run local workflow eval suites.",
  usage: "agentflow eval <validate|run|report|inspect|compare> <target> [options]",
  examples: [
    "agentflow eval validate evals/agentflow-workflow-quality",
    "agentflow eval run evals/agentflow-workflow-quality --variant current --trials 3",
    "agentflow eval report .agentflow/evals/<eval-run-id> --format markdown",
    "agentflow eval inspect .agentflow/evals/<eval-run-id> --scenario missing-dependency-docs --variant current --trial 1",
    "agentflow eval compare .agentflow/evals/<eval-run-id> --baseline current --candidate terse"
  ] as const,
  optionNames: [
    "scenario",
    "variant",
    "trials",
    "eval-root",
    "concurrency",
    "format",
    "baseline",
    "candidate",
    "trial",
    "help"
  ] as const,
  helpNotes: [
    "Eval suites are local file-backed workflow benchmarks.",
    "Deterministic graders set hard blockers; LLM judges rate quality and prompt feedback.",
    "Use eval for offline workflow grading; use graph check nodes for in-run sensors and supervisor semantic_evaluation for runtime interventions."
  ] as const,
  async run(
    options: Record<string, string | boolean | string[] | undefined>,
    currentWorkingDirectory: string,
    signal?: AbortSignal,
    positionals: readonly string[] = []
  ) {
    const subcommand = positionals[0];

    if (!subcommand) {
      return {
        exitCode: 2,
        stdout: renderEvalUsageError("Missing eval subcommand.")
      };
    }

    if (subcommand === "help") {
      const unexpected = unexpectedEvalOptions(options, []);
      if (unexpected.length > 0) {
        return { exitCode: 2, stdout: renderUnexpectedEvalOptions(unexpected) };
      }
      return { exitCode: 0, stdout: renderEvalHelp() };
    }

    if (subcommand === "validate") {
      const unexpected = unexpectedEvalOptions(options, []);
      if (unexpected.length > 0) {
        return { exitCode: 2, stdout: renderUnexpectedEvalOptions(unexpected) };
      }

      const target = requireSingleTarget(positionals, "validate");
      if (!target.target) {
        return { exitCode: 2, stdout: renderEvalUsageError(target.error ?? "Missing eval suite target.") };
      }

      const loaded = await loadEvalSuite(currentWorkingDirectory, target.target);
      const passed = loaded.diagnostics.length === 0;

      return {
        exitCode: passed ? 0 : 1,
        output: {
          command: "eval validate",
          status: passed ? "passed" : "failed",
          message: passed
            ? `Eval suite "${loaded.suite.suite_id}" validated.`
            : `Eval suite "${loaded.suite.suite_id}" has validation diagnostics.`,
          suite_path: loaded.suite_path,
          suite_id: loaded.suite.suite_id,
          source_reference: loaded.suite.source_reference,
          scenario_count: loaded.scenarios.length,
          scenarios: loaded.scenarios.map((scenario) => scenario.id),
          variants: loaded.variants.map((variant) => variant.id),
          grader_count: loaded.graders.length,
          judge_count: loaded.judges.length,
          diagnostics: loaded.diagnostics
        }
      };
    }

    if (subcommand === "run") {
      const unexpected = unexpectedEvalOptions(options, ["scenario", "variant", "trials", "eval-root", "concurrency"]);
      if (unexpected.length > 0) {
        return { exitCode: 2, stdout: renderUnexpectedEvalOptions(unexpected) };
      }

      const target = requireSingleTarget(positionals, "run");
      if (!target.target) {
        return { exitCode: 2, stdout: renderEvalUsageError(target.error ?? "Missing eval suite target.") };
      }

      try {
        const loaded = await loadEvalSuite(currentWorkingDirectory, target.target);

        if (loaded.diagnostics.length > 0) {
          return {
            exitCode: 1,
            output: {
              command: "eval run",
              status: "failed",
              message: `Eval suite "${loaded.suite.suite_id}" has validation diagnostics.`,
              suite_path: loaded.suite_path,
              diagnostics: loaded.diagnostics
            }
          };
        }

        const evalRoot = createEvalRootPath({
          currentWorkingDirectory,
          suite_id: loaded.suite.suite_id,
          ...(typeof options["eval-root"] === "string" ? { eval_root: options["eval-root"] } : {})
        });
        const run = await runEvalSuite({
          currentWorkingDirectory,
          loaded,
          eval_root: evalRoot,
          ...(typeof options.scenario === "string" ? { scenario_id: options.scenario } : {}),
          ...(typeof options.variant === "string" ? { variant_id: options.variant } : {}),
          trials: readPositiveInteger(options.trials, loaded.suite.default_trials),
          concurrency: readPositiveInteger(options.concurrency, 1),
          ...(signal ? { signal } : {})
        });

        return {
          exitCode: run.infrastructure_failed || !run.ledger.benchmark.threshold_passed ? 1 : 0,
          output: {
            command: "eval run",
            status: run.ledger.status,
            message: run.ledger.status === "passed"
              ? "Eval suite completed and thresholds passed."
              : "Eval suite completed with failing thresholds or infrastructure errors.",
            eval_root: evalRoot,
            suite_path: loaded.suite_path,
            suite_id: loaded.suite.suite_id,
            benchmark: run.ledger.benchmark,
            artifacts: {
              eval_run_file: join(evalRoot, "eval-run.json"),
              evaluation_ledger_file: join(evalRoot, "evaluation-ledger.json"),
              benchmark_file: join(evalRoot, "benchmark.json"),
              report_file: join(evalRoot, "report.md")
            }
          }
        };
      } catch (error) {
        return {
          exitCode: 1,
          output: {
            command: "eval run",
            status: "failed",
            message: error instanceof Error ? error.message : String(error)
          }
        };
      }
    }

    if (subcommand === "report") {
      const unexpected = unexpectedEvalOptions(options, ["format"]);
      if (unexpected.length > 0) {
        return { exitCode: 2, stdout: renderUnexpectedEvalOptions(unexpected) };
      }

      const target = requireSingleTarget(positionals, "report");
      if (!target.target) {
        return { exitCode: 2, stdout: renderEvalUsageError(target.error ?? "Missing eval root target.") };
      }

      try {
        const ledger = await readEvalLedger(target.target);
        const format = typeof options.format === "string" ? options.format : "json";

        if (format === "markdown") {
          return {
            exitCode: ledger.status === "passed" ? 0 : 1,
            stdout: `${renderEvalReport(ledger)}\n`
          };
        }

        if (format !== "json") {
          return { exitCode: 2, stdout: renderEvalUsageError("--format must be json or markdown.") };
        }

        return {
          exitCode: ledger.status === "passed" ? 0 : 1,
          output: {
            command: "eval report",
            status: ledger.status,
            eval_root: ledger.eval_root,
            suite_id: ledger.suite_id,
            benchmark: ledger.benchmark,
            results: ledger.results,
            artifacts: {
              evaluation_ledger_file: join(target.target, "evaluation-ledger.json"),
              benchmark_file: join(target.target, "benchmark.json"),
              report_file: join(target.target, "report.md")
            }
          }
        };
      } catch (error) {
        return {
          exitCode: 1,
          output: {
            command: "eval report",
            status: "failed",
            message: error instanceof Error ? error.message : String(error)
          }
        };
      }
    }

    if (subcommand === "inspect") {
      const unexpected = unexpectedEvalOptions(options, ["scenario", "variant", "trial"]);
      if (unexpected.length > 0) {
        return { exitCode: 2, stdout: renderUnexpectedEvalOptions(unexpected) };
      }

      const target = requireSingleTarget(positionals, "inspect");
      if (!target.target) {
        return { exitCode: 2, stdout: renderEvalUsageError(target.error ?? "Missing eval root target.") };
      }

      if (typeof options.scenario !== "string" || typeof options.variant !== "string" || typeof options.trial !== "string") {
        return { exitCode: 2, stdout: renderEvalUsageError("inspect requires --scenario, --variant, and --trial.") };
      }

      try {
        const inspected = await inspectEvalTrial({
          eval_root: target.target,
          scenario_id: options.scenario,
          variant_id: options.variant,
          trial_index: readPositiveInteger(options.trial, 1)
        });

        return {
          exitCode: 0,
          output: {
            command: "eval inspect",
            eval_root: target.target,
            scenario_id: options.scenario,
            variant_id: options.variant,
            trial: inspected.trial,
            trace_packet: inspected.trace_packet,
            scorecard: inspected.scorecard
          }
        };
      } catch (error) {
        return {
          exitCode: 1,
          output: {
            command: "eval inspect",
            status: "failed",
            message: error instanceof Error ? error.message : String(error)
          }
        };
      }
    }

    if (subcommand === "compare") {
      const unexpected = unexpectedEvalOptions(options, ["baseline", "candidate"]);
      if (unexpected.length > 0) {
        return { exitCode: 2, stdout: renderUnexpectedEvalOptions(unexpected) };
      }

      const target = requireSingleTarget(positionals, "compare");
      if (!target.target) {
        return { exitCode: 2, stdout: renderEvalUsageError(target.error ?? "Missing eval root target.") };
      }

      if (typeof options.baseline !== "string" || typeof options.candidate !== "string") {
        return { exitCode: 2, stdout: renderEvalUsageError("compare requires --baseline and --candidate.") };
      }

      try {
        const ledger = await readEvalLedger(target.target);
        const comparison = compareEvalVariants({
          ledger,
          baseline: options.baseline,
          candidate: options.candidate
        });

        return {
          exitCode: 0,
          output: {
            command: "eval compare",
            eval_root: target.target,
            ...comparison
          }
        };
      } catch (error) {
        return {
          exitCode: 1,
          output: {
            command: "eval compare",
            status: "failed",
            message: error instanceof Error ? error.message : String(error)
          }
        };
      }
    }

    return {
      exitCode: 2,
      stdout: renderEvalUsageError(`Unknown eval subcommand: ${subcommand}`)
    };
  }
};

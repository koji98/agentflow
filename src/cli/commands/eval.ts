import { join } from "node:path";

import { loadEvalSuite } from "../../evals/suite.js";
import { createEvalRootPath, readEvalLedger, runEvalSuite } from "../../evals/runner.js";
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
    "eval: Validate and run local eval suites for Agentflow graphs.",
    "",
    `Usage: ${evalCommand.usage}`,
    "",
    "Subcommands:",
    "  validate --suite <suite.json>",
    "  run --suite <suite.json> [--case <id>] [--variant <id>] [--label <label>] [--evals-root <abs path>]",
    "  report --eval-root <path>",
    "",
    "Notes:",
    "- Eval suites are local JSON/JSONL files.",
    "- Eval runs write artifacts under <launch-cwd>/.agentflow/evals unless --evals-root is provided.",
    "- Graph execution still uses normal Agentflow graph run artifacts.",
    "- eval is offline product/workflow evaluation; use graph check nodes for in-run sensors and supervisor semantic_evaluation for runtime interventions."
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

export const evalCommand = {
  name: "eval",
  summary: "Validate and run local eval suites for agentic workflows.",
  usage: "agentflow eval <validate|run|report> [options]",
  examples: [
    "agentflow eval validate --suite evals/receipt-agent/suite.json",
    "agentflow eval run --suite evals/receipt-agent/suite.json --variant candidate",
    "agentflow eval report --eval-root .agentflow/evals/<eval-run-id>"
  ] as const,
  optionNames: ["suite", "case", "variant", "label", "evals-root", "eval-root", "help"] as const,
  helpNotes: [
    "Eval suites are local file-backed datasets and graders for workflows built with Agentflow.",
    "Script graders receive AGENTFLOW_EVAL_* environment variables and must emit normalized JSON.",
    "Use eval for offline product/workflow grading; use graph check nodes for in-run sensors and supervisor semantic_evaluation for runtime interventions."
  ] as const,
  async run(
    options: Record<string, string | boolean | string[] | undefined>,
    currentWorkingDirectory: string,
    signal?: AbortSignal,
    positionals: readonly string[] = []
  ) {
    const subcommand = positionals[0];

    if (!subcommand || positionals.length > 1) {
      return {
        exitCode: 2,
        stdout: renderEvalUsageError(
          subcommand ? `Unexpected eval positional arguments: ${positionals.slice(1).join(", ")}` : "Missing eval subcommand."
        )
      };
    }

    if (subcommand === "validate") {
      const unexpected = unexpectedEvalOptions(options, ["suite"]);
      if (unexpected.length > 0) {
        return {
          exitCode: 2,
          stdout: renderUnexpectedEvalOptions(unexpected)
        };
      }

      const suitePath = typeof options.suite === "string" ? options.suite : undefined;

      if (!suitePath) {
        return {
          exitCode: 2,
          stdout: renderEvalUsageError("Missing required option: --suite")
        };
      }

      const loaded = await loadEvalSuite(currentWorkingDirectory, suitePath);
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
          case_count: loaded.cases.length,
          variants: Object.keys(loaded.suite.variants ?? { candidate: {} }),
          grader_count: loaded.suite.graders?.length ?? 0,
          diagnostics: loaded.diagnostics
        }
      };
    }

    if (subcommand === "run") {
      const unexpected = unexpectedEvalOptions(options, ["suite", "case", "variant", "label", "evals-root"]);
      if (unexpected.length > 0) {
        return {
          exitCode: 2,
          stdout: renderUnexpectedEvalOptions(unexpected)
        };
      }

      const suitePath = typeof options.suite === "string" ? options.suite : undefined;

      if (!suitePath) {
        return {
          exitCode: 2,
          stdout: renderEvalUsageError("Missing required option: --suite")
        };
      }

      try {
        const loaded = await loadEvalSuite(currentWorkingDirectory, suitePath);

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
          ...(typeof options.label === "string" ? { label: options.label } : {}),
          ...(typeof options["evals-root"] === "string" ? { evals_root: options["evals-root"] } : {})
        });
        const run = await runEvalSuite({
          currentWorkingDirectory,
          loaded,
          eval_root: evalRoot,
          ...(typeof options.case === "string" ? { case_id: options.case } : {}),
          ...(typeof options.variant === "string" ? { variant_id: options.variant } : {}),
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
              summary_file: join(evalRoot, "summary.md")
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
      const unexpected = unexpectedEvalOptions(options, ["eval-root"]);
      if (unexpected.length > 0) {
        return {
          exitCode: 2,
          stdout: renderUnexpectedEvalOptions(unexpected)
        };
      }

      const evalRoot = typeof options["eval-root"] === "string" ? options["eval-root"] : undefined;

      if (!evalRoot) {
        return {
          exitCode: 2,
          stdout: renderEvalUsageError("Missing required option: --eval-root")
        };
      }

      try {
        const ledger = await readEvalLedger(evalRoot);

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
              evaluation_ledger_file: join(evalRoot, "evaluation-ledger.json"),
              benchmark_file: join(evalRoot, "benchmark.json"),
              summary_file: join(evalRoot, "summary.md")
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

    if (subcommand === "help") {
      const unexpected = unexpectedEvalOptions(options, []);
      if (unexpected.length > 0) {
        return {
          exitCode: 2,
          stdout: renderUnexpectedEvalOptions(unexpected)
        };
      }

      return {
        exitCode: 0,
        stdout: renderEvalHelp()
      };
    }

    return {
      exitCode: 2,
      stdout: renderEvalUsageError(`Unknown eval subcommand: ${subcommand}`)
    };
  }
};

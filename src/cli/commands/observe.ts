import { stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import { resolveRunsRoot } from "../../artifacts/paths.js";
import { readRunRecord } from "../../artifacts/reader.js";
import {
  appendOperatorObservation,
  createOperatorObservation,
  operatorObservationsPath,
  readOperatorObservations,
  resolveOperatorObservation
} from "../../runtime/observations/index.js";
import {
  evidenceKinds,
  findingKinds,
  type CompletionEvidence,
  type ObservationKind,
  type OperatorObservation
} from "../../runtime/completion/index.js";
import { listRuns } from "./runs.js";
import { renderCommandUsageError } from "../command_support.js";

type OptionValue = string | boolean | string[] | undefined;

function renderObserveUsageError(message: string): string {
  return renderCommandUsageError({
    message,
    commandName: observeCommand.name,
    usage: observeCommand.usage
  });
}

function stringOption(options: Record<string, OptionValue>, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function booleanOption(options: Record<string, OptionValue>, name: string): boolean {
  return options[name] === true;
}

function evidenceOptionValues(options: Record<string, OptionValue>): string[] {
  const value = options.evidence;
  if (Array.isArray(value)) {
    return value;
  }
  return typeof value === "string" ? [value] : [];
}

function parseEvidence(rawValues: string[]): CompletionEvidence[] {
  return rawValues.map((raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`--evidence must be a JSON object: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("--evidence must be a JSON object.");
    }
    const record = parsed as Record<string, unknown>;
    const kind = typeof record.kind === "string" ? record.kind : undefined;
    const summary = typeof record.summary === "string" && record.summary.trim().length > 0
      ? record.summary
      : undefined;
    if (!kind || !evidenceKinds.includes(kind as CompletionEvidence["kind"])) {
      throw new Error(`--evidence kind must be one of: ${evidenceKinds.join(", ")}.`);
    }
    if (!summary) {
      throw new Error("--evidence summary is required.");
    }
    const status = typeof record.status === "string" ? record.status : undefined;
    return {
      kind: kind as CompletionEvidence["kind"],
      ...(typeof record.ref === "string" && record.ref.trim().length > 0 ? { ref: record.ref } : {}),
      summary,
      ...(status === "passed" || status === "failed" || status === "blocked" || status === "unknown"
        ? { status }
        : {})
    };
  });
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function resolveRunRoot(input: string, currentWorkingDirectory: string): Promise<string> {
  const direct = isAbsolute(input) ? input : resolve(currentWorkingDirectory, input);
  if (await directoryExists(direct)) {
    return direct;
  }

  const runsRoot = resolveRunsRoot({
    currentWorkingDirectory,
    environment: process.env
  });
  const byDirectoryName = join(runsRoot, input);
  if (await directoryExists(byDirectoryName)) {
    return byDirectoryName;
  }

  const listed = await listRuns({
    runsRoot,
    currentWorkingDirectory
  });
  const matching = listed.runs.find((run) => run.run_id === input || basename(run.run_root) === input);
  if (matching) {
    return matching.run_root;
  }

  throw new Error(`Run "${input}" could not be found as a path or under ${runsRoot}.`);
}

function activeFilter(options: Record<string, OptionValue>): boolean {
  return booleanOption(options, "active");
}

function matchesListFilters(
  observation: OperatorObservation,
  options: {
    node?: string;
    activeOnly: boolean;
  }
): boolean {
  if (options.activeOnly && observation.status !== "active") {
    return false;
  }
  if (options.node && observation.node !== options.node) {
    return false;
  }
  return true;
}

async function runIdForRunRoot(runRoot: string): Promise<string | undefined> {
  try {
    return (await readRunRecord(runRoot)).run_id;
  } catch {
    return undefined;
  }
}

function defaultAuthor(): string {
  return process.env.AGENTFLOW_OBSERVER ?? process.env.USER ?? userInfo().username ?? "human";
}

export const observeCommand = {
  name: "observe",
  summary: "Add, list, or resolve live human observations for a run without pausing it.",
  usage: "agentflow observe <add|list|resolve> --run <run-root-or-id> [options]",
  examples: [
    "agentflow observe add --run .agentflow/runs/<run-id> --kind observation --summary \"Backend worker is running\"",
    "agentflow observe add --run <run-id> --kind blocker --summary \"Export worker is unavailable\" --blocked-on backend_worker --recoverable-by operator",
    "agentflow observe list --run <run-id> --active",
    "agentflow observe resolve --run <run-id> --observation <obs-id> --resolution resolved --summary \"Worker restored\""
  ] as const,
  optionNames: [
    "run",
    "kind",
    "summary",
    "body",
    "node",
    "attempt",
    "evidence",
    "severity",
    "author",
    "blocking",
    "blocked-on",
    "recoverable-by",
    "active",
    "observation",
    "resolution",
    "help"
  ] as const,
  helpNotes: [
    "Observations are evidence, not graph contract edits.",
    "Use pause/edit/resume rather than observe when the goal, acceptance criteria, artifacts, authority, sandbox, or supervision policy must change.",
    "Blocking observations affect completion until resolved or superseded."
  ] as const,
  async run(
    options: Record<string, OptionValue>,
    currentWorkingDirectory: string,
    _signal?: AbortSignal,
    positionals: readonly string[] = []
  ) {
    const subcommand = positionals[0];
    if (!subcommand || !["add", "list", "resolve"].includes(subcommand) || positionals.length > 1) {
      return {
        exitCode: 2,
        stdout: renderObserveUsageError(
          subcommand
            ? `Unexpected observe subcommand or positional arguments: ${positionals.join(", ")}`
            : "Missing observe subcommand."
        )
      };
    }

    const runInput = stringOption(options, "run");
    if (!runInput) {
      return {
        exitCode: 2,
        stdout: renderObserveUsageError("--run <run-root-or-id> is required.")
      };
    }
    const runRoot = await resolveRunRoot(runInput, currentWorkingDirectory);

    if (subcommand === "add") {
      const kind = stringOption(options, "kind");
      const summary = stringOption(options, "summary");
      const severity = stringOption(options, "severity") ?? "info";
      if (!kind || !findingKinds.includes(kind as ObservationKind)) {
        return {
          exitCode: 2,
          stdout: renderObserveUsageError(`--kind must be one of: ${findingKinds.join(", ")}.`)
        };
      }
      if (!summary) {
        return {
          exitCode: 2,
          stdout: renderObserveUsageError("--summary <text> is required.")
        };
      }
      if (severity !== "info" && severity !== "warning" && severity !== "error") {
        return {
          exitCode: 2,
          stdout: renderObserveUsageError("--severity must be one of: info, warning, error.")
        };
      }

      const runId = await runIdForRunRoot(runRoot);
      const body = stringOption(options, "body");
      const node = stringOption(options, "node");
      const attempt = stringOption(options, "attempt");
      const blockedOn = stringOption(options, "blocked-on");
      const recoverableBy = stringOption(options, "recoverable-by");
      const observation = createOperatorObservation({
        ...(runId ? { runId } : {}),
        author: stringOption(options, "author") ?? defaultAuthor(),
        kind: kind as ObservationKind,
        severity,
        summary,
        ...(body ? { body } : {}),
        ...(node ? { node } : {}),
        ...(attempt ? { attempt } : {}),
        evidence: parseEvidence(evidenceOptionValues(options)),
        ...(booleanOption(options, "blocking") || kind === "blocker" ? { blocking: true } : {}),
        ...(blockedOn ? { blockedOn } : {}),
        ...(recoverableBy ? { recoverableBy } : {})
      });
      const observations_path = await appendOperatorObservation(runRoot, observation);

      return {
        exitCode: 0,
        output: {
          command: "observe add",
          status: "recorded",
          run_root: runRoot,
          observations_path,
          observation
        }
      };
    }

    if (subcommand === "list") {
      const node = stringOption(options, "node");
      const observations = (await readOperatorObservations(runRoot))
        .filter((observation) => matchesListFilters(observation, {
          ...(node ? { node } : {}),
          activeOnly: activeFilter(options)
        }));

      return {
        exitCode: 0,
        output: {
          command: "observe list",
          status: "passed",
          run_root: runRoot,
          observations_path: operatorObservationsPath(runRoot),
          observations
        }
      };
    }

    const observationId = stringOption(options, "observation");
    const resolution = stringOption(options, "resolution");
    const summary = stringOption(options, "summary");
    if (!observationId) {
      return {
        exitCode: 2,
        stdout: renderObserveUsageError("--observation <observation-id> is required.")
      };
    }
    if (resolution !== "resolved" && resolution !== "superseded") {
      return {
        exitCode: 2,
        stdout: renderObserveUsageError("--resolution must be one of: resolved, superseded.")
      };
    }
    if (!summary) {
      return {
        exitCode: 2,
        stdout: renderObserveUsageError("--summary <text> is required.")
      };
    }
    const observation = await resolveOperatorObservation({
      runRoot,
      observationId,
      status: resolution,
      summary
    });

    return {
      exitCode: 0,
      output: {
        command: "observe resolve",
        status: "recorded",
        run_root: runRoot,
        observations_path: operatorObservationsPath(runRoot),
        observation
      }
    };
  }
};

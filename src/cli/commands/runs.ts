import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { resolveRunsRoot } from "../../artifacts/paths.js";
import { readRunRecord, type RunRecord } from "../../artifacts/reader.js";
import { loadAuthoredGraphDocument } from "../../graph/validate.js";
import {
  createRunsRootDetails,
  renderCommandUsageError
} from "../command_support.js";

interface RunsListOptions {
  graph?: string;
  runsRoot?: string;
}

export interface RunSummary {
  run_id: string;
  run_root: string;
  graph_id?: string;
  graph_path?: string;
  launch_profile?: string;
  workspace_backend?: string;
  status?: string;
  started_at?: string;
  ended_at?: string;
  load_error?: string;
}

function renderRunsUsageError(message: string): string {
  return renderCommandUsageError({
    message,
    commandName: runsCommand.name,
    usage: runsCommand.usage
  });
}

async function listRunDirectories(runsRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(runsRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(runsRoot, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function loadRunSummary(runRoot: string): Promise<RunSummary> {
  const baseSummary: RunSummary = {
    run_id: runRoot.split("/").at(-1) ?? runRoot,
    run_root: runRoot
  };

  try {
    const record: RunRecord = await readRunRecord(runRoot);
    const summary: RunSummary = {
      ...baseSummary,
      run_id: record.run_id,
      graph_id: record.graph_id,
      launch_profile: record.launch_profile,
      workspace_backend: record.workspace_backend,
      status: record.status,
      started_at: record.started_at
    };

    if (record.graph_path) {
      summary.graph_path = record.graph_path;
    }
    if (record.ended_at) {
      summary.ended_at = record.ended_at;
    }

    return summary;
  } catch (error) {
    return {
      ...baseSummary,
      load_error: error instanceof Error ? error.message : String(error)
    };
  }
}

function compareRunsByStartedAtDescending(left: RunSummary, right: RunSummary): number {
  const leftStarted = left.started_at ? Date.parse(left.started_at) : 0;
  const rightStarted = right.started_at ? Date.parse(right.started_at) : 0;

  if (leftStarted !== rightStarted) {
    return rightStarted - leftStarted;
  }

  return right.run_id.localeCompare(left.run_id);
}

async function resolveRunsListContext(
  options: RunsListOptions,
  currentWorkingDirectory: string
): Promise<
  | {
      ok: true;
      runs_root: string;
      graph_directory?: string;
      graph_path?: string;
    }
  | {
      ok: false;
      message: string;
      diagnostics?: Array<{ path: string; message: string }>;
    }
> {
  if (options.runsRoot) {
    const runsRoot = resolve(currentWorkingDirectory, options.runsRoot);
    return { ok: true, runs_root: runsRoot };
  }

  if (options.graph) {
    const loaded = await loadAuthoredGraphDocument(currentWorkingDirectory, options.graph);

    if (!loaded.document) {
      return {
        ok: false,
        message: "Graph could not be loaded or normalized from --graph.",
        diagnostics: loaded.diagnostics
      };
    }

    const graphDirectory = dirname(loaded.absolute_path);
    const runsRoot = resolveRunsRoot({
      currentWorkingDirectory,
      graphDirectory,
      environment: process.env
    });

    return {
      ok: true,
      runs_root: runsRoot,
      graph_directory: graphDirectory,
      graph_path: loaded.absolute_path
    };
  }

  const runsRoot = resolveRunsRoot({
    currentWorkingDirectory,
    environment: process.env
  });

  return { ok: true, runs_root: runsRoot };
}

export async function listRuns(options: {
  runsRoot?: string;
  graph?: string;
  currentWorkingDirectory: string;
}): Promise<{
  runs_root: string;
  graph_path?: string;
  graph_directory?: string;
  runs: RunSummary[];
}> {
  const context = await resolveRunsListContext(
    {
      ...(options.runsRoot ? { runsRoot: options.runsRoot } : {}),
      ...(options.graph ? { graph: options.graph } : {})
    },
    options.currentWorkingDirectory
  );

  if (!context.ok) {
    throw new Error(context.message);
  }

  const directories = await listRunDirectories(context.runs_root);
  const summaries = await Promise.all(directories.map((directory) => loadRunSummary(directory)));
  summaries.sort(compareRunsByStartedAtDescending);

  return {
    runs_root: context.runs_root,
    ...(context.graph_path ? { graph_path: context.graph_path } : {}),
    ...(context.graph_directory ? { graph_directory: context.graph_directory } : {}),
    runs: summaries
  };
}

export const runsCommand = {
  name: "runs",
  summary: "Inspect previously recorded run roots discovered under the runs root.",
  usage: "agentflow runs list [--graph <path>] [--runs-root <path>]",
  examples: [
    "agentflow runs list --graph ./agentflow.graph.json",
    "agentflow runs list --runs-root /absolute/path/to/.agentflow/runs"
  ] as const,
  optionNames: ["graph", "runs-root", "help"] as const,
  helpNotes: [
    "Without --graph or --runs-root, the runs root is resolved from AGENTFLOW_RUNS_ROOT or the launch cwd default.",
    "With --graph, the runs root resolves to <graph-directory>/.agentflow/runs (unless AGENTFLOW_RUNS_ROOT overrides it)."
  ] as const,
  async run(
    options: Record<string, string | boolean | string[] | undefined>,
    currentWorkingDirectory: string,
    _signal?: AbortSignal,
    positionals: readonly string[] = []
  ) {
    const subcommand = positionals[0];

    if (subcommand !== "list" || positionals.length > 1) {
      return {
        exitCode: 2,
        stdout: renderRunsUsageError(
          subcommand
            ? `Unexpected runs subcommand or positional arguments: ${positionals.join(", ")}`
            : "Missing runs subcommand."
        )
      };
    }

    const graphInput = typeof options.graph === "string" ? options.graph : undefined;
    const runsRootInput = typeof options["runs-root"] === "string" ? options["runs-root"] : undefined;

    if (graphInput && runsRootInput) {
      return {
        exitCode: 2,
        stdout: renderRunsUsageError("Provide either --graph or --runs-root, not both.")
      };
    }

    const context = await resolveRunsListContext(
      {
        ...(graphInput ? { graph: graphInput } : {}),
        ...(runsRootInput ? { runsRoot: runsRootInput } : {})
      },
      currentWorkingDirectory
    );

    if (!context.ok) {
      return {
        exitCode: 1,
        output: {
          command: "runs list",
          status: "failed",
          message: context.message,
          ...(context.diagnostics ? { diagnostics: context.diagnostics } : {})
        }
      };
    }

    const directories = await listRunDirectories(context.runs_root);
    const summaries = await Promise.all(directories.map((directory) => loadRunSummary(directory)));
    summaries.sort(compareRunsByStartedAtDescending);

    const runsRootDetails = createRunsRootDetails(
      currentWorkingDirectory,
      process.env,
      context.graph_directory,
      runsRootInput ? resolve(currentWorkingDirectory, runsRootInput) : undefined
    );

    return {
      exitCode: 0,
      output: {
        command: "runs list",
        status: "passed",
        runs_root: context.runs_root,
        runs_root_source: runsRootDetails.runs_root_source,
        runs_root_env: runsRootDetails.runs_root_env,
        ...(runsRootDetails.runs_root_input
          ? { runs_root_input: runsRootDetails.runs_root_input }
          : {}),
        ...(context.graph_path ? { graph_path: context.graph_path } : {}),
        ...(context.graph_directory ? { graph_directory: context.graph_directory } : {}),
        runs_count: summaries.length,
        runs: summaries
      }
    };
  }
};

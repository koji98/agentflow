import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  createRunRootPath,
  resolveRunArtifactPaths
} from "../../artifacts/paths.js";
import { createMonitorHandoff } from "../monitor_handoff.js";
import type { AuthoredGraphDocument } from "../../graph/authored.js";
import { compileAuthoredGraph } from "../../graph/compile.js";
import { resolveLaunchConfig } from "../../graph/profiles.js";
import { workspaceBackends } from "../../graph/schema.js";
import { loadAuthoredGraphDocument, summarizeAuthoredGraph } from "../../graph/validate.js";
import { runCompiledGraph } from "../../runtime/core/engine.js";
import { createCodexCliHarness } from "../../runtime/harness/codex_cli.js";
import { createCursorCliHarness } from "../../runtime/harness/cursor_cli.js";
import {
  createGraphCliInvocation,
  createGraphPathResolution,
  createRunsRootDetails,
  renderCommandUsageError,
  runCancellationText
} from "../command_support.js";
import { createRuntimeProgressReporter } from "../progress.js";

async function resolveRepoSources(
  absoluteGraphPath: string,
  document: AuthoredGraphDocument
): Promise<{
  repo_sources?: Record<string, string>;
  diagnostics: Array<{
    path: string;
    message: string;
  }>;
}> {
  const graphDirectory = dirname(absoluteGraphPath);
  const repo_sources: Record<string, string> = {};
  const diagnostics: Array<{
    path: string;
    message: string;
  }> = [];

  for (const [repoAlias, repoDefinition] of Object.entries(document.repos)) {
    const absoluteRepoPath = resolve(graphDirectory, repoDefinition.path);

    try {
      const entry = await stat(absoluteRepoPath);

      if (!entry.isDirectory()) {
        diagnostics.push({
          path: `$.repos.${repoAlias}.path`,
          message: `Resolved repo path is not a directory: ${absoluteRepoPath}`
        });
        continue;
      }

      repo_sources[repoAlias] = absoluteRepoPath;
    } catch (error) {
      diagnostics.push({
        path: `$.repos.${repoAlias}.path`,
        message:
          error instanceof Error
            ? `Repo path could not be resolved: ${absoluteRepoPath} (${error.message})`
            : `Repo path could not be resolved: ${absoluteRepoPath}`
      });
    }
  }

  return diagnostics.length > 0
    ? { diagnostics }
    : {
        repo_sources,
        diagnostics
      };
}

export const runCommand = {
  name: "run",
  summary: "Compile and execute a graph run with durable artifacts.",
  usage:
    "agentflow run --graph <path/to/agentflow.graph.json> [--profile <launch_profile>] [--workspace-backend <inplace|worktree>] [--label <run_label>]",
  examples: [
    "agentflow run --graph ./agentflow.graph.json --workspace-backend worktree",
    "AGENTFLOW_RUNS_ROOT=/absolute/path/to/.agentflow/runs agentflow run --graph ./agentflow.graph.json"
  ] as const,
  optionNames: ["graph", "profile", "workspace-backend", "label", "help"] as const,
  helpNotes: [
    "Runs default to <launch-cwd>/.agentflow/runs/<run-id> unless AGENTFLOW_RUNS_ROOT is set to an absolute path.",
    "Press Ctrl-C in the launching terminal to cancel. The runtime waits for cleanup and the monitor reflects the durable Canceled state from artifacts.",
    "Repo paths inside the graph resolve from the graph file directory even when --graph is passed relative to the launch shell."
  ] as const,
  async run(
    options: Record<string, string | boolean | undefined>,
    currentWorkingDirectory: string,
    signal?: AbortSignal
  ) {
    const graphPath = typeof options.graph === "string" ? options.graph : undefined;

    if (!graphPath) {
      return {
        exitCode: 2,
        stdout: renderCommandUsageError({
          message: "Missing required option: --graph",
          commandName: this.name,
          usage: this.usage,
          includeGraphHelp: true
        })
      };
    }

    const loaded = await loadAuthoredGraphDocument(currentWorkingDirectory, graphPath);
    const pathResolution = createGraphPathResolution(
      currentWorkingDirectory,
      graphPath,
      loaded.absolute_path
    );

    if (!loaded.document) {
      return {
        exitCode: 1,
        output: {
          command: "run",
          status: "failed",
          message: "Graph could not be loaded or normalized from --graph.",
          graph_path: loaded.absolute_path,
          path_resolution: pathResolution,
          next_steps: {
            graph_help: "agentflow graph-help",
            validate: createGraphCliInvocation("validate", {
              graphPath: loaded.absolute_path
            })
          },
          diagnostics: loaded.diagnostics
        }
      };
    }

    const launch = resolveLaunchConfig(loaded.document, {
      ...(typeof options.profile === "string" ? { launchProfile: options.profile } : {}),
      ...(typeof options["workspace-backend"] === "string"
        ? { workspaceBackend: options["workspace-backend"] }
        : {})
    });

    if (launch.diagnostics.length > 0) {
      return {
        exitCode: 1,
        output: {
          command: "run",
          status: "failed",
          message: "Launch settings could not be resolved before execution.",
          graph_path: loaded.absolute_path,
          path_resolution: pathResolution,
          available_profiles: Object.keys(loaded.document.profiles ?? {}),
          supported_workspace_backends: workspaceBackends,
          next_steps: {
            graph_help: "agentflow graph-help",
            validate: createGraphCliInvocation("validate", {
              graphPath: loaded.absolute_path
            }),
            compile: createGraphCliInvocation("compile", {
              graphPath: loaded.absolute_path
            })
          },
          diagnostics: launch.diagnostics
        }
      };
    }

    const compilation = compileAuthoredGraph(
      loaded.document,
      launch,
      loaded.lowered_managed_nodes
    );

    if (compilation.diagnostics.length > 0) {
      return {
        exitCode: 1,
        output: {
          command: "run",
          status: "failed",
          message: "Graph compilation returned diagnostics before runtime launch.",
          graph_path: loaded.absolute_path,
          path_resolution: pathResolution,
          next_steps: {
            validate: createGraphCliInvocation("validate", {
              graphPath: loaded.absolute_path,
              launch
            }),
            compile: createGraphCliInvocation("compile", {
              graphPath: loaded.absolute_path,
              launch
            }),
            graph_help: "agentflow graph-help"
          },
          diagnostics: compilation.diagnostics,
          ...(compilation.compiled_graph ? { compiled_graph: compilation.compiled_graph } : {})
        }
      };
    }

    const repoResolution = await resolveRepoSources(loaded.absolute_path, loaded.document);

    if (!repoResolution.repo_sources) {
      return {
        exitCode: 1,
        output: {
          command: "run",
          status: "failed",
          message: "One or more repo sources could not be resolved for runtime execution.",
          graph_path: loaded.absolute_path,
          path_resolution: pathResolution,
          next_steps: {
            validate: createGraphCliInvocation("validate", {
              graphPath: loaded.absolute_path,
              launch
            }),
            compile: createGraphCliInvocation("compile", {
              graphPath: loaded.absolute_path,
              launch
            })
          },
          diagnostics: repoResolution.diagnostics
        }
      };
    }

    const progress = createRuntimeProgressReporter(compilation.compiled_graph!);
    const run = await runCompiledGraph({
      on_event: (event) => {
        progress.onEvent(event);
      },
      run_root: createRunRootPath({
        currentWorkingDirectory,
        graphId: loaded.document.graph_id,
        ...(typeof options.label === "string" ? { runLabel: options.label } : {}),
        environment: process.env
      }),
      compiled_graph: compilation.compiled_graph!,
      repo_sources: repoResolution.repo_sources,
      authored_graph: loaded.document,
      compile_diagnostics: compilation.diagnostics,
      harnesses: {
        "codex-cli": createCodexCliHarness(),
        "cursor-cli": createCursorCliHarness()
      },
      ...(signal ? { signal } : {})
    });
    const artifactPaths = resolveRunArtifactPaths(run.run_root);
    const runsRoot = dirname(run.run_root);
    const runsRootDetails = createRunsRootDetails(currentWorkingDirectory, process.env);
    const monitor = createMonitorHandoff({
      runsRoot,
      runId: run.run_id
    });
    const runMessage =
      run.outcome === "passed"
        ? "Run completed and durable artifacts are ready for the graph-native monitor."
        : run.outcome === "canceled"
          ? "Run canceled. Durable artifacts captured the terminal Canceled state for the graph-native monitor."
          : "Run failed. Durable artifacts captured the terminal failure state for the graph-native monitor.";

    return {
      exitCode: run.outcome === "passed" ? 0 : 1,
      output: {
        command: "run",
        status: run.outcome,
        message: runMessage,
        graph_path: loaded.absolute_path,
        path_resolution: pathResolution,
        runs_root: runsRoot,
        runs_root_env: runsRootDetails.runs_root_env,
        runs_root_source: runsRootDetails.runs_root_source,
        ...(runsRootDetails.runs_root_input
          ? { runs_root_input: runsRootDetails.runs_root_input }
          : {}),
        default_runs_root: runsRootDetails.default_runs_root,
        runs_root_contract: runsRootDetails.contract,
        authored_summary: summarizeAuthoredGraph(loaded.document),
        launch,
        repo_sources: repoResolution.repo_sources,
        run_id: run.run_id,
        run_root: run.run_root,
        counts: run.state.counts,
        repo_workspaces: run.state.repo_workspaces,
        attempt_count: run.attempts.length,
        artifacts: {
          run_file: artifactPaths.run_file,
          authored_graph_file: artifactPaths.authored_graph_file,
          compiled_graph_file: artifactPaths.compiled_graph_file,
          execution_manifest_file: artifactPaths.execution_manifest_file,
          compile_diagnostics_file: artifactPaths.compile_diagnostics_file,
          state_file: artifactPaths.state_file,
          events_file: artifactPaths.events_file,
          summary_file: artifactPaths.summary_file
        },
        monitor,
        cancel_note: runCancellationText,
        next_steps: {
          open_monitor: monitor.monitor_route,
          start_monitor: monitor.start_command,
          dev_monitor: monitor.dev_command,
          validate: createGraphCliInvocation("validate", {
            graphPath: loaded.absolute_path,
            launch
          }),
          ui: createGraphCliInvocation("ui", {
            graphPath: loaded.absolute_path,
            launch
          })
        },
        latest_run_state: run.state
      }
    };
  }
};

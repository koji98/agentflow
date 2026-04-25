import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { isRecordedRunOwnerActive } from "../../artifacts/owner.js";
import { resolveRunArtifactPaths, resolveRunsRoot } from "../../artifacts/paths.js";
import { reconcileRunArtifacts } from "../../artifacts/reconcile.js";
import {
  readCompiledGraph,
  readExecutionManifest,
  readRunEvents,
  readRunExecutionAttempts,
  readRunRecord,
  readRunState
} from "../../artifacts/reader.js";
import { compileAuthoredGraph } from "../../graph/compile.js";
import { resolveLaunchConfig } from "../../graph/profiles.js";
import { workspaceBackends } from "../../graph/schema.js";
import { loadAuthoredGraphDocument } from "../../graph/validate.js";
import { resumeCompiledGraph } from "../../runtime/core/engine.js";
import { createCodexCliHarness } from "../../runtime/harness/codex_cli.js";
import { createCursorCliHarness } from "../../runtime/harness/cursor_cli.js";
import { createResumedRuntimeSession } from "../../runtime/resume.js";
import { resumeWorkspaceFromManifest } from "../../runtime/workspace/resume.js";
import { createInteractiveCheckpointExecutor } from "../checkpoint.js";
import {
  createGraphCliInvocation,
  createGraphPathResolution,
  createResumeCliInvocation,
  renderCommandUsageError,
  runCancellationText
} from "../command_support.js";
import { createRuntimeProgressReporter } from "../progress.js";
import { collectReferencedRepoAliases, resolveRepoSources } from "../repo_sources.js";
import { createRunTerminalFields } from "../run_output.js";

async function selectLatestResumableRunRoot(
  currentWorkingDirectory: string,
  graphInput: string
): Promise<
  | { ok: true; run_root: string; graph_path: string; runs_root: string }
  | {
      ok: false;
      message: string;
      runs_root?: string;
      graph_path?: string;
      diagnostics?: Array<{ path: string; message: string }>;
    }
> {
  const loaded = await loadAuthoredGraphDocument(currentWorkingDirectory, graphInput);

  if (!loaded.document) {
    return {
      ok: false,
      message: "Graph could not be loaded or normalized from --graph.",
      diagnostics: loaded.diagnostics
    };
  }

  const runsRoot = resolveRunsRoot({
    currentWorkingDirectory,
    graphDirectory: dirname(loaded.absolute_path),
    environment: process.env
  });

  let entries: Dirent[];
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        ok: false,
        message: "No runs root found for the supplied graph.",
        runs_root: runsRoot,
        graph_path: loaded.absolute_path
      };
    }
    throw error;
  }

  const candidateRoots = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${runsRoot}/${entry.name}`);

  const records = await Promise.all(
    candidateRoots.map(async (runRoot) => {
      try {
        const record = await readRunRecord(runRoot);
        return { runRoot, record };
      } catch {
        return undefined;
      }
    })
  );

  const resumableEntries = records
    .filter((entry): entry is { runRoot: string; record: Awaited<ReturnType<typeof readRunRecord>> } =>
      Boolean(entry) &&
      ["failed", "canceled"].includes(entry!.record.status) &&
      entry!.record.graph_path === loaded.absolute_path
    )
    .sort((left, right) => {
      const leftStarted = Date.parse(left.record.started_at) || 0;
      const rightStarted = Date.parse(right.record.started_at) || 0;
      return rightStarted - leftStarted;
    });

  const latest = resumableEntries[0];
  if (!latest) {
    return {
      ok: false,
      message:
        "No failed or canceled runs were found for the supplied graph in the resolved runs root.",
      runs_root: runsRoot,
      graph_path: loaded.absolute_path
    };
  }

  return {
    ok: true,
    run_root: latest.runRoot,
    graph_path: loaded.absolute_path,
    runs_root: runsRoot
  };
}

function compareRepoBindings(
  expected: Record<string, string>,
  actual: Record<string, string>
): Array<{ path: string; message: string }> {
  const diagnostics: Array<{ path: string; message: string }> = [];
  const aliases = new Set([...Object.keys(expected), ...Object.keys(actual)]);

  for (const repoAlias of aliases) {
    const expectedSource = expected[repoAlias];
    const actualSource = actual[repoAlias];

    if (!expectedSource) {
      diagnostics.push({
        path: `$.repos.${repoAlias}`,
        message: `Resume cannot add repo "${repoAlias}" because it was not present in the original run.`
      });
      continue;
    }

    if (!actualSource) {
      diagnostics.push({
        path: `$.repos.${repoAlias}`,
        message: `Resume cannot remove repo "${repoAlias}" because it was present in the original run.`
      });
      continue;
    }

    if (expectedSource !== actualSource) {
      diagnostics.push({
        path: `$.repos.${repoAlias}.path`,
        message:
          `Resume requires the same repo source path as the original run. ` +
          `Expected ${expectedSource} but resolved ${actualSource}.`
      });
    }
  }

  return diagnostics;
}

export const resumeCommand = {
  name: "resume",
  summary: "Recompile the original graph for a failed or canceled run root and preserve only unchanged passed work.",
  usage: "agentflow resume (--run-root <path/to/run-root> | --graph <path/to/graph> --latest)",
  examples: [
    "agentflow resume --run-root .agentflow/runs/<run-id>",
    "agentflow resume --run-root /absolute/path/to/.agentflow/runs/<run-id>",
    "agentflow resume --graph ./agentflow.graph.json --latest"
  ] as const,
  optionNames: ["run-root", "graph", "latest", "help"] as const,
  helpNotes: [
    "Resume recompiles from the original graph path using the current Agentflow build.",
    "Only passed nodes whose compiled contract still matches are preserved.",
    "Repeat scopes restart from iteration 1 when they were unfinished or their compiled contract changed.",
    "Pass --graph with --latest to resume the most recent failed or canceled run discovered under the graph's runs root."
  ] as const,
  async run(
    options: Record<string, string | boolean | string[] | undefined>,
    currentWorkingDirectory: string
  ) {
    const runRootInput = typeof options["run-root"] === "string" ? options["run-root"] : undefined;
    const graphInput = typeof options.graph === "string" ? options.graph : undefined;
    const latestRequested = options.latest === true;

    if (latestRequested && runRootInput) {
      return {
        exitCode: 2,
        stdout: renderCommandUsageError({
          message: "Provide either --run-root or --latest with --graph, not both.",
          commandName: this.name,
          usage: this.usage
        })
      };
    }

    if (!runRootInput && !latestRequested) {
      return {
        exitCode: 2,
        stdout: renderCommandUsageError({
          message: "Missing required option: --run-root (or --graph with --latest)",
          commandName: this.name,
          usage: this.usage
        })
      };
    }

    if (latestRequested && !graphInput) {
      return {
        exitCode: 2,
        stdout: renderCommandUsageError({
          message: "--latest requires --graph to locate the runs root.",
          commandName: this.name,
          usage: this.usage
        })
      };
    }

    let run_root: string;

    if (runRootInput) {
      run_root = resolve(currentWorkingDirectory, runRootInput);
    } else {
      const latest = await selectLatestResumableRunRoot(currentWorkingDirectory, graphInput!);
      if (!latest.ok) {
        return {
          exitCode: 1,
          output: {
            command: "resume",
            status: "failed",
            message: latest.message,
            ...(latest.runs_root ? { runs_root: latest.runs_root } : {}),
            ...(latest.graph_path ? { graph_path: latest.graph_path } : {}),
            ...(latest.diagnostics ? { diagnostics: latest.diagnostics } : {})
          }
        };
      }
      run_root = latest.run_root;
    }

    await reconcileRunArtifacts(run_root);

    const [
      runRecord,
      state,
      prior_compiled_graph,
      execution_manifest,
      attempts,
      events
    ] = await Promise.all([
      readRunRecord(run_root),
      readRunState(run_root),
      readCompiledGraph(run_root),
      readExecutionManifest(run_root),
      readRunExecutionAttempts(run_root),
      readRunEvents(run_root)
    ]);

    if (runRecord.status === "passed") {
      return {
        exitCode: 1,
        output: {
          command: "resume",
          status: "failed",
          message: "Passed runs cannot be resumed.",
          run_root,
          run_id: runRecord.run_id
        }
      };
    }

    if (runRecord.status === "running" && await isRecordedRunOwnerActive(runRecord)) {
      return {
        exitCode: 1,
        output: {
          command: "resume",
          status: "failed",
          message: "Run is still active and cannot be resumed from another process.",
          run_root,
          run_id: runRecord.run_id
        }
      };
    }

    if (!runRecord.graph_path) {
      return {
        exitCode: 1,
        output: {
          command: "resume",
          status: "failed",
          message: "Run cannot be resumed because it does not record an original graph path.",
          run_root,
          run_id: runRecord.run_id
        }
      };
    }

    if (!["failed", "canceled"].includes(runRecord.status)) {
      return {
        exitCode: 1,
        output: {
          command: "resume",
          status: "failed",
          message: `Only failed or canceled runs can be resumed. Current status: ${runRecord.status}.`,
          run_root,
          run_id: runRecord.run_id
        }
      };
    }

    const loaded = await loadAuthoredGraphDocument(currentWorkingDirectory, runRecord.graph_path);
    const pathResolution = createGraphPathResolution(
      currentWorkingDirectory,
      runRecord.graph_path,
      loaded.absolute_path
    );

    if (!loaded.document) {
      return {
        exitCode: 1,
        output: {
          command: "resume",
          status: "failed",
          message: "Original graph could not be loaded or normalized before resume.",
          run_root,
          run_id: runRecord.run_id,
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
      launchProfile: runRecord.launch_profile,
      workspaceBackend: runRecord.workspace_backend
    });

    if (launch.diagnostics.length > 0) {
      return {
        exitCode: 1,
        output: {
          command: "resume",
          status: "failed",
          message: "Original graph could not be launched with the stored run settings during resume.",
          run_root,
          run_id: runRecord.run_id,
          graph_path: loaded.absolute_path,
          path_resolution: pathResolution,
          available_profiles: Object.keys(loaded.document.profiles ?? {}),
          supported_workspace_backends: workspaceBackends,
          next_steps: {
            graph_help: "agentflow graph-help",
            validate: createGraphCliInvocation("validate", {
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
      loaded.lowered_managed_nodes,
      {
        ...(loaded.resolved_plugins ? { resolved_plugins: loaded.resolved_plugins } : {}),
        graph_dir: dirname(loaded.absolute_path)
      }
    );

    if (compilation.diagnostics.length > 0) {
      return {
        exitCode: 1,
        output: {
          command: "resume",
          status: "failed",
          message: "Original graph returned compile-time diagnostics before resume.",
          run_root,
          run_id: runRecord.run_id,
          graph_path: loaded.absolute_path,
          path_resolution: pathResolution,
          next_steps: {
            graph_help: "agentflow graph-help",
            validate: createGraphCliInvocation("validate", {
              graphPath: loaded.absolute_path
            })
          },
          diagnostics: compilation.diagnostics,
          ...(compilation.compiled_graph ? { compiled_graph: compilation.compiled_graph } : {})
        }
      };
    }

    const activeRepoAliases = collectReferencedRepoAliases(compilation.compiled_graph!);
    const repoResolution = await resolveRepoSources(
      loaded.absolute_path,
      loaded.document,
      activeRepoAliases
    );

    if (!repoResolution.repo_sources) {
      return {
        exitCode: 1,
        output: {
          command: "resume",
          status: "failed",
          message: "One or more repo sources could not be resolved before resume.",
          run_root,
          run_id: runRecord.run_id,
          graph_path: loaded.absolute_path,
          path_resolution: pathResolution,
          next_steps: {
            validate: createGraphCliInvocation("validate", {
              graphPath: loaded.absolute_path
            })
          },
          diagnostics: repoResolution.diagnostics
        }
      };
    }

    const repoBindingDiagnostics = compareRepoBindings(
      Object.fromEntries(
        Object.entries(execution_manifest.repo_workspaces)
          .filter(([repoAlias]) => activeRepoAliases.includes(repoAlias))
          .map(([repoAlias, binding]) => [
          repoAlias,
          binding.source_path
        ])
      ),
      repoResolution.repo_sources
    );

    if (repoBindingDiagnostics.length > 0) {
      return {
        exitCode: 1,
        output: {
          command: "resume",
          status: "failed",
          message: "Resume requires the recompiled graph to resolve to the same repo source bindings as the original run.",
          run_root,
          run_id: runRecord.run_id,
          graph_path: loaded.absolute_path,
          path_resolution: pathResolution,
          diagnostics: repoBindingDiagnostics
        }
      };
    }

    const compiled_graph = compilation.compiled_graph!;
    const repo_sources = repoResolution.repo_sources;
    const workspace = await resumeWorkspaceFromManifest(execution_manifest);

    const {
      session,
      previous_status,
      preserved_node_count,
      restarted_node_count
    } = await createResumedRuntimeSession({
      run_root,
      graph_path: loaded.absolute_path,
      prior_graph: prior_compiled_graph,
      graph: compiled_graph,
      manifest: execution_manifest,
      prior_state: state,
      attempts,
      events
    });

    const progress = createRuntimeProgressReporter(compiled_graph);
    const resumed = await resumeCompiledGraph({
      on_event: (event) => {
        progress.onEvent(event);
      },
      run_root,
      compiled_graph,
      repo_sources,
      graph_path: loaded.absolute_path,
      authored_graph: loaded.document,
      compile_diagnostics: compilation.diagnostics,
      harnesses: {
        "codex-cli": createCodexCliHarness(),
        "cursor-cli": createCursorCliHarness()
      },
      executors: {
        checkpoint: createInteractiveCheckpointExecutor()
      },
      resumed_session: session,
      prior_events: events,
      workspace,
      previous_status,
      preserved_node_count,
      restarted_node_count
    });

    const artifactPaths = resolveRunArtifactPaths(run_root);
    const terminalFields = createRunTerminalFields(resumed.state, resumed.attempts, resumed.events);
    const message =
      resumed.outcome === "passed"
        ? "Run resumed and completed successfully."
        : resumed.outcome === "canceled"
          ? "Run resumed and was canceled."
          : "Run resumed and failed again.";

    return {
      exitCode: resumed.outcome === "passed" ? 0 : 1,
      output: {
        command: "resume",
        status: resumed.outcome,
        message,
        run_id: resumed.run_id,
        run_root,
        graph_path: loaded.absolute_path,
        path_resolution: pathResolution,
        resumed_from_status: previous_status,
        preserved_node_count,
        restarted_node_count,
        counts: resumed.state.counts,
        supervisor_status: resumed.state.supervisor.status,
        intervention_count: resumed.state.supervisor.intervention_count,
        supervisor_budget_remaining: resumed.state.supervisor.budget_remaining,
        delivery_package: `${artifactPaths.delivery_dir}/manifest.json`,
        reviewer_guide: `${artifactPaths.delivery_dir}/reviewer-guide.md`,
        repo_workspaces: resumed.state.repo_workspaces,
        workspace_change_artifacts: resumed.state.workspace_change_artifacts,
        attempt_count: resumed.attempts.length,
        ...terminalFields,
        artifacts: {
          run_file: artifactPaths.run_file,
          authored_graph_file: artifactPaths.authored_graph_file,
          compiled_graph_file: artifactPaths.compiled_graph_file,
          execution_manifest_file: artifactPaths.execution_manifest_file,
          compile_diagnostics_file: artifactPaths.compile_diagnostics_file,
          state_file: artifactPaths.state_file,
          events_file: artifactPaths.events_file,
          interventions_file: artifactPaths.interventions_file,
          summary_file: artifactPaths.summary_file,
          delivery_dir: artifactPaths.delivery_dir,
          workspace_changes_dir: artifactPaths.workspace_changes_dir
        },
        cancel_note: runCancellationText,
        next_steps: {
          validate: createGraphCliInvocation("validate", {
            graphPath: loaded.absolute_path
          }),
          resume: createResumeCliInvocation(run_root)
        },
        latest_run_state: resumed.state
      }
    };
  }
};

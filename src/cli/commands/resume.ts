import type { Dirent } from "node:fs";
import { appendFile, mkdir, readdir } from "node:fs/promises";
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
import type { CompiledExecutableNode, CompiledGraph } from "../../graph/compiled.js";
import { resolveLaunchConfig } from "../../graph/profiles.js";
import { workspaceBackends } from "../../graph/schema.js";
import { loadAuthoredGraphDocument } from "../../graph/validate.js";
import { resumeCompiledGraph } from "../../runtime/core/engine.js";
import { createCodexCliHarness } from "../../runtime/harness/codex_cli.js";
import { createCursorCliHarness } from "../../runtime/harness/cursor_cli.js";
import { createResumedRuntimeSession } from "../../runtime/resume.js";
import type { RuntimeNodeStatus, RuntimeSession } from "../../runtime/session.js";
import { resumeWorkspaceFromManifest } from "../../runtime/workspace/resume.js";
import {
  createInteractiveCheckpointExecutor,
  createScriptedCheckpointExecutor,
  parseScriptedCheckpointDecisions
} from "../checkpoint.js";
import {
  createGraphCliInvocation,
  createGraphPathResolution,
  createResumeCliInvocation,
  renderCommandUsageError,
  runCancellationText
} from "../command_support.js";
import { createRuntimeProgressReporter } from "../progress.js";
import { collectReferencedRepoAliases, resolveRepoSources } from "../repo_sources.js";
import { createRunTerminalFields, createSupervisorDisplayFields } from "../run_output.js";

function summarizeResumeNode(
  node: CompiledExecutableNode,
  session: RuntimeSession
): {
  compiled_id: string;
  authored_id: string;
  kind: CompiledExecutableNode["kind"];
  status: RuntimeNodeStatus;
  deps: string[];
  blocked_by: string[];
} {
  const status = session.node_statuses.get(node.compiled_id) ?? "pending";
  const blockedBy = node.deps.filter((dep) => session.node_statuses.get(dep) !== "passed");

  return {
    compiled_id: node.compiled_id,
    authored_id: node.authored_id,
    kind: node.kind,
    status,
    deps: [...node.deps],
    blocked_by: blockedBy
  };
}

function buildResumeDryRunPlan(graph: CompiledGraph, session: RuntimeSession): {
  preserved_nodes: ReturnType<typeof summarizeResumeNode>[];
  restarted_nodes: ReturnType<typeof summarizeResumeNode>[];
  start_nodes: ReturnType<typeof summarizeResumeNode>[];
} {
  const nodeSummaries = graph.nodes.map((node) => summarizeResumeNode(node, session));
  const preservedNodes = nodeSummaries.filter((node) => node.status === "passed");
  const restartedNodes = nodeSummaries.filter((node) => node.status !== "passed");

  return {
    preserved_nodes: preservedNodes,
    restarted_nodes: restartedNodes,
    start_nodes: restartedNodes.filter((node) => node.blocked_by.length === 0)
  };
}

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
      ["failed", "canceled", "paused"].includes(entry!.record.status) &&
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
        "No failed, canceled, or paused runs were found for the supplied graph in the resolved runs root.",
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
  summary: "Recompile the original graph for a failed, canceled, paused, or inactive running run root and preserve only unchanged passed work.",
  usage: "agentflow resume (--run-root <path/to/run-root> | --graph <path/to/graph> --latest)",
  examples: [
    "agentflow resume --run-root .task-runtime/runs/<run-id>",
    "agentflow resume --run-root /absolute/path/to/.task-runtime/runs/<run-id>",
    "agentflow resume --graph ./agentflow.graph.json --latest",
    "agentflow resume --run-root .task-runtime/runs/<run-id> --dry-run",
    "agentflow resume --run-root .task-runtime/runs/<run-id> --reset-supervisor-budget"
  ] as const,
  optionNames: [
    "run-root",
    "graph",
    "latest",
    "human-action",
    "human-note",
    "dry-run",
    "reset-supervisor-budget",
    "help"
  ] as const,
  helpNotes: [
    "Resume recompiles from the original graph path using the current Agentflow build.",
    "Only passed nodes whose compiled contract still matches are preserved.",
    "Repeat scopes restart from iteration 1 when they were unfinished or their compiled contract changed.",
    "Pass --graph with --latest to resume the most recent failed, canceled, or paused run discovered under the graph's runs root.",
    "Use --dry-run to preview preserved, restarted, and initially startable nodes without executing the resumed run.",
    "A run recorded as running is resumable only after Agentflow confirms the original run owner is no longer active.",
    "Use --reset-supervisor-budget when resuming a failed/exhausted run after changing the graph or environment so recovery actions can be attempted again.",
    "Paused runs require --human-action approve|fail|add_context|retry_with_guidance|rebuild_context_then_retry, with optional --human-note."
  ] as const,
  async run(
    options: Record<string, string | boolean | string[] | undefined>,
    currentWorkingDirectory: string,
    _signal?: AbortSignal,
    _positionals: readonly string[] = [],
    environment: NodeJS.ProcessEnv = process.env,
    runtimeEnv: Record<string, string> = {}
  ) {
    const runRootInput = typeof options["run-root"] === "string" ? options["run-root"] : undefined;
    const graphInput = typeof options.graph === "string" ? options.graph : undefined;
    const humanAction = typeof options["human-action"] === "string" ? options["human-action"] : undefined;
    const humanNote = typeof options["human-note"] === "string" ? options["human-note"] : undefined;
    const latestRequested = options.latest === true;
    const dryRun = options["dry-run"] === true;
    const resetSupervisorBudget = options["reset-supervisor-budget"] === true;

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

    if (!dryRun) {
      await reconcileRunArtifacts(run_root);
    }

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

    if (!["failed", "canceled", "paused", "running"].includes(runRecord.status)) {
      return {
        exitCode: 1,
        output: {
          command: "resume",
          status: "failed",
          message: `Only failed, canceled, paused, or inactive running runs can be resumed. Current status: ${runRecord.status}.`,
          run_root,
          run_id: runRecord.run_id
        }
      };
    }

    if (runRecord.status === "paused" && !dryRun) {
      const allowedHumanActions = new Set([
        "approve",
        "fail",
        "add_context",
        "retry_with_guidance",
        "rebuild_context_then_retry"
      ]);
      if (!humanAction || !allowedHumanActions.has(humanAction)) {
        return {
          exitCode: 2,
          output: {
            command: "resume",
            status: "failed",
            message: "Paused runs require --human-action approve|fail|add_context|retry_with_guidance|rebuild_context_then_retry.",
            run_root,
            run_id: runRecord.run_id,
            pause: state.supervisor.pause
          }
        };
      }
      const artifactPaths = resolveRunArtifactPaths(run_root);
      await mkdir(`${run_root}/runtime`, { recursive: true });
      await appendFile(
        `${run_root}/runtime/human-resume-input.jsonl`,
        `${JSON.stringify({
          run_id: runRecord.run_id,
          decision_id: state.supervisor.pause?.decision_id,
          action: humanAction,
          ...(humanNote ? { note: humanNote } : {}),
          created_at: new Date().toISOString()
        })}\n`,
        "utf8"
      );
      if (humanAction === "fail") {
        return {
          exitCode: 1,
          output: {
            command: "resume",
            status: "failed",
            message: "Paused run was rejected by structured human input.",
            run_root,
            run_id: runRecord.run_id,
            delivery_package: `${artifactPaths.delivery_dir}/manifest.json`,
            review_brief: `${artifactPaths.delivery_dir}/01-review-brief.md`
          }
        };
      }
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
        ...(loaded.resolved_skill_sources ? { resolved_skill_sources: loaded.resolved_skill_sources } : {}),
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
      events,
      reset_supervisor_budget: resetSupervisorBudget
    });

    if (dryRun) {
      const resumePlan = buildResumeDryRunPlan(compiled_graph, session);

      return {
        exitCode: 0,
        output: {
          command: "resume",
          status: "dry_run",
          message: "Resume dry-run completed; no nodes were executed.",
          run_id: runRecord.run_id,
          run_root,
          graph_path: loaded.absolute_path,
          path_resolution: pathResolution,
          resumed_from_status: previous_status,
          preserved_node_count,
          restarted_node_count,
          would_start_node_count: resumePlan.start_nodes.length,
          ...createSupervisorDisplayFields(session),
          intervention_count: session.supervisor.intervention_count,
          supervisor_budget_reset: resetSupervisorBudget,
          supervisor_budget_remaining: session.supervisor.budget_remaining,
          resume_plan: resumePlan,
          next_steps: {
            resume: createResumeCliInvocation(run_root),
            resume_with_budget_reset: `${createResumeCliInvocation(run_root)} --reset-supervisor-budget`
          }
        }
      };
    }

    const workspace = await resumeWorkspaceFromManifest(execution_manifest);

    const progress = createRuntimeProgressReporter(compiled_graph);
    const scriptedCheckpointDecisions =
      runtimeEnv.AGENTFLOW_EVAL_CHECKPOINT_DECISIONS ?? environment.AGENTFLOW_EVAL_CHECKPOINT_DECISIONS;
    const checkpointExecutor = scriptedCheckpointDecisions
      ? createScriptedCheckpointExecutor({
          decisions: parseScriptedCheckpointDecisions(scriptedCheckpointDecisions)
        })
      : createInteractiveCheckpointExecutor();
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
        "codex-cli": createCodexCliHarness(
          environment.AGENTFLOW_CODEX_CLI_BIN ? { binary: environment.AGENTFLOW_CODEX_CLI_BIN } : {}
        ),
        "cursor-cli": createCursorCliHarness(
          environment.AGENTFLOW_CURSOR_CLI_BIN ? { binary: environment.AGENTFLOW_CURSOR_CLI_BIN } : {}
        )
      },
      executors: {
        checkpoint: checkpointExecutor
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
    const deliveryFailed = resumed.state.delivery_status === "failed";
    const message =
      deliveryFailed
        ? "Run resumed to terminal graph state, but curated delivery failed verification."
        : resumed.outcome === "passed"
        ? "Run resumed and completed successfully."
        : resumed.outcome === "canceled"
          ? "Run resumed and was canceled."
          : resumed.outcome === "paused"
            ? "Run resumed and paused for human input."
            : "Run resumed and failed again.";

    return {
      exitCode: resumed.outcome === "passed" && !deliveryFailed ? 0 : 1,
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
        ...createSupervisorDisplayFields(resumed.state),
        intervention_count: resumed.state.supervisor.intervention_count,
        supervisor_budget_reset: resetSupervisorBudget,
        supervisor_budget_remaining: resumed.state.supervisor.budget_remaining,
        delivery_package: `${artifactPaths.delivery_dir}/manifest.json`,
        ...(resumed.state.review_ready || deliveryFailed ? { review_brief: `${artifactPaths.delivery_dir}/01-review-brief.md` } : {}),
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

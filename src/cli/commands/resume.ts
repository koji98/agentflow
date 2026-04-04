import { dirname, resolve } from "node:path";

import { isRecordedRunOwnerActive } from "../../artifacts/owner.js";
import { resolveRunArtifactPaths } from "../../artifacts/paths.js";
import { reconcileRunArtifacts } from "../../artifacts/reconcile.js";
import {
  readAuthoredGraph,
  readCompiledGraph,
  readExecutionManifest,
  readRunEvents,
  readRunExecutionAttempts,
  readRunRecord,
  readRunState
} from "../../artifacts/reader.js";
import { resumeCompiledGraph } from "../../runtime/core/engine.js";
import { createCodexCliHarness } from "../../runtime/harness/codex_cli.js";
import { createCursorCliHarness } from "../../runtime/harness/cursor_cli.js";
import { createResumedRuntimeSession } from "../../runtime/resume.js";
import { resumeWorkspaceFromManifest } from "../../runtime/workspace/resume.js";
import {
  renderCommandUsageError,
  runCancellationText
} from "../command_support.js";
import { createMonitorHandoff } from "../monitor_handoff.js";
import { createRuntimeProgressReporter } from "../progress.js";

export const resumeCommand = {
  name: "resume",
  summary: "Resume a failed or canceled run root, preserving passed work and restarting unfinished work.",
  usage: "agentflow resume --run-root <path/to/run-root>",
  examples: [
    "agentflow resume --run-root .agentflow/runs/<run-id>",
    "agentflow resume --run-root /absolute/path/to/.agentflow/runs/<run-id>"
  ] as const,
  optionNames: ["run-root", "help"] as const,
  helpNotes: [
    "Resume reuses the existing run root and appends new events and attempts.",
    "Passed nodes are preserved. Everything else is restarted.",
    "Repeat scopes that did not pass restart from iteration 1."
  ] as const,
  async run(
    options: Record<string, string | boolean | undefined>,
    currentWorkingDirectory: string
  ) {
    const runRootInput = typeof options["run-root"] === "string" ? options["run-root"] : undefined;

    if (!runRootInput) {
      return {
        exitCode: 2,
        stdout: renderCommandUsageError({
          message: "Missing required option: --run-root",
          commandName: this.name,
          usage: this.usage
        })
      };
    }

    const run_root = resolve(currentWorkingDirectory, runRootInput);
    await reconcileRunArtifacts(run_root);

    const [
      runRecord,
      state,
      compiled_graph,
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

    const repo_sources = Object.fromEntries(
      Object.entries(execution_manifest.repo_workspaces).map(([repoAlias, binding]) => [
        repoAlias,
        binding.source_path
      ])
    );

    const {
      session,
      previous_status,
      preserved_node_count,
      restarted_node_count
    } = createResumedRuntimeSession({
      run_root,
      graph: compiled_graph,
      manifest: execution_manifest,
      prior_state: state,
      attempts,
      events
    });

    const workspace = await resumeWorkspaceFromManifest(execution_manifest);
    const authored_graph = await readAuthoredGraph(run_root).catch(() => undefined);
    const progress = createRuntimeProgressReporter(compiled_graph);
    const resumed = await resumeCompiledGraph({
      on_event: (event) => {
        progress.onEvent(event);
      },
      run_root,
      compiled_graph,
      repo_sources,
      ...(authored_graph ? { authored_graph } : {}),
      compile_diagnostics: [],
      harnesses: {
        "codex-cli": createCodexCliHarness(),
        "cursor-cli": createCursorCliHarness()
      },
      resumed_session: session,
      prior_events: events,
      workspace,
      previous_status,
      preserved_node_count,
      restarted_node_count
    });

    const artifactPaths = resolveRunArtifactPaths(run_root);
    const runsRoot = dirname(run_root);
    const monitor = createMonitorHandoff({
      runsRoot,
      runId: resumed.run_id
    });
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
        resumed_from_status: previous_status,
        preserved_node_count,
        restarted_node_count,
        counts: resumed.state.counts,
        repo_workspaces: resumed.state.repo_workspaces,
        attempt_count: resumed.attempts.length,
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
          dev_monitor: monitor.dev_command
        },
        latest_run_state: resumed.state
      }
    };
  }
};

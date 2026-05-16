import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { resolveRunArtifactPaths } from "../../artifacts/paths.js";
import {
  readRunEvents,
  readRunExecutionAttempts,
  readRunRecord,
  readRunState,
  readTextFileIfPresent,
  type RunRecord
} from "../../artifacts/reader.js";
import { operatorObservationsPath, readOperatorObservations } from "../../runtime/observations/index.js";
import type { RuntimeNodeAttempt } from "../../runtime/attempts.js";
import { createRunTerminalFields } from "../run_output.js";
import { renderCommandUsageError } from "../command_support.js";

const stderrTailMaxBytes = 4_000;
const stderrTailMaxAttempts = 5;

export interface NodeStderrTail {
  authored_id: string;
  compiled_id: string;
  execution_id: string;
  status: RuntimeNodeAttempt["status"];
  attempt_index: number;
  iteration_index?: number;
  iteration_attempt_index?: number;
  stderr_log_path?: string;
  stderr_tail?: string;
  truncated?: boolean;
}

function renderInspectUsageError(message: string): string {
  return renderCommandUsageError({
    message,
    commandName: inspectCommand.name,
    usage: inspectCommand.usage
  });
}

async function readStderrTail(filePath: string): Promise<{ stderr_tail: string; truncated: boolean }> {
  const contents = (await readTextFileIfPresent(filePath)) ?? "";

  if (contents.length <= stderrTailMaxBytes) {
    return { stderr_tail: contents, truncated: false };
  }

  return {
    stderr_tail: contents.slice(-stderrTailMaxBytes),
    truncated: true
  };
}

async function summarizeFailedNodes(attempts: RuntimeNodeAttempt[]): Promise<NodeStderrTail[]> {
  const failed = attempts
    .filter((attempt) => attempt.status === "failed")
    .slice(-stderrTailMaxAttempts);

  return Promise.all(
    failed.map(async (attempt) => {
      const summary: NodeStderrTail = {
        authored_id: attempt.authored_id,
        compiled_id: attempt.compiled_id,
        execution_id: attempt.execution_id,
        status: attempt.status,
        attempt_index: attempt.attempt_index,
        ...(attempt.iteration_index !== undefined ? { iteration_index: attempt.iteration_index } : {}),
        ...(attempt.iteration_attempt_index !== undefined
          ? { iteration_attempt_index: attempt.iteration_attempt_index }
          : {})
      };

      if (attempt.stderr_log_path) {
        summary.stderr_log_path = attempt.stderr_log_path;
        const tail = await readStderrTail(attempt.stderr_log_path);
        if (tail.stderr_tail.length > 0) {
          summary.stderr_tail = tail.stderr_tail;
          if (tail.truncated) {
            summary.truncated = true;
          }
        }
      }

      return summary;
    })
  );
}

async function readDeliveryTaxonomySummary(manifestPath: string): Promise<Record<string, number> | undefined> {
  const contents = await readTextFileIfPresent(manifestPath);
  if (!contents) {
    return undefined;
  }

  try {
    const manifest = JSON.parse(contents) as {
      artifact_taxonomy?: Record<string, unknown[]>;
    };
    const taxonomy = manifest.artifact_taxonomy;
    if (!taxonomy) {
      return undefined;
    }

    return Object.fromEntries(
      Object.entries(taxonomy).map(([category, entries]) => [
        category,
        Array.isArray(entries) ? entries.length : 0
      ])
    );
  } catch {
    return undefined;
  }
}

async function countJsonlRecords(filePath: string): Promise<number> {
  const contents = await readTextFileIfPresent(filePath);
  return contents
    ? contents.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length
    : 0;
}

export const inspectCommand = {
  name: "inspect",
  summary: "Inspect a recorded run root and surface terminal status, counts, and failure stderr tails.",
  usage: "agentflow inspect <run-root>",
  examples: [
    "agentflow inspect .agentflow/runs/<run-id>",
    "agentflow inspect /absolute/path/to/.agentflow/runs/<run-id>"
  ] as const,
  optionNames: ["help"] as const,
  helpNotes: [
    "Reads run.json, state.json, attempts, and event logs from the supplied run root.",
    "Prints stderr tails for the most recent failed node attempts to speed up local debugging."
  ] as const,
  async run(
    options: Record<string, string | boolean | string[] | undefined>,
    currentWorkingDirectory: string,
    _signal?: AbortSignal,
    positionals: readonly string[] = []
  ) {
    const runRootInput = positionals[0];

    if (!runRootInput || positionals.length > 1) {
      return {
        exitCode: 2,
        stdout: renderInspectUsageError(
          runRootInput
            ? `Unexpected positional arguments: ${positionals.slice(1).join(", ")}`
            : "Missing required positional argument: <run-root>"
        )
      };
    }

    const runRoot = resolve(currentWorkingDirectory, runRootInput);

    try {
      const entry = await stat(runRoot);
      if (!entry.isDirectory()) {
        return {
          exitCode: 1,
          output: {
            command: "inspect",
            status: "failed",
            message: "Run root exists but is not a directory.",
            run_root: runRoot
          }
        };
      }
    } catch (error) {
      return {
        exitCode: 1,
        output: {
          command: "inspect",
          status: "failed",
          message:
            error instanceof Error
              ? `Run root could not be resolved: ${error.message}`
              : "Run root could not be resolved.",
          run_root: runRoot
        }
      };
    }

    let record: RunRecord;
    try {
      record = await readRunRecord(runRoot);
    } catch (error) {
      return {
        exitCode: 1,
        output: {
          command: "inspect",
          status: "failed",
          message:
            error instanceof Error
              ? `run.json could not be read: ${error.message}`
              : "run.json could not be read.",
          run_root: runRoot
        }
      };
    }

    const artifactPaths = resolveRunArtifactPaths(runRoot);
    const [state, attempts, events] = await Promise.all([
      readRunState(runRoot).catch(() => undefined),
      readRunExecutionAttempts(runRoot).catch(() => [] as RuntimeNodeAttempt[]),
      readRunEvents(runRoot).catch(() => [])
    ]);
    const deliveryManifestPath = `${artifactPaths.delivery_dir}/manifest.json`;
    const [deliveryTaxonomySummary, supervisorTimelineCount, runtimeLogCount, operatorObservations] = await Promise.all([
      readDeliveryTaxonomySummary(deliveryManifestPath),
      countJsonlRecords(artifactPaths.supervisor_timeline_file),
      countJsonlRecords(artifactPaths.runtime_log_file),
      readOperatorObservations(runRoot)
    ]);

    const failedNodeStderrTails = await summarizeFailedNodes(attempts);
    const terminalFields = state
      ? createRunTerminalFields(state, attempts, events)
      : undefined;

    return {
      exitCode: 0,
      output: {
        command: "inspect",
        status: "passed",
        run_root: runRoot,
        run_id: record.run_id,
        graph_id: record.graph_id,
        ...(record.graph_path ? { graph_path: record.graph_path } : {}),
        launch_profile: record.launch_profile,
        workspace_backend: record.workspace_backend,
        run_status: record.status,
        started_at: record.started_at,
        ...(record.ended_at ? { ended_at: record.ended_at } : {}),
        ...(state
          ? {
              counts: state.counts,
              evidence_status: state.evidence_status,
              supervisor_status: state.supervisor.status,
              supervisor_pause: state.supervisor.pause,
              supervisor_timeline_count: supervisorTimelineCount,
              runtime_log_count: runtimeLogCount,
              operator_observation_count: operatorObservations.length,
              active_operator_observation_count: operatorObservations.filter((entry) => entry.status === "active").length,
              blocking_operator_observation_count: operatorObservations.filter((entry) =>
                entry.status === "active" && (entry.kind === "blocker" || entry.blocking === true)
              ).length,
              operator_observations: operatorObservations,
              intervention_count: state.supervisor.intervention_count,
              supervisor_budget_remaining: state.supervisor.budget_remaining,
              delivery_package: deliveryManifestPath,
              review_brief: `${artifactPaths.delivery_dir}/01-review-brief.md`,
              ...(deliveryTaxonomySummary
                ? { delivery_artifact_taxonomy: deliveryTaxonomySummary }
                : {}),
              soft_verification_counts: state.soft_verification_counts,
              repo_workspaces: state.repo_workspaces,
              workspace_change_artifacts: state.workspace_change_artifacts
            }
          : {}),
        ...(terminalFields ?? {}),
        attempt_count: attempts.length,
        event_count: events.length,
        failed_node_count: attempts.filter((attempt) => attempt.status === "failed").length,
        failed_node_stderr_tails: failedNodeStderrTails,
        artifacts: {
          run_file: artifactPaths.run_file,
          authored_graph_file: artifactPaths.authored_graph_file,
          compiled_graph_file: artifactPaths.compiled_graph_file,
          execution_manifest_file: artifactPaths.execution_manifest_file,
          compile_diagnostics_file: artifactPaths.compile_diagnostics_file,
          state_file: artifactPaths.state_file,
          events_file: artifactPaths.events_file,
          supervisor_timeline_file: artifactPaths.supervisor_timeline_file,
          runtime_log_file: artifactPaths.runtime_log_file,
          operator_observations_file: operatorObservationsPath(runRoot),
          interventions_file: artifactPaths.interventions_file,
          summary_file: artifactPaths.summary_file,
          delivery_dir: artifactPaths.delivery_dir,
          workspaces_dir: artifactPaths.workspaces_dir,
          workspace_changes_dir: artifactPaths.workspace_changes_dir,
          nodes_dir: artifactPaths.nodes_dir
        }
      }
    };
  }
};

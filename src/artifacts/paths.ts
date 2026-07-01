import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

import { taskRuntimeDirectoryName } from "../generated_state.js";

export const runsRootEnvironmentVariable = "AGENTFLOW_RUNS_ROOT";
const maxPathSegmentLength = 120;

export interface RunsRootOptions {
  currentWorkingDirectory: string;
  graphDirectory?: string;
  runsRoot?: string;
  environment?: NodeJS.ProcessEnv;
}

export interface RunRootOptions {
  currentWorkingDirectory: string;
  graphDirectory?: string;
  graphId: string;
  runLabel?: string;
  runsRoot?: string;
  environment?: NodeJS.ProcessEnv;
}

export interface NodeArtifactDirectoryOptions {
  nodeIndex?: number;
  nodeCount?: number;
  label?: string;
}

export interface ExecutionDirectoryOptions extends NodeArtifactDirectoryOptions {
  attemptIndex?: number;
  iterationIndex?: number;
  iterationAttemptIndex?: number;
}

function sanitizePathSegment(value: string): string {
  const sanitized =
    value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "graph";

  if (sanitized.length <= maxPathSegmentLength) {
    return sanitized;
  }

  const hash = createHash("sha1").update(sanitized).digest("hex").slice(0, 12);
  const prefixLength = Math.max(1, maxPathSegmentLength - hash.length - 1);
  const prefix = sanitized.slice(0, prefixLength).replace(/-+$/g, "") || "graph";
  return `${prefix}-${hash}`;
}

function hashPathSegment(value: string, prefix: string): string {
  const normalized = value.trim() || prefix;
  const hash = createHash("sha1").update(normalized).digest("hex").slice(0, 16);
  return `${prefix}-${hash}`;
}

function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function formatNodeIndexPrefix(options: NodeArtifactDirectoryOptions): string | undefined {
  if (options.nodeIndex === undefined) {
    return undefined;
  }

  const nodeCount = Math.max(options.nodeCount ?? 0, options.nodeIndex + 1);
  const width = Math.max(3, String(nodeCount).length);
  return String(options.nodeIndex + 1).padStart(width, "0");
}

function formatExecutionOrdinal(value: number): string {
  return String(value).padStart(3, "0");
}

function combineBoundedPathSegment(prefix: string, label: string, suffix: string): string {
  const availableLabelLength = maxPathSegmentLength - prefix.length - suffix.length;

  if (availableLabelLength <= 0) {
    return `${prefix}${suffix}`.slice(0, maxPathSegmentLength);
  }

  if (label.length <= availableLabelLength) {
    return `${prefix}${label}${suffix}`;
  }

  const hash = shortHash(label);
  const trimmedLength = Math.max(1, availableLabelLength - hash.length - 1);
  const trimmed = label.slice(0, trimmedLength).replace(/-+$/g, "") || "node";
  return `${prefix}${trimmed}-${hash}${suffix}`;
}

export function resolveNodeArtifactDirectoryName(
  compiledId: string,
  options: NodeArtifactDirectoryOptions = {}
): string {
  const orderPrefix = formatNodeIndexPrefix(options);

  if (orderPrefix) {
    const label = sanitizePathSegment(options.label ?? compiledId);
    return combineBoundedPathSegment(`${orderPrefix}-`, label, `-${shortHash(compiledId)}`);
  }

  return hashPathSegment(compiledId, "node");
}

export function resolveExecutionDirectoryName(
  executionId: string,
  options: Pick<ExecutionDirectoryOptions, "attemptIndex" | "iterationIndex" | "iterationAttemptIndex"> = {}
): string {
  const hashSegment = hashPathSegment(executionId, "exec");

  if (options.iterationIndex !== undefined) {
    const attemptIndex = options.iterationAttemptIndex ?? options.attemptIndex;

    if (attemptIndex !== undefined) {
      return `i${formatExecutionOrdinal(options.iterationIndex)}-a${formatExecutionOrdinal(attemptIndex)}-${hashSegment}`;
    }
  }

  if (options.attemptIndex !== undefined) {
    return `${formatExecutionOrdinal(options.attemptIndex)}-${hashSegment}`;
  }

  return hashSegment;
}

function normalizeConfiguredRunsRoot(value: string, source: "runsRoot" | "environment"): string {
  if (!isAbsolute(value)) {
    throw new Error(
      source === "environment"
        ? `${runsRootEnvironmentVariable} must be an absolute path when set. Received: ${value}`
        : `runsRoot must be an absolute path when provided. Received: ${value}`
    );
  }

  return resolve(value);
}

function readConfiguredRunsRoot(options: RunsRootOptions): string | undefined {
  const explicitRunsRoot = options.runsRoot?.trim();

  if (explicitRunsRoot) {
    return normalizeConfiguredRunsRoot(explicitRunsRoot, "runsRoot");
  }

  const environmentRunsRoot = options.environment?.[runsRootEnvironmentVariable]?.trim();
  return environmentRunsRoot
    ? normalizeConfiguredRunsRoot(environmentRunsRoot, "environment")
    : undefined;
}

export function resolveLaunchWorkingDirectory(options: {
  currentWorkingDirectory?: string;
  environment?: NodeJS.ProcessEnv;
} = {}): string {
  if (options.currentWorkingDirectory) {
    return resolve(options.currentWorkingDirectory);
  }

  const launchWorkingDirectory = options.environment?.INIT_CWD?.trim();

  return resolve(launchWorkingDirectory || process.cwd());
}

export function resolveRunsRoot(options: RunsRootOptions): string {
  const configuredRunsRoot = readConfiguredRunsRoot(options);

  if (configuredRunsRoot) {
    return configuredRunsRoot;
  }

  const baseDirectory = options.graphDirectory ?? options.currentWorkingDirectory;
  return resolve(baseDirectory, taskRuntimeDirectoryName, "runs");
}

export function createRunRootPath(options: RunRootOptions): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const graphSegment = sanitizePathSegment(options.graphId);
  const labelSegment = options.runLabel ? `-${sanitizePathSegment(options.runLabel)}` : "";
  const runSegment = sanitizePathSegment(`${timestamp}-${graphSegment}${labelSegment}`);

  return resolve(
    resolveRunsRoot({
      currentWorkingDirectory: options.currentWorkingDirectory,
      ...(options.graphDirectory ? { graphDirectory: options.graphDirectory } : {}),
      ...(options.runsRoot ? { runsRoot: options.runsRoot } : {}),
      ...(options.environment ? { environment: options.environment } : {})
    }),
    runSegment
  );
}

export interface RunArtifactPaths {
  run_root: string;
  run_file: string;
  authored_graph_file: string;
  compiled_graph_file: string;
  execution_manifest_file: string;
  compile_diagnostics_file: string;
  state_file: string;
  events_file: string;
  runtime_log_file: string;
  supervisor_timeline_file: string;
  interventions_file: string;
  summary_file: string;
  delivery_dir: string;
  workspaces_dir: string;
  workspace_changes_dir: string;
  nodes_dir: string;
}

export function resolveRunArtifactPaths(runRoot: string): RunArtifactPaths {
  return {
    run_root: runRoot,
    run_file: join(runRoot, "run.json"),
    authored_graph_file: join(runRoot, "authored_graph.json"),
    compiled_graph_file: join(runRoot, "compiled_graph.json"),
    execution_manifest_file: join(runRoot, "execution_manifest.json"),
    compile_diagnostics_file: join(runRoot, "compile_diagnostics.json"),
    state_file: join(runRoot, "state.json"),
    events_file: join(runRoot, "events.jsonl"),
    runtime_log_file: join(runRoot, "runtime", "log.jsonl"),
    supervisor_timeline_file: join(runRoot, "supervisor-timeline.jsonl"),
    interventions_file: join(runRoot, "interventions.jsonl"),
    summary_file: join(runRoot, "summary.md"),
    delivery_dir: join(runRoot, "delivery"),
    workspaces_dir: join(runRoot, "workspaces"),
    workspace_changes_dir: join(runRoot, "workspace-changes"),
    nodes_dir: join(runRoot, "nodes")
  };
}

export function resolveNodeExecutionDirectory(
  runRoot: string,
  compiledId: string,
  executionId: string,
  options: ExecutionDirectoryOptions = {}
): string {
  return join(
    resolveNodeArtifactDirectory(runRoot, compiledId, options),
    "executions",
    resolveExecutionDirectoryName(executionId, options)
  );
}

export function resolveExecutionArtifactsDirectory(executionDir: string): string {
  return join(executionDir, "artifacts");
}

export function resolveExecutionAgentDirectory(executionDir: string): string {
  return join(executionDir, "agent");
}

export function resolveExecutionAgentPromptPath(executionDir: string): string {
  return join(resolveExecutionAgentDirectory(executionDir), "prompt.md");
}

export function resolveExecutionAgentContextPath(executionDir: string): string {
  return join(resolveExecutionAgentDirectory(executionDir), "context.md");
}

export function resolveExecutionAgentResponsePath(executionDir: string): string {
  return join(resolveExecutionAgentDirectory(executionDir), "response.md");
}

export function resolveExecutionAgentAttemptMemoryPath(executionDir: string): string {
  return join(resolveExecutionAgentDirectory(executionDir), "attempt-memory.md");
}

export function resolveExecutionAgentRecoveryBriefPath(executionDir: string): string {
  return join(resolveExecutionAgentDirectory(executionDir), "supervisor-recovery.md");
}

export function resolveExecutionAgentArtifactRepairBriefPath(executionDir: string): string {
  return join(resolveExecutionAgentDirectory(executionDir), "artifact-repair.md");
}

export function resolveExecutionRuntimeDirectory(executionDir: string): string {
  return join(executionDir, "runtime");
}

export function resolveExecutionRuntimeResultPath(executionDir: string): string {
  return join(resolveExecutionRuntimeDirectory(executionDir), "result.json");
}

export function resolveExecutionRuntimeCompletionPacketPath(executionDir: string): string {
  return join(resolveExecutionRuntimeDirectory(executionDir), "completion-packet.json");
}

export function resolveExecutionRuntimeAttemptMemoryPath(executionDir: string): string {
  return join(resolveExecutionRuntimeDirectory(executionDir), "attempt-memory.json");
}

export function resolveExecutionRuntimeContextPath(executionDir: string): string {
  return join(resolveExecutionRuntimeDirectory(executionDir), "context.json");
}

export function resolveExecutionRuntimeVerifierPath(executionDir: string): string {
  return join(resolveExecutionRuntimeDirectory(executionDir), "verifier.json");
}

export function resolveExecutionRuntimeSupervisorDirectory(executionDir: string): string {
  return join(resolveExecutionRuntimeDirectory(executionDir), "supervisor");
}

export function resolveExecutionRuntimeToolDirectory(executionDir: string): string {
  return join(resolveExecutionRuntimeDirectory(executionDir), "tools");
}

export function resolveExecutionHumanDebugDirectory(executionDir: string): string {
  return join(executionDir, "human-debug");
}

export function resolveExecutionHumanDebugHarnessDirectory(executionDir: string): string {
  return join(resolveExecutionHumanDebugDirectory(executionDir), "harness");
}

export function resolveExecutionHumanDebugToolDirectory(executionDir: string): string {
  return join(resolveExecutionHumanDebugDirectory(executionDir), "tools");
}

export function resolveExecutionHumanDebugVerifierDirectory(executionDir: string): string {
  return join(resolveExecutionHumanDebugDirectory(executionDir), "verifier");
}

export function resolveExecutionHumanDebugWorkspaceDirectory(executionDir: string): string {
  return join(resolveExecutionHumanDebugDirectory(executionDir), "workspace");
}

export function resolveInterventionDirectoryName(interventionId: string): string {
  return hashPathSegment(interventionId, "intervention");
}

export function resolveInterventionDirectory(executionDir: string, interventionId: string): string {
  return join(resolveExecutionHumanDebugDirectory(executionDir), "interventions", resolveInterventionDirectoryName(interventionId));
}

export function resolveNodeArtifactDirectory(
  runRoot: string,
  compiledId: string,
  options: NodeArtifactDirectoryOptions = {}
): string {
  return join(resolveRunArtifactPaths(runRoot).nodes_dir, resolveNodeArtifactDirectoryName(compiledId, options));
}

import { isAbsolute, join, resolve } from "node:path";

export const runsRootEnvironmentVariable = "AGENTFLOW_RUNS_ROOT";

export interface RunsRootOptions {
  currentWorkingDirectory: string;
  runsRoot?: string;
  environment?: NodeJS.ProcessEnv;
}

export interface RunRootOptions {
  currentWorkingDirectory: string;
  graphId: string;
  runLabel?: string;
  runsRoot?: string;
  environment?: NodeJS.ProcessEnv;
}

function sanitizePathSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "graph";
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

  return configuredRunsRoot
    ? configuredRunsRoot
    : resolve(options.currentWorkingDirectory, ".agentflow", "runs");
}

export function createRunRootPath(options: RunRootOptions): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const graphSegment = sanitizePathSegment(options.graphId);
  const labelSegment = options.runLabel ? `-${sanitizePathSegment(options.runLabel)}` : "";

  return resolve(
    resolveRunsRoot({
      currentWorkingDirectory: options.currentWorkingDirectory,
      ...(options.runsRoot ? { runsRoot: options.runsRoot } : {}),
      ...(options.environment ? { environment: options.environment } : {})
    }),
    `${timestamp}-${graphSegment}${labelSegment}`
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
  summary_file: string;
  repos_dir: string;
  workspaces_dir: string;
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
    summary_file: join(runRoot, "summary.md"),
    repos_dir: join(runRoot, "repos"),
    workspaces_dir: join(runRoot, "workspaces"),
    nodes_dir: join(runRoot, "nodes")
  };
}

export function resolveRepoManifestPath(runRoot: string, repoAlias: string): string {
  return join(resolveRunArtifactPaths(runRoot).repos_dir, `${sanitizePathSegment(repoAlias)}.json`);
}

export function resolveNodeExecutionDirectory(
  runRoot: string,
  compiledId: string,
  executionId: string
): string {
  return join(
    resolveRunArtifactPaths(runRoot).nodes_dir,
    sanitizePathSegment(compiledId),
    "executions",
    sanitizePathSegment(executionId)
  );
}

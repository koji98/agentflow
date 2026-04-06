import { dirname, resolve } from "node:path";

import {
  resolveRunsRoot,
  runsRootEnvironmentVariable
} from "../artifacts/paths.js";
import type { LaunchResolution } from "../graph/profiles.js";

export const graphPathRuleText =
  "--graph resolves relative to the launch shell current working directory.";
export const repoPathRuleText =
  "Repo paths in $.repos.*.path resolve relative to the graph file directory.";
export const runsRootContractText =
  `CLI commands resolve runs roots from an absolute ${runsRootEnvironmentVariable} when set; otherwise they default to <launch-cwd>/.agentflow/runs.`;
export const runCancellationText =
  "Press Ctrl-C in the terminal running agentflow run to cancel. The runtime waits for cleanup and durable artifacts capture the terminal Canceled state.";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function renderCommandUsageError(options: {
  message: string;
  commandName: string;
  usage: string;
  includeGraphHelp?: boolean;
}): string {
  return [
    options.message,
    "",
    `Usage: ${options.usage}`,
    `Try: agentflow ${options.commandName} --help`,
    ...(options.includeGraphHelp ? ["Graph contract: agentflow graph-help"] : [])
  ].join("\n");
}

export function createGraphPathResolution(
  currentWorkingDirectory: string,
  graphPath: string,
  absoluteGraphPath = resolve(currentWorkingDirectory, graphPath)
) {
  return {
    launch_cwd: resolve(currentWorkingDirectory),
    graph_path_input: graphPath,
    graph_path: absoluteGraphPath,
    graph_directory: dirname(absoluteGraphPath),
    rules: {
      graph_path: graphPathRuleText,
      repo_paths: repoPathRuleText
    }
  };
}

export function createRunsRootDetails(
  currentWorkingDirectory: string,
  environment: NodeJS.ProcessEnv
) {
  const configuredRunsRoot = environment[runsRootEnvironmentVariable]?.trim();
  const resolvedRunsRoot = resolveRunsRoot({
    currentWorkingDirectory,
    environment
  });

  return {
    runs_root: resolvedRunsRoot,
    runs_root_env: runsRootEnvironmentVariable,
    runs_root_source: configuredRunsRoot ? "environment" : "launch-cwd-default",
    ...(configuredRunsRoot ? { runs_root_input: configuredRunsRoot } : {}),
    default_runs_root: resolve(currentWorkingDirectory, ".agentflow", "runs"),
    contract: runsRootContractText
  };
}

export function createGraphCliInvocation(
  commandName: "validate" | "compile" | "run",
  options: {
    graphPath: string;
    launch?: LaunchResolution;
    label?: string;
  }
): string {
  const args = [
    "agentflow",
    commandName,
    "--graph",
    shellQuote(options.graphPath)
  ];

  if (options.launch?.launch_profile) {
    args.push("--profile", shellQuote(options.launch.launch_profile));
  }

  if (options.launch?.workspace_backend) {
    args.push("--workspace-backend", shellQuote(options.launch.workspace_backend));
  }

  if (options.label) {
    args.push("--label", shellQuote(options.label));
  }

  return args.join(" ");
}

export function createResumeCliInvocation(runRoot: string): string {
  return ["agentflow", "resume", "--run-root", shellQuote(runRoot)].join(" ");
}

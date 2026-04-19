import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  resolveRunsRoot,
  runsRootEnvironmentVariable
} from "../artifacts/paths.js";
import {
  mergeConfig,
  parseConfigOverridesFromCli,
  type GraphConfig
} from "../graph/config.js";
import type { GraphDiagnostic } from "../graph/schema.js";

export const graphPathRuleText =
  "--graph resolves relative to the launch shell current working directory.";
export const repoPathRuleText =
  "Repo paths in $.repos.*.path resolve relative to the graph file directory.";
export const runsRootContractText =
  `CLI commands resolve runs roots from an absolute ${runsRootEnvironmentVariable} when set; otherwise they default to <graph-directory>/.agentflow/runs (falling back to <launch-cwd>/.agentflow/runs when the graph directory is unavailable).`;
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
  environment: NodeJS.ProcessEnv,
  graphDirectory?: string,
  explicitRunsRoot?: string
) {
  const configuredRunsRoot = environment[runsRootEnvironmentVariable]?.trim();
  const resolvedRunsRoot = resolveRunsRoot({
    currentWorkingDirectory,
    ...(graphDirectory ? { graphDirectory } : {}),
    ...(explicitRunsRoot ? { runsRoot: explicitRunsRoot } : {}),
    environment
  });

  const defaultBaseDirectory = graphDirectory ?? currentWorkingDirectory;
  const runsRootSource = explicitRunsRoot
    ? "explicit"
    : configuredRunsRoot
      ? "environment"
      : graphDirectory
        ? "graph-directory-default"
        : "launch-cwd-default";

  return {
    runs_root: resolvedRunsRoot,
    runs_root_env: runsRootEnvironmentVariable,
    runs_root_source: runsRootSource,
    ...(explicitRunsRoot ? { runs_root_input: explicitRunsRoot } : configuredRunsRoot ? { runs_root_input: configuredRunsRoot } : {}),
    default_runs_root: resolve(defaultBaseDirectory, ".agentflow", "runs"),
    contract: runsRootContractText
  };
}

export function createGraphCliInvocation(
  commandName: "validate" | "run",
  options: {
    graphPath: string;
    label?: string;
  }
): string {
  const args = [
    "agentflow",
    commandName,
    "--graph",
    shellQuote(options.graphPath)
  ];

  if (options.label) {
    args.push("--label", shellQuote(options.label));
  }

  return args.join(" ");
}

export function createResumeCliInvocation(runRoot: string): string {
  return ["agentflow", "resume", "--run-root", shellQuote(runRoot)].join(" ");
}

export interface CollectGraphConfigOverridesResult {
  config_overrides?: GraphConfig;
  diagnostics: GraphDiagnostic[];
}

export async function collectGraphConfigOverrides(
  options: Record<string, string | boolean | string[] | undefined>,
  currentWorkingDirectory: string
): Promise<CollectGraphConfigOverridesResult> {
  const diagnostics: GraphDiagnostic[] = [];
  const fileEntry = options["config-file"];
  let fromFile: GraphConfig = {};

  if (typeof fileEntry === "string") {
    const absolutePath = resolve(currentWorkingDirectory, fileEntry);
    try {
      const contents = await readFile(absolutePath, "utf8");
      const parsed = JSON.parse(contents) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        diagnostics.push({
          path: "--config-file",
          message: `--config-file ${fileEntry} must contain a JSON object.`
        });
      } else {
        fromFile = parsed as GraphConfig;
      }
    } catch (error) {
      diagnostics.push({
        path: "--config-file",
        message: `--config-file ${fileEntry} could not be loaded: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  } else if (fileEntry === true) {
    diagnostics.push({
      path: "--config-file",
      message: "--config-file requires a path argument."
    });
  }

  const cliEntry = options.config;
  let cliEntries: string[] = [];

  if (typeof cliEntry === "string") {
    cliEntries = [cliEntry];
  } else if (Array.isArray(cliEntry)) {
    cliEntries = cliEntry;
  } else if (cliEntry === true) {
    diagnostics.push({
      path: "--config",
      message: "--config requires a key=value argument."
    });
  }

  const cliParsed = parseConfigOverridesFromCli(cliEntries);
  diagnostics.push(...cliParsed.diagnostics);

  if (Object.keys(fromFile).length === 0 && Object.keys(cliParsed.config).length === 0) {
    return { diagnostics };
  }

  const merged = mergeConfig(fromFile, cliParsed.config);
  return { config_overrides: merged, diagnostics };
}

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  resolveRunsRoot,
  runsRootEnvironmentVariable
} from "../../artifacts/paths.js";
import { compileAuthoredGraph } from "../../graph/compile.js";
import { resolveLaunchConfig } from "../../graph/profiles.js";
import { workspaceBackends } from "../../graph/schema.js";
import { loadAuthoredGraphDocument, summarizeAuthoredGraph } from "../../graph/validate.js";
import {
  createMonitorHandoff,
  defaultUiApiOrigin,
  defaultUiBaseUrl
} from "../monitor_handoff.js";
import {
  createGraphCliInvocation,
  createGraphPathResolution,
  createRunsRootDetails
} from "../command_support.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const webAppRoot = resolve(packageRoot, "web-app");

export const uiCommand = {
  name: "ui",
  summary: "Prepare the graph-native launchpad or inspect a specific graph for UI preload.",
  usage:
    "agentflow ui [--graph <path/to/agentflow.graph.json>] [--profile <launch_profile>] [--workspace-backend <inplace|worktree>]",
  examples: [
    "agentflow ui",
    "agentflow ui --graph ./agentflow.graph.json"
  ] as const,
  optionNames: ["graph", "profile", "workspace-backend", "help"] as const,
  helpNotes: [
    "The web monitor reads one runs root: an absolute AGENTFLOW_RUNS_ROOT when set, otherwise <launch-cwd>/.agentflow/runs.",
    "Reuse the emitted AGENTFLOW_RUNS_ROOT value from a run handoff when the CLI and web monitor start from different working directories.",
    "When --graph is set, the CLI resolves the graph path from the launch shell and the graph resolves repo paths from its own directory."
  ] as const,
  async run(options: Record<string, string | boolean | undefined>, currentWorkingDirectory: string) {
    const graphPath = typeof options.graph === "string" ? options.graph : undefined;
    const runsRoot = resolveRunsRoot({
      currentWorkingDirectory,
      environment: process.env
    });
    const runsRootDetails = createRunsRootDetails(currentWorkingDirectory, process.env);
    const monitor = createMonitorHandoff({
      runsRoot
    });

    if (!graphPath) {
      return {
        exitCode: 0,
        output: {
          command: "ui",
          status: "ready",
          message:
            "UI handoff is ready. Start the launchpad or dev server against this runs root, then choose a graph to validate, compile, inspect, or monitor.",
          package_root: packageRoot,
          web_app_root: webAppRoot,
          runs_root: runsRoot,
          runs_root_env: runsRootEnvironmentVariable,
          runs_root_source: runsRootDetails.runs_root_source,
          ...(runsRootDetails.runs_root_input
            ? { runs_root_input: runsRootDetails.runs_root_input }
            : {}),
          default_runs_root: runsRootDetails.default_runs_root,
          runs_root_contract: runsRootDetails.contract,
          start_command: monitor.start_command,
          dev_command: monitor.dev_command,
          launchpad_url: monitor.launchpad_url,
          inspect_route: monitor.inspect_route,
          monitor_route: monitor.monitor_route,
          dev_note:
            `Development mode serves the client at ${defaultUiBaseUrl}/ and proxies /api plus /health to ${defaultUiApiOrigin}.`,
          runs_root_note:
            `${monitor.contract} Reuse the emitted ${runsRootEnvironmentVariable} value when the CLI and web monitor start from different working directories.`,
          note: "Pass --graph to resolve launch defaults and preload graph inspection metadata.",
          next_steps: {
            graph_help: "agentflow graph-help",
            validate: "agentflow validate --graph ./agentflow.graph.json",
            compile: "agentflow compile --graph ./agentflow.graph.json",
            run: "agentflow run --graph ./agentflow.graph.json"
          }
        }
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
          command: "ui",
          status: "failed",
          message: "Graph could not be loaded or normalized from --graph.",
          graph_path: loaded.absolute_path,
          path_resolution: pathResolution,
          next_steps: {
            graph_help: "agentflow graph-help"
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
          command: "ui",
          status: "failed",
          message: "Launch settings could not be resolved for UI preload.",
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
          command: "ui",
          status: "failed",
          message: "Graph compilation returned diagnostics before UI preload could be prepared.",
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
          diagnostics: compilation.diagnostics,
          ...(compilation.compiled_graph ? { compiled_graph: compilation.compiled_graph } : {})
        }
      };
    }

    return {
      exitCode: 0,
      output: {
        command: "ui",
        status: "ready",
        message:
          "UI preload is ready. Start the launchpad or dev server against this runs root, then open the inspect route or a historical run route.",
        graph_path: loaded.absolute_path,
        path_resolution: pathResolution,
        runs_root: runsRoot,
        runs_root_env: runsRootEnvironmentVariable,
        runs_root_source: runsRootDetails.runs_root_source,
        ...(runsRootDetails.runs_root_input
          ? { runs_root_input: runsRootDetails.runs_root_input }
          : {}),
        default_runs_root: runsRootDetails.default_runs_root,
        runs_root_contract: runsRootDetails.contract,
        authored_summary: summarizeAuthoredGraph(loaded.document),
        launch,
        package_root: packageRoot,
        web_app_root: webAppRoot,
        start_command: monitor.start_command,
        dev_command: monitor.dev_command,
        launchpad_url: monitor.launchpad_url,
        inspect_url: `${defaultUiBaseUrl}/graphs/inspect?path=${encodeURIComponent(loaded.absolute_path)}&compiled=1`,
        inspect_route: monitor.inspect_route,
        monitor_route: monitor.monitor_route,
        dev_note:
          `Development mode serves the client at ${defaultUiBaseUrl}/ and proxies /api plus /health to ${defaultUiApiOrigin}.`,
        runs_root_note:
          `${monitor.contract} Reuse the emitted ${runsRootEnvironmentVariable} value when the CLI and web monitor start from different working directories.`,
        preload: {
          graph_id: loaded.document.graph_id,
          launch_profile: launch.launch_profile,
          workspace_backend: launch.workspace_backend,
          compiled_node_count: compilation.compiled_graph!.nodes.length,
          compiled_edge_count: compilation.compiled_graph!.edges.length,
          scope_count: compilation.compiled_graph!.scopes.length
        },
        next_steps: {
          open_launchpad: monitor.launchpad_url,
          open_inspect: `${defaultUiBaseUrl}/graphs/inspect?path=${encodeURIComponent(loaded.absolute_path)}&compiled=1`,
          start_monitor: monitor.start_command,
          dev_monitor: monitor.dev_command,
          validate: createGraphCliInvocation("validate", {
            graphPath: loaded.absolute_path,
            launch
          }),
          compile: createGraphCliInvocation("compile", {
            graphPath: loaded.absolute_path,
            launch
          }),
          run: createGraphCliInvocation("run", {
            graphPath: loaded.absolute_path,
            launch
          })
        }
      }
    };
  }
};

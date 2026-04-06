import { compileAuthoredGraph } from "../../graph/compile.js";
import { resolveLaunchConfig } from "../../graph/profiles.js";
import { workspaceBackends } from "../../graph/schema.js";
import { loadAuthoredGraphDocument, summarizeAuthoredGraph } from "../../graph/validate.js";
import {
  createGraphCliInvocation,
  createGraphPathResolution,
  renderCommandUsageError
} from "../command_support.js";

export const validateCommand = {
  name: "validate",
  summary: "Validate and compile an authored graph without launching a run.",
  usage:
    "agentflow validate --graph <path/to/agentflow.graph.json> [--profile <launch_profile>] [--workspace-backend <inplace|worktree>]",
  examples: [
    "agentflow validate --graph ./agentflow.graph.json",
    "agentflow validate --graph ./agentflow.graph.json --profile default"
  ] as const,
  optionNames: ["graph", "profile", "workspace-backend", "help"] as const,
  helpNotes: [
    "--graph validation resolves from the launch shell current working directory.",
    "Use compile next when you want the full compiled graph contract, or run when you want durable artifacts."
  ] as const,
  async run(options: Record<string, string | boolean | undefined>, currentWorkingDirectory: string) {
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
          command: "validate",
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
          command: "validate",
          status: "failed",
          message: "Launch settings could not be resolved for validation.",
          graph_path: loaded.absolute_path,
          path_resolution: pathResolution,
          available_profiles: Object.keys(loaded.document.profiles ?? {}),
          supported_workspace_backends: workspaceBackends,
          next_steps: {
            graph_help: "agentflow graph-help",
            retry_validate: createGraphCliInvocation("validate", {
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
          command: "validate",
          status: "failed",
          message: "Graph validation reached compile-time diagnostics.",
          graph_path: loaded.absolute_path,
          path_resolution: pathResolution,
          next_steps: {
            graph_help: "agentflow graph-help",
            inspect_compile: createGraphCliInvocation("compile", {
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
        command: "validate",
        status: "passed",
        message: `Graph validated for launch profile "${launch.launch_profile}" and workspace backend "${launch.workspace_backend}".`,
        graph_path: loaded.absolute_path,
        path_resolution: pathResolution,
        authored_summary: summarizeAuthoredGraph(loaded.document),
        launch,
        lowered_managed_nodes: loaded.lowered_managed_nodes,
        compiled_summary: {
          entry_node_count: compilation.compiled_graph!.entry_node_ids.length,
          node_count: compilation.compiled_graph!.nodes.length,
          edge_count: compilation.compiled_graph!.edges.length,
          scope_count: compilation.compiled_graph!.scopes.length
        },
        next_steps: {
          compile: createGraphCliInvocation("compile", {
            graphPath: loaded.absolute_path,
            launch
          }),
          run: createGraphCliInvocation("run", {
            graphPath: loaded.absolute_path,
            launch
          }),
          graph_help: "agentflow graph-help"
        }
      }
    };
  }
};

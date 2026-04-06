import { compileAuthoredGraph } from "../../graph/compile.js";
import { resolveLaunchConfig } from "../../graph/profiles.js";
import { workspaceBackends } from "../../graph/schema.js";
import { loadAuthoredGraphDocument, summarizeAuthoredGraph } from "../../graph/validate.js";
import {
  createGraphCliInvocation,
  createGraphPathResolution,
  renderCommandUsageError
} from "../command_support.js";

export const compileCommand = {
  name: "compile",
  summary: "Resolve launch settings and emit the compiled graph contract.",
  usage:
    "agentflow compile --graph <path/to/agentflow.graph.json> [--profile <launch_profile>] [--workspace-backend <inplace|worktree>]",
  examples: [
    "agentflow compile --graph ./agentflow.graph.json",
    "agentflow compile --graph ./agentflow.graph.json --workspace-backend worktree"
  ] as const,
  optionNames: ["graph", "profile", "workspace-backend", "help"] as const,
  helpNotes: [
    "--graph resolves from the launch shell current working directory before the compiler resolves repo paths from the graph file directory.",
    "Use run when you want durable artifacts written for the same resolved launch settings."
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
          command: "compile",
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
          command: "compile",
          status: "failed",
          message: "Launch settings could not be resolved for compilation.",
          graph_path: loaded.absolute_path,
          path_resolution: pathResolution,
          available_profiles: Object.keys(loaded.document.profiles ?? {}),
          supported_workspace_backends: workspaceBackends,
          next_steps: {
            graph_help: "agentflow graph-help",
            retry_compile: createGraphCliInvocation("compile", {
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
          command: "compile",
          status: "failed",
          message: "Graph compilation returned diagnostics.",
          graph_path: loaded.absolute_path,
          path_resolution: pathResolution,
          next_steps: {
            graph_help: "agentflow graph-help",
            retry_validate: createGraphCliInvocation("validate", {
              graphPath: loaded.absolute_path
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
        command: "compile",
        status: "passed",
        message: `Compiled graph contract is ready for launch profile "${launch.launch_profile}" and workspace backend "${launch.workspace_backend}".`,
        graph_path: loaded.absolute_path,
        path_resolution: pathResolution,
        authored_summary: summarizeAuthoredGraph(loaded.document),
        launch,
        lowered_managed_nodes: loaded.lowered_managed_nodes,
        compiled_graph: compilation.compiled_graph,
        next_steps: {
          validate: createGraphCliInvocation("validate", {
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

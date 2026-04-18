import {
  renderCommandUsageError
} from "../command_support.js";
import { resolvePluginsForGraph } from "../../plugins/workflows.js";

function renderPluginUsageError(message: string): string {
  return renderCommandUsageError({
    message,
    commandName: "plugin",
    usage: pluginCommand.usage
  });
}

export const pluginCommand = {
  name: "plugin",
  summary: "Resolve Git-distributed plugin workflows for an authored graph.",
  usage: "agentflow plugin <resolve> --graph <path/to/agentflow.graph.json>",
  examples: [
    "agentflow plugin resolve --graph ./agentflow.graph.json"
  ] as const,
  optionNames: ["graph", "help"] as const,
  helpNotes: [
    "Plugins package reusable managed workflows that lower into normal Agentflow graph primitives.",
    "resolve clones declared plugins, pins them to commits, and writes agentflow.plugins.lock.json next to the graph."
  ] as const,
  async run(
    options: Record<string, string | boolean | undefined>,
    currentWorkingDirectory: string,
    _signal?: AbortSignal,
    positionals: readonly string[] = []
  ) {
    const subcommand = positionals[0];

    if (subcommand !== "resolve" || positionals.length > 1) {
      return {
        exitCode: 2,
        stdout: renderPluginUsageError(
          subcommand
            ? `Unexpected plugin subcommand or positional arguments: ${positionals.join(", ")}`
            : "Missing plugin subcommand."
        )
      };
    }

    const graphPath = typeof options.graph === "string" ? options.graph : undefined;
    if (!graphPath) {
      return {
        exitCode: 2,
        stdout: renderPluginUsageError("Missing required option: --graph")
      };
    }

    const result = await resolvePluginsForGraph(currentWorkingDirectory, graphPath);
    const passed = result.diagnostics.length === 0;

    return {
      exitCode: passed ? 0 : 1,
      output: {
        command: "plugin resolve",
        status: passed ? "passed" : "failed",
        message: passed
          ? "Plugin workflows resolved and lockfile updated."
          : "Plugin workflow resolution failed.",
        graph_path: result.graph_path,
        lockfile_path: result.lockfile_path,
        resolved_plugins: result.resolved_plugins,
        diagnostics: result.diagnostics
      }
    };
  }
};

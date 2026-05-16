import {
  renderCommandUsageError
} from "../command_support.js";
import { resolvePluginsForGraph } from "../../plugins/workflows.js";
import { resolveSkillSourcesForGraph } from "../../skills/sources.js";

function renderPluginUsageError(message: string): string {
  return renderCommandUsageError({
    message,
    commandName: "plugin",
    usage: pluginCommand.usage
  });
}

export const pluginCommand = {
  name: "plugin",
  summary: "Resolve Git or local plugin and skill packages for an authored graph.",
  usage: "agentflow plugin <resolve> --graph <path/to/agentflow.graph.json>",
  examples: [
    "agentflow plugin resolve --graph ./agentflow.graph.json"
  ] as const,
  optionNames: ["graph", "help"] as const,
  helpNotes: [
    "Plugins package reusable managed workflows, CLI tools, and credential metadata.",
    "Skill sources package reusable SKILL.md collections for node support.",
    "resolve clones Git packages or fingerprints local folders, then writes lockfiles next to the graph."
  ] as const,
  async run(
    options: Record<string, string | boolean | string[] | undefined>,
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

    const [pluginResult, skillResult] = await Promise.all([
      resolvePluginsForGraph(currentWorkingDirectory, graphPath),
      resolveSkillSourcesForGraph(currentWorkingDirectory, graphPath)
    ]);
    const diagnostics = [...pluginResult.diagnostics, ...skillResult.diagnostics];
    const passed = diagnostics.length === 0;

    return {
      exitCode: passed ? 0 : 1,
      output: {
        command: "plugin resolve",
        status: passed ? "passed" : "failed",
        message: passed
          ? "Plugin and skill sources resolved and lockfiles updated."
          : "Plugin or skill source resolution failed.",
        graph_path: pluginResult.graph_path,
        plugin_lockfile_path: pluginResult.lockfile_path,
        skill_lockfile_path: skillResult.lockfile_path,
        resolved_plugins: pluginResult.resolved_plugins,
        resolved_skill_sources: skillResult.resolved_skill_sources,
        diagnostics
      }
    };
  }
};

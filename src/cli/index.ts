#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runsRootEnvironmentVariable } from "../artifacts/paths.js";
import {
  graphPathRuleText,
  renderCommandUsageError,
  repoPathRuleText,
  runsRootContractText
} from "./command_support.js";
import {
  checkKinds,
  containerNodeKinds,
  executableNodeKinds,
  graphVersion,
  harnessNames,
  managedWorkflowKinds,
  workspaceBackends
} from "../graph/schema.js";
import { managedWorkflowDescriptors } from "../managed/index.js";
import { compileCommand } from "./commands/compile.js";
import { resumeCommand } from "./commands/resume.js";
import { runCommand } from "./commands/run.js";
import { uiCommand } from "./commands/ui.js";
import { validateCommand } from "./commands/validate.js";

interface GraphCliCommandResult {
  exitCode: number;
  output?: unknown;
  stdout?: string;
}

interface GraphCliCommand {
  name: string;
  summary: string;
  usage: string;
  optionNames: readonly string[];
  examples?: readonly string[];
  helpNotes?: readonly string[];
  run: (
    options: Record<string, string | boolean | undefined>,
    currentWorkingDirectory: string,
    signal?: AbortSignal
  ) => Promise<GraphCliCommandResult>;
}

const optionDescriptions: Record<string, string> = {
  graph: "--graph <path>               Authored graph document to validate, compile, run, or preload for UI.",
  profile: "--profile <name>             Launch profile override.",
  "workspace-backend":
    "--workspace-backend <name>   Run-scoped workspace backend override.",
  label: "--label <run_label>          Optional run label appended to the generated run root.",
  "run-root": "--run-root <path>            Existing run root to resume.",
  mission: "--mission <path>             Mission state file reserved for the deferred controller surface.",
  help: "--help, -h                   Show command help."
};

function renderGraphHelp(): string {
  const managedWorkflowLines = managedWorkflowDescriptors.map(
    (descriptor) => `- ${descriptor.kind}: ${descriptor.summary}`
  );

  const minimalGraph = [
    "{",
    `  "version": "${graphVersion}",`,
    '  "graph_id": "example-graph",',
    '  "repos": {',
    '    "main": { "path": "." }',
    "  },",
    '  "defaults": {',
    '    "launch_profile": "default",',
    '    "workspace_backend": "worktree"',
    "  },",
    '  "profiles": {',
    '    "default": { "harness": "codex-cli" }',
    "  },",
    '  "graph": {',
    '    "type": "sequence",',
    '    "id": "root",',
    '    "steps": [',
    '      { "type": "agent", "id": "implement", "prompt": "Implement the requested change." },',
    '      { "type": "check", "id": "verify", "check_kind": "deterministic", "command": "npm", "args": ["test"] }',
    "    ]",
    "  }",
    "}"
  ].join("\n");

  return [
    "Agentflow graph contract",
    "",
    `Version: ${graphVersion}`,
    `Executable node kinds: ${executableNodeKinds.join(", ")}`,
    `Container node kinds: ${containerNodeKinds.join(", ")}`,
    `Managed workflow scaffolds: ${managedWorkflowKinds.join(", ")}`,
    `Harness adapters: ${harnessNames.join(", ")}`,
    `Check kinds: ${checkKinds.join(", ")}`,
    `Workspace backends: ${workspaceBackends.join(", ")}`,
    "",
    "Managed workflow direction:",
    ...managedWorkflowLines,
    "",
    "Top-level document fields:",
    "- graph_id",
    "- repos",
    "- defaults.launch_profile",
    "- defaults.workspace_backend",
    "- profiles",
    "- graph",
    "",
    "Key rules:",
    "- The runtime executes compiled graphs only.",
    "- sequence, parallel, and repeat are authoring containers, not executable runtime nodes.",
    "- deep_research, spec_design, execute_spec, and review_change are implemented as managed workflows that lower into generated primitive subgraphs.",
    "- repeat.until.node must target a descendant check node.",
    "- profile selection is launch-scoped by default and may be overridden per executable node.",
    "- agent and ai check nodes require a resolved harness; deterministic checks do not.",
    `- ${graphPathRuleText}`,
    `- ${repoPathRuleText}`,
    `- ${runsRootContractText}`,
    "",
    "Minimal graph:",
    minimalGraph,
    "",
    "Recommended local workflow:",
    "1. agentflow validate --graph agentflow.graph.json",
    "2. agentflow compile --graph agentflow.graph.json",
    "3. agentflow run --graph agentflow.graph.json",
    "4. agentflow ui --graph agentflow.graph.json"
  ].join("\n");
}

const graphHelpCommand: GraphCliCommand = {
  name: "graph-help",
  summary: "Print the authored graph contract, supported node kinds, and a minimal example.",
  usage: "agentflow graph-help",
  optionNames: ["help"] as const,
  examples: ["agentflow graph-help"] as const,
  async run() {
    return {
      exitCode: 0,
      stdout: renderGraphHelp()
    };
  }
};

const controlCommand: GraphCliCommand = {
  name: "control",
  summary: "Reserved controller stub for future mission-oriented control-plane flows.",
  usage: "agentflow control --mission <path/to/mission.json>",
  optionNames: ["mission", "help"] as const,
  examples: ["agentflow control --mission mission.json"] as const,
  async run(options, currentWorkingDirectory) {
    const missionPath = typeof options.mission === "string" ? options.mission : undefined;

    if (!missionPath) {
      return {
        exitCode: 2,
        stdout: renderCommandUsageError({
          message: "Missing required option: --mission",
          commandName: this.name,
          usage: this.usage
        })
      };
    }

    const absoluteMissionPath = resolve(currentWorkingDirectory, missionPath);

    try {
      const entry = await stat(absoluteMissionPath);

      if (!entry.isFile()) {
        return {
          exitCode: 1,
          output: {
            command: "control",
            status: "failed",
            mission_path: absoluteMissionPath,
            message: "Mission path exists but is not a file."
          }
        };
      }
    } catch (error) {
      return {
        exitCode: 1,
        output: {
          command: "control",
          status: "failed",
          mission_path: absoluteMissionPath,
          message:
            error instanceof Error
              ? `Mission file could not be resolved: ${error.message}`
              : "Mission file could not be resolved."
        }
      };
    }

    return {
      exitCode: 1,
      output: {
        command: "control",
        status: "deferred",
        mission_path: absoluteMissionPath,
        message:
          "The controller boundary is intentionally deferred in this build. Mission orchestration does not execute in this release."
      }
    };
  }
};

const commandRegistry = {
  validate: validateCommand,
  compile: compileCommand,
  run: runCommand,
  resume: resumeCommand,
  ui: uiCommand,
  "graph-help": graphHelpCommand,
  control: controlCommand
} as const satisfies Record<string, GraphCliCommand>;

export type GraphCliCommandName = keyof typeof commandRegistry;

export interface GraphCliExecutionResult {
  exitCode: number;
  stdout: string;
}

function renderMainHelp(): string {
  const commandLines = Object.values(commandRegistry)
    .map((command) => `  ${command.name.padEnd(10)} ${command.summary}`)
    .join("\n");

  return [
    "Agentflow CLI",
    "",
    "Commands:",
    commandLines,
    "",
    "Local workflow:",
    "  1. graph-help: review the authored graph contract and minimal example",
    "  2. validate: check the authored graph plus launch settings without running it",
    "  3. compile: inspect the compiled graph contract before execution",
    "  4. run: execute the compiled graph and write durable artifacts under the run root",
    "  5. resume: continue a failed or canceled run root without redoing passed work",
    "  6. ui: point the launchpad or monitor at the same runs root",
    "",
    "Examples:",
    "  agentflow graph-help",
    "  agentflow validate --graph agentflow.graph.json",
    "  agentflow compile --graph agentflow.graph.json",
    "  agentflow run --graph agentflow.graph.json --workspace-backend worktree",
    "  agentflow resume --run-root .agentflow/runs/<run-id>",
    "  agentflow ui --graph agentflow.graph.json",
    "  agentflow control --mission mission.json",
    "",
    "Path rules:",
    `  ${graphPathRuleText}`,
    `  ${repoPathRuleText}`,
    "",
    "Runs root contract:",
    `  ${runsRootContractText}`,
    `  Override CLI and web monitor with ${runsRootEnvironmentVariable}=/absolute/path`,
    "",
    "Use `agentflow <command> --help` for command-specific options."
  ].join("\n");
}

function renderCommandHelp(command: GraphCliCommand): string {
  const options = command.optionNames
    .map((optionName) => optionDescriptions[optionName])
    .filter((value): value is string => Boolean(value));

  return [
    `${command.name}: ${command.summary}`,
    "",
    `Usage: ${command.usage}`,
    ...(options.length > 0 ? ["", "Options:", ...options.map((line) => `  ${line}`)] : []),
    ...(command.examples && command.examples.length > 0
      ? ["", "Examples:", ...command.examples.map((line) => `  ${line}`)]
      : []),
    ...(command.helpNotes && command.helpNotes.length > 0
      ? ["", "Notes:", ...command.helpNotes.map((line) => `  ${line}`)]
      : [])
  ].join("\n");
}

function parseArgs(argv: string[]): {
  commandName: GraphCliCommandName | undefined;
  unknownCommand: string | undefined;
  options: Record<string, string | boolean>;
  positionals: string[];
} {
  const [commandCandidate, ...rest] = argv;
  const hasExplicitCommand = Boolean(commandCandidate && !commandCandidate.startsWith("-"));
  const commandName =
    hasExplicitCommand && commandCandidate !== undefined && commandCandidate in commandRegistry
      ? (commandCandidate as GraphCliCommandName)
      : undefined;
  const unknownCommand =
    hasExplicitCommand && !commandName && commandCandidate ? commandCandidate : undefined;
  const optionTokens = commandName ? rest : hasExplicitCommand ? rest : argv;
  const options: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let index = 0; index < optionTokens.length; index += 1) {
    const token = optionTokens[index];

    if (!token) {
      continue;
    }

    if (token === "-h") {
      options.help = true;
      continue;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const optionName = token.slice(2);
    const nextToken = optionTokens[index + 1];

    if (!nextToken || nextToken.startsWith("--")) {
      options[optionName] = true;
      continue;
    }

    options[optionName] = nextToken;
    index += 1;
  }

  return {
    commandName,
    unknownCommand,
    options,
    positionals
  };
}

function renderUnknownCommand(commandName: string): string {
  return [`Unknown command: ${commandName}`, "", renderMainHelp()].join("\n");
}

function validateOptionNames(
  command: GraphCliCommand,
  options: Record<string, string | boolean>
): string[] {
  return Object.keys(options).filter((optionName) => !command.optionNames.includes(optionName));
}

export async function executeCli(
  argv: string[],
  currentWorkingDirectory = process.cwd(),
  execution: {
    signal?: AbortSignal;
  } = {}
): Promise<GraphCliExecutionResult> {
  const { commandName, unknownCommand, options, positionals } = parseArgs(argv);

  if (unknownCommand) {
    return {
      exitCode: 2,
      stdout: renderUnknownCommand(unknownCommand)
    };
  }

  if (!commandName) {
    if (options.help || (Object.keys(options).length === 0 && positionals.length === 0)) {
      return {
        exitCode: 0,
        stdout: renderMainHelp()
      };
    }

    return {
      exitCode: 2,
      stdout: [`A command is required.`, "", renderMainHelp()].join("\n")
    };
  }

  const command = commandRegistry[commandName];

  if (options.help) {
    return {
      exitCode: 0,
      stdout: renderCommandHelp(command)
    };
  }

  if (positionals.length > 0) {
    return {
      exitCode: 2,
      stdout: renderCommandUsageError({
        message: `Unexpected positional arguments: ${positionals.join(", ")}`,
        commandName: command.name,
        usage: command.usage,
        includeGraphHelp: (command.optionNames as readonly string[]).includes("graph")
      })
    };
  }

  const unexpectedOptions = validateOptionNames(command, options);

  if (unexpectedOptions.length > 0) {
    return {
      exitCode: 2,
      stdout: renderCommandUsageError({
        message: `Unexpected option(s): ${unexpectedOptions.map((optionName) => `--${optionName}`).join(", ")}`,
        commandName: command.name,
        usage: command.usage,
        includeGraphHelp: (command.optionNames as readonly string[]).includes("graph")
      })
    };
  }

  try {
    const result: GraphCliCommandResult = await command.run(
      options,
      currentWorkingDirectory,
      execution.signal
    );

    return {
      exitCode: result.exitCode,
      stdout:
        result.stdout ??
        JSON.stringify(result.output ?? { command: command.name, status: "ok" }, null, 2)
    };
  } catch (error) {
    return {
      exitCode: 1,
      stdout: JSON.stringify(
        {
          command: command.name,
          status: "failed",
          message: error instanceof Error ? error.message : String(error)
        },
        null,
        2
      )
    };
  }
}

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  const abortController = new AbortController();
  const onSignal = (signalName: NodeJS.Signals) => {
    if (abortController.signal.aborted) {
      return;
    }

    process.stderr.write(`\n${signalName} received. Canceling the active graph run and waiting for cleanup.\n`);
    abortController.abort();
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const result = await executeCli(argv, process.cwd(), {
      signal: abortController.signal
    });
    process.stdout.write(`${result.stdout}\n`);
    process.exitCode = result.exitCode;
    return result.exitCode;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

function isDirectCliInvocation(argvPath: string | undefined): boolean {
  if (!argvPath) {
    return false;
  }

  try {
    return (
      pathToFileURL(realpathSync(argvPath)).href
      === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href
    );
  } catch {
    return false;
  }
}

if (isDirectCliInvocation(process.argv[1])) {
  await runCli();
}

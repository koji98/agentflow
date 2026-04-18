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
  artifactSourceKinds,
  contextSourceKinds,
  executableNodeKinds,
  graphVersion,
  harnessNames,
  managedPatternKinds,
  reservedArtifactNames,
  workspaceBackends
} from "../graph/schema.js";
import { managedPatternDescriptors } from "../managed/index.js";
import { applyCommand } from "./commands/apply.js";
import { compileCommand } from "./commands/compile.js";
import { evalCommand } from "./commands/eval.js";
import { pluginCommand } from "./commands/plugin.js";
import { resumeCommand } from "./commands/resume.js";
import { runCommand } from "./commands/run.js";
import { validateCommand } from "./commands/validate.js";
import { formatDuration } from "./progress.js";

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
    signal?: AbortSignal,
    positionals?: readonly string[]
  ) => Promise<GraphCliCommandResult>;
}

const optionDescriptions: Record<string, string> = {
  graph: "--graph <path>               Authored graph document to validate, compile, or run.",
  label: "--label <run_label>          Optional run label appended to the generated run root.",
  "run-ready": "--run-ready                  Also check local runtime dependencies during validate.",
  "run-root": "--run-root <path>            Existing run root to resume.",
  repo: "--repo <alias>                Repo alias to select from run workspace changes.",
  target: "--target <path>              Git worktree where captured workspace changes should be applied.",
  "allow-dirty": "--allow-dirty                Apply onto a target repo that already has local changes.",
  "commit-message": "--commit-message <message>   Commit the applied captured changes with this message.",
  suite: "--suite <path>               Eval suite JSON file.",
  case: "--case <id>                  Eval case id filter.",
  variant: "--variant <id>              Eval variant id filter.",
  "evals-root": "--evals-root <path>          Absolute eval artifact root for a new eval run.",
  "eval-root": "--eval-root <path>           Existing eval artifact root to report.",
  mission: "--mission <path>             Mission state file reserved for the deferred controller surface.",
  help: "--help, -h                   Show command help."
};

function renderGraphHelp(): string {
  const managedPatternLines = managedPatternDescriptors.map(
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
    '      {',
    '        "type": "agent",',
    '        "id": "implement",',
    '        "prompt": "Implement the requested change and write a concise handoff artifact.",',
    '        "context": [{ "name": "goal", "from": "text", "text": "Keep the change small." }],',
    '        "artifacts": { "handoff": { "from": "output_dir", "path": "handoff.md", "description": "Markdown handoff from this node." } }',
    "      },",
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
    `Managed pattern scaffolds: ${managedPatternKinds.join(", ")}`,
    "Plugin workflow node: plugin (uses Git-resolved reusable managed workflows)",
    `Harness adapters: ${harnessNames.join(", ")}`,
    `Check kinds: ${checkKinds.join(", ")}`,
    `Workspace backends: ${workspaceBackends.join(", ")}`,
    `Context sources: ${contextSourceKinds.join(", ")}`,
    `Artifact sources: ${artifactSourceKinds.join(", ")}`,
    `Reserved automatic artifacts: ${reservedArtifactNames.join(", ")}`,
    "",
    "Managed pattern direction:",
    ...managedPatternLines,
    "",
    "Top-level document fields:",
    "- graph_id",
    "- repos",
    "- defaults.launch_profile",
    "- defaults.workspace_backend",
    "- profiles",
    "- prerequisites.checks",
    "- graph",
    "- plugins",
    "",
    "Key rules:",
    "- The runtime executes compiled graphs only.",
    "- validate reports authored validation, compiled validation, and declared readiness; add --run-ready for local machine dependency checks.",
    "- sequence, parallel, and repeat are authoring containers, not executable runtime nodes.",
    "- pattern_deep_research, pattern_spec_design, pattern_generate_evaluate_fix, and pattern_review_change are implemented as managed patterns that lower into generated primitive subgraphs.",
    "- plugin workflow nodes use type = plugin, uses = plugin_alias/workflow_id, and config = workflow-specific settings; run agentflow plugin resolve --graph first.",
    "- repeat.until.node must target a descendant check or checkpoint node.",
    "- repeat context selectors support latest, latest_passed, latest_failed, or a positive integer ordinal.",
    "- launch profile and workspace backend come from graph defaults in this release.",
    "- executable nodes may still select node-level profiles inside the authored graph.",
    "- codex-cli profiles may set skip_git_repo_check for intentional non-git workspace roots.",
    "- profiles, exec nodes, and deterministic check nodes may set env_files for repo-local dotenv-style command environment.",
    "- profiles and agent nodes may set artifact_repair.max_attempts from 0 to 3; agent nodes default to one repair attempt.",
    "- exec and check support on_failure = fail | continue; soft verification still records the true verifier result.",
    "- executable nodes use context for text, workspace files, workspace globs, and prior artifacts.",
    "- executable nodes use artifacts to declare durable handoff files from AGENTFLOW_OUTPUT_DIR (execution artifacts/) or the workspace.",
    "- inputs, context_from, and outputs are invalid graph syntax; use context and artifacts.",
    "- agent_response is automatically written for agent nodes; result_json is automatically available for every executable node.",
    "- prerequisites.checks may assert required files, commands, env vars, or repos before launch.",
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
    "2. agentflow validate --graph agentflow.graph.json --run-ready when local launch readiness matters",
    "3. agentflow compile --graph agentflow.graph.json",
    "4. agentflow run --graph agentflow.graph.json",
    "5. inspect summary.md, state.json, and compiled_graph.json under the emitted run root"
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
  apply: applyCommand,
  eval: evalCommand,
  plugin: pluginCommand,
  "graph-help": graphHelpCommand,
  control: controlCommand
} as const satisfies Record<string, GraphCliCommand>;

export type GraphCliCommandName = keyof typeof commandRegistry;

export interface GraphCliExecutionResult {
  exitCode: number;
  stdout: string;
  output?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderInteractiveRunResult(output: Record<string, unknown>): string | undefined {
  const command = typeof output.command === "string" ? output.command : undefined;

  if (command !== "run" && command !== "resume") {
    return undefined;
  }

  const status = typeof output.status === "string" ? output.status : "unknown";
  const durationMs = typeof output.duration_ms === "number" ? output.duration_ms : undefined;
  const runRoot = typeof output.run_root === "string" ? output.run_root : undefined;
  const message = typeof output.message === "string" ? output.message.trim() : undefined;
  const terminalError =
    typeof output.terminal_error === "string" && output.terminal_error.trim().length > 0
      ? output.terminal_error.trim()
      : undefined;
  const terminalWarning =
    typeof output.terminal_warning === "string" && output.terminal_warning.trim().length > 0
      ? output.terminal_warning.trim()
      : undefined;
  const evidenceStatus =
    typeof output.evidence_status === "string" ? output.evidence_status : undefined;
  const artifacts = isRecord(output.artifacts) ? output.artifacts : undefined;
  const summaryFile =
    artifacts && typeof artifacts.summary_file === "string" ? artifacts.summary_file : undefined;
  const workspaceChangesDir =
    artifacts && typeof artifacts.workspace_changes_dir === "string" ? artifacts.workspace_changes_dir : undefined;

  const statusLabel =
    status === "passed"
      ? "succeeded"
      : status === "failed"
        ? "failed"
        : status === "canceled"
          ? "canceled"
          : status;
  const headline = `${command === "resume" ? "Resume" : "Run"} ${statusLabel}${
    durationMs !== undefined ? ` in ${formatDuration(durationMs)}` : ""
  }.`;
  const errorText =
    status === "passed"
      ? undefined
      : terminalError ?? message;
  const lines = [
    headline,
    ...(errorText ? [`Error: ${errorText}`] : []),
    ...(status === "passed" && evidenceStatus === "warnings" && terminalWarning
      ? [`Warning: ${terminalWarning}`]
      : []),
    ...(runRoot ? [`Run root: ${runRoot}`] : []),
    ...(summaryFile ? [`Summary: ${summaryFile}`] : []),
    ...(workspaceChangesDir ? [`Workspace changes: ${workspaceChangesDir}`] : [])
  ];

  return lines.join("\n");
}

function renderInteractiveValidateResult(output: Record<string, unknown>): string | undefined {
  if (output.command !== "validate") {
    return undefined;
  }

  const status = typeof output.status === "string" ? output.status : "unknown";
  const message = typeof output.message === "string" ? output.message.trim() : undefined;
  const graphPath = typeof output.graph_path === "string" ? output.graph_path : undefined;
  const launch = isRecord(output.launch) ? output.launch : undefined;
  const launchProfile = launch && typeof launch.launch_profile === "string" ? launch.launch_profile : undefined;
  const workspaceBackend = launch && typeof launch.workspace_backend === "string" ? launch.workspace_backend : undefined;
  const compiledSummary = isRecord(output.compiled_summary) ? output.compiled_summary : undefined;
  const nodeCount = compiledSummary && typeof compiledSummary.node_count === "number"
    ? compiledSummary.node_count
    : undefined;
  const edgeCount = compiledSummary && typeof compiledSummary.edge_count === "number"
    ? compiledSummary.edge_count
    : undefined;
  const readiness = isRecord(output.readiness) ? output.readiness : undefined;
  const readinessStatus = readiness && typeof readiness.status === "string" ? readiness.status : undefined;
  const blockedCount = readiness && typeof readiness.blocked_count === "number" ? readiness.blocked_count : 0;
  const warningCount = readiness && typeof readiness.warning_count === "number" ? readiness.warning_count : 0;
  const passedCount = readiness && typeof readiness.passed_count === "number" ? readiness.passed_count : 0;
  const checks = readiness && Array.isArray(readiness.checks) ? readiness.checks : [];
  const readinessMode = output.readiness_mode === "run-ready" ? "run-ready" : "declared";
  const problemChecks = checks
    .filter((check): check is Record<string, unknown> =>
      isRecord(check) && (check.status === "blocked" || check.status === "warning")
    )
    .slice(0, 6)
    .map((check) => `- ${String(check.status)} ${String(check.kind ?? "check")} ${String(check.target ?? "")}: ${String(check.message ?? "")}`);

  const headline =
    status === "passed"
      ? readinessMode === "run-ready"
        ? "Graph validated and run-ready."
        : "Graph validated."
      : "Graph validation failed.";
  const readinessLine = readinessStatus
    ? `Readiness: ${readinessStatus} (${passedCount} passed, ${warningCount} warnings, ${blockedCount} blocked; mode: ${readinessMode})`
    : undefined;
  const nextSteps = isRecord(output.next_steps) ? output.next_steps : undefined;
  const runStep = nextSteps && typeof nextSteps.run === "string" ? nextSteps.run : undefined;

  return [
    headline,
    ...(message && status !== "passed" ? [`Message: ${message}`] : []),
    ...(graphPath ? [`Graph: ${graphPath}`] : []),
    ...(launchProfile || workspaceBackend
      ? [`Launch: ${launchProfile ?? "unknown"} · workspace: ${workspaceBackend ?? "unknown"}`]
      : []),
    ...(nodeCount !== undefined || edgeCount !== undefined
      ? [`Compiled: ${nodeCount ?? "?"} nodes · ${edgeCount ?? "?"} edges`]
      : []),
    ...(readinessLine ? [readinessLine] : []),
    ...(readinessMode !== "run-ready" && status === "passed"
      ? ["Run-ready checks: not requested; add --run-ready to check git, commands, and harness binaries."]
      : []),
    ...(problemChecks.length > 0 ? ["Issues:", ...problemChecks] : []),
    ...(runStep && status === "passed" ? [`Run: ${runStep}`] : [])
  ].join("\n");
}

export function renderCliStdout(
  result: GraphCliExecutionResult,
  options: {
    isTty: boolean;
  }
): string {
  if (!options.isTty || !isRecord(result.output)) {
    return result.stdout;
  }

  return renderInteractiveRunResult(result.output) ?? renderInteractiveValidateResult(result.output) ?? result.stdout;
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
    "  2. validate: check authored, compiled, and optional run-ready phases without running the graph",
    "  3. compile: inspect the compiled graph contract before execution",
    "  4. run: execute the compiled graph and write durable artifacts under the run root",
    "  5. resume: recompile the original graph for a failed or canceled run root and preserve unchanged passed work",
    "  6. apply: apply captured workspace changes from a run back to a git repo",
    "  7. eval: validate or run local eval suites for Agentflow graphs",
    "  8. plugin: resolve Git-distributed managed workflow plugins for a graph",
    "",
    "Examples:",
  "  agentflow graph-help",
  "  agentflow validate --graph agentflow.graph.json",
  "  agentflow validate --graph agentflow.graph.json --run-ready",
  "  agentflow compile --graph agentflow.graph.json",
    "  agentflow run --graph agentflow.graph.json",
    "  agentflow resume --run-root .agentflow/runs/<run-id>",
    "  agentflow apply --run-root .agentflow/runs/<run-id>",
    "  agentflow eval validate --suite evals/example/suite.json",
    "  agentflow plugin resolve --graph agentflow.graph.json",
    "  agentflow control --mission mission.json",
    "",
    "Path rules:",
    `  ${graphPathRuleText}`,
    `  ${repoPathRuleText}`,
    "",
    "Runs root contract:",
    `  ${runsRootContractText}`,
    `  Override the default runs root with ${runsRootEnvironmentVariable}=/absolute/path`,
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

  if (positionals.length > 0 && command.name !== "eval" && command.name !== "plugin") {
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
      execution.signal,
      positionals
    );

    return {
      exitCode: result.exitCode,
      output: result.output,
      stdout:
        result.stdout ??
        JSON.stringify(result.output ?? { command: command.name, status: "ok" }, null, 2)
    };
  } catch (error) {
    const output = {
      command: command.name,
      status: "failed",
      message: error instanceof Error ? error.message : String(error)
    };

    return {
      exitCode: 1,
      output,
      stdout: JSON.stringify(output, null, 2)
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
    process.stdout.write(`${renderCliStdout(result, { isTty: process.stdout.isTTY === true })}\n`);
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

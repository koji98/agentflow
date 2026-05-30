import { accessSync, constants } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import type { CompiledExecutableNode, CompiledGraph, ResolvedTool } from "../graph/compiled.js";
import type { HarnessName } from "../graph/schema.js";
import { resolveSubpathWithinRoot } from "../path_rules.js";
import type { HarnessAdapter } from "./harness/types.js";
import { resolveCliBinary } from "./harness/types.js";
import { createCredentialStore } from "../auth/store.js";
import type { CredentialScopeSpec } from "../auth/types.js";
import { analyzeGraphContext } from "./context/analyze.js";

export type ReadinessCheckStatus = "passed" | "warning" | "blocked";
export type ReadinessStatus = "ready" | "warnings" | "blocked";

export interface ReadinessCheckResult {
  kind: "file" | "command" | "env" | "repo" | "harness" | "credential" | "tool" | "mcp" | "cli" | "context";
  required: boolean;
  status: ReadinessCheckStatus;
  target: string;
  message: string;
}

export interface GraphReadinessResult {
  status: ReadinessStatus;
  checks: ReadinessCheckResult[];
  passed_count: number;
  warning_count: number;
  blocked_count: number;
}

function readQualifiedRepoAlias(pathValue: string): string | undefined {
  const separatorIndex = pathValue.indexOf(":");
  return separatorIndex <= 0 ? undefined : pathValue.slice(0, separatorIndex);
}

function readQualifiedRepoPath(pathValue: string): string {
  const separatorIndex = pathValue.indexOf(":");
  return separatorIndex <= 0 ? pathValue : pathValue.slice(separatorIndex + 1);
}

function quoteForSingleQuotedShell(value: string): string {
  return value.replace(/'/g, `'\"'\"'`);
}

function commandAvailable(command: string, environment: NodeJS.ProcessEnv): boolean {
  if (process.platform === "win32") {
    const result = spawnSync("where", [command], {
      env: environment,
      stdio: "ignore"
    });

    return result.status === 0;
  }

  const result = spawnSync("sh", ["-lc", `command -v -- '${quoteForSingleQuotedShell(command)}' >/dev/null 2>&1`], {
    env: environment,
    stdio: "ignore"
  });

  return result.status === 0;
}

function canAccessExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    if (process.platform !== "win32") {
      return false;
    }

    try {
      accessSync(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

function summarizeStatus(checks: ReadinessCheckResult[]): GraphReadinessResult {
  const passed_count = checks.filter((check) => check.status === "passed").length;
  const warning_count = checks.filter((check) => check.status === "warning").length;
  const blocked_count = checks.filter((check) => check.status === "blocked").length;

  return {
    status: blocked_count > 0 ? "blocked" : warning_count > 0 ? "warnings" : "ready",
    checks,
    passed_count,
    warning_count,
    blocked_count
  };
}

function buildIssue(
  kind: ReadinessCheckResult["kind"],
  required: boolean,
  target: string,
  passed: boolean,
  message: string
): ReadinessCheckResult {
  if (passed) {
    return {
      kind,
      required,
      status: "passed",
      target,
      message
    };
  }

  return {
    kind,
    required,
    status: required ? "blocked" : "warning",
    target,
    message
  };
}

async function evaluateFilePrerequisite(
  pathValue: string,
  required: boolean,
  repoSources: Record<string, string>
): Promise<ReadinessCheckResult> {
  const repoAlias = readQualifiedRepoAlias(pathValue);
  const relativePath = readQualifiedRepoPath(pathValue);
  const resolvedRepoAlias =
    repoAlias ??
    (Object.keys(repoSources).length === 1 ? Object.keys(repoSources)[0] : undefined);

  if (!resolvedRepoAlias) {
    return buildIssue(
      "file",
      required,
      pathValue,
      false,
      `Prerequisite file "${pathValue}" could not be resolved because no repo alias was selected.`
    );
  }

  const repoRoot = repoSources[resolvedRepoAlias];

  if (!repoRoot) {
    return buildIssue(
      "file",
      required,
      pathValue,
      false,
      `Prerequisite file "${pathValue}" references unavailable repo "${resolvedRepoAlias}".`
    );
  }

  const absolutePath = join(repoRoot, relativePath);

  try {
    const entry = await stat(absolutePath);

    return entry.isFile()
      ? buildIssue("file", required, pathValue, true, `Found prerequisite file at ${absolutePath}.`)
      : buildIssue("file", required, pathValue, false, `Prerequisite path exists but is not a file: ${absolutePath}`);
  } catch (error) {
    return buildIssue(
      "file",
      required,
      pathValue,
      false,
      error instanceof Error
        ? `Prerequisite file is missing: ${absolutePath} (${error.message})`
        : `Prerequisite file is missing: ${absolutePath}`
    );
  }
}

function evaluateCommandPrerequisite(
  command: string,
  required: boolean,
  environment: NodeJS.ProcessEnv
): ReadinessCheckResult {
  const passed = commandAvailable(command, environment);

  return buildIssue(
    "command",
    required,
    command,
    passed,
    passed
      ? `Command "${command}" is available.`
      : `Command "${command}" is not available on PATH.`
  );
}

async function evaluateGitRepository(
  repoAlias: string,
  repoRoot: string | undefined,
  required: boolean,
  environment: NodeJS.ProcessEnv
): Promise<ReadinessCheckResult> {
  if (!repoRoot) {
    return buildIssue("repo", required, repoAlias, false, `Repo "${repoAlias}" is unavailable.`);
  }

  const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: repoRoot,
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const passed = result.status === 0 && result.stdout.trim() === "true";
  const detail = result.error instanceof Error
    ? result.error.message
    : result.stderr.trim();

  return buildIssue(
    "repo",
    required,
    repoAlias,
    passed,
    passed
      ? `Repo "${repoAlias}" is a git worktree.`
      : `Repo "${repoAlias}" must be a git worktree for full launch readiness${detail ? ` (${detail})` : ""}.`
  );
}

function commandUsesPath(command: string): boolean {
  return command.includes("/") || command.includes("\\") || isAbsolute(command);
}

async function evaluateNodeCommand(
  node: CompiledExecutableNode,
  command: string,
  repoSources: Record<string, string>,
  environment: NodeJS.ProcessEnv
): Promise<ReadinessCheckResult> {
  const target = `${node.authored_id}: ${command}`;
  const repoRoot = repoSources[node.repo];

  if (!repoRoot) {
    return buildIssue(
      "command",
      true,
      target,
      false,
      `Node "${node.authored_id}" command "${command}" cannot be checked because repo "${node.repo}" is unavailable.`
    );
  }

  let cwd: string;

  try {
    cwd = "cwd" in node && node.cwd
      ? resolveSubpathWithinRoot(repoRoot, node.cwd, `cwd "${node.cwd}"`)
      : repoRoot;
  } catch (error) {
    return buildIssue(
      "command",
      true,
      target,
      false,
      error instanceof Error
        ? `Node "${node.authored_id}" has an invalid cwd for command readiness: ${error.message}`
        : `Node "${node.authored_id}" has an invalid cwd for command readiness.`
    );
  }

  const commandEnvironment = {
    ...environment,
    ...("env" in node ? node.env ?? {} : {})
  };

  if (commandUsesPath(command)) {
    const commandPath = isAbsolute(command) ? command : resolve(cwd, command);
    const passed = canAccessExecutable(commandPath);

    return buildIssue(
      "command",
      true,
      target,
      passed,
      passed
        ? `Node "${node.authored_id}" command is executable at ${commandPath}.`
        : `Node "${node.authored_id}" command is not executable at ${commandPath}.`
    );
  }

  const passed = commandAvailable(command, commandEnvironment);

  return buildIssue(
    "command",
    true,
    target,
    passed,
    passed
      ? `Node "${node.authored_id}" command "${command}" is available on PATH.`
      : `Node "${node.authored_id}" command "${command}" is not available on PATH.`
  );
}

async function evaluateCliHint(
  node: CompiledExecutableNode,
  command: string,
  repoSources: Record<string, string>,
  environment: NodeJS.ProcessEnv
): Promise<ReadinessCheckResult> {
  const target = `${node.authored_id}: ${command}`;
  const repoRoot = repoSources[node.repo];

  if (commandUsesPath(command)) {
    if (!repoRoot && !isAbsolute(command)) {
      return buildIssue(
        "cli",
        true,
        target,
        false,
        `CLI hint "${command}" cannot be checked because repo "${node.repo}" is unavailable.`
      );
    }
    const commandPath = isAbsolute(command) ? command : resolve(repoRoot!, command);
    const passed = canAccessExecutable(commandPath);
    return buildIssue(
      "cli",
      true,
      target,
      passed,
      passed
        ? `CLI hint "${command}" is executable at ${commandPath}.`
        : `CLI hint "${command}" is not executable at ${commandPath}.`
    );
  }

  const passed = commandAvailable(command, environment);
  return buildIssue(
    "cli",
    true,
    target,
    passed,
    passed
      ? `CLI hint "${command}" is available on PATH.`
      : `CLI hint "${command}" is not available on PATH.`
  );
}

async function evaluateRepoPrerequisite(
  repoAlias: string,
  required: boolean,
  repoSources: Record<string, string>
): Promise<ReadinessCheckResult> {
  const repoRoot = repoSources[repoAlias];

  if (!repoRoot) {
    return buildIssue("repo", required, repoAlias, false, `Repo "${repoAlias}" is unavailable.`);
  }

  try {
    const entry = await stat(repoRoot);

    return entry.isDirectory()
      ? buildIssue("repo", required, repoAlias, true, `Repo "${repoAlias}" resolved to ${repoRoot}.`)
      : buildIssue("repo", required, repoAlias, false, `Repo "${repoAlias}" is not a directory: ${repoRoot}`);
  } catch (error) {
    return buildIssue(
      "repo",
      required,
      repoAlias,
      false,
      error instanceof Error
        ? `Repo "${repoAlias}" could not be resolved at ${repoRoot} (${error.message})`
        : `Repo "${repoAlias}" could not be resolved at ${repoRoot}`
    );
  }
}

function collectRuntimeCommandChecks(graph: Pick<CompiledGraph, "nodes">): Array<{
  node: CompiledExecutableNode;
  command: string;
}> {
  const checks: Array<{
    node: CompiledExecutableNode;
    command: string;
  }> = [];

  for (const node of graph.nodes) {
    if (node.kind === "exec") {
      checks.push({ node, command: node.command });
      continue;
    }

    if (node.kind === "check" && node.check_kind === "deterministic" && node.command) {
      checks.push({ node, command: node.command });
    }
  }

  return checks;
}

function collectRequiredHarnesses(graph: Pick<CompiledGraph, "nodes" | "supervisor_effective_policy">): HarnessName[] {
  const harnesses = new Set<HarnessName>();

  for (const node of graph.nodes) {
    const needsHarness = node.kind === "agent" || (node.kind === "check" && node.check_kind === "ai");

    if (needsHarness && node.effective_policy.harness) {
      harnesses.add(node.effective_policy.harness);
    }
  }

  if (graph.supervisor_effective_policy?.harness) {
    harnesses.add(graph.supervisor_effective_policy.harness);
  }

  return [...harnesses].sort();
}

function collectRequiredCredentialScopes(
  graph: Pick<CompiledGraph, "nodes">
): string[] {
  const scopes = new Set<string>();

  for (const node of graph.nodes) {
    if (node.kind !== "agent") {
      continue;
    }

    for (const tool of node.tools) {
      for (const scope of tool.credentials ?? []) {
        scopes.add(scope);
      }
    }
  }

  return [...scopes].sort();
}

function collectPluginTools(graph: Pick<CompiledGraph, "nodes">): ResolvedTool[] {
  const tools = new Map<string, ResolvedTool>();

  for (const node of graph.nodes) {
    if (node.kind !== "agent") {
      continue;
    }

    for (const tool of node.tools) {
      if (tool.source.kind !== "plugin") {
        continue;
      }

      const key = `${tool.source.alias}/${tool.source.tool}:${tool.executable_path}`;
      if (!tools.has(key)) {
        tools.set(key, tool);
      }
    }
  }

  return [...tools.values()].sort((left, right) => left.callable_name.localeCompare(right.callable_name));
}

interface RequiredCursorMcpCheck {
  node: CompiledExecutableNode;
  identifier: string;
}

function collectRequiredCursorMcps(graph: Pick<CompiledGraph, "nodes">): RequiredCursorMcpCheck[] {
  const checks = new Map<string, RequiredCursorMcpCheck>();

  for (const node of graph.nodes) {
    if (node.kind !== "agent" || node.effective_policy.harness !== "cursor-cli") {
      continue;
    }

    for (const identifier of node.effective_policy.harness_config?.cursor?.required_mcps ?? []) {
      const key = `${node.repo}:${identifier}`;
      if (!checks.has(key)) {
        checks.set(key, { node, identifier });
      }
    }
  }

  return [...checks.values()].sort((left, right) =>
    `${left.node.repo}:${left.identifier}`.localeCompare(`${right.node.repo}:${right.identifier}`)
  );
}

function helpValidationEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const safeEnvironment: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "ComSpec"]) {
    const value = environment[key];
    if (typeof value === "string") {
      safeEnvironment[key] = value;
    }
  }
  return safeEnvironment;
}

function missingHelpSignals(helpText: string): string[] {
  const requiredSignals = [
    { label: "Usage", pattern: /\bUsage\s*:/i },
    { label: "Options", pattern: /\bOptions\s*:/i },
    { label: "Default", pattern: /\bDefault\s*:/i },
    { label: "Output", pattern: /\bOutput\s*:/i },
    { label: "Exit codes", pattern: /\bExit codes\s*:/i },
    { label: "Examples", pattern: /\bExamples\s*:/i },
    { label: "--help option", pattern: /--help\b/i }
  ];

  return requiredSignals
    .filter((signal) => !signal.pattern.test(helpText))
    .map((signal) => signal.label);
}

function containsObviousSecret(helpText: string): boolean {
  return /(?:token|secret|password|passwd|api[_-]?key|credential)\s*[:=]\s*(?!<redacted>|redacted|\(redacted\)|unset|none\b)[^\s\n]{8,}/i
    .test(helpText);
}

async function evaluatePluginToolHelp(
  tool: ResolvedTool,
  environment: NodeJS.ProcessEnv
): Promise<ReadinessCheckResult> {
  const target = `$.plugins.${tool.source.alias}.tools.${tool.source.tool}.help`;
  const helpArgs = ["--help"];
  const result = spawnSync(tool.executable_path, helpArgs, {
    cwd: tool.source.plugin_root,
    env: helpValidationEnvironment(environment),
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 5000,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();

  if (result.error) {
    return buildIssue(
      "tool",
      true,
      target,
      false,
      `Plugin tool "${tool.source.alias}/${tool.source.tool}" --help could not run: ${result.error.message}.`
    );
  }

  if (result.status !== 0) {
    return buildIssue(
      "tool",
      true,
      target,
      false,
      `Plugin tool "${tool.source.alias}/${tool.source.tool}" --help must exit 0; got ${result.status ?? "unknown"}.`
    );
  }

  if (output.length === 0) {
    return buildIssue(
      "tool",
      true,
      target,
      false,
      `Plugin tool "${tool.source.alias}/${tool.source.tool}" --help must print non-empty help output.`
    );
  }

  const missingSignals = missingHelpSignals(output);
  if (missingSignals.length > 0) {
    return buildIssue(
      "tool",
      true,
      target,
      false,
      `Plugin tool "${tool.source.alias}/${tool.source.tool}" --help is missing required help sections/signals: ${missingSignals.join(", ")}.`
    );
  }

  if (containsObviousSecret(output)) {
    return buildIssue(
      "tool",
      true,
      target,
      false,
      `Plugin tool "${tool.source.alias}/${tool.source.tool}" --help appears to expose an unredacted secret-looking value. Redact credential and token defaults.`
    );
  }

  return buildIssue(
    "tool",
    true,
    target,
    true,
    `Plugin tool "${tool.source.alias}/${tool.source.tool}" --help satisfies the Agentflow help contract.`
  );
}

async function evaluateHarnessReadiness(
  harnessName: HarnessName,
  harnesses: Partial<Record<HarnessName, HarnessAdapter>> | undefined
): Promise<ReadinessCheckResult> {
  const harness = harnesses?.[harnessName];

  if (!harness) {
    return buildIssue(
      "harness",
      true,
      harnessName,
      false,
      `Harness adapter "${harnessName}" is unavailable for run-ready validation.`
    );
  }

  const diagnostics = await Promise.resolve(harness.checkReadiness?.() ?? []);

  return buildIssue(
    "harness",
    true,
    harnessName,
    diagnostics.length === 0,
    diagnostics.length === 0
      ? `Harness "${harnessName}" is available.`
      : diagnostics.join(" | ")
  );
}

async function evaluateCredentialReadiness(
  scope: string,
  spec: CredentialScopeSpec
): Promise<ReadinessCheckResult> {
  try {
    await createCredentialStore().resolveScope(spec, scope);
    return buildIssue(
      "credential",
      true,
      scope,
      true,
      `Credential scope "${scope}" is configured.`
    );
  } catch (error) {
    return buildIssue(
      "credential",
      true,
      scope,
      false,
      error instanceof Error
        ? error.message
        : `Credential scope "${scope}" is not configured.`
    );
  }
}

function summarizeProcessOutput(stdout: string | Buffer | undefined, stderr: string | Buffer | undefined): string {
  return `${stdout?.toString() ?? ""}\n${stderr?.toString() ?? ""}`
    .trim()
    .split(/\r?\n/u)
    .slice(-20)
    .join("\n");
}

async function evaluateCursorMcpReadiness(
  check: RequiredCursorMcpCheck,
  repoSources: Record<string, string>,
  environment: NodeJS.ProcessEnv
): Promise<ReadinessCheckResult> {
  const repoRoot = repoSources[check.node.repo];
  const target = `${check.node.repo}:${check.identifier}`;

  if (!repoRoot) {
    return buildIssue(
      "mcp",
      true,
      target,
      false,
      `Cursor MCP "${check.identifier}" cannot be checked because repo "${check.node.repo}" is unavailable.`
    );
  }

  const binary = resolveCliBinary(undefined, "AGENTFLOW_CURSOR_CLI_BIN", "agent");
  const result = spawnSync(binary, ["mcp", "list-tools", check.identifier], {
    cwd: repoRoot,
    env: environment,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 15000,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const detail = result.error instanceof Error
    ? result.error.message
    : summarizeProcessOutput(result.stdout, result.stderr);
  const setupHint =
    `Run: cd '${quoteForSingleQuotedShell(repoRoot)}' && ${binary} mcp login '${quoteForSingleQuotedShell(check.identifier)}' && ${binary} mcp enable '${quoteForSingleQuotedShell(check.identifier)}' && ${binary} mcp list-tools '${quoteForSingleQuotedShell(check.identifier)}'`;

  if (result.error instanceof Error) {
    return buildIssue(
      "mcp",
      true,
      target,
      false,
      `Cursor MCP "${check.identifier}" readiness check could not run with "${binary}": ${detail}.`
    );
  }

  if (result.status !== 0) {
    return buildIssue(
      "mcp",
      true,
      target,
      false,
      `Cursor MCP "${check.identifier}" is not ready for repo "${check.node.repo}" at ${repoRoot}${detail ? ` (${detail})` : ""}. ${setupHint}`
    );
  }

  return buildIssue(
    "mcp",
    true,
    target,
    true,
    `Cursor MCP "${check.identifier}" is authenticated and lists tools for repo "${check.node.repo}".`
  );
}

async function evaluateMachineReadiness(options: {
  graph: Pick<CompiledGraph, "launch" | "nodes"> & Partial<Pick<CompiledGraph, "credential_specs" | "supervisor_effective_policy">>;
  repo_sources: Record<string, string>;
  env: NodeJS.ProcessEnv;
  harnesses?: Partial<Record<HarnessName, HarnessAdapter>>;
}): Promise<ReadinessCheckResult[]> {
  const checks: ReadinessCheckResult[] = [];
  const gitRequired = options.graph.launch.workspace_backend === "worktree";
  const gitAvailable = commandAvailable("git", options.env);

  checks.push(
    buildIssue(
      "command",
      gitRequired,
      "git",
      gitAvailable,
      gitAvailable
        ? "Command \"git\" is available for workspace setup and change capture."
        : gitRequired
          ? "Command \"git\" is required for worktree workspace setup and is not available on PATH."
          : "Command \"git\" is not available on PATH; workspace change capture will be incomplete."
    )
  );

  for (const repoAlias of [...new Set(options.graph.nodes.map((node) => node.repo))].sort()) {
    checks.push(await evaluateRepoPrerequisite(repoAlias, true, options.repo_sources));
    checks.push(
      await evaluateGitRepository(
        repoAlias,
        options.repo_sources[repoAlias],
        gitRequired,
        options.env
      )
    );
  }

  for (const { node, command } of collectRuntimeCommandChecks(options.graph)) {
    checks.push(await evaluateNodeCommand(node, command, options.repo_sources, options.env));
  }

  for (const node of options.graph.nodes) {
    for (const hint of node.cli) {
      checks.push(await evaluateCliHint(node, hint.cmd, options.repo_sources, options.env));
    }
  }

  for (const harnessName of collectRequiredHarnesses(options.graph)) {
    checks.push(await evaluateHarnessReadiness(harnessName, options.harnesses));
  }

  for (const check of collectRequiredCursorMcps(options.graph)) {
    checks.push(await evaluateCursorMcpReadiness(check, options.repo_sources, options.env));
  }

  for (const tool of collectPluginTools(options.graph)) {
    checks.push(await evaluatePluginToolHelp(tool, options.env));
  }

  const credentialSpecs = options.graph.credential_specs ?? {};
  for (const scope of collectRequiredCredentialScopes(options.graph)) {
    const spec = credentialSpecs[scope];
    if (!spec) {
      checks.push(
        buildIssue(
          "credential",
          true,
          scope,
          false,
          `Credential scope "${scope}" is required by a tool but missing from the compiled credential contract.`
        )
      );
      continue;
    }
    checks.push(await evaluateCredentialReadiness(scope, spec));
  }

  return checks;
}

export async function evaluateGraphReadiness(options: {
  graph: Partial<Pick<CompiledGraph, "launch" | "nodes" | "credential_specs" | "supervisor_effective_policy">>;
  repo_sources: Record<string, string>;
  repo_source_diagnostics?: Array<{ path: string; message: string }>;
  env?: NodeJS.ProcessEnv;
  machine_checks?: boolean;
  harnesses?: Partial<Record<HarnessName, HarnessAdapter>>;
}): Promise<GraphReadinessResult> {
  const checks: ReadinessCheckResult[] = [];
  const environment = options.env ?? process.env;

  for (const diagnostic of options.repo_source_diagnostics ?? []) {
    checks.push({
      kind: "repo",
      required: true,
      status: "blocked",
      target: diagnostic.path,
      message: diagnostic.message
    });
  }

  if (options.graph.nodes) {
    const context = await analyzeGraphContext({
      graph: { nodes: options.graph.nodes },
      repo_workspaces: options.repo_sources
    });
    for (const diagnostic of context.diagnostics) {
      if (diagnostic.severity !== "error") {
        continue;
      }

      checks.push({
        kind: "context",
        required: true,
        status: "blocked",
        target: `${diagnostic.authored_id}: ${diagnostic.path}`,
        message: diagnostic.message
      });
    }
  }

  if (options.machine_checks && options.graph.launch && options.graph.nodes) {
    checks.push(
      ...(await evaluateMachineReadiness({
        graph: {
          launch: options.graph.launch,
          nodes: options.graph.nodes,
          credential_specs: options.graph.credential_specs ?? {}
        },
        repo_sources: options.repo_sources,
        env: environment,
        ...(options.harnesses ? { harnesses: options.harnesses } : {})
      }))
    );
  }

  return summarizeStatus(checks);
}

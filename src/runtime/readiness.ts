import { accessSync, constants } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import type { CompiledExecutableNode, CompiledGraph } from "../graph/compiled.js";
import type { HarnessName } from "../graph/schema.js";
import { resolveSubpathWithinRoot } from "../path_rules.js";
import type { HarnessAdapter } from "./harness/types.js";

export type ReadinessCheckStatus = "passed" | "warning" | "blocked";
export type ReadinessStatus = "ready" | "warnings" | "blocked";

export interface ReadinessCheckResult {
  kind: "file" | "command" | "env" | "repo" | "harness";
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

function collectRequiredHarnesses(graph: Pick<CompiledGraph, "nodes">): HarnessName[] {
  const harnesses = new Set<HarnessName>();

  for (const node of graph.nodes) {
    const needsHarness = node.kind === "agent" || (node.kind === "check" && node.check_kind === "ai");

    if (needsHarness && node.effective_policy.harness) {
      harnesses.add(node.effective_policy.harness);
    }
  }

  return [...harnesses].sort();
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

async function evaluateMachineReadiness(options: {
  graph: Pick<CompiledGraph, "launch" | "nodes">;
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

  for (const harnessName of collectRequiredHarnesses(options.graph)) {
    checks.push(await evaluateHarnessReadiness(harnessName, options.harnesses));
  }

  return checks;
}

export async function evaluateGraphReadiness(options: {
  graph: Pick<CompiledGraph, "prerequisites"> & Partial<Pick<CompiledGraph, "launch" | "nodes">>;
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

  for (const check of options.graph.prerequisites.checks) {
    const required = check.required !== false;

    if (check.kind === "file") {
      checks.push(await evaluateFilePrerequisite(check.path, required, options.repo_sources));
      continue;
    }

    if (check.kind === "command") {
      checks.push(evaluateCommandPrerequisite(check.command, required, environment));
      continue;
    }

    if (check.kind === "env") {
      checks.push(
        buildIssue(
          "env",
          required,
          check.name,
          typeof environment[check.name] === "string" && environment[check.name]!.length > 0,
          typeof environment[check.name] === "string" && environment[check.name]!.length > 0
            ? `Environment variable "${check.name}" is set.`
            : `Environment variable "${check.name}" is not set.`
        )
      );
      continue;
    }

    checks.push(await evaluateRepoPrerequisite(check.repo, required, options.repo_sources));
  }

  if (options.machine_checks && options.graph.launch && options.graph.nodes) {
    checks.push(
      ...(await evaluateMachineReadiness({
        graph: {
          launch: options.graph.launch,
          nodes: options.graph.nodes
        },
        repo_sources: options.repo_sources,
        env: environment,
        ...(options.harnesses ? { harnesses: options.harnesses } : {})
      }))
    );
  }

  return summarizeStatus(checks);
}

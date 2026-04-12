import { stat } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import type { CompiledGraph } from "../graph/compiled.js";

export type ReadinessCheckStatus = "passed" | "warning" | "blocked";
export type ReadinessStatus = "ready" | "warnings" | "blocked";

export interface ReadinessCheckResult {
  kind: "file" | "command" | "env" | "repo";
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
  if (process.platform === "win32") {
    const result = spawnSync("where", [command], {
      env: environment,
      stdio: "ignore"
    });

    return buildIssue(
      "command",
      required,
      command,
      result.status === 0,
      result.status === 0
        ? `Command "${command}" is available.`
        : `Command "${command}" is not available on PATH.`
    );
  }

  const result = spawnSync("sh", ["-lc", `command -v -- '${quoteForSingleQuotedShell(command)}' >/dev/null 2>&1`], {
    env: environment,
    stdio: "ignore"
  });

  return buildIssue(
    "command",
    required,
    command,
    result.status === 0,
    result.status === 0
      ? `Command "${command}" is available.`
      : `Command "${command}" is not available on PATH.`
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

export async function evaluateGraphReadiness(options: {
  graph: Pick<CompiledGraph, "prerequisites">;
  repo_sources: Record<string, string>;
  repo_source_diagnostics?: Array<{ path: string; message: string }>;
  env?: NodeJS.ProcessEnv;
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

  return summarizeStatus(checks);
}

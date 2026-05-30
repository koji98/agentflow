import { execFile } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { resolveSubpathWithinRoot } from "../../path_rules.js";
import type { ContextItem } from "../../graph/authored.js";
import { normalizeRelativePath, splitQualifiedPath } from "../context/common.js";

const execFileAsync = promisify(execFile);
const gitMaxBuffer = 100 * 1024 * 1024;
const excludedRoots = new Set([
  ".agentflow",
  ".agentflow-runtime",
  ".git",
  ".next",
  ".turbo",
  ".vite",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target"
]);

export interface EphemeralInvestigationWorkspaceLease {
  source_path: string;
  workspace_path: string;
  manifest_path: string;
  included_file_count: number;
  explicit_context_file_count: number;
  cleanup: () => Promise<EphemeralInvestigationWorkspaceMetadata>;
}

export interface EphemeralInvestigationWorkspaceMetadata {
  kind: "ephemeral_investigation_workspace";
  source_path: string;
  workspace_path: string;
  manifest_path: string;
  included_file_count: number;
  explicit_context_file_count: number;
  status: "active" | "discarded" | "cleanup_failed";
  cleanup_error?: string;
}

function splitNulList(value: string): string[] {
  return value.split("\0").filter((entry) => entry.length > 0);
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    maxBuffer: gitMaxBuffer
  });
  return result.stdout;
}

function shouldMaterializeRelativePath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath).replace(/^\/+/u, "");
  if (normalized.length === 0 || normalized.includes("\0")) {
    return false;
  }
  const [root] = normalized.split("/");
  return root !== undefined && !excludedRoots.has(root);
}

function workspaceFileContextPaths(
  context: readonly ContextItem[],
  defaultRepoAlias: string
): string[] {
  const paths: string[] = [];

  for (const item of context) {
    if (!("from" in item) || item.from !== "workspace_file") {
      continue;
    }

    const { repo_alias, repo_relative_path } = splitQualifiedPath(item.path, defaultRepoAlias);
    if (repo_alias !== defaultRepoAlias || !shouldMaterializeRelativePath(repo_relative_path)) {
      continue;
    }
    paths.push(normalizeRelativePath(repo_relative_path));
  }

  return paths;
}

async function copyMaterializedFile(sourceRoot: string, workspaceRoot: string, relativePath: string): Promise<boolean> {
  if (!shouldMaterializeRelativePath(relativePath)) {
    return false;
  }

  const source = resolveSubpathWithinRoot(sourceRoot, relativePath, `Ephemeral source file "${relativePath}"`);
  const destination = resolveSubpathWithinRoot(workspaceRoot, relativePath, `Ephemeral destination file "${relativePath}"`);
  const sourceStat = await lstat(source).catch(() => undefined);
  if (!sourceStat?.isFile()) {
    return false;
  }

  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  return true;
}

async function materializeCurrentSourceState(options: {
  sourcePath: string;
  workspacePath: string;
  explicitContextPaths: string[];
}): Promise<{ included_file_count: number; explicit_context_file_count: number }> {
  const [trackedRaw, untrackedRaw] = await Promise.all([
    git(options.sourcePath, ["ls-files", "-z"]),
    git(options.sourcePath, ["ls-files", "--others", "--exclude-standard", "-z"])
  ]);
  const allPaths = new Set([
    ...splitNulList(trackedRaw),
    ...splitNulList(untrackedRaw),
    ...options.explicitContextPaths
  ]);
  let included = 0;
  let explicitIncluded = 0;

  for (const relativePath of [...allPaths].sort()) {
    const copied = await copyMaterializedFile(options.sourcePath, options.workspacePath, relativePath);
    if (copied) {
      included += 1;
      if (options.explicitContextPaths.includes(relativePath)) {
        explicitIncluded += 1;
      }
    }
  }

  return {
    included_file_count: included,
    explicit_context_file_count: explicitIncluded
  };
}

async function initializeSyntheticGitBaseline(workspacePath: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: workspacePath, maxBuffer: gitMaxBuffer });
  await execFileAsync("git", ["config", "user.email", "agentflow@example.com"], { cwd: workspacePath });
  await execFileAsync("git", ["config", "user.name", "Agentflow"], { cwd: workspacePath });
  await execFileAsync("git", ["config", "commit.gpgsign", "false"], { cwd: workspacePath });
  await execFileAsync("git", ["add", "-A"], { cwd: workspacePath, maxBuffer: gitMaxBuffer });
  await execFileAsync("git", ["commit", "--allow-empty", "-m", "ephemeral investigation baseline"], {
    cwd: workspacePath,
    maxBuffer: gitMaxBuffer
  });
}

async function writeManifest(path: string, metadata: EphemeralInvestigationWorkspaceMetadata): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

export async function createEphemeralInvestigationWorkspace(options: {
  source_path: string;
  execution_dir: string;
  repo_alias: string;
  context: readonly ContextItem[];
}): Promise<EphemeralInvestigationWorkspaceLease> {
  const workspacePath = join(options.execution_dir, "runtime", "ephemeral-investigation-workspace", "workspace");
  const manifestPath = join(options.execution_dir, "runtime", "ephemeral-investigation-workspace.json");
  await rm(workspacePath, { recursive: true, force: true });
  await mkdir(workspacePath, { recursive: true });

  const explicitContextPaths = workspaceFileContextPaths(options.context, options.repo_alias);
  const materialized = await materializeCurrentSourceState({
    sourcePath: options.source_path,
    workspacePath,
    explicitContextPaths
  });
  await initializeSyntheticGitBaseline(workspacePath);

  const activeMetadata: EphemeralInvestigationWorkspaceMetadata = {
    kind: "ephemeral_investigation_workspace",
    source_path: options.source_path,
    workspace_path: workspacePath,
    manifest_path: manifestPath,
    included_file_count: materialized.included_file_count,
    explicit_context_file_count: materialized.explicit_context_file_count,
    status: "active"
  };
  await writeManifest(manifestPath, activeMetadata);

  return {
    source_path: options.source_path,
    workspace_path: workspacePath,
    manifest_path: manifestPath,
    included_file_count: materialized.included_file_count,
    explicit_context_file_count: materialized.explicit_context_file_count,
    async cleanup() {
      let metadata: EphemeralInvestigationWorkspaceMetadata;
      try {
        await rm(workspacePath, { recursive: true, force: true });
        metadata = {
          ...activeMetadata,
          status: "discarded"
        };
      } catch (error) {
        metadata = {
          ...activeMetadata,
          status: "cleanup_failed",
          cleanup_error: readErrorMessage(error)
        };
      }
      await writeManifest(manifestPath, metadata);
      return metadata;
    }
  };
}

export async function readEphemeralInvestigationWorkspaceManifest(path: string): Promise<EphemeralInvestigationWorkspaceMetadata | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as EphemeralInvestigationWorkspaceMetadata;
  } catch {
    return undefined;
  }
}

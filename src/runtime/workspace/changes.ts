import { execFile } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { resolveRunArtifactPaths } from "../../artifacts/paths.js";
import type { WorkspaceChangeArtifacts } from "../session.js";
import type { WorkspaceBackendBinding } from "./types.js";

const execFileAsync = promisify(execFile);
const gitMaxBuffer = 100 * 1024 * 1024;

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_") || "repo";
}

function splitNulList(value: string): string[] {
  return value.split("\0").filter((entry) => entry.length > 0);
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function git(
  cwd: string,
  args: string[]
): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    maxBuffer: gitMaxBuffer
  });
  return result.stdout;
}

async function gitDiffNoIndex(cwd: string, filePath: string): Promise<string> {
  try {
    return await git(cwd, ["diff", "--binary", "--no-index", "--", "/dev/null", filePath]);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "stdout" in error &&
      typeof error.stdout === "string"
    ) {
      return error.stdout;
    }

    throw error;
  }
}

async function collectUntrackedDiff(cwd: string, files: string[]): Promise<string> {
  const chunks: string[] = [];

  for (const file of files) {
    const fileStat = await stat(join(cwd, file)).catch(() => undefined);

    if (!fileStat?.isFile()) {
      continue;
    }

    chunks.push(await gitDiffNoIndex(cwd, file));
  }

  return chunks.join(chunks.length > 0 ? "\n" : "");
}

async function captureOneWorkspaceChange(
  runRoot: string,
  binding: WorkspaceBackendBinding
): Promise<WorkspaceChangeArtifacts> {
  const paths = resolveRunArtifactPaths(runRoot);
  const outputDir = join(paths.workspace_changes_dir, safeSegment(binding.repo_alias));
  await mkdir(outputDir, { recursive: true });

  const status_file = join(outputDir, "status.txt");
  const diff_file = join(outputDir, "diff.patch");
  const changed_files_file = join(outputDir, "changed-files.json");

  const artifact: WorkspaceChangeArtifacts = {
    repo_alias: binding.repo_alias,
    workspace_path: binding.workspace_path,
    status_file,
    diff_file,
    changed_files_file,
    changed_files: []
  };

  try {
    const [status, trackedDiff, changedTracked, untracked] = await Promise.all([
      git(binding.workspace_path, ["status", "--porcelain=v1", "--untracked-files=all"]),
      git(binding.workspace_path, ["diff", "--binary", "HEAD", "--"]),
      git(binding.workspace_path, ["diff", "--name-only", "-z", "HEAD", "--"]),
      git(binding.workspace_path, ["ls-files", "--others", "--exclude-standard", "-z"])
    ]);
    const untrackedFiles = splitNulList(untracked);
    const changedFiles = [...new Set([...splitNulList(changedTracked), ...untrackedFiles])].sort();
    const untrackedDiff = await collectUntrackedDiff(binding.workspace_path, untrackedFiles);
    const diff = `${trackedDiff}${trackedDiff && untrackedDiff ? "\n" : ""}${untrackedDiff}`;

    artifact.changed_files = changedFiles;
    await Promise.all([
      writeFile(status_file, status, "utf8"),
      writeFile(diff_file, diff, "utf8"),
      writeFile(changed_files_file, `${JSON.stringify(changedFiles, null, 2)}\n`, "utf8")
    ]);
  } catch (error) {
    const capture_error_file = join(outputDir, "capture-error.txt");
    artifact.capture_error_file = capture_error_file;
    await Promise.all([
      writeFile(status_file, "", "utf8"),
      writeFile(diff_file, "", "utf8"),
      writeFile(changed_files_file, "[]\n", "utf8"),
      writeFile(capture_error_file, `${readErrorMessage(error)}\n`, "utf8")
    ]);
  }

  return artifact;
}

export async function captureWorkspaceChanges(
  runRoot: string,
  bindings: WorkspaceBackendBinding[]
): Promise<Record<string, WorkspaceChangeArtifacts>> {
  const captured = await Promise.all(
    bindings.map((binding) => captureOneWorkspaceChange(runRoot, binding))
  );

  return Object.fromEntries(captured.map((artifact) => [artifact.repo_alias, artifact]));
}

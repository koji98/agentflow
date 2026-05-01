import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type {
  NodeWorkspaceChangeArtifacts,
  NodeWorkspaceChangedFile,
  NodeWorkspaceDiff,
  NodeWorkspaceRestoreResult,
  NodeWorkspaceSnapshot
} from "./types.js";

const execFileAsync = promisify(execFile);
const gitMaxBuffer = 100 * 1024 * 1024;

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function splitNulList(value: string): string[] {
  return value.split("\0").filter((entry) => entry.length > 0);
}

async function git(workspacePath: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: workspacePath,
    maxBuffer: gitMaxBuffer
  });
  return result.stdout;
}

async function tryGit(workspacePath: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync("git", args, {
      cwd: workspacePath,
      maxBuffer: gitMaxBuffer
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "stdout" in error &&
      "stderr" in error &&
      "code" in error
    ) {
      const raw = error as { stdout?: unknown; stderr?: unknown; code?: unknown };
      return {
        stdout: typeof raw.stdout === "string" ? raw.stdout : "",
        stderr: typeof raw.stderr === "string" ? raw.stderr : "",
        code: typeof raw.code === "number" ? raw.code : 1
      };
    }

    throw error;
  }
}

export async function snapshotWorkspaceForNode(workspacePath: string): Promise<NodeWorkspaceSnapshot> {
  try {
    const headSha = (await git(workspacePath, ["rev-parse", "HEAD"])).trim();
    const stashAttempt = await tryGit(workspacePath, ["stash", "create"]);
    const stashSha = stashAttempt.code === 0 ? stashAttempt.stdout.trim() : "";
    const untrackedRaw = await git(workspacePath, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z"
    ]);
    const statusText = await git(workspacePath, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all"
    ]);

    return {
      head_sha: headSha,
      stash_sha: stashSha,
      untracked_files: splitNulList(untrackedRaw).sort(),
      status_text: statusText
    };
  } catch (error) {
    return {
      head_sha: "",
      stash_sha: "",
      untracked_files: [],
      status_text: "",
      capture_error: readErrorMessage(error)
    };
  }
}

function pickRef(snapshot: NodeWorkspaceSnapshot): string {
  return snapshot.stash_sha.length > 0 ? snapshot.stash_sha : snapshot.head_sha;
}

function isSafeWorkspacePath(workspacePath: string, path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\0")) {
    return false;
  }
  const absolute = resolve(workspacePath, path);
  const root = resolve(workspacePath);
  return absolute === root || absolute.startsWith(`${root}${sep}`);
}

async function gitDiffNoIndex(workspacePath: string, filePath: string): Promise<string> {
  const result = await tryGit(workspacePath, [
    "diff",
    "--binary",
    "--no-index",
    "--",
    "/dev/null",
    filePath
  ]);
  return result.stdout;
}

async function collectUntrackedDiff(
  workspacePath: string,
  files: readonly string[]
): Promise<{ patch: string; included: string[] }> {
  const chunks: string[] = [];
  const included: string[] = [];

  for (const file of files) {
    const fileStat = await stat(join(workspacePath, file)).catch(() => undefined);

    if (!fileStat?.isFile()) {
      continue;
    }

    const chunk = await gitDiffNoIndex(workspacePath, file);
    if (chunk.length > 0) {
      chunks.push(chunk);
      included.push(file);
    }
  }

  return {
    patch: chunks.join(chunks.length > 0 ? "\n" : ""),
    included
  };
}

async function readChangedTrackedFiles(
  workspacePath: string,
  beforeRef: string,
  afterRef: string
): Promise<string[]> {
  if (beforeRef.length === 0 || afterRef.length === 0) {
    return [];
  }

  const stdout = await git(workspacePath, [
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    beforeRef,
    afterRef
  ]);
  return splitNulList(stdout);
}

export async function diffNodeSnapshots(
  workspacePath: string,
  before: NodeWorkspaceSnapshot,
  after: NodeWorkspaceSnapshot
): Promise<NodeWorkspaceDiff> {
  const upstreamCaptureError = before.capture_error ?? after.capture_error;
  if (upstreamCaptureError) {
    return {
      status_text_after: after.status_text,
      diff_patch: "",
      changed_files: [],
      deleted_untracked: [],
      capture_error: upstreamCaptureError
    };
  }

  try {
    const beforeRef = pickRef(before);
    const afterRef = pickRef(after);

    let trackedDiff = "";
    let trackedChanged: string[] = [];

    if (beforeRef !== afterRef && beforeRef.length > 0 && afterRef.length > 0) {
      trackedDiff = await git(workspacePath, ["diff", "--binary", "--no-renames", beforeRef, afterRef]);
      trackedChanged = await readChangedTrackedFiles(workspacePath, beforeRef, afterRef);
    } else if (beforeRef.length === 0 && afterRef.length > 0) {
      trackedDiff = await git(workspacePath, ["diff", "--binary", "--no-renames", before.head_sha, afterRef]);
      trackedChanged = await readChangedTrackedFiles(workspacePath, before.head_sha, afterRef);
    } else if (beforeRef.length > 0 && afterRef.length === 0) {
      trackedDiff = await git(workspacePath, ["diff", "--binary", "--no-renames", beforeRef, after.head_sha]);
      trackedChanged = await readChangedTrackedFiles(workspacePath, beforeRef, after.head_sha);
    }

    const beforeUntracked = new Set(before.untracked_files);
    const afterUntracked = new Set(after.untracked_files);
    const newUntracked = [...afterUntracked].filter((path) => !beforeUntracked.has(path)).sort();
    const deletedUntracked = [...beforeUntracked].filter((path) => !afterUntracked.has(path)).sort();

    const untracked = await collectUntrackedDiff(workspacePath, newUntracked);
    const diffPatch = `${trackedDiff}${trackedDiff && untracked.patch ? "\n" : ""}${untracked.patch}`;

    const changed: NodeWorkspaceChangedFile[] = [
      ...trackedChanged.sort().map((path) => ({ path, change_kind: "tracked" as const })),
      ...untracked.included.map((path) => ({ path, change_kind: "untracked_added" as const })),
      ...deletedUntracked.map((path) => ({ path, change_kind: "untracked_deleted" as const }))
    ];

    return {
      status_text_after: after.status_text,
      diff_patch: diffPatch,
      changed_files: changed,
      deleted_untracked: deletedUntracked
    };
  } catch (error) {
    return {
      status_text_after: after.status_text,
      diff_patch: "",
      changed_files: [],
      deleted_untracked: [],
      capture_error: readErrorMessage(error)
    };
  }
}

export const nodeWorkspaceChangesDirName = "workspace-changes";

function nodeWorkspaceChangesDir(attemptDir: string): string {
  return join(attemptDir, nodeWorkspaceChangesDirName);
}

export function resolveNodeWorkspaceChangePaths(attemptDir: string): {
  dir: string;
  baseline_path: string;
  after_path: string;
  status_path: string;
  diff_patch_path: string;
  changed_files_path: string;
  capture_error_path: string;
} {
  const dir = nodeWorkspaceChangesDir(attemptDir);
  return {
    dir,
    baseline_path: join(dir, "baseline.json"),
    after_path: join(dir, "after.json"),
    status_path: join(dir, "status.txt"),
    diff_patch_path: join(dir, "diff.patch"),
    changed_files_path: join(dir, "changed-files.json"),
    capture_error_path: join(dir, "capture-error.txt")
  };
}

export async function persistNodeBaselineSnapshot(
  attemptDir: string,
  snapshot: NodeWorkspaceSnapshot
): Promise<string> {
  const paths = resolveNodeWorkspaceChangePaths(attemptDir);
  await mkdir(paths.dir, { recursive: true });
  await writeFile(paths.baseline_path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return paths.baseline_path;
}

export async function persistNodeWorkspaceChanges(
  attemptDir: string,
  before: NodeWorkspaceSnapshot,
  after: NodeWorkspaceSnapshot,
  diff: NodeWorkspaceDiff
): Promise<NodeWorkspaceChangeArtifacts> {
  const paths = resolveNodeWorkspaceChangePaths(attemptDir);
  await mkdir(paths.dir, { recursive: true });

  await Promise.all([
    writeFile(paths.baseline_path, `${JSON.stringify(before, null, 2)}\n`, "utf8"),
    writeFile(paths.after_path, `${JSON.stringify(after, null, 2)}\n`, "utf8"),
    writeFile(paths.status_path, diff.status_text_after, "utf8"),
    writeFile(paths.diff_patch_path, diff.diff_patch, "utf8"),
    writeFile(paths.changed_files_path, `${JSON.stringify(diff.changed_files, null, 2)}\n`, "utf8")
  ]);

  const captureError = before.capture_error ?? after.capture_error ?? diff.capture_error;
  let captureErrorPath: string | undefined;
  if (captureError) {
    captureErrorPath = paths.capture_error_path;
    await writeFile(captureErrorPath, `${captureError}\n`, "utf8");
  }

  return {
    baseline_path: paths.baseline_path,
    after_path: paths.after_path,
    status_path: paths.status_path,
    diff_patch_path: paths.diff_patch_path,
    changed_files_path: paths.changed_files_path,
    ...(captureErrorPath ? { capture_error_path: captureErrorPath } : {}),
    changed_file_count: diff.changed_files.length,
    status: captureError ? "degraded" : "captured"
  };
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export async function restoreNodeWorkspaceChangesFromSnapshot(options: {
  workspacePath: string;
  attemptDir: string;
  resultPath?: string;
}): Promise<NodeWorkspaceRestoreResult> {
  const paths = resolveNodeWorkspaceChangePaths(options.attemptDir);
  const before = parseJson<NodeWorkspaceSnapshot>(
    await readFile(paths.baseline_path, "utf8").catch(() => "{}"),
    {
      head_sha: "",
      stash_sha: "",
      untracked_files: [],
      status_text: ""
    }
  );
  const changedFiles = parseJson<NodeWorkspaceChangedFile[]>(
    await readFile(paths.changed_files_path, "utf8").catch(() => "[]"),
    []
  );
  const ref = pickRef(before);
  const cleanedFiles: string[] = [];
  const skippedFiles: NodeWorkspaceRestoreResult["skipped_files"] = [];
  const errors: string[] = [];

  for (const changed of changedFiles) {
    if (!isSafeWorkspacePath(options.workspacePath, changed.path)) {
      skippedFiles.push({
        path: changed.path,
        reason: "Path is outside the workspace or is not a safe relative path."
      });
      continue;
    }

    if (changed.change_kind === "untracked_added") {
      try {
        await rm(join(options.workspacePath, changed.path), { recursive: true, force: true });
        cleanedFiles.push(changed.path);
      } catch (error) {
        errors.push(`${changed.path}: ${readErrorMessage(error)}`);
      }
      continue;
    }

    if (changed.change_kind === "untracked_deleted") {
      skippedFiles.push({
        path: changed.path,
        reason: "The baseline snapshot records untracked file names but not their contents."
      });
      continue;
    }

    if (ref.length === 0) {
      skippedFiles.push({
        path: changed.path,
        reason: "No baseline git ref was available for restoring tracked content."
      });
      continue;
    }

    const result = await tryGit(options.workspacePath, ["checkout", ref, "--", changed.path]);
    if (result.code === 0) {
      cleanedFiles.push(changed.path);
    } else {
      errors.push(`${changed.path}: ${result.stderr || result.stdout || `git checkout exited ${result.code}`}`);
    }
  }

  const restoreResult: NodeWorkspaceRestoreResult = {
    status: errors.length > 0
      ? "failed"
      : skippedFiles.length > 0
        ? "partial"
        : "passed",
    strategy: "restore_failed_attempt_changes",
    cleaned_files: [...new Set(cleanedFiles)].sort(),
    skipped_files: skippedFiles,
    errors
  };

  if (options.resultPath) {
    await writeFile(options.resultPath, `${JSON.stringify(restoreResult, null, 2)}\n`, "utf8");
  }

  return restoreResult;
}

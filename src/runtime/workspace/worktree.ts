import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type {
  WorkspaceBackendBinding,
  WorkspaceBackendOptions,
  WorkspaceSetup
} from "./types.js";

const execFileAsync = promisify(execFile);

async function assertGitRepository(sourcePath: string): Promise<void> {
  const result = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: sourcePath
  });

  if (result.stdout.trim() !== "true") {
    throw new Error(`Repo "${sourcePath}" is not a git worktree.`);
  }
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingWorktreeError(message: string): boolean {
  const normalized = message.toLowerCase();
  return [
    "is not a working tree",
    "not found",
    "does not exist",
    "no such file or directory",
    "cannot find"
  ].some((fragment) => normalized.includes(fragment));
}

async function removeWorktreeBinding(binding: WorkspaceBackendBinding): Promise<void> {
  let removeError: string | undefined;

  try {
    await execFileAsync("git", ["worktree", "remove", "--force", binding.workspace_path], {
      cwd: binding.source_path
    });
  } catch (error) {
    removeError = readErrorMessage(error);
  }

  await rm(binding.workspace_path, { recursive: true, force: true });

  try {
    await execFileAsync("git", ["worktree", "prune", "--expire", "now"], {
      cwd: binding.source_path
    });
  } catch (error) {
    if (!removeError) {
      removeError = readErrorMessage(error);
    }
  }

  if (removeError && !isMissingWorktreeError(removeError)) {
    throw new Error(
      `Failed to clean worktree "${binding.workspace_path}" for repo "${binding.repo_alias}": ${removeError}`
    );
  }
}

export async function cleanupWorktreeBindings(bindings: WorkspaceBackendBinding[]): Promise<void> {
  const cleanupErrors: string[] = [];

  for (const binding of [...bindings].reverse()) {
    try {
      await removeWorktreeBinding(binding);
    } catch (error) {
      cleanupErrors.push(readErrorMessage(error));
    }
  }

  if (cleanupErrors.length > 0) {
    throw new Error(cleanupErrors.join(" | "));
  }
}

export async function initializeWorktreeWorkspace(
  options: WorkspaceBackendOptions
): Promise<WorkspaceSetup> {
  const workspacesRoot = join(options.run_root, "workspaces");
  await mkdir(workspacesRoot, { recursive: true });

  const createdBindings: WorkspaceBackendBinding[] = [];

  try {
    for (const [repo_alias, source_path] of Object.entries(options.repo_sources)) {
      await assertGitRepository(source_path);

      const workspace_path = join(workspacesRoot, repo_alias);
      await execFileAsync("git", ["worktree", "add", "--detach", workspace_path, "HEAD"], {
        cwd: source_path
      });
      createdBindings.push({
        repo_alias,
        source_path,
        workspace_path,
        backend: "worktree"
      });
    }
  } catch (error) {
    try {
      await cleanupWorktreeBindings(createdBindings);
    } catch (cleanupError) {
      throw new Error(
        `${readErrorMessage(error)} | Worktree rollback failed: ${readErrorMessage(cleanupError)}`
      );
    }

    throw error;
  }

  const repo_workspaces = Object.fromEntries(
    createdBindings.map((binding) => [
      binding.repo_alias,
      binding
    ])
  );

  return {
    backend: "worktree",
    repo_workspaces,
    async cleanup() {
      await cleanupWorktreeBindings(createdBindings);
    }
  };
}

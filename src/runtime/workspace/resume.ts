import { access, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { promisify } from "node:util";

import type { ExecutionManifest } from "../session.js";
import type {
  WorkspaceBackendBinding,
  WorkspaceSetup
} from "./types.js";
import { cleanupWorktreeBindings } from "./worktree.js";

const execFileAsync = promisify(execFile);

async function assertGitWorktree(path: string): Promise<void> {
  const result = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: path
  });

  if (result.stdout.trim() !== "true") {
    throw new Error(`Workspace "${path}" is not a git worktree.`);
  }
}

async function ensureWorktreeBinding(binding: WorkspaceBackendBinding): Promise<void> {
  await assertGitWorktree(binding.source_path);

  try {
    await access(binding.workspace_path);
    await assertGitWorktree(binding.workspace_path);
    return;
  } catch {
    await mkdir(dirname(binding.workspace_path), { recursive: true });
    await execFileAsync("git", ["worktree", "add", "--detach", binding.workspace_path, "HEAD"], {
      cwd: binding.source_path
    });
  }
}

export async function resumeWorkspaceFromManifest(
  manifest: ExecutionManifest
): Promise<WorkspaceSetup> {
  const bindings = Object.values(manifest.repo_workspaces);

  if (manifest.workspace_backend === "inplace") {
    await Promise.all(
      bindings.map(async (binding) => {
        await access(binding.source_path);
        await access(binding.workspace_path);
      })
    );

    return {
      backend: "inplace",
      repo_workspaces: manifest.repo_workspaces,
      async cleanup() {
        return;
      }
    };
  }

  for (const binding of bindings) {
    await ensureWorktreeBinding(binding);
  }

  return {
    backend: "worktree",
    repo_workspaces: manifest.repo_workspaces,
    async cleanup() {
      await cleanupWorktreeBindings(bindings);
    }
  };
}

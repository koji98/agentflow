import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { resolveRunArtifactPaths } from "../../artifacts/paths.js";
import { readExecutionManifest, readRunState } from "../../artifacts/reader.js";
import {
  createResumeCliInvocation,
  renderCommandUsageError
} from "../command_support.js";

const execFileAsync = promisify(execFile);
const gitMaxBuffer = 100 * 1024 * 1024;

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_") || "repo";
}

function readErrorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr.trim() : "";
    const stdout = "stdout" in error && typeof error.stdout === "string" ? error.stdout.trim() : "";
    const message = error instanceof Error ? error.message : String(error);
    return stderr || stdout || message;
  }

  return String(error);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    maxBuffer: gitMaxBuffer
  });
  return result.stdout;
}

async function isGitWorktree(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
  } catch {
    return false;
  }
}

async function readJsonFile<TPayload>(filePath: string): Promise<TPayload> {
  return JSON.parse(await readFile(filePath, "utf8")) as TPayload;
}

function pickRepoAlias(
  requestedRepoAlias: string | undefined,
  availableRepoAliases: string[]
): { repo_alias?: string; error?: string } {
  if (requestedRepoAlias) {
    return availableRepoAliases.includes(requestedRepoAlias)
      ? { repo_alias: requestedRepoAlias }
      : {
          error:
            `Run does not contain workspace changes for repo "${requestedRepoAlias}". ` +
            `Available repos: ${availableRepoAliases.join(", ") || "none"}.`
        };
  }

  if (availableRepoAliases.length === 1) {
    const repoAlias = availableRepoAliases[0];
    return repoAlias
      ? { repo_alias: repoAlias }
      : { error: "Run does not contain captured workspace changes to apply." };
  }

  return {
    error:
      availableRepoAliases.length === 0
        ? "Run does not contain captured workspace changes to apply."
        : `Run contains multiple repos (${availableRepoAliases.join(", ")}). Pass --repo <alias>.`
  };
}

export const applyCommand = {
  name: "apply",
  summary: "Apply captured workspace changes from a run back to a git repo.",
  usage:
    "agentflow apply --run-root <path/to/run-root> [--repo <alias>] [--target <path>] [--allow-dirty] [--commit-message <message>]",
  examples: [
    "agentflow apply --run-root .task-runtime/runs/<run-id>",
    "agentflow apply --run-root .task-runtime/runs/<run-id> --repo main",
    "agentflow apply --run-root .task-runtime/runs/<run-id> --commit-message 'Apply Agentflow run changes'"
  ] as const,
  optionNames: ["run-root", "repo", "target", "allow-dirty", "commit-message", "help"] as const,
  helpNotes: [
    "Applies workspace-changes/<repo>/diff.patch from the selected run.",
    "Defaults --target to the original source repo path recorded in execution_manifest.json.",
    "Refuses to apply onto a dirty target unless --allow-dirty is passed.",
    "Passing --commit-message stages the captured changed files and creates a git commit after applying."
  ] as const,
  async run(
    options: Record<string, string | boolean | string[] | undefined>,
    currentWorkingDirectory: string
  ) {
    const runRootInput = typeof options["run-root"] === "string" ? options["run-root"] : undefined;

    if (!runRootInput) {
      return {
        exitCode: 2,
        stdout: renderCommandUsageError({
          message: "Missing required option: --run-root",
          commandName: this.name,
          usage: this.usage
        })
      };
    }

    const run_root = resolve(currentWorkingDirectory, runRootInput);
    const paths = resolveRunArtifactPaths(run_root);
    const [manifest, state] = await Promise.all([
      readExecutionManifest(run_root),
      readRunState(run_root)
    ]);
    const requestedRepoAlias = typeof options.repo === "string" ? options.repo : undefined;
    const availableRepoAliases = Object.keys(state.workspace_change_artifacts).sort();
    const picked = pickRepoAlias(requestedRepoAlias, availableRepoAliases);

    if (!picked.repo_alias) {
      return {
        exitCode: 1,
        output: {
          command: "apply",
          status: "failed",
          message: picked.error,
          run_root,
          available_repos: availableRepoAliases,
          next_steps: {
            resume: createResumeCliInvocation(run_root)
          }
        }
      };
    }

    const repo_alias = picked.repo_alias;
    const binding = manifest.repo_workspaces[repo_alias];
    const changeArtifact = state.workspace_change_artifacts[repo_alias];
    const target_path =
      typeof options.target === "string"
        ? resolve(currentWorkingDirectory, options.target)
        : binding?.source_path;

    if (!binding || !target_path) {
      return {
        exitCode: 1,
        output: {
          command: "apply",
          status: "failed",
          message: `Run does not record a source repo binding for repo "${repo_alias}".`,
          run_root,
          repo_alias
        }
      };
    }

    if (!await isGitWorktree(target_path)) {
      return {
        exitCode: 1,
        output: {
          command: "apply",
          status: "failed",
          message: `Target path is not a git worktree: ${target_path}`,
          run_root,
          repo_alias,
          target_path
        }
      };
    }

    const diff_file =
      changeArtifact?.diff_file ?? `${paths.workspace_changes_dir}/${safeSegment(repo_alias)}/diff.patch`;
    const changed_files_file =
      changeArtifact?.changed_files_file ?? `${paths.workspace_changes_dir}/${safeSegment(repo_alias)}/changed-files.json`;

    try {
      await access(diff_file);
    } catch {
      return {
        exitCode: 1,
        output: {
          command: "apply",
          status: "failed",
          message: `Captured patch file is missing: ${diff_file}`,
          run_root,
          repo_alias,
          target_path,
          diff_file
        }
      };
    }

    const diff = await readFile(diff_file, "utf8");
    const changed_files = await readJsonFile<string[]>(changed_files_file).catch(
      () => changeArtifact?.changed_files ?? []
    );

    if (diff.trim().length === 0) {
      return {
        exitCode: 0,
        output: {
          command: "apply",
          status: "skipped",
          message: "Captured workspace patch is empty; nothing was applied.",
          run_root,
          repo_alias,
          target_path,
          diff_file,
          changed_files
        }
      };
    }

    const allowDirty = options["allow-dirty"] === true;
    const targetStatus = await git(target_path, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all"
    ]);

    if (!allowDirty && targetStatus.trim().length > 0) {
      return {
        exitCode: 1,
        output: {
          command: "apply",
          status: "failed",
          message: "Target repo has existing changes. Commit, stash, or pass --allow-dirty before applying.",
          run_root,
          repo_alias,
          target_path,
          diff_file,
          target_status: targetStatus
        }
      };
    }

    try {
      await git(target_path, ["apply", "--check", "--binary", diff_file]);
      await git(target_path, ["apply", "--binary", diff_file]);
    } catch (error) {
      return {
        exitCode: 1,
        output: {
          command: "apply",
          status: "failed",
          message: `Captured patch did not apply cleanly: ${readErrorMessage(error)}`,
          run_root,
          repo_alias,
          target_path,
          diff_file,
          changed_files
        }
      };
    }

    const commitMessage =
      typeof options["commit-message"] === "string" ? options["commit-message"].trim() : undefined;
    let commit: { sha: string; message: string } | undefined;

    if (commitMessage) {
      if (changed_files.length > 0) {
        await git(target_path, ["add", "--", ...changed_files]);
      }

      try {
        await git(target_path, ["diff", "--cached", "--quiet"]);
      } catch {
        await git(target_path, ["commit", "-m", commitMessage]);
        commit = {
          sha: (await git(target_path, ["rev-parse", "HEAD"])).trim(),
          message: commitMessage
        };
      }
    }

    return {
      exitCode: 0,
      output: {
        command: "apply",
        status: "passed",
        message: commit
          ? "Captured workspace patch was applied and committed."
          : "Captured workspace patch was applied.",
        run_root,
        repo_alias,
        target_path,
        diff_file,
        changed_files,
        ...(commit ? { commit } : {})
      }
    };
  }
};

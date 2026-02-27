import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { log } from './log.ts';
import type { Session, TaskLaunch } from './types.ts';

/**
 * Creates a new git worktree and its tracking branch.
 * @param projectRoot Absolute path to the main repository.
 * @param branch Branch name for the new worktree.
 * @param target Absolute path where the worktree will be created.
 * @param dryRun When true, prints the command without executing.
 * @throws {Error} When the `git worktree add` command fails.
 */
export function addWorktree(
  projectRoot: string,
  branch: string,
  target: string,
  dryRun: boolean,
): void {
  const cmd = ['git', 'worktree', 'add', '-b', branch, target, 'HEAD'];
  if (dryRun) {
    log(`$ ${cmd.map((c) => JSON.stringify(c)).join(' ')}`);
    return;
  }

  const result = spawnSync(cmd[0], cmd.slice(1), { cwd: projectRoot, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`git worktree add failed (exit=${result.status}).`);
  }
}

/**
 * Force-removes a git worktree directory.
 * @param projectRoot Absolute path to the main repository.
 * @param target Absolute path to the worktree to remove.
 * @param dryRun When true, prints the command without executing.
 * @throws {Error} When the `git worktree remove` command fails.
 */
export function removeWorktree(projectRoot: string, target: string, dryRun: boolean): void {
  const cmd = ['git', 'worktree', 'remove', '--force', target];
  if (dryRun) {
    log(`$ ${cmd.map((c) => JSON.stringify(c)).join(' ')}`);
    return;
  }

  const result = spawnSync(cmd[0], cmd.slice(1), { cwd: projectRoot, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`git worktree remove failed (exit=${result.status}).`);
  }
}

/**
 * Force-deletes a local git branch.
 * @param projectRoot Absolute path to the main repository.
 * @param branch Branch name to delete.
 * @param dryRun When true, prints the command without executing.
 * @throws {Error} When the `git branch -D` command fails.
 */
export function removeBranch(projectRoot: string, branch: string, dryRun: boolean): void {
  const cmd = ['git', 'branch', '-D', branch];
  if (dryRun) {
    log(`$ ${cmd.map((c) => JSON.stringify(c)).join(' ')}`);
    return;
  }

  const result = spawnSync(cmd[0], cmd.slice(1), { cwd: projectRoot, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`git branch -D failed (exit=${result.status}).`);
  }
}

/**
 * Prepares task launch directories and worktrees, writing prompt files.
 * @param session Current run session.
 * @param launches Array of task launch descriptors to prepare.
 */
export function prepareLaunches(session: Session, launches: TaskLaunch[]): void {
  for (const launch of launches) {
    if (!session.dryRun) {
      fs.mkdirSync(launch.taskDir, { recursive: true });
      if (launch.useWorktree && launch.branch && !fs.existsSync(launch.workspaceCwd)) {
        addWorktree(launch.repoRoot, launch.branch, launch.workspaceCwd, false);
        session.worktreeTracker.created.set(launch.workspaceCwd, launch.repoRoot);
        session.worktreeTracker.createdBranches.set(launch.branch, launch.repoRoot);
      }
      fs.writeFileSync(launch.promptPath, launch.promptText, 'utf8');
    } else {
      log(`[dry-run] prepare ${launch.taskDir}`);
      if (launch.useWorktree && launch.branch) {
        addWorktree(launch.repoRoot, launch.branch, launch.workspaceCwd, true);
        session.worktreeTracker.createdBranches.set(launch.branch, launch.repoRoot);
      }
    }
  }
}

/**
 * Removes all worktrees and branches created during the run.
 * @param session Current run session.
 */
export function cleanupWorktrees(session: Session): void {
  if (!session.plan.options.cleanupWorktrees) return;
  if (session.worktreeTracker.created.size === 0 && session.worktreeTracker.createdBranches.size === 0) return;

  log('\ncleanup: removing worktrees');
  for (const [worktree, repoRoot] of [...session.worktreeTracker.created.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    try {
      removeWorktree(repoRoot, worktree, session.dryRun);
    } catch (error) {
      log(`warning: failed to remove worktree ${worktree}: ${String(error)}`);
    }
  }
  for (const [branch, repoRoot] of [...session.worktreeTracker.createdBranches.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    try {
      removeBranch(repoRoot, branch, session.dryRun);
    } catch (error) {
      log(`warning: failed to delete branch ${branch}: ${String(error)}`);
    }
  }
}

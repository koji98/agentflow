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
    if (!session.dry_run) {
      fs.mkdirSync(launch.task_dir, { recursive: true });
      if (launch.use_worktree && launch.branch && !fs.existsSync(launch.workspace_cwd)) {
        addWorktree(session.paths.project_root, launch.branch, launch.workspace_cwd, false);
        session.worktree_tracker.created.add(launch.workspace_cwd);
        session.worktree_tracker.created_branches.add(launch.branch);
      }
      fs.writeFileSync(launch.prompt_path, launch.prompt_text, 'utf8');
    } else {
      log(`[dry-run] prepare ${launch.task_dir}`);
      if (launch.use_worktree && launch.branch) {
        addWorktree(session.paths.project_root, launch.branch, launch.workspace_cwd, true);
        session.worktree_tracker.created_branches.add(launch.branch);
      }
    }
  }
}

/**
 * Removes all worktrees and branches created during the run.
 * @param session Current run session.
 */
export function cleanupWorktrees(session: Session): void {
  if (!session.plan.options.cleanup_worktrees) return;
  if (session.worktree_tracker.created.size === 0 && session.worktree_tracker.created_branches.size === 0) return;

  log('\ncleanup: removing worktrees');
  for (const worktree of [...session.worktree_tracker.created].sort()) {
    try {
      removeWorktree(session.paths.project_root, worktree, session.dry_run);
    } catch (error) {
      log(`warning: failed to remove worktree ${worktree}: ${String(error)}`);
    }
  }
  for (const branch of [...session.worktree_tracker.created_branches].sort()) {
    try {
      removeBranch(session.paths.project_root, branch, session.dry_run);
    } catch (error) {
      log(`warning: failed to delete branch ${branch}: ${String(error)}`);
    }
  }
}

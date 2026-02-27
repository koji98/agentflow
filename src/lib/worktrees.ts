import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import type { Session, TaskLaunch } from './types.ts';

/**
 * Creates a git worktree on a new branch.
 * @param projectRoot Repository root where git commands run.
 * @param branch New branch name to create.
 * @param target Filesystem path for the worktree checkout.
 * @param dryRun When true, prints command without executing.
 * @returns Nothing.
 */
export function addWorktree(
  projectRoot: string,
  branch: string,
  target: string,
  dryRun: boolean,
): void {
  const cmd = ['git', 'worktree', 'add', '-b', branch, target, 'HEAD'];
  if (dryRun) {
    // eslint-disable-next-line no-console
    console.log(`$ ${cmd.map((c) => JSON.stringify(c)).join(' ')}`);
    return;
  }

  const result = spawnSync(cmd[0], cmd.slice(1), { cwd: projectRoot, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`git worktree add failed (exit=${result.status}).`);
  }
}

/**
 * Removes a git worktree directory.
 * @param projectRoot Repository root where git commands run.
 * @param target Worktree directory path to remove.
 * @param dryRun When true, prints command without executing.
 * @returns Nothing.
 */
export function removeWorktree(projectRoot: string, target: string, dryRun: boolean): void {
  const cmd = ['git', 'worktree', 'remove', '--force', target];
  if (dryRun) {
    // eslint-disable-next-line no-console
    console.log(`$ ${cmd.map((c) => JSON.stringify(c)).join(' ')}`);
    return;
  }

  const result = spawnSync(cmd[0], cmd.slice(1), { cwd: projectRoot, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`git worktree remove failed (exit=${result.status}).`);
  }
}

/**
 * Deletes a git branch used for worktree execution.
 * @param projectRoot Repository root where git commands run.
 * @param branch Branch name to delete.
 * @param dryRun When true, prints command without executing.
 * @returns Nothing.
 */
export function removeBranch(projectRoot: string, branch: string, dryRun: boolean): void {
  const cmd = ['git', 'branch', '-D', branch];
  if (dryRun) {
    // eslint-disable-next-line no-console
    console.log(`$ ${cmd.map((c) => JSON.stringify(c)).join(' ')}`);
    return;
  }

  const result = spawnSync(cmd[0], cmd.slice(1), { cwd: projectRoot, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`git branch -D failed (exit=${result.status}).`);
  }
}

/**
 * Prepares directories and optional worktrees for a launch batch.
 * @param session Active run session.
 * @param launches Launches to materialize before task execution.
 * @returns Nothing.
 */
export function prepareLaunches(session: Session, launches: TaskLaunch[]): void {
  for (const launch of launches) {
    if (!session.dry_run) {
      fs.mkdirSync(launch.task_dir, { recursive: true });
      if (launch.use_worktree && launch.branch && !fs.existsSync(launch.workspace_cwd)) {
        addWorktree(session.project_root, launch.branch, launch.workspace_cwd, false);
        session.created_worktrees.add(launch.workspace_cwd);
        session.created_worktree_branches.add(launch.branch);
      }
      fs.writeFileSync(launch.prompt_path, launch.prompt_text, 'utf8');
    } else {
      // eslint-disable-next-line no-console
      console.log(`[dry-run] prepare ${launch.task_dir}`);
      if (launch.use_worktree && launch.branch) {
        addWorktree(session.project_root, launch.branch, launch.workspace_cwd, true);
        session.created_worktree_branches.add(launch.branch);
      }
    }
  }
}

/**
 * Cleans up created worktrees and branches when enabled by runtime config.
 * @param session Active run session.
 * @returns Nothing.
 */
export function cleanupWorktrees(session: Session): void {
  if (!session.plan.runtime.cleanup_worktrees) return;
  if (session.created_worktrees.size === 0 && session.created_worktree_branches.size === 0) return;

  // eslint-disable-next-line no-console
  console.log('\ncleanup: removing worktrees');
  for (const worktree of [...session.created_worktrees].sort()) {
    try {
      removeWorktree(session.project_root, worktree, session.dry_run);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.log(`warning: failed to remove worktree ${worktree}: ${String(error)}`);
    }
  }
  for (const branch of [...session.created_worktree_branches].sort()) {
    try {
      removeBranch(session.project_root, branch, session.dry_run);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.log(`warning: failed to delete branch ${branch}: ${String(error)}`);
    }
  }
}

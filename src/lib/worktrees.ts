import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { log } from './log.ts';
import type { CommandLaunch, Session, TaskLaunch } from './types.ts';

type WorktreeScopedLaunch = {
  repoRoot: string;
  useWorktree: boolean;
  branch: string | null;
  baseRef: string;
  workspaceRoot: string;
};

function toScopedLaunch(launch: TaskLaunch | CommandLaunch): WorktreeScopedLaunch {
  return {
    repoRoot: launch.repoRoot,
    useWorktree: launch.useWorktree,
    branch: launch.branch,
    baseRef: launch.baseRef,
    workspaceRoot: 'workspaceRoot' in launch ? launch.workspaceRoot : launch.workspaceCwd,
  };
}

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
  baseRef: string,
  dryRun: boolean,
): void {
  const cmd = ['git', 'worktree', 'add', '-b', branch, target, baseRef];
  if (dryRun) {
    log(`$ ${cmd.map((c) => JSON.stringify(c)).join(' ')}`);
    return;
  }

  const result = spawnSync(cmd[0], cmd.slice(1), { cwd: projectRoot, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`git worktree add failed (exit=${result.status}).`);
  }
}

function prepareWorktreeLaunch(session: Session, launch: WorktreeScopedLaunch): void {
  if (!launch.useWorktree || !launch.branch) return;
  if (fs.existsSync(launch.workspaceRoot)) return;
  if (session.worktreeTracker.createdBranches.has(launch.branch)) {
    throw new Error(
      `Worktree branch name collision detected: "${launch.branch}". ` +
      'Adjust options.worktree_branch_template to produce unique names per launch.',
    );
  }

  addWorktree(launch.repoRoot, launch.branch, launch.workspaceRoot, launch.baseRef, session.dryRun);
  if (!session.dryRun) {
    session.worktreeTracker.created.set(launch.workspaceRoot, launch.repoRoot);
  }
  session.worktreeTracker.createdBranches.set(launch.branch, launch.repoRoot);
}

function stageSnapshotIfNeeded(workspaceRoot: string): boolean {
  const statusResult = spawnSync('git', ['status', '--porcelain'], { cwd: workspaceRoot, encoding: 'utf8' });
  if (statusResult.status !== 0) {
    throw new Error(`git status --porcelain failed (exit=${statusResult.status}).`);
  }
  if (!String(statusResult.stdout || '').trim()) {
    return false;
  }

  const addResult = spawnSync('git', ['add', '-A'], { cwd: workspaceRoot, stdio: 'inherit' });
  if (addResult.status !== 0) {
    throw new Error(`git add -A failed (exit=${addResult.status}).`);
  }

  // Worker artifacts may transiently live under .agentflow. Keep snapshots focused on repo content.
  spawnSync('git', ['reset', '--quiet', '--', '.agentflow'], { cwd: workspaceRoot, stdio: 'ignore' });

  const diffResult = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: workspaceRoot });
  if (diffResult.status === 0) {
    return false;
  }
  if (diffResult.status !== 1) {
    throw new Error(`git diff --cached --quiet failed (exit=${diffResult.status}).`);
  }
  return true;
}

function commitSnapshot(workspaceRoot: string, label: string): void {
  const message = `agentflow: snapshot ${label}`;
  const commitResult = spawnSync(
    'git',
    [
      '-c', 'user.name=agentflow',
      '-c', 'user.email=agentflow@local',
      '-c', 'commit.gpgsign=false',
      'commit',
      '--no-verify',
      '-m',
      message,
    ],
    { cwd: workspaceRoot, stdio: 'inherit' },
  );
  if (commitResult.status !== 0) {
    throw new Error(`git commit failed (exit=${commitResult.status}).`);
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
      prepareWorktreeLaunch(session, toScopedLaunch(launch));
      fs.writeFileSync(launch.promptPath, launch.promptText, 'utf8');
    } else {
      log(`[dry-run] prepare ${launch.taskDir}`);
      prepareWorktreeLaunch(session, toScopedLaunch(launch));
    }
  }
}

/**
 * Prepares command launch directory and optional worktree.
 * @param session Current run session.
 * @param launch Command launch descriptor to prepare.
 */
export function prepareCommandLaunch(session: Session, launch: CommandLaunch): void {
  if (!session.dryRun) {
    fs.mkdirSync(launch.taskDir, { recursive: true });
  }
  prepareWorktreeLaunch(session, toScopedLaunch(launch));
}

/**
 * Captures repo changes from a successful worktree launch onto its branch.
 * The resulting branch ref becomes the base for subsequent launches targeting
 * the same repo, so sequential worktree runs can observe prior successful edits.
 *
 * @param session Current run session.
 * @param launch Launch descriptor (task or command).
 * @param status Final status from execution contract.
 * @param label Snapshot label used in commit message.
 */
export function captureSuccessfulWorktreeSnapshot(
  session: Session,
  launch: TaskLaunch | CommandLaunch,
  status: string,
  label: string,
): void {
  if (!launch.useWorktree || !launch.branch || status !== 'DONE') return;

  const scoped = toScopedLaunch(launch);
  if (!session.dryRun) {
    const hasStagedChanges = stageSnapshotIfNeeded(scoped.workspaceRoot);
    if (hasStagedChanges) {
      commitSnapshot(scoped.workspaceRoot, label);
    }
  }
  const previousGroupIndex = session.worktreeTracker.latestGroupIndexByRepo.get(scoped.repoRoot);
  if (previousGroupIndex === undefined || launch.groupIndex >= previousGroupIndex) {
    session.worktreeTracker.latestRefByRepo.set(scoped.repoRoot, launch.branch);
    session.worktreeTracker.latestGroupIndexByRepo.set(scoped.repoRoot, launch.groupIndex);
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

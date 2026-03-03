import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './lib/args.ts';
import { usageText, planHelpText } from './lib/help.ts';
import {
  collectTaskNodes,
  countExecutableNodes,
  countWorkflowNodes,
  loadPayload,
  normalizePlan,
  resolveConfigPaths,
  resolveRepoRoots,
} from './lib/plan.ts';
import {
  createSession,
  createResumedSession,
  loadResumedState,
  failureCount,
  finalizeSession,
  initializeSessionArtifacts,
} from './lib/session.ts';
import { runWorkflow } from './lib/task_runner.ts';
import { cleanupWorktrees } from './lib/worktrees.ts';
import { log, logError } from './lib/log.ts';
import { renderWorktreeBranchName } from './lib/worktree_branch.ts';
import type {
  TaskNode,
  WorkerPlan,
  WorkflowNode,
} from './lib/types.ts';

/**
 * Resolves and validates only global context files at startup.
 * Task-level context files are validated by `validateTaskContextFiles`.
 *
 * @param plan Normalized worker plan with contextFiles array.
 * @param planPath Absolute path to the plan JSON file.
 * @param repoRoots Map of alias to resolved absolute repo root.
 * @returns Array of resolved absolute paths to existing context files.
 * @throws {Error} When any configured file does not exist.
 */
function validateGlobalContextFiles(
  plan: WorkerPlan,
  planPath: string,
  repoRoots: Record<string, string>,
): string[] {
  return resolveConfigPaths(planPath, repoRoots, plan.contextFiles);
}

/**
 * Resolves and validates every task node's context files at startup.
 * Task-level context files resolve from the task's repo root for bare relative paths.
 *
 * @param plan Normalized worker plan with workflow tree.
 * @param planPath Absolute path to the plan JSON file.
 * @param repoRoots Map of alias to resolved absolute repo root.
 * @throws {Error} When any task references context files that do not exist.
 */
function validateTaskContextFiles(
  plan: WorkerPlan,
  planPath: string,
  repoRoots: Record<string, string>,
): void {
  const defaultRepoAlias = Object.keys(repoRoots)[0];
  const errors: string[] = [];

  for (const task of collectTaskNodes(plan.workflow)) {
    const repoAlias = task.repo || defaultRepoAlias;
    const repoRoot = repoRoots[repoAlias];
    try {
      resolveConfigPaths(planPath, repoRoots, task.contextFiles, repoRoot);
    } catch (error) {
      errors.push(
        `task "${task.taskId}" (repo "${repoAlias}"):\n${String(error)}`,
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(`Task context file validation failed:\n${errors.join('\n\n')}`);
  }
}

/**
 * Checks whether a target path is inside (or equal to) a base directory.
 * @param baseDir Directory root to test against.
 * @param targetPath Candidate target path.
 * @returns `true` when targetPath is within baseDir.
 */
function isWithinDir(baseDir: string, targetPath: string): boolean {
  const absBase = path.resolve(baseDir);
  const absTarget = path.resolve(targetPath);
  return absTarget === absBase || absTarget.startsWith(absBase + path.sep);
}

/**
 * Validates one workflow cwd field against repo boundaries and filesystem reachability.
 *
 * @param params Validation input payload.
 * @param params.nodePath Schema-style node path used in error messages.
 * @param params.repoAlias Repo alias selected for this node.
 * @param params.cwd Raw cwd value from plan payload.
 * @param params.repoRoots Map of alias to absolute repo root.
 * @param params.errors Mutable error accumulator.
 */
function validateNodeCwd({
  nodePath,
  repoAlias,
  cwd,
  repoRoots,
  errors,
}: {
  nodePath: string;
  repoAlias: string;
  cwd: string | null;
  repoRoots: Record<string, string>;
  errors: string[];
}): void {
  if (!cwd) return;

  if (path.isAbsolute(cwd)) {
    errors.push(`${nodePath}.cwd must be a relative path.`);
    return;
  }

  const repoRoot = repoRoots[repoAlias];
  if (!repoRoot) {
    errors.push(`${nodePath} references unknown repo alias "${repoAlias}".`);
    return;
  }

  const resolved = path.resolve(repoRoot, cwd);
  if (!isWithinDir(repoRoot, resolved)) {
    errors.push(`${nodePath}.cwd resolves outside repo "${repoAlias}": ${resolved}`);
    return;
  }
  if (!fs.existsSync(resolved)) {
    errors.push(`${nodePath}.cwd not found: ${cwd}`);
    return;
  }
  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    errors.push(`${nodePath}.cwd is not readable: ${cwd}`);
    return;
  }
  if (!stats.isDirectory()) {
    errors.push(`${nodePath}.cwd must be a directory: ${cwd}`);
  }
}

/**
 * Validates workflow-level references not covered by schema:
 * - command/deterministic-gate cwd reachability within repo roots
 * - task context_from references (existence, non-self, and ordering)
 *
 * @param plan Normalized worker plan with workflow tree.
 * @param repoRoots Map of alias to resolved absolute repo root.
 * @throws {Error} When any workflow reference is invalid.
 */
function validateWorkflowReferences(
  plan: WorkerPlan,
  repoRoots: Record<string, string>,
): void {
  interface ParallelScope {
    groupPath: string;
    stepIndex: number;
  }

  interface ExecutableMeta {
    index: number;
    scopes: ParallelScope[];
  }

  const defaultRepoAlias = Object.keys(repoRoots)[0];
  const errors: string[] = [];
  const taskRows: Array<{ task: TaskNode; nodePath: string }> = [];
  const executableOrder = new Map<string, ExecutableMeta>();
  let nextExecutableIndex = 0;

  const walk = (node: WorkflowNode, nodePath: string, scopes: ParallelScope[]): void => {
    if (node.type === 'task') {
      taskRows.push({ task: node, nodePath });
      executableOrder.set(node.taskId, {
        index: nextExecutableIndex,
        scopes,
      });
      nextExecutableIndex += 1;
      return;
    }

    if (node.type === 'command') {
      executableOrder.set(node.id, {
        index: nextExecutableIndex,
        scopes,
      });
      nextExecutableIndex += 1;
      const repoAlias = node.repo ?? defaultRepoAlias;
      validateNodeCwd({
        nodePath,
        repoAlias,
        cwd: node.cwd,
        repoRoots,
        errors,
      });
      return;
    }

    if (node.type === 'group') {
      if (!node.parallel) {
        node.steps.forEach((child, i) => {
          walk(child, `${nodePath}.steps[${i}]`, scopes);
        });
      } else {
        node.steps.forEach((child, i) => {
          walk(child, `${nodePath}.steps[${i}]`, [
            ...scopes,
            { groupPath: nodePath, stepIndex: i },
          ]);
        });
      }
      return;
    }

    const gate = node.until;
    if (gate.type === 'deterministic') {
      const repoAlias = gate.repo ?? defaultRepoAlias;
      validateNodeCwd({
        nodePath: `${nodePath}.gate`,
        repoAlias,
        cwd: gate.exec.cwd,
        repoRoots,
        errors,
      });
    }
    node.body.forEach((child, i) => {
      walk(child, `${nodePath}.body[${i}]`, scopes);
    });
  };

  const hasCrossBranchParallelDependency = (
    consumer: ExecutableMeta,
    producer: ExecutableMeta,
  ): { groupPath: string; consumerStep: number; producerStep: number } | null => {
    for (const consumerScope of consumer.scopes) {
      const producerScope = producer.scopes.find((scope) => scope.groupPath === consumerScope.groupPath);
      if (!producerScope) continue;
      if (producerScope.stepIndex !== consumerScope.stepIndex) {
        return {
          groupPath: consumerScope.groupPath,
          consumerStep: consumerScope.stepIndex,
          producerStep: producerScope.stepIndex,
        };
      }
    }
    return null;
  };

  plan.workflow.forEach((node, i) => walk(node, `flow[${i}]`, []));

  for (const { task, nodePath } of taskRows) {
    const currentMeta = executableOrder.get(task.taskId);
    if (!currentMeta) {
      errors.push(`${nodePath} could not determine executable order for task "${task.taskId}".`);
      continue;
    }

    for (const reference of task.contextFrom) {
      if (reference === task.taskId) {
        errors.push(`${nodePath}.context_from cannot reference itself: "${reference}"`);
        continue;
      }
      const referenceMeta = executableOrder.get(reference);
      if (!referenceMeta) {
        errors.push(`${nodePath}.context_from references unknown executable id: "${reference}"`);
        continue;
      }
      if (referenceMeta.index >= currentMeta.index) {
        errors.push(
          `${nodePath}.context_from must reference an earlier executable node; "${reference}" is not earlier in flow order.`,
        );
        continue;
      }

      const invalidParallelDependency = hasCrossBranchParallelDependency(currentMeta, referenceMeta);
      if (invalidParallelDependency) {
        errors.push(
          `${nodePath}.context_from cannot depend on "${reference}" across parallel branches in ${invalidParallelDependency.groupPath} (producer step ${invalidParallelDependency.producerStep + 1}, consumer step ${invalidParallelDependency.consumerStep + 1}).`,
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Workflow reference validation failed:\n${errors.map((e) => `- ${e}`).join('\n')}`);
  }
}

/**
 * Validates rendered worktree branch names with git's ref-format rules.
 * Ensures generated names are valid and collision-free within each repo.
 */
function validateWorktreeBranchTemplateRendering(
  plan: WorkerPlan,
  repoRoots: Record<string, string>,
): void {
  if (!plan.worktrees) return;

  const defaultRepoAlias = Object.keys(repoRoots)[0];
  const syntheticRunId = plan.options.runId || 'run_template_validation';
  const errors: string[] = [];
  const seenByRepo = new Map<string, Set<string>>();
  let syntheticGroupIndex = 1;

  const validateOne = ({
    nodePath,
    repoAlias,
    nodeId,
    kind,
  }: {
    nodePath: string;
    repoAlias: string;
    nodeId: string;
    kind: 'task' | 'command';
  }): void => {
    const repoRoot = repoRoots[repoAlias];
    let branch: string;
    try {
      branch = renderWorktreeBranchName(plan.options.worktreeBranchTemplate, {
        runId: syntheticRunId,
        repoAlias,
        groupIndex: syntheticGroupIndex,
        nodeId,
        attempt: 1,
        kind,
      });
    } catch (error) {
      errors.push(`${nodePath}: ${String(error)}`);
      syntheticGroupIndex += 1;
      return;
    }

    const repoSeen = seenByRepo.get(repoRoot) || new Set<string>();
    if (repoSeen.has(branch)) {
      errors.push(
        `${nodePath} generated duplicate worktree branch "${branch}" in repo "${repoAlias}". ` +
        'Update options.worktree_branch_template to ensure uniqueness.',
      );
    }
    repoSeen.add(branch);
    seenByRepo.set(repoRoot, repoSeen);

    const checkResult = spawnSync('git', ['check-ref-format', '--branch', branch], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (checkResult.status !== 0) {
      const detail = String(checkResult.stderr || checkResult.stdout || '').trim();
      errors.push(
        `${nodePath} generated invalid worktree branch "${branch}" for repo "${repoAlias}". ` +
        (detail || 'git check-ref-format --branch rejected it.'),
      );
    }
    syntheticGroupIndex += 1;
  };

  const walk = (node: WorkflowNode, nodePath: string): void => {
    if (node.type === 'task') {
      validateOne({
        nodePath,
        repoAlias: node.repo || defaultRepoAlias,
        nodeId: node.taskId,
        kind: 'task',
      });
      return;
    }
    if (node.type === 'command') {
      validateOne({
        nodePath,
        repoAlias: node.repo || defaultRepoAlias,
        nodeId: node.id,
        kind: 'command',
      });
      return;
    }
    if (node.type === 'group') {
      node.steps.forEach((child, i) => walk(child, `${nodePath}.steps[${i}]`));
      return;
    }
    node.body.forEach((child, i) => walk(child, `${nodePath}.body[${i}]`));
  };

  plan.workflow.forEach((node, i) => walk(node, `flow[${i}]`));

  if (errors.length > 0) {
    throw new Error(`Worktree branch template validation failed:\n${errors.map((e) => `- ${e}`).join('\n')}`);
  }
}

/**
 * Executes the CLI workflow lifecycle from argument parsing to final run summary.
 *
 * @param argv CLI tokens (without `node` and script path). Defaults to `process.argv.slice(2)`.
 * @returns Exit code: 0 on success, 1 on failure, 2 on usage error.
 */
export async function main(argv = process.argv.slice(2)): Promise<number> {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    logError(String(error));
    logError(usageText());
    return 2;
  }

  if (args.help) {
    log(usageText());
    return 0;
  }
  if (args.planHelp) {
    log(`${planHelpText()}\n`);
    return 0;
  }
  if (!args.planFile) {
    logError(usageText());
    return 2;
  }

  const planPath = path.isAbsolute(args.planFile)
    ? path.resolve(args.planFile)
    : path.resolve(process.cwd(), args.planFile);
  if (!fs.existsSync(planPath)) {
    logError(`Plan file not found: ${planPath}`);
    return 1;
  }

  let plan;
  try {
    plan = normalizePlan(loadPayload(planPath));
  } catch (error) {
    logError(`Invalid plan schema at ${planPath}:`);
    logError(String(error));
    return 1;
  }

  const repoRoots = resolveRepoRoots(planPath, plan.repos);
  for (const [alias, root] of Object.entries(repoRoots)) {
    if (!fs.existsSync(root)) {
      logError(`Resolved repo root for "${alias}" does not exist: ${root}`);
      return 1;
    }
  }

  plan.options.dryRun = args.dryRunOverride === true;
  plan.options.skipGitRepoCheck = args.skipGitRepoCheck;
  plan.options.sandboxMode = args.sandboxMode ?? plan.options.sandboxMode;

  let globalContextFiles;
  try {
    globalContextFiles = validateGlobalContextFiles(plan, planPath, repoRoots);
    validateTaskContextFiles(plan, planPath, repoRoots);
    validateWorkflowReferences(plan, repoRoots);
    validateWorktreeBranchTemplateRendering(plan, repoRoots);
  } catch (error) {
    logError(String(error));
    return 1;
  }

  const totalTaskCount = collectTaskNodes(plan.workflow).length;
  const totalExecutableCount = countExecutableNodes(plan.workflow);

  if (args.validate) {
    log('plan is valid');
    log(`  workflow_nodes: ${countWorkflowNodes(plan.workflow)}`);
    log(`  task_nodes:     ${totalTaskCount}`);
    log(`  provider:       ${plan.provider}`);
    for (const [alias, root] of Object.entries(repoRoots)) {
      log(`  repo.${alias}:${' '.repeat(Math.max(1, 10 - alias.length))}${root}`);
    }
    return 0;
  }

  let session;
  if (args.resumeDir) {
    const runDir = path.isAbsolute(args.resumeDir)
      ? args.resumeDir
      : path.resolve(process.cwd(), args.resumeDir);
    let priorState;
    try {
      priorState = loadResumedState(runDir);
    } catch (error) {
      logError(String(error));
      return 1;
    }
    session = createResumedSession({
      repoRoots,
      planPath,
      plan,
      globalContextFiles,
      totalTaskCount: totalExecutableCount,
      priorState,
      runDir,
    });
    log(`[resume] resuming run ${session.paths.runId} (${session.resumedTasks.size} completed tasks will be skipped)`);
  } else {
    session = createSession({
      repoRoots,
      planPath,
      plan,
      globalContextFiles,
      totalTaskCount: totalExecutableCount,
    });
  }

  if (session.dryRun) {
    log('[dry-run] no CLI sessions will be executed');
  }

  for (const [alias, root] of Object.entries(session.paths.repoRoots)) {
    log(`repo.${alias}:${' '.repeat(Math.max(1, 10 - alias.length))}${root}`);
  }
  log(`plan_file:      ${session.paths.configPath}`);
  log(`run_root:       ${session.paths.runRoot}`);
  log(`run_id:         ${session.paths.runId}`);
  log(`workflow_nodes: ${countWorkflowNodes(plan.workflow)}`);
  log(`task_nodes:     ${totalTaskCount}`);
  log(`worktrees:      ${plan.worktrees}`);
  log(`dry_run:        ${session.dryRun}`);
  log(`skip_git_check: ${plan.options.skipGitRepoCheck}`);
  log(`sandbox_mode:   ${plan.options.sandboxMode}`);

  initializeSessionArtifacts(session);

  let finalized = false;
  let failures = 0;
  let runStatus = 'DONE';
  const finalizeRun = (): void => {
    if (finalized) return;
    cleanupWorktrees(session);
    failures = failureCount(session);
    if (runStatus === 'DONE' && failures > 0) runStatus = 'FAILED';
    finalizeSession(session);
    finalized = true;
  };

  const signalExitCode = (signal: NodeJS.Signals): number => (signal === 'SIGINT' ? 130 : 143);
  const handleSignal = (signal: NodeJS.Signals): void => {
    if (session.shutdownSignal) return;
    session.shutdownSignal = signal;
    runStatus = 'FAILED';
    log(`\nreceived ${signal}, shutting down...`);
    finalizeRun();
    log(`\ncompleted with failures: ${failures}`);
    process.exit(signalExitCode(signal));
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  try {
    await runWorkflow(session);
  } catch (err: unknown) {
    runStatus = 'FAILED';
    const error = err instanceof Error ? err : null;
    log(`\nrun failed: ${error?.name || 'Error'}: ${error?.message || String(err)}`);
  } finally {
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
    finalizeRun();
  }

  if (runStatus === 'FAILED') {
    log(`\ncompleted with failures: ${failures}`);
    return 1;
  }

  log('\ncompleted successfully');
  return 0;
}

const directEntry = process.argv[1] ? path.resolve(process.argv[1]) : null;
const currentFile = path.resolve(fileURLToPath(import.meta.url));

if (directEntry === currentFile) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      logError(err instanceof Error ? err.stack || String(err) : String(err));
      process.exit(1);
    },
  );
}

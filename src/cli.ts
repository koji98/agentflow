import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './lib/args.ts';
import { usageText, planHelpText } from './lib/help.ts';
import {
  collectTaskNodes,
  countWorkflowNodes,
  loadPayload,
  normalizePlan,
  resolveConfigPaths,
  resolveProjectRoot,
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
import type { WorkerPlan } from './lib/types.ts';

/**
 * Resolves and validates only global context files at startup.
 * Task-level context files are validated lazily when each task is materialized.
 *
 * @param plan Normalized worker plan with contextFiles array.
 * @param planPath Absolute path to the plan JSON file.
 * @param projectRoot Absolute path to the target repository root.
 * @returns Array of resolved absolute paths to existing context files.
 * @throws {Error} When any configured file does not exist.
 */
function validateGlobalContextFiles(
  plan: WorkerPlan,
  planPath: string,
  projectRoot: string,
): string[] {
  return resolveConfigPaths(planPath, projectRoot, plan.contextFiles);
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

  const projectRoot = resolveProjectRoot(planPath, plan.targetRepoRoot);
  if (!fs.existsSync(projectRoot)) {
    logError(`Resolved repo root does not exist: ${projectRoot}`);
    return 1;
  }

  plan.options.dryRun = args.dryRunOverride === true;
  plan.options.skipGitRepoCheck = args.skipGitRepoCheck;
  plan.options.sandboxMode = args.sandboxMode ?? plan.options.sandboxMode;

  let globalContextFiles;
  try {
    globalContextFiles = validateGlobalContextFiles(plan, planPath, projectRoot);
  } catch (error) {
    logError(String(error));
    return 1;
  }

  const totalTaskCount = collectTaskNodes(plan.workflow).length;

  if (args.validate) {
    log('plan is valid');
    log(`  workflow_nodes: ${countWorkflowNodes(plan.workflow)}`);
    log(`  task_nodes:     ${totalTaskCount}`);
    log(`  provider:       ${plan.provider}`);
    log(`  repo:           ${projectRoot}`);
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
      projectRoot,
      planPath,
      plan,
      globalContextFiles,
      totalTaskCount,
      priorState,
      runDir,
    });
    log(`[resume] resuming run ${session.paths.runId} (${session.resumedTasks.size} completed tasks will be skipped)`);
  } else {
    session = createSession({
      projectRoot,
      planPath,
      plan,
      globalContextFiles,
      totalTaskCount,
    });
  }

  if (session.dryRun) {
    log('[dry-run] no CLI sessions will be executed');
  }

  log(`project_root:   ${session.paths.projectRoot}`);
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

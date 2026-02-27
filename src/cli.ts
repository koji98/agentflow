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
  failureCount,
  finalizeSession,
  initializeSessionArtifacts,
} from './lib/session.ts';
import { runWorkflow } from './lib/task_runner.ts';
import { cleanupWorktrees } from './lib/worktrees.ts';
import type { WorkerPlan } from './lib/types.ts';

/**
 * Resolves and validates only global context files at startup.
 * Task-level context files are validated lazily when each task is materialized.
 * @param plan Normalized workflow plan.
 * @param planPath Absolute path to the source plan file.
 * @param projectRoot Absolute project root used for relative path resolution.
 * @returns Resolved absolute paths for global context files.
 */
function validateGlobalContextFiles(
  plan: WorkerPlan,
  planPath: string,
  projectRoot: string,
): string[] {
  return resolveConfigPaths(planPath, projectRoot, plan.context_files);
}

/**
 * Executes the CLI workflow lifecycle from argument parsing to final run summary.
 * @param argv CLI arguments without the node/binary prefix.
 * @returns Process exit code (`0` success, non-zero failure).
 */
export async function main(argv = process.argv.slice(2)): Promise<number> {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(String(error));
    // eslint-disable-next-line no-console
    console.error(usageText());
    return 2;
  }

  if (args.help) {
    // eslint-disable-next-line no-console
    console.log(usageText());
    return 0;
  }
  if (args.planHelp) {
    // eslint-disable-next-line no-console
    console.log(`${planHelpText()}\n`);
    return 0;
  }
  if (!args.planFile) {
    // eslint-disable-next-line no-console
    console.error(usageText());
    return 2;
  }

  const planPath = path.isAbsolute(args.planFile)
    ? path.resolve(args.planFile)
    : path.resolve(process.cwd(), args.planFile);
  if (!fs.existsSync(planPath)) {
    // eslint-disable-next-line no-console
    console.error(`Plan file not found: ${planPath}`);
    return 1;
  }

  let plan;
  try {
    plan = normalizePlan(loadPayload(planPath));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(`Invalid plan schema at ${planPath}:`);
    // eslint-disable-next-line no-console
    console.error(String(error));
    return 1;
  }

  const projectRoot = resolveProjectRoot(planPath, plan.target_repo_root);
  if (!fs.existsSync(projectRoot)) {
    // eslint-disable-next-line no-console
    console.error(`Resolved repo root does not exist: ${projectRoot}`);
    return 1;
  }

  // CLI controls dry-run mode: default is always live unless --dry-run is passed.
  plan.runtime.dry_run = args.dryRunOverride === true;
  // Optional CLI passthrough for Codex repository trust checks.
  plan.runtime.skip_git_repo_check = args.skipGitRepoCheck;
  // Optional CLI passthrough for Codex sandbox mode.
  plan.runtime.sandbox_mode = args.sandboxMode;

  let globalContextFiles;
  try {
    globalContextFiles = validateGlobalContextFiles(plan, planPath, projectRoot);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(String(error));
    return 1;
  }

  const session = createSession({
    projectRoot,
    planPath,
    plan,
    globalContextFiles,
  });

  if (session.dry_run) {
    // eslint-disable-next-line no-console
    console.log('[dry-run] no CLI sessions will be executed');
  }

  // eslint-disable-next-line no-console
  console.log(`project_root:   ${session.project_root}`);
  // eslint-disable-next-line no-console
  console.log(`plan_file:      ${session.config_path}`);
  // eslint-disable-next-line no-console
  console.log(`run_root:       ${session.run_root}`);
  // eslint-disable-next-line no-console
  console.log(`run_id:         ${session.run_id}`);
  // eslint-disable-next-line no-console
  console.log(`raw_thoughts:   ${path.resolve(session.run_root, 'raw_thoughts.md')}`);
  // eslint-disable-next-line no-console
  console.log(`workflow_nodes: ${countWorkflowNodes(plan.workflow)}`);
  // eslint-disable-next-line no-console
  console.log(`task_nodes:     ${collectTaskNodes(plan.workflow).length}`);
  // eslint-disable-next-line no-console
  console.log(`worktrees:      ${plan.runtime.use_worktrees}`);
  // eslint-disable-next-line no-console
  console.log(`dry_run:        ${session.dry_run}`);
  // eslint-disable-next-line no-console
  console.log(`skip_git_check: ${plan.runtime.skip_git_repo_check}`);
  // eslint-disable-next-line no-console
  console.log(`sandbox_mode:   ${plan.runtime.sandbox_mode || 'provider-default'}`);

  initializeSessionArtifacts(session);

  let finalized = false;
  let failures = 0;
  let runStatus = 'DONE';
  const finalizeRun = (): void => {
    if (finalized) return;
    cleanupWorktrees(session);
    failures = failureCount(session);
    if (runStatus === 'DONE' && failures > 0) runStatus = 'FAILED';
    finalizeSession(session, runStatus);
    finalized = true;
  };

  const signalExitCode = (signal: NodeJS.Signals): number => (signal === 'SIGINT' ? 130 : 143);
  const handleSignal = (signal: NodeJS.Signals): void => {
    if (session.shutdown_signal) return;
    session.shutdown_signal = signal;
    runStatus = 'FAILED';
    // eslint-disable-next-line no-console
    console.log(`\nreceived ${signal}, shutting down...`);
    finalizeRun();
    // eslint-disable-next-line no-console
    console.log(`\ncompleted with failures: ${failures}`);
    process.exit(signalExitCode(signal));
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  try {
    await runWorkflow(session);
  } catch (error) {
    runStatus = 'FAILED';
    // eslint-disable-next-line no-console
    console.log(`\nrun failed: ${error?.name || 'Error'}: ${error?.message || String(error)}`);
  } finally {
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
    finalizeRun();
  }

  if (runStatus === 'FAILED') {
    // eslint-disable-next-line no-console
    console.log(`\ncompleted with failures: ${failures}`);
    return 1;
  }

  // eslint-disable-next-line no-console
  console.log('\ncompleted successfully');
  return 0;
}

const directEntry = process.argv[1] ? path.resolve(process.argv[1]) : null;
const currentFile = path.resolve(fileURLToPath(import.meta.url));

if (directEntry === currentFile) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      // eslint-disable-next-line no-console
      console.error(error?.stack || String(error));
      process.exit(1);
    },
  );
}

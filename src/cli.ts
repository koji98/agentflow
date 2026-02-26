import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './lib/args.ts';
import { usageText, planHelpText } from './lib/help.ts';
import {
  collectTaskNodes,
  countWorkflowNodes,
  hasParallelGroups,
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

/** Validates only global context files at startup. Task context is validated lazily per task. */
function validateGlobalContextFiles(
  plan: WorkerPlan,
  planPath: string,
  projectRoot: string,
): string[] {
  return resolveConfigPaths(planPath, projectRoot, plan.context_files);
}

/** Resolves optional plan_doc path with CLI override support. */
function resolvePlanDocPath({
  plan,
  planPath,
  projectRoot,
  cliPlanDocOverride,
}: {
  plan: WorkerPlan;
  planPath: string;
  projectRoot: string;
  cliPlanDocOverride: string | null;
}): string | null {
  if (cliPlanDocOverride) {
    return path.isAbsolute(cliPlanDocOverride)
      ? path.resolve(cliPlanDocOverride)
      : path.resolve(process.cwd(), cliPlanDocOverride);
  }
  if (!plan.plan_doc) return null;
  const [resolved] = resolveConfigPaths(planPath, projectRoot, [plan.plan_doc]);
  return resolved || null;
}

/** Executes the CLI flow and returns process exit code. */
export async function main(argv = process.argv.slice(2)) {
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

  if (hasParallelGroups(plan.workflow) && !plan.runtime.use_worktrees) {
    // eslint-disable-next-line no-console
    console.error('Parallel groups require runtime.use_worktrees=true.');
    // eslint-disable-next-line no-console
    console.error('Set use_worktrees=true or disable parallel group nodes.');
    return 1;
  }

  const projectRoot = args.repoRootOverride
    ? path.resolve(process.cwd(), args.repoRootOverride)
    : resolveProjectRoot(planPath, plan.target_repo_root);
  if (!fs.existsSync(projectRoot)) {
    // eslint-disable-next-line no-console
    console.error(`Resolved repo root does not exist: ${projectRoot}`);
    return 1;
  }

  if (args.dryRunOverride !== null) plan.runtime.dry_run = args.dryRunOverride;

  let planDocPath = null;
  try {
    planDocPath = resolvePlanDocPath({
      plan,
      planPath,
      projectRoot,
      cliPlanDocOverride: args.planDocOverride,
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(String(error));
    return 1;
  }
  if (planDocPath && !fs.existsSync(planDocPath)) {
    // eslint-disable-next-line no-console
    console.error(`plan_doc not found: ${planDocPath}`);
    return 1;
  }

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
    planDocPath,
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

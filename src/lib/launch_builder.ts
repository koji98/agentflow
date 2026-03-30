import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_REPORT_FILENAME, DEFAULT_SUMMARY_FILENAME } from './constants.ts';
import { resolveConfigPaths } from './plan.ts';
import { buildPrompt } from './prompt.ts';
import type {
  CommandLaunch,
  CommandNode,
  ContextArtifact,
  PriorTaskSummary,
  Session,
  TaskLaunch,
  TaskNode,
} from './types.ts';
import { log } from './log.ts';
import {
  mapProjectPathToWorker,
  readText,
  safeSlug,
  taskKey,
} from './utils.ts';
import { renderWorktreeBranchName } from './worktree_branch.ts';

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

function assertRuntimeDirectoryExists(absPath: string, contextLabel: string): void {
  if (!fs.existsSync(absPath)) {
    throw new Error(`${contextLabel} runtime cwd not found: ${absPath}`);
  }
  let stats: fs.Stats;
  try {
    stats = fs.statSync(absPath);
  } catch {
    throw new Error(`${contextLabel} runtime cwd is not readable: ${absPath}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`${contextLabel} runtime cwd must be a directory: ${absPath}`);
  }
}

/**
 * Gathers completed prior-task context for prompt injection.
 * Reads either each task's summary or report artifact depending on the requested mode.
 * @param session Current run session.
 * @param contextFrom When non-empty, only include summaries from these task IDs.
 * @param artifact Which prior-task artifact to load for prompt injection.
 * @returns Array of prior task summaries sorted by completion time.
 */
export function gatherPriorTaskSummaries(
  session: Session,
  contextFrom: string[] = [],
  artifact: ContextArtifact = 'summary',
): PriorTaskSummary[] {
  const filterSet = contextFrom.length > 0 ? new Set(contextFrom) : null;
  return Object.values(session.state.tasks)
    .filter((row) => row.status === 'DONE' || row.status === 'FAILED')
    .filter((row) => !filterSet || filterSet.has(row.taskId))
    .sort((a, b) => (a.endedAtUtc || '').localeCompare(b.endedAtUtc || ''))
    .map((row) => {
      const sourcePath = artifact === 'report' ? row.reportPath : row.summaryPath;
      const sourceContent = readText(sourcePath);
      if (!sourceContent) {
        log(`[context_from] no ${artifact} artifact found for task "${row.taskId}", skipping`);
        return null;
      }
      return {
        taskId: row.taskId,
        status: row.status,
        artifact,
        content: sourceContent.trim(),
      };
    })
    .filter((s): s is PriorTaskSummary => s !== null);
}

/**
 * Materializes one executable task launch from a workflow task node.
 *
 * @param params Launch construction inputs.
 * @param params.session Current run session.
 * @param params.node Task workflow node.
 * @param params.nodePath Workflow node path for tracing.
 * @param params.attempt Current attempt number (1-based).
 * @param params.groupIndex Assigned execution group index.
 * @param params.taskIndex Position within the group.
 * @param params.gateFeedbackToAddress Latest loop-gate feedback that should be addressed by this task.
 * @returns Fully populated task launch descriptor.
 */
export function buildLaunchFromTaskNode({
  session,
  node,
  nodePath,
  attempt,
  groupIndex,
  taskIndex,
  gateFeedbackToAddress = [],
}: {
  session: Session;
  node: TaskNode;
  nodePath: string;
  attempt: number;
  groupIndex: number;
  taskIndex: number;
  gateFeedbackToAddress?: string[];
}): TaskLaunch {
  const repoAlias = node.repo ?? Object.keys(session.paths.repoRoots)[0];
  const repoRoot = session.paths.repoRoots[repoAlias];

  const task: TaskLaunch['task'] = {
    taskId: node.taskId,
    task: node.task,
    repo: node.repo,
    provider: node.provider,
    model: node.model,
    persona: node.persona,
    contextFiles: node.contextFiles,
    contextFrom: node.contextFrom,
    contextFromArtifact: node.contextFromArtifact,
  };
  const taskSlug = safeSlug(`${node.taskId}-a${attempt}`);
  const taskDir = path.resolve(
    session.paths.runRoot,
    `group_${String(groupIndex).padStart(2, '0')}`,
    `task_${taskSlug}`,
  );
  const promptPath = path.resolve(taskDir, 'prompt.md');
  const logPath = path.resolve(taskDir, 'worker_exec.log');
  const lastMessagePath = path.resolve(taskDir, 'worker_last_message.md');
  const reportPath = path.resolve(taskDir, DEFAULT_REPORT_FILENAME);
  const summaryPath = path.resolve(taskDir, DEFAULT_SUMMARY_FILENAME);

  const useWorktree = Boolean(session.plan.worktrees);
  const baseRef = useWorktree
    ? session.worktreeTracker.latestRefByRepo.get(repoRoot) || 'HEAD'
    : 'HEAD';
  const branch = useWorktree
    ? renderWorktreeBranchName(session.plan.options.worktreeBranchTemplate, {
      runId: session.paths.runId,
      repoAlias,
      groupIndex,
      nodeId: task.taskId,
      attempt,
      kind: 'task',
    })
    : null;
  const workspaceCwd = useWorktree ? path.resolve(taskDir, 'worktree') : repoRoot;

  const mergedContextFiles = [
    ...session.globalContextFiles,
    ...resolveConfigPaths(session.paths.configPath, session.paths.repoRoots, task.contextFiles, repoRoot),
  ];
  const workerContextFiles = mergedContextFiles.map((f) =>
    mapProjectPathToWorker(repoRoot, workspaceCwd, f),
  );
  const candidateWorkerReportPath = mapProjectPathToWorker(repoRoot, workspaceCwd, reportPath);
  const candidateWorkerSummaryPath = mapProjectPathToWorker(repoRoot, workspaceCwd, summaryPath);
  const workerArtifactsDir = path.resolve(
    workspaceCwd,
    '.agentflow',
    'worker_artifacts',
    session.paths.runId,
    `group_${String(groupIndex).padStart(2, '0')}`,
    `task_${taskSlug}`,
  );
  const workerReportPath = isWithinDir(workspaceCwd, candidateWorkerReportPath)
    ? candidateWorkerReportPath
    : path.resolve(workerArtifactsDir, DEFAULT_REPORT_FILENAME);
  const workerSummaryPath = isWithinDir(workspaceCwd, candidateWorkerSummaryPath)
    ? candidateWorkerSummaryPath
    : path.resolve(workerArtifactsDir, DEFAULT_SUMMARY_FILENAME);

  const provider = task.provider || session.plan.provider;
  const promptText = buildPrompt({
    persona: node.persona || session.plan.persona,
    objective: session.plan.objective,
    setup: session.plan.setup,
    task,
    contextFiles: workerContextFiles,
    reportPath: workerReportPath,
    summaryPath: workerSummaryPath,
    priorTaskSummaries: gatherPriorTaskSummaries(session, node.contextFrom, node.contextFromArtifact),
    gateFeedbackToAddress,
  });

  return {
    groupIndex,
    taskIndex,
    taskKey: taskKey(groupIndex, `${task.taskId}#a${attempt}`),
    task,
    repoAlias,
    provider,
    model: task.model || session.plan.model,
    reasoningEffort: session.plan.reasoningEffort,
    profile: session.plan.profile,
    promptText,
    taskDir,
    promptPath,
    logPath,
    lastMessagePath,
    reportPath,
    workerReportPath,
    summaryPath,
    workerSummaryPath,
    workspaceCwd,
    baseRef,
    branch,
    useWorktree,
    skipGitRepoCheck: session.plan.options.skipGitRepoCheck,
    sandboxMode: session.plan.options.sandboxMode,
    nodePath,
    attempt,
    repoRoot,
  };
}

/**
 * Materializes one executable command launch from a workflow command node.
 *
 * @param params Launch construction inputs.
 * @param params.session Current run session.
 * @param params.node Command workflow node.
 * @param params.nodePath Workflow node path for tracing.
 * @param params.attempt Current attempt number (1-based).
 * @param params.groupIndex Assigned execution group index.
 * @param params.taskIndex Position within the group.
 * @returns Fully populated command launch descriptor.
 */
export function buildLaunchFromCommandNode({
  session,
  node,
  nodePath,
  attempt,
  groupIndex,
  taskIndex,
}: {
  session: Session;
  node: CommandNode;
  nodePath: string;
  attempt: number;
  groupIndex: number;
  taskIndex: number;
}): CommandLaunch {
  const repoAlias = node.repo ?? Object.keys(session.paths.repoRoots)[0];
  const repoRoot = session.paths.repoRoots[repoAlias];
  const useWorktree = Boolean(session.plan.worktrees);
  const baseRef = useWorktree
    ? session.worktreeTracker.latestRefByRepo.get(repoRoot) || 'HEAD'
    : 'HEAD';
  const branch = useWorktree
    ? renderWorktreeBranchName(session.plan.options.worktreeBranchTemplate, {
      runId: session.paths.runId,
      repoAlias,
      groupIndex,
      nodeId: node.id,
      attempt,
      kind: 'command',
    })
    : null;

  const taskSlug = safeSlug(`${node.id}-a${attempt}`);
  const taskDir = path.resolve(
    session.paths.runRoot,
    `group_${String(groupIndex).padStart(2, '0')}`,
    `task_${taskSlug}`,
  );
  const promptPath = path.resolve(taskDir, 'command_request.md');
  const logPath = path.resolve(taskDir, 'command_exec.log');
  const lastMessagePath = path.resolve(taskDir, 'command_stdout.log');
  const reportPath = path.resolve(taskDir, 'report.md');
  const summaryPath = path.resolve(taskDir, 'summary.md');
  const resultPath = path.resolve(taskDir, 'command_result.json');
  const workspaceRoot = useWorktree ? path.resolve(taskDir, 'worktree') : repoRoot;
  const workspaceCwdCandidate = node.cwd ? path.resolve(workspaceRoot, node.cwd) : workspaceRoot;
  if (!isWithinDir(workspaceRoot, workspaceCwdCandidate)) {
    throw new Error(`Command node ${node.id} resolved cwd outside workspace root: ${workspaceCwdCandidate}`);
  }
  if (node.cwd && !session.dryRun) {
    assertRuntimeDirectoryExists(
      workspaceCwdCandidate,
      `Command node ${node.id} at ${nodePath} (cwd=${node.cwd})`,
    );
  }
  const workspaceCwd = workspaceCwdCandidate;

  return {
    groupIndex,
    taskIndex,
    taskKey: taskKey(groupIndex, `${node.id}#a${attempt}`),
    taskId: node.id,
    repoAlias,
    command: node.command,
    args: node.args,
    timeoutSeconds: node.timeoutSec,
    allowFailure: node.allowFailure,
    priorTaskSummaries: gatherPriorTaskSummaries(session),
    taskDir,
    promptPath,
    logPath,
    lastMessagePath,
    reportPath,
    summaryPath,
    resultPath,
    workspaceRoot,
    workspaceCwd,
    baseRef,
    branch,
    useWorktree,
    nodePath,
    attempt,
    repoRoot,
  };
}

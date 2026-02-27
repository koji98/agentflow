import path from 'node:path';

import { DEFAULT_REPORT_FILENAME, DEFAULT_SUMMARY_FILENAME } from './constants.ts';
import { resolveConfigPaths } from './plan.ts';
import { buildPrompt } from './prompt.ts';
import type {
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

/**
 * Gathers summaries of completed prior tasks for prompt injection.
 * Reads exclusively from each task's `summary.md`. Tasks without a summary are skipped.
 * @param session Current run session.
 * @param contextFrom When non-empty, only include summaries from these task IDs.
 * @returns Array of prior task summaries sorted by completion time.
 */
export function gatherPriorTaskSummaries(
  session: Session,
  contextFrom: string[] = [],
): PriorTaskSummary[] {
  const filterSet = contextFrom.length > 0 ? new Set(contextFrom) : null;
  return Object.values(session.state.tasks)
    .filter((row) => row.status === 'DONE' || row.status === 'FAILED')
    .filter((row) => !filterSet || filterSet.has(row.taskId))
    .sort((a, b) => (a.endedAtUtc || '').localeCompare(b.endedAtUtc || ''))
    .map((row) => {
      const summaryContent = readText(row.summaryPath);
      if (!summaryContent) {
        log(`[context_from] no summary.md found for task "${row.taskId}", skipping`);
        return null;
      }
      return {
        taskId: row.taskId,
        status: row.status,
        summary: summaryContent.trim(),
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
 * @returns Fully populated task launch descriptor.
 */
export function buildLaunchFromTaskNode({
  session,
  node,
  nodePath,
  attempt,
  groupIndex,
  taskIndex,
}: {
  session: Session;
  node: TaskNode;
  nodePath: string;
  attempt: number;
  groupIndex: number;
  taskIndex: number;
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
  const branch = useWorktree
    ? `agentflow/${safeSlug(`${session.paths.runId}-r${repoAlias}-g${groupIndex}-t${task.taskId}-a${attempt}`)}`
    : null;
  const workspaceCwd = useWorktree ? path.resolve(taskDir, 'worktree') : repoRoot;

  const mergedContextFiles = [
    ...session.globalContextFiles,
    ...resolveConfigPaths(session.paths.configPath, session.paths.repoRoots, task.contextFiles, repoRoot),
  ];
  const workerContextFiles = mergedContextFiles.map((f) =>
    mapProjectPathToWorker(repoRoot, workspaceCwd, f),
  );
  const workerReportPath = mapProjectPathToWorker(repoRoot, workspaceCwd, reportPath);
  const workerSummaryPath = mapProjectPathToWorker(repoRoot, workspaceCwd, summaryPath);

  const provider = task.provider || session.plan.provider;
  const promptText = buildPrompt({
    persona: node.persona || session.plan.persona,
    objective: session.plan.objective,
    setup: session.plan.setup,
    task,
    contextFiles: workerContextFiles,
    reportPath: workerReportPath,
    summaryPath: workerSummaryPath,
    priorTaskSummaries: gatherPriorTaskSummaries(session, node.contextFrom),
  });

  return {
    groupIndex,
    taskIndex,
    taskKey: taskKey(groupIndex, `${task.taskId}#a${attempt}`),
    task,
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
    branch,
    useWorktree,
    skipGitRepoCheck: session.plan.options.skipGitRepoCheck,
    sandboxMode: session.plan.options.sandboxMode,
    nodePath,
    attempt,
    repoRoot,
  };
}

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
  const task: TaskLaunch['task'] = {
    task_id: node.task_id,
    task: node.task,
    provider: node.provider,
    model: node.model,
    persona: node.persona,
    context_files: node.context_files,
    context_from: node.context_from,
  };
  const taskSlug = safeSlug(`${node.task_id}-a${attempt}`);
  const taskDir = path.resolve(
    session.paths.run_root,
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
    ? `agentflow/${safeSlug(`${session.paths.run_id}-g${groupIndex}-t${task.task_id}-a${attempt}`)}`
    : null;
  const workspaceCwd = useWorktree ? path.resolve(taskDir, 'worktree') : session.paths.project_root;

  const mergedContextFiles = [
    ...session.global_context_files,
    ...resolveConfigPaths(session.paths.config_path, session.paths.project_root, task.context_files),
  ];
  const workerContextFiles = mergedContextFiles.map((f) =>
    mapProjectPathToWorker(session.paths.project_root, workspaceCwd, f),
  );
  const workerReportPath = mapProjectPathToWorker(session.paths.project_root, workspaceCwd, reportPath);
  const workerSummaryPath = mapProjectPathToWorker(session.paths.project_root, workspaceCwd, summaryPath);

  const provider = task.provider || session.plan.provider;
  const promptText = buildPrompt({
    persona: node.persona || session.plan.persona,
    objective: session.plan.objective,
    setup: session.plan.setup,
    task,
    contextFiles: workerContextFiles,
    reportPath: workerReportPath,
    summaryPath: workerSummaryPath,
    priorTaskSummaries: gatherPriorTaskSummaries(session, node.context_from),
  });

  return {
    group_index: groupIndex,
    task_index: taskIndex,
    task_key: taskKey(groupIndex, `${task.task_id}#a${attempt}`),
    task,
    provider,
    model: task.model || session.plan.model,
    reasoning_effort: session.plan.reasoning_effort,
    profile: session.plan.profile,
    prompt_text: promptText,
    task_dir: taskDir,
    prompt_path: promptPath,
    log_path: logPath,
    last_message_path: lastMessagePath,
    report_path: reportPath,
    worker_report_path: workerReportPath,
    summary_path: summaryPath,
    worker_summary_path: workerSummaryPath,
    workspace_cwd: workspaceCwd,
    branch,
    use_worktree: useWorktree,
    skip_git_repo_check: session.plan.options.skip_git_repo_check,
    sandbox_mode: session.plan.options.sandbox_mode,
    node_path: nodePath,
    attempt,
  };
}

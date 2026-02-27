import type { PriorTaskSummary } from './types.ts';

const DEFAULT_PERSONA = 'You are a senior software engineer. Write clean, well-tested code and explain your reasoning clearly.';

/**
 * Builds the full prompt sent to a worker for one task launch.
 *
 * @param params Prompt construction inputs.
 * @param params.persona Optional persona override; defaults to a senior engineer persona.
 * @param params.objective Optional high-level objective prepended to the prompt.
 * @param params.setup Background/setup section text.
 * @param params.task Task node with `task_id` and `task` description.
 * @param params.contextFiles Resolved file paths the agent should review.
 * @param params.reportPath Path where the agent should write its completion report.
 * @param params.summaryPath Path where the agent should write its downstream summary.
 * @param params.priorTaskSummaries Summaries of previously completed tasks for context.
 * @returns Complete prompt string ready for provider submission.
 */
export function buildPrompt({
  persona,
  objective,
  setup,
  task,
  contextFiles,
  reportPath,
  summaryPath,
  priorTaskSummaries,
}: {
  persona: string | null;
  objective: string | null;
  setup: string;
  task: { task_id: string; task: string };
  contextFiles: string[];
  reportPath: string;
  summaryPath: string;
  priorTaskSummaries: PriorTaskSummary[];
}): string {
  const sections: string[] = [];

  sections.push(persona || DEFAULT_PERSONA);

  if (objective) {
    sections.push(`## Overall Goal\n${objective}`);
  }

  if (setup) {
    sections.push(`## Background\n${setup}`);
  }

  sections.push(`## Your Task For Completing The Overall Goal (${task.task_id})\n${task.task}`);

  if (priorTaskSummaries.length > 0) {
    const summaryLines = priorTaskSummaries.map(
      (s) => `- **${s.taskId}** (${s.status}): ${s.summary || '(no summary)'}`,
    );
    sections.push(`## What's Been Done So Far\n${summaryLines.join('\n')}`);
  }

  if (contextFiles.length > 0) {
    sections.push(
      `## Files to Review First\n${contextFiles.map((f) => `- ${f}`).join('\n')}`,
    );
  }

  sections.push(
    `## When You're Done\n- Write a detailed report to: ${reportPath}\n  Include: what you did, files changed, tests run, any blockers.\n  If you cannot complete the task, explain exactly what is blocking you.\n- Write a brief summary to: ${summaryPath}\n  2-5 sentences for downstream tasks: what was the outcome, key decisions, what the next task should know.`,
  );

  return sections.join('\n\n') + '\n';
}

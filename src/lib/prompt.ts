/**
 * Builds the full prompt sent to a worker for one task launch.
 * @param params Prompt rendering inputs.
 * @param params.setup Run-level setup/instructions.
 * @param params.task Task payload (id, prompt, and task context files).
 * @param params.provider Selected provider id for the launch.
 * @param params.contextFiles Resolved context files to read before execution.
 * @param params.reportPath Destination path for the worker report file.
 * @param params.promptContract Prompt contract configuration for final status formatting.
 * @returns Rendered markdown prompt string.
 */
export function buildPrompt({ setup, task, provider, contextFiles, reportPath, promptContract }) {
  const statusContract = promptContract.require_status_line
    ? promptContract.allowed_statuses.map((status) => `   Status: ${status}`).join('\n')
    : '   (Status line optional by contract)';

  return `You are executing one task in an automated worker run.\n\nRun setup and intent:\n${setup}\n\nTask ID:\n- ${task.task_id}\n\nTask instruction:\n- ${task.task}\n\nExecution provider:\n- ${provider}\n\nRequired context files (read first):\n${contextFiles.length > 0 ? contextFiles.map((f) => `- ${f}`).join('\n') : '- (none configured)'}\n\nExecution rules:\n1) Complete only this task.\n2) Keep changes scoped and high quality.\n3) Run targeted tests for touched behavior.\n4) If blocked, report the exact blocking dependency.\n\nFinal response format:\n1) First line must be exactly one of:\n${statusContract}\n2) Files changed\n3) Tests run\n4) Blockers/dependencies\n\nMandatory report write:\n- Write a concise markdown report to:\n  ${reportPath}\n- Include status, summary, changed files, tests, blockers/dependencies.\n`;
}

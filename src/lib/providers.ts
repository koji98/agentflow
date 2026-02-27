import type { TaskLaunch } from './types.ts';

/**
 * Builds provider-specific command invocation for one task launch.
 * New providers should be added here behind the same launch contract.
 * @param launch Materialized task launch metadata.
 * @returns Shell argument vector where index 0 is the executable.
 * @throws {Error} When the provider is unsupported or not yet implemented.
 */
export function buildProviderCommand(launch: TaskLaunch): string[] {
  if (launch.provider === 'codex') {
    const cmd = ['codex', 'exec', '-o', launch.last_message_path];
    if (launch.skip_git_repo_check) cmd.push('--skip-git-repo-check');
    if (launch.profile) cmd.push('--profile', launch.profile);
    if (launch.model) cmd.push('-m', launch.model);
    if (launch.reasoning_effort) cmd.push('-c', `model_reasoning_effort=${launch.reasoning_effort}`);
    cmd.push('-');
    return cmd;
  }

  throw new Error(`Unsupported provider: ${launch.provider}`);
}

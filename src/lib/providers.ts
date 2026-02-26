import type { TaskLaunch } from './types.ts';

/**
 * Builds provider-specific command invocation for one task launch.
 * New providers should be added here behind the same launch contract.
 */
export function buildProviderCommand(launch: TaskLaunch): string[] {
  if (launch.provider === 'codex') {
    const cmd = ['codex', 'exec', '-o', launch.last_message_path];
    if (launch.profile) cmd.push('--profile', launch.profile);
    if (launch.model) cmd.push('-m', launch.model);
    if (launch.reasoning_effort) cmd.push('-c', `model_reasoning_effort=${launch.reasoning_effort}`);
    cmd.push('-');
    return cmd;
  }

  if (launch.provider === 'cursor') {
    throw new Error(
      "provider 'cursor' is not implemented yet. Add cursor adapter wiring in buildProviderCommand().",
    );
  }

  throw new Error(`Unsupported provider: ${launch.provider}`);
}

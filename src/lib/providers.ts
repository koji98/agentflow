import type { Provider, ReasoningEffort, SandboxMode } from './types.ts';
import { mapSandboxForCursor } from './utils.ts';

/** Shared inputs for building a provider CLI command. */
export interface ProviderCommandInput {
  provider: Provider;
  model: string | null;
  reasoning_effort: ReasoningEffort | null;
  profile: string | null;
  promptText: string;
  workspaceCwd: string;
  lastMessagePath: string;
  skipGitRepoCheck: boolean;
  sandboxMode: SandboxMode;
}

/**
 * Builds provider-specific command invocation.
 * Used by both task launches and AI gate evaluations.
 *
 * @param input Provider command configuration.
 * @returns Array of command tokens ready for spawn.
 * @throws {Error} When provider is not supported.
 */
export function buildProviderCommand(input: ProviderCommandInput): string[] {
  if (input.provider === 'codex') {
    const cmd = ['codex', 'exec', '-o', input.lastMessagePath];
    if (input.skipGitRepoCheck) cmd.push('--skip-git-repo-check');
    cmd.push('--sandbox', input.sandboxMode);
    if (input.profile) cmd.push('--profile', input.profile);
    if (input.model) cmd.push('-m', input.model);
    if (input.reasoning_effort) cmd.push('-c', `model_reasoning_effort=${input.reasoning_effort}`);
    cmd.push('-');
    return cmd;
  }

  if (input.provider === 'cursor') {
    const cmd = ['agent', '-p'];
    cmd.push('--output-format', 'text');
    cmd.push('--force');
    cmd.push('--workspace', input.workspaceCwd);
    const cursorSandbox = mapSandboxForCursor(input.sandboxMode);
    if (cursorSandbox) cmd.push('--sandbox', cursorSandbox);
    if (input.model) cmd.push('--model', input.model);
    cmd.push(input.promptText);
    return cmd;
  }

  throw new Error(`Unsupported provider: ${input.provider}`);
}

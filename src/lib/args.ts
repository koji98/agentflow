import type { CliArgs, SandboxMode } from './types.ts';

const SANDBOX_MODES = new Set<SandboxMode>([
  'read-only',
  'workspace-write',
  'danger-full-access',
]);

/**
 * Parses agentflow CLI arguments.
 * @param argv CLI tokens (without `node` and script path).
 * @returns Normalized argument object for one invocation.
 * @throws {Error} When an option is unsupported or missing its required value.
 */
export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    planFile: null,
    dryRunOverride: null,
    skipGitRepoCheck: false,
    sandboxMode: null,
    validate: false,
    resumeDir: null,
    planHelp: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--plan-help') {
      out.planHelp = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      out.help = true;
      continue;
    }
    if (token === '--plan') {
      const value = argv[i + 1];
      if (!value) throw new Error('--plan requires a value.');
      out.planFile = value;
      i += 1;
      continue;
    }
    if (token === '--validate') {
      out.validate = true;
      continue;
    }
    if (token === '--resume') {
      const value = argv[i + 1];
      if (!value) throw new Error('--resume requires a value.');
      out.resumeDir = value;
      i += 1;
      continue;
    }
    if (token === '--dry-run') {
      out.dryRunOverride = true;
      continue;
    }
    if (token === '--skip-git-repo-check') {
      out.skipGitRepoCheck = true;
      continue;
    }
    if (token === '--sandbox') {
      const value = argv[i + 1];
      if (!value) throw new Error('--sandbox requires a value.');
      if (!SANDBOX_MODES.has(value as SandboxMode)) {
        throw new Error(
          `--sandbox must be one of: read-only, workspace-write, danger-full-access.`,
        );
      }
      out.sandboxMode = value as SandboxMode;
      i += 1;
      continue;
    }
    if (token.startsWith('-')) throw new Error(`Unsupported option: ${token}`);
    if (!out.planFile) {
      out.planFile = token;
      continue;
    }
    throw new Error(`Unexpected argument: ${token}`);
  }
  return out;
}

import type { CliArgs } from './types.ts';

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
    if (token === '--dry-run') {
      out.dryRunOverride = true;
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

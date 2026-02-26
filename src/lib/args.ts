import type { CliArgs } from './types.ts';

/** Parses CLI args for agentflow. */
export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    planFile: null,
    repoRootOverride: null,
    planDocOverride: null,
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
    if (token === '--repo') {
      const value = argv[i + 1];
      if (!value) throw new Error('--repo requires a value.');
      out.repoRootOverride = value;
      i += 1;
      continue;
    }
    if (token === '--plan-doc') {
      const value = argv[i + 1];
      if (!value) throw new Error('--plan-doc requires a value.');
      out.planDocOverride = value;
      i += 1;
      continue;
    }
    if (token === '--dry-run') {
      out.dryRunOverride = true;
      continue;
    }
    if (token === '--no-dry-run') {
      out.dryRunOverride = false;
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

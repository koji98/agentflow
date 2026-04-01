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
    supervisor: false,
    supervisorConfigFile: null,
    missionStateFile: null,
    supervisorProfile: null,
    webMode: false,
    webHost: null,
    webPort: null,
    webNoOpen: false,
    planHelp: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === 'web' && i === 0) {
      out.webMode = true;
      continue;
    }
    if (token === '--plan-help') {
      out.planHelp = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      out.help = true;
      continue;
    }
    if (token === 'supervise') {
      throw new Error('`supervise` command was removed. Use --supervise <mission_state_file>.');
    }
    if (token === '--plan') {
      const value = argv[i + 1];
      if (!value) throw new Error('--plan requires a value.');
      out.planFile = value;
      i += 1;
      continue;
    }
    if (token === '--supervise') {
      const value = argv[i + 1];
      if (!value) throw new Error('--supervise requires a value.');
      out.supervisor = true;
      out.missionStateFile = value;
      i += 1;
      continue;
    }
    if (token === '--validate') {
      out.validate = true;
      continue;
    }
    if (token === '--host') {
      const value = argv[i + 1];
      if (!value) throw new Error('--host requires a value.');
      out.webHost = value;
      i += 1;
      continue;
    }
    if (token === '--port') {
      const value = argv[i + 1];
      if (!value) throw new Error('--port requires a value.');
      const port = Number(value);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error('--port must be an integer between 1 and 65535.');
      }
      out.webPort = port;
      i += 1;
      continue;
    }
    if (token === '--no-open') {
      out.webNoOpen = true;
      continue;
    }
    if (token === '--resume') {
      const value = argv[i + 1];
      if (!value) throw new Error('--resume requires a value.');
      out.resumeDir = value;
      i += 1;
      continue;
    }
    if (token === '--supervisor-config') {
      const value = argv[i + 1];
      if (!value) throw new Error('--supervisor-config requires a value.');
      out.supervisorConfigFile = value;
      i += 1;
      continue;
    }
    if (token === '--supervisor-profile') {
      const value = argv[i + 1];
      if (!value) throw new Error('--supervisor-profile requires a value.');
      out.supervisorProfile = value;
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

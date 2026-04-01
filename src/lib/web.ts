import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

import { log, logError } from './log.ts';
import type { CliArgs } from './types.ts';

export const DEFAULT_WEB_HOST = '127.0.0.1';
export const DEFAULT_WEB_PORT = 3208;

export interface WebModeDeps {
  cwd(): string;
  existsSync(filePath: string): boolean;
  fetch(input: string, init?: RequestInit): Promise<{ ok: boolean; status?: number }>;
  spawnDetached(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): void;
  spawnSync(
    command: string,
    args: string[],
    options: { cwd: string; env?: NodeJS.ProcessEnv },
  ): { status: number | null; stdout?: string | Buffer | null; stderr?: string | Buffer | null };
  openExternal(url: string): void;
  sleep(ms: number): Promise<void>;
  log(message: string): void;
  logError(message: string): void;
}

const defaultDeps: WebModeDeps = {
  cwd: () => process.cwd(),
  existsSync: (filePath) => fs.existsSync(filePath),
  fetch: (input, init) => fetch(input, init),
  spawnDetached: (command, args, options) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  },
  spawnSync: (command, args, options) =>
    spawnSync(command, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      stdio: 'pipe',
    }),
  openExternal: (url) => openExternalUrl(url),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log,
  logError,
};

function npmExecutable(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

function uniquePaths(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const resolved = path.resolve(value);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

export function findAgentflowRepoRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'bin', 'agentflow.js'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir);
}

export function resolveWebPlanPath(planFile: string | null, cwd: string): string | null {
  if (!planFile) return null;
  return path.isAbsolute(planFile)
    ? path.resolve(planFile)
    : path.resolve(cwd, planFile);
}

export function buildWebUrl(host: string, port: number, planPath: string | null): string {
  const url = new URL(`http://${host}:${port}/`);
  if (planPath) url.searchParams.set('plan', planPath);
  return url.toString();
}

export async function isWebServerHealthy(baseUrl: string, deps: Pick<WebModeDeps, 'fetch'> = defaultDeps): Promise<boolean> {
  try {
    const res = await deps.fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(750),
    });
    return Boolean(res.ok);
  } catch {
    return false;
  }
}

function openExternalUrl(url: string): void {
  if (process.platform === 'darwin') {
    const child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    child.unref();
    return;
  }
  if (process.platform === 'win32') {
    const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
    child.unref();
    return;
  }
  const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
  child.unref();
}

async function ensureWebBuild(repoRoot: string, deps: Pick<WebModeDeps, 'existsSync' | 'spawnSync'>): Promise<void> {
  const distIndex = path.resolve(repoRoot, 'web-app', 'client', 'dist', 'index.html');
  if (deps.existsSync(distIndex)) return;

  const result = deps.spawnSync(npmExecutable(), ['--prefix', 'web-app', 'run', 'build'], {
    cwd: repoRoot,
    env: process.env,
  });
  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    const stdout = String(result.stdout || '').trim();
    throw new Error(
      `web-app build failed.${stderr ? ` ${stderr}` : stdout ? ` ${stdout}` : ''}`,
    );
  }
}

async function waitForWebServer(baseUrl: string, deps: Pick<WebModeDeps, 'fetch' | 'sleep'>): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    if (await isWebServerHealthy(baseUrl, deps)) return;
    await deps.sleep(250);
  }
  throw new Error(`agentflow web server did not become healthy at ${baseUrl}`);
}

function spawnWebServer(
  repoRoot: string,
  cwd: string,
  host: string,
  port: number,
  planPath: string | null,
  deps: Pick<WebModeDeps, 'spawnDetached'>,
): void {
  const allowedRoots = uniquePaths([
    repoRoot,
    cwd,
    path.dirname(repoRoot),
    planPath ? path.dirname(planPath) : null,
    os.tmpdir(),
  ]);
  deps.spawnDetached(
    npmExecutable(),
    ['--prefix', 'web-app', 'run', 'start'],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        AGENTFLOW_WEB_ALLOWED_ROOTS: allowedRoots.join(path.delimiter),
        HOST: host,
        PORT: String(port),
        NODE_ENV: 'production',
      },
    },
  );
}

export async function runWebMode(args: CliArgs, deps: Partial<WebModeDeps> = {}): Promise<number> {
  const impl = { ...defaultDeps, ...deps };
  const invalidWebFlags = [
    args.dryRunOverride !== null,
    args.skipGitRepoCheck,
    args.sandboxMode !== null,
    args.validate,
    args.resumeDir !== null,
    args.supervisor,
    args.supervisorConfigFile !== null,
    args.supervisorProfile !== null,
    args.missionStateFile !== null,
  ];
  if (invalidWebFlags.some(Boolean)) {
    impl.logError('`agentflow web` only supports --plan, --host, --port, and --no-open.');
    return 2;
  }

  const cwd = impl.cwd();
  const repoRoot = findAgentflowRepoRoot(cwd);
  const host = args.webHost || DEFAULT_WEB_HOST;
  const port = args.webPort || DEFAULT_WEB_PORT;
  if (!isLoopbackHost(host) && process.env.AGENTFLOW_WEB_ALLOW_REMOTE !== '1') {
    impl.logError('Refusing to bind agentflow web to a non-loopback host without AGENTFLOW_WEB_ALLOW_REMOTE=1.');
    return 2;
  }
  const planPath = resolveWebPlanPath(args.planFile, cwd);
  if (planPath && !impl.existsSync(planPath)) {
    impl.logError(`Plan file not found: ${planPath}`);
    return 1;
  }

  await ensureWebBuild(repoRoot, impl);
  const baseUrl = `http://${host}:${port}`;
  if (!(await isWebServerHealthy(baseUrl, impl))) {
    spawnWebServer(repoRoot, cwd, host, port, planPath, impl);
    await waitForWebServer(baseUrl, impl);
    impl.log(`web_server: started ${baseUrl}`);
  } else {
    impl.log(`web_server: reused ${baseUrl}`);
  }

  const url = buildWebUrl(host, port, planPath);
  if (!args.webNoOpen) {
    impl.openExternal(url);
  }
  impl.log(`web_url: ${url}`);
  return 0;
}

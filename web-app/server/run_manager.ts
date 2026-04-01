import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { watchRunFiles } from './file_watch.ts';
import { getBus } from './sse_bus.ts';

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ConsoleSource = 'stdout' | 'stderr';
export interface RunConsoleEntry {
  atUtc: string;
  source: ConsoleSource;
  text: string;
}

export type RunHandle = {
  runId: string;
  runDir: string;
  planPath?: string;
  child?: ChildProcess | null;
  closeWatch?: () => void;
  isActive: boolean;
  cancelRequested: boolean;
  lastExitCode: number | null;
  recentConsole: RunConsoleEntry[];
};

const runs = new Map<string, RunHandle>();
const MAX_CONSOLE_ENTRIES = 300;

function inferActiveFromState(state: Record<string, unknown>): boolean {
  const taskRows = Object.values((state.tasks as Record<string, Record<string, unknown>>) || {});
  const groupRows = Object.values((state.groups as Record<string, Record<string, unknown>>) || {});
  const statuses = [...taskRows, ...groupRows].map((row) => String(row.status || ''));
  if (statuses.some((status) => status === 'RUNNING')) return true;

  const runFailureReasons = Array.isArray(state.runFailureReasons) ? state.runFailureReasons : [];
  const failureCount = Number(state.totalFailureCount || 0) + Number(state.totalRunFailureCount || 0);
  if (Boolean(state.cancelRequested) || runFailureReasons.length > 0 || failureCount > 0) return false;

  const totalTaskCount = Number(state.totalTaskCount || 0);
  const terminalTasks = taskRows.filter((row) => {
    const status = String(row.status || '');
    return status === 'DONE' || status === 'FAILED';
  }).length;
  return totalTaskCount > 0 && terminalTasks < totalTaskCount;
}

function parseCliLine(line: string): { key: string; value: string } | null {
  const m = /^(\w+):\s+(.+)$/.exec(line.trim());
  if (!m) return null;
  return { key: m[1], value: m[2] };
}

function findRepoRoot(): string {
  // Start at process.cwd() and walk up until repo root detected (has bin/agentflow.js)
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'bin', 'agentflow.js'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback to two levels up from web-app
  return path.resolve(process.cwd(), '..');
}

function resolveBin(): string {
  const repoRoot = findRepoRoot();
  return path.resolve(repoRoot, 'bin', 'agentflow.js');
}

function attachWatchers(handle: RunHandle): void {
  if (handle.closeWatch) handle.closeWatch();
  const watcher = watchRunFiles(handle.runId, handle.runDir, {
    onState: (state) => {
      if (!handle.child) {
        handle.isActive = inferActiveFromState(state);
      }
      if (!handle.planPath && typeof state.configPath === 'string') {
        handle.planPath = state.configPath;
      }
    },
  });
  handle.closeWatch = watcher.close;
}

function nowUtcIso(): string {
  return new Date().toISOString();
}

function pushConsoleEntries(handle: RunHandle, source: ConsoleSource, text: string): void {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return;

  const entries = lines.map((line) => ({
    atUtc: nowUtcIso(),
    source,
    text: line,
  }));
  handle.recentConsole.push(...entries);
  if (handle.recentConsole.length > MAX_CONSOLE_ENTRIES) {
    handle.recentConsole.splice(0, handle.recentConsole.length - MAX_CONSOLE_ENTRIES);
  }
  const bus = getBus(handle.runId);
  bus.emit('event', { type: 'run-console', entries });
}

function finalizeHandle(handle: RunHandle, code: number | null): void {
  handle.isActive = false;
  handle.child = null;
  handle.lastExitCode = code === null ? null : Number(code);
  try { handle.closeWatch?.(); } catch {}
  handle.closeWatch = undefined;
  const bus = getBus(handle.runId);
  bus.emit('event', {
    type: 'run-exited',
    code: handle.lastExitCode,
    cancelled: handle.cancelRequested,
  });
}

function createHandle(params: {
  runId: string;
  runDir: string;
  planPath?: string;
  child?: ChildProcess | null;
  isActive: boolean;
}): RunHandle {
  return {
    runId: params.runId,
    runDir: params.runDir,
    planPath: params.planPath,
    child: params.child ?? null,
    isActive: params.isActive,
    cancelRequested: false,
    lastExitCode: null,
    recentConsole: [],
  };
}

function spawnManagedRun(params: {
  args: string[];
  planPath?: string;
  runDirHint?: string | null;
  runIdHint?: string | null;
}): Promise<RunHandle> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, params.args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let runId: string | null = params.runIdHint || null;
    let runRootDir: string | null = params.runDirHint || null;
    let settled = false;
    let handle: RunHandle | null = null;
    const pendingConsole: RunConsoleEntry[] = [];

    const flushPendingConsole = (): void => {
      if (!handle || pendingConsole.length === 0) return;
      for (const entry of pendingConsole) {
        handle.recentConsole.push(entry);
      }
      if (handle.recentConsole.length > MAX_CONSOLE_ENTRIES) {
        handle.recentConsole.splice(0, handle.recentConsole.length - MAX_CONSOLE_ENTRIES);
      }
      pendingConsole.length = 0;
    };

    const tryResolve = (): void => {
      if (!runId || !runRootDir || handle) return;
      handle = createHandle({
        runId,
        runDir: path.resolve(runRootDir),
        planPath: params.planPath,
        child,
        isActive: true,
      });
      runs.set(runId, handle);
      attachWatchers(handle);
      flushPendingConsole();
      if (!settled) {
        settled = true;
        resolve(handle);
      }
    };

    const onConsole = (source: ConsoleSource, chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      const lines = text
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0);
      if (lines.length === 0) return;

      if (source === 'stdout') {
        for (const line of lines) {
          const kv = parseCliLine(line);
          if (!kv) continue;
          if (kv.key === 'run_id') runId = kv.value;
          if (kv.key === 'run_root') runRootDir = kv.value;
        }
      }

      if (handle) {
        pushConsoleEntries(handle, source, text);
      } else {
        pendingConsole.push(...lines.map((line) => ({
          atUtc: nowUtcIso(),
          source,
          text: line,
        })));
      }
      tryResolve();
    };

    child.stdout.on('data', (chunk: Buffer) => onConsole('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => onConsole('stderr', chunk));
    child.once('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.once('exit', (code) => {
      if (!handle) {
        if (!settled) {
          settled = true;
          reject(new Error(`agentflow exited before emitting run metadata (exit=${Number(code || 0)})`));
        }
        return;
      }
      finalizeHandle(handle, code);
    });

    // Resume/open flows may already know enough to register immediately.
    tryResolve();

    // Fallback for runs that emit run_id but not run_root promptly.
    setTimeout(() => {
      if (runId && !runRootDir && params.planPath) {
        const planDir = path.dirname(params.planPath);
        const candidate = path.resolve(planDir, 'tmp/agentflow_runs', runId);
        if (fs.existsSync(candidate)) {
          runRootDir = candidate;
          tryResolve();
        }
      }
    }, 1500);
  });
}

export function openRun(runDir: string): RunHandle {
  const statePath = path.resolve(runDir, 'run_state.json');
  if (!fs.existsSync(statePath)) {
    throw new Error();
  }
  const json = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
  const runId = String(json.runId || path.basename(runDir));
  const existing = runs.get(runId);
  if (existing) return existing;
  const handle = createHandle({
    runId,
    runDir,
    planPath: typeof json.configPath === 'string' ? json.configPath : undefined,
    child: null,
    isActive: inferActiveFromState(json),
  });
  runs.set(runId, handle);
  attachWatchers(handle);
  return handle;
}

export function startRun(params: {
  planPath: string;
  skipGitRepoCheck?: boolean;
  sandbox?: SandboxMode;
  dryRun?: boolean;
}): Promise<RunHandle> {
  const bin = resolveBin();
  const args: string[] = [bin, '--plan', params.planPath];
  if (params.dryRun) args.push('--dry-run');
  if (params.skipGitRepoCheck) args.push('--skip-git-repo-check');
  if (params.sandbox) args.push('--sandbox', params.sandbox);

  return spawnManagedRun({
    args,
    planPath: params.planPath,
  });
}

export function resumeRun(params: {
  runDir: string;
  planPath?: string;
  skipGitRepoCheck?: boolean;
  sandbox?: SandboxMode;
  dryRun?: boolean;
}): Promise<RunHandle> {
  const statePath = path.resolve(params.runDir, 'run_state.json');
  if (!fs.existsSync(statePath)) return Promise.reject(new Error());
  const json = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
  const inferredPlan = params.planPath || String(json.configPath);

  const bin = resolveBin();
  const args: string[] = [bin, '--plan', inferredPlan, '--resume', params.runDir];
  if (params.dryRun) args.push('--dry-run');
  if (params.skipGitRepoCheck) args.push('--skip-git-repo-check');
  if (params.sandbox) args.push('--sandbox', params.sandbox);

  return spawnManagedRun({
    args,
    planPath: inferredPlan,
    runDirHint: params.runDir,
    runIdHint: String(json.runId || ''),
  });
}

export function cancelRun(runId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const handle = runs.get(runId);
    if (!handle || !handle.child) return resolve(true);
    const child = handle.child;
    handle.cancelRequested = true;
    getBus(runId).emit('event', { type: 'run-cancelled', runId });
    let resolved = false;
    const done = (ok: boolean): void => { if (resolved) return; resolved = true; resolve(ok); };
    child.once('exit', () => done(true));
    try { child.kill('SIGINT'); } catch {}
    setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, 3000);
    setTimeout(() => {
      if (handle.isActive && child.exitCode !== null) {
        finalizeHandle(handle, child.exitCode);
        done(true);
        return;
      }
      done(false);
    }, 7000);
  });
}

export function getHandle(runId: string): RunHandle | undefined {
  return runs.get(runId);
}

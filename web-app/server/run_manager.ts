import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { getAllowedRoots, isPathAllowed } from './fs_access.ts';
import { watchRunFiles } from './file_watch.ts';
import { readJsonFile } from './json_files.ts';
import { getBus } from './sse_bus.ts';
import {
  collectLifecycleRows,
  hasRecordedFailure,
  inferActiveFromStateSnapshot,
  inferResumableFromStateSnapshot,
} from '../shared/run_state.ts';

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
  lastKnownState?: Record<string, unknown>;
  lastKnownDecisionTrace?: Array<Record<string, unknown>>;
};

export type RunResolution =
  | { kind: 'resolved'; handle: RunHandle }
  | { kind: 'not_found' }
  | { kind: 'ambiguous'; runDirs: string[] };

const runs = new Map<string, RunHandle>();
const MAX_CONSOLE_ENTRIES = 300;
const MAX_RUN_ROOT_CHILDREN = 120;
const MAX_RUN_ROOT_DEPTH = 2;
const MAX_RUN_ROOT_DIRS = 240;

function trimConsoleEntries(entries: RunConsoleEntry[]): RunConsoleEntry[] {
  if (entries.length <= MAX_CONSOLE_ENTRIES) return entries;
  return entries.slice(entries.length - MAX_CONSOLE_ENTRIES);
}

function cancellationLikeReason(reason: string): boolean {
  const normalized = reason.toLowerCase();
  return normalized.includes('signal:sigint')
    || normalized.includes('signal:sigterm')
    || normalized.includes('cancelled')
    || normalized.includes('canceled');
}

function inferCancelRequestedFromState(state: Record<string, unknown>): boolean {
  if (Boolean(state.cancelRequested)) return true;
  const runFailureReasons = Array.isArray(state.runFailureReasons) ? state.runFailureReasons : [];
  return runFailureReasons.some((reason) => cancellationLikeReason(String(reason || '')));
}

function readTraceFile(runDir: string): Array<Record<string, unknown>> | null {
  const tracePath = path.resolve(runDir, 'decision_trace.json');
  if (!fs.existsSync(tracePath)) return [];
  const trace = readJsonFile<Array<Record<string, unknown>>>(tracePath);
  return Array.isArray(trace) ? trace : null;
}

export function inferActiveFromState(
  state: Record<string, unknown>,
  trace?: Array<Record<string, unknown>>,
): boolean {
  return inferActiveFromStateSnapshot(state, trace);
}

export function inferResumableFromState(
  state: Record<string, unknown>,
  trace?: Array<Record<string, unknown>>,
): boolean {
  return inferResumableFromStateSnapshot(state, trace);
}

export function inferHandleActive(
  handle: RunHandle | undefined,
  state: Record<string, unknown>,
  trace?: Array<Record<string, unknown>>,
): boolean {
  if (handle?.child) return handle.isActive;
  if (handle && handle.lastExitCode !== null) return false;
  return inferActiveFromState(state, trace);
}

export function inferHandleResumable(
  handle: RunHandle | undefined,
  state: Record<string, unknown>,
  trace?: Array<Record<string, unknown>>,
): boolean {
  if (inferHandleActive(handle, state, trace)) return false;
  if (!handle || handle.lastExitCode === null) {
    return inferResumableFromState(state, trace);
  }
  if (handle.lastExitCode === 0) return false;
  if (inferResumableFromState(state, trace)) return true;

  const rows = collectLifecycleRows(state);
  return hasRecordedFailure(state) || rows.some((row) => String(row.status || '') !== 'DONE');
}

export function deriveRunCapabilities(
  handle: RunHandle | undefined,
  state: Record<string, unknown>,
  trace?: Array<Record<string, unknown>>,
): { canCancel: boolean; canResume: boolean } {
  const isActive = inferHandleActive(handle, state, trace);
  return {
    canCancel: Boolean(handle?.child && isActive),
    canResume: inferHandleResumable(handle, state, trace),
  };
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
      refreshHandleFromState(handle, state);
    },
    onTrace: (entries) => {
      handle.lastKnownDecisionTrace = entries;
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
  handle.recentConsole = trimConsoleEntries(handle.recentConsole);
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
  cancelRequested?: boolean;
  recentConsole?: RunConsoleEntry[];
  lastKnownState?: Record<string, unknown>;
  lastKnownDecisionTrace?: Array<Record<string, unknown>>;
}): RunHandle {
  return {
    runId: params.runId,
    runDir: params.runDir,
    planPath: params.planPath,
    child: params.child ?? null,
    isActive: params.isActive,
    cancelRequested: params.cancelRequested ?? false,
    lastExitCode: null,
    recentConsole: trimConsoleEntries([...(params.recentConsole || [])]),
    lastKnownState: params.lastKnownState,
    lastKnownDecisionTrace: params.lastKnownDecisionTrace,
  };
}

function mergeHandleConsole(existing: RunHandle | undefined, incoming: RunConsoleEntry[]): RunConsoleEntry[] {
  if (!existing) return trimConsoleEntries([...incoming]);
  return trimConsoleEntries([...existing.recentConsole, ...incoming]);
}

function registerHandle(handle: RunHandle): RunHandle {
  const existing = runs.get(handle.runId);
  if (existing && existing !== handle) {
    handle.recentConsole = mergeHandleConsole(existing, handle.recentConsole);
    handle.lastKnownState = handle.lastKnownState || existing.lastKnownState;
    handle.lastKnownDecisionTrace = handle.lastKnownDecisionTrace || existing.lastKnownDecisionTrace;
    try { existing.closeWatch?.(); } catch {}
    existing.closeWatch = undefined;
  }
  runs.set(handle.runId, handle);
  return handle;
}

export function refreshHandleFromState(handle: RunHandle, state: Record<string, unknown>): RunHandle {
  handle.lastKnownState = state;
  if (typeof state.configPath === 'string') {
    handle.planPath = state.configPath;
  }
  handle.isActive = inferHandleActive(handle, state, handle.lastKnownDecisionTrace);
  if (!handle.child) handle.cancelRequested = inferCancelRequestedFromState(state);
  return handle;
}

function refreshHandleFromDisk(handle: RunHandle): RunHandle {
  const statePath = path.resolve(handle.runDir, 'run_state.json');
  if (!fs.existsSync(statePath)) return handle;
  const trace = readTraceFile(handle.runDir);
  if (trace !== null) handle.lastKnownDecisionTrace = trace;
  const state = readJsonFile<Record<string, unknown>>(statePath);
  return state ? refreshHandleFromState(handle, state) : handle;
}

function readSearchChildren(root: string): fs.Dirent[] {
  try {
    const children = fs.readdirSync(root, { withFileTypes: true });
    return children
      .filter((child) => child.isDirectory())
      .sort((left, right) => {
        if (left.name === '.tmp' && right.name !== '.tmp') return -1;
        if (right.name === '.tmp' && left.name !== '.tmp') return 1;
        return left.name.localeCompare(right.name);
      });
  } catch {
    return [];
  }
}

function shouldSkipRunRootChild(name: string): boolean {
  return name === '.git'
    || name === 'node_modules'
    || name === 'dist'
    || name === 'coverage';
}

function collectRunSearchRoots(root: string): string[] {
  const searchRoots = [path.resolve(root)];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: path.resolve(root), depth: 0 }];
  const seen = new Set(searchRoots);

  while (queue.length > 0 && searchRoots.length < MAX_RUN_ROOT_DIRS) {
    const next = queue.shift();
    if (!next || next.depth >= MAX_RUN_ROOT_DEPTH) continue;

    let scanned = 0;
    for (const child of readSearchChildren(next.dir)) {
      if (scanned >= MAX_RUN_ROOT_CHILDREN || searchRoots.length >= MAX_RUN_ROOT_DIRS) break;
      if (shouldSkipRunRootChild(child.name)) continue;
      scanned += 1;
      const childRoot = path.resolve(next.dir, child.name);
      if (seen.has(childRoot)) continue;
      seen.add(childRoot);
      searchRoots.push(childRoot);
      queue.push({ dir: childRoot, depth: next.depth + 1 });
    }
  }

  return searchRoots;
}

function candidateRunDirsForRoot(root: string, runId: string): string[] {
  const candidates: string[] = [];
  for (const searchRoot of collectRunSearchRoots(root)) {
    candidates.push(
      path.resolve(searchRoot, '.tmp', 'agentflow_runs', runId),
      path.resolve(searchRoot, 'tmp', 'agentflow_runs', runId),
      path.resolve(searchRoot, 'agentflow_runs', runId),
      path.resolve(searchRoot, runId),
    );
  }
  return candidates;
}

function findRunDirsById(runId: string): string[] {
  const allowedRoots = getAllowedRoots();
  const seen = new Set<string>();
  const matches: string[] = [];

  for (const root of allowedRoots) {
    for (const candidate of candidateRunDirsForRoot(root, runId)) {
      const resolved = path.resolve(candidate);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      if (!isPathAllowed(resolved, allowedRoots)) continue;
      if (!fs.existsSync(path.resolve(resolved, 'run_state.json'))) continue;
      matches.push(resolved);
    }
  }

  return matches;
}

function spawnManagedRun(params: {
  args: string[];
  planPath?: string;
  runDirHint?: string | null;
  runIdHint?: string | null;
  initialState?: Record<string, unknown>;
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
      handle.recentConsole = trimConsoleEntries(handle.recentConsole);
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
        lastKnownState: params.initialState,
      });
      registerHandle(handle);
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
  const json = readJsonFile<Record<string, unknown>>(statePath);
  if (!json) {
    throw new Error();
  }
  const trace = readTraceFile(runDir) || [];
  const runId = String(json.runId || path.basename(runDir));
  const existing = runs.get(runId);
  if (existing) {
    existing.runDir = path.resolve(runDir);
    existing.lastKnownDecisionTrace = trace;
    refreshHandleFromState(existing, json);
    attachWatchers(existing);
    return existing;
  }
  const handle = createHandle({
    runId,
    runDir: path.resolve(runDir),
    planPath: typeof json.configPath === 'string' ? json.configPath : undefined,
    child: null,
    isActive: inferActiveFromState(json, trace),
    cancelRequested: inferCancelRequestedFromState(json),
    lastKnownState: json,
    lastKnownDecisionTrace: trace,
  });
  registerHandle(handle);
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
  const json = readJsonFile<Record<string, unknown>>(statePath);
  if (!json) return Promise.reject(new Error());
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
    initialState: json,
  });
}

export function cancelRun(runId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const handle = runs.get(runId);
    if (!handle || !handle.child || !handle.isActive) return resolve(false);
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

export function resolveHandle(runId: string): RunHandle | undefined {
  const resolution = inspectRunResolution(runId);
  return resolution.kind === 'resolved' ? resolution.handle : undefined;
}

export function inspectRunResolution(runId: string): RunResolution {
  const existing = runs.get(runId);
  if (existing) {
    const statePath = path.resolve(existing.runDir, 'run_state.json');
    if (!fs.existsSync(statePath)) {
      try { existing.closeWatch?.(); } catch {}
      existing.closeWatch = undefined;
      runs.delete(runId);
    } else {
      refreshHandleFromDisk(existing);
      if (!existing.closeWatch) attachWatchers(existing);
      return { kind: 'resolved', handle: existing };
    }
  }

  const runDirs = findRunDirsById(runId);
  if (runDirs.length === 0) return { kind: 'not_found' };
  if (runDirs.length > 1) return { kind: 'ambiguous', runDirs };
  return { kind: 'resolved', handle: openRun(runDirs[0]) };
}

import fs from 'node:fs';
import path from 'node:path';
import { getBus } from './sse_bus.ts';
import { readJsonFile } from './json_files.ts';

export function deriveTraceUpdates(entries: Record<string, unknown>[], previousLength: number): {
  kind: 'snapshot' | 'append';
  entries: Record<string, unknown>[];
  nextLength: number;
  startIndex: number;
} | null {
  if (entries.length === 0) {
    return previousLength === 0
      ? null
      : { kind: 'snapshot', entries: [], nextLength: 0, startIndex: 0 };
  }
  const snapshotStartIndex = Math.max(0, entries.length - 50);
  if (previousLength <= 0 || entries.length < previousLength) {
    return {
      kind: 'snapshot',
      entries: entries.slice(snapshotStartIndex),
      nextLength: entries.length,
      startIndex: snapshotStartIndex,
    };
  }
  if (entries.length === previousLength) {
    return {
      kind: 'snapshot',
      entries: entries.slice(snapshotStartIndex),
      nextLength: entries.length,
      startIndex: snapshotStartIndex,
    };
  }
  const appended = entries.slice(previousLength);
  if (appended.length === 0) return null;
  return {
    kind: 'append',
    entries: appended,
    nextLength: entries.length,
    startIndex: previousLength,
  };
}

export function watchRunFiles(
  runId: string,
  runDir: string,
  hooks?: {
    onState?: (state: Record<string, unknown>) => void;
    onTrace?: (entries: Record<string, unknown>[]) => void;
  },
): { close: () => void } {
  const bus = getBus(runId);
  const statePath = path.resolve(runDir, 'run_state.json');
  const tracePath = path.resolve(runDir, 'decision_trace.json');

  const fileWatchers = new Map<string, fs.FSWatcher>();
  const rootWatchers: fs.FSWatcher[] = [];
  const debounceMap = new Map<string, NodeJS.Timeout>();
  let lastTraceLength = 0;

  const onChange = (file: string, emit: () => void): void => {
    const prev = debounceMap.get(file);
    if (prev) clearTimeout(prev);
    debounceMap.set(file, setTimeout(emit, 120));
  };

  const hasFileWatcher = (filePath: string): boolean => fileWatchers.has(filePath);
  const detachFileWatcher = (filePath: string): void => {
    const watcher = fileWatchers.get(filePath);
    if (!watcher) return;
    try { watcher.close(); } catch {}
    fileWatchers.delete(filePath);
  };

  const emitStateUpdate = (): void => {
    const json = readJsonFile<Record<string, unknown>>(statePath);
    if (!json) return;
    hooks?.onState?.(json);
    bus.emit('event', { type: 'run-state', state: json });
  };

  const emitTraceUpdate = (): void => {
    if (!fs.existsSync(tracePath)) {
      if (lastTraceLength === 0) return;
      lastTraceLength = 0;
      hooks?.onTrace?.([]);
      bus.emit('event', {
        type: 'decision-trace-snapshot',
        entries: [],
        nextLength: 0,
        startIndex: 0,
      });
      return;
    }

    try {
      const raw = fs.readFileSync(tracePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      const entries = parsed as Record<string, unknown>[];
      const update = deriveTraceUpdates(entries, lastTraceLength);
      lastTraceLength = entries.length;
      hooks?.onTrace?.(entries);
      if (!update) return;
      if (update.kind === 'snapshot') {
        bus.emit('event', {
          type: 'decision-trace-snapshot',
          entries: update.entries,
          nextLength: update.nextLength,
          startIndex: update.startIndex,
        });
        return;
      }
      for (const entry of update.entries) {
        bus.emit('event', { type: 'decision-trace', entry });
      }
    } catch {}
  };

  const attachStateWatcher = (): void => {
    if (hasFileWatcher(statePath)) return;
    try {
      emitStateUpdate();
      const w = fs.watch(statePath, () => onChange(statePath, emitStateUpdate));
      fileWatchers.set(statePath, w);
    } catch {}
  };

  const attachTraceWatcher = (): void => {
    if (hasFileWatcher(tracePath)) return;
    try {
      emitTraceUpdate();
      const w = fs.watch(tracePath, () => onChange(tracePath, emitTraceUpdate));
      fileWatchers.set(tracePath, w);
    } catch {}
  };

  // Attach watchers immediately if files already exist
  if (fs.existsSync(statePath)) attachStateWatcher();
  if (fs.existsSync(tracePath)) attachTraceWatcher();

  // Watch the directory for late file creation
  try {
    const dirWatcher = fs.watch(runDir, { persistent: true }, (_eventType, filename) => {
      if (!filename) return;
      const full = path.resolve(runDir, filename.toString());
      if (full === statePath) {
        onChange(statePath, () => {
          detachFileWatcher(statePath);
          if (fs.existsSync(statePath)) {
            attachStateWatcher();
            return;
          }
          emitStateUpdate();
        });
      }
      if (full === tracePath) {
        onChange(tracePath, () => {
          detachFileWatcher(tracePath);
          if (fs.existsSync(tracePath)) {
            attachTraceWatcher();
            return;
          }
          emitTraceUpdate();
        });
      }
    });
    rootWatchers.push(dirWatcher);
  } catch {}

  return {
    close: () => {
      for (const watcher of fileWatchers.values()) { try { watcher.close(); } catch {} }
      for (const w of rootWatchers) { try { w.close(); } catch {} }
      for (const t of debounceMap.values()) clearTimeout(t);
    },
  };
}

import fs from 'node:fs';
import path from 'node:path';
import { getBus } from './sse_bus.ts';

function safeReadJson(filePath: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function deriveTraceUpdates(entries: Record<string, unknown>[], previousLength: number): {
  kind: 'snapshot' | 'append';
  entries: Record<string, unknown>[];
  nextLength: number;
} | null {
  if (entries.length === 0) {
    return previousLength === 0
      ? null
      : { kind: 'snapshot', entries: [], nextLength: 0 };
  }
  if (previousLength <= 0 || entries.length < previousLength) {
    return {
      kind: 'snapshot',
      entries: entries.slice(Math.max(0, entries.length - 50)),
      nextLength: entries.length,
    };
  }
  const appended = entries.slice(previousLength);
  if (appended.length === 0) return null;
  return {
    kind: 'append',
    entries: appended,
    nextLength: entries.length,
  };
}

export function watchRunFiles(
  runId: string,
  runDir: string,
  hooks?: { onState?: (state: Record<string, unknown>) => void },
): { close: () => void } {
  const bus = getBus(runId);
  const statePath = path.resolve(runDir, 'run_state.json');
  const tracePath = path.resolve(runDir, 'decision_trace.json');

  const fileWatchers: fs.FSWatcher[] = [];
  const rootWatchers: fs.FSWatcher[] = [];
  const debounceMap = new Map<string, NodeJS.Timeout>();
  let lastTraceLength = 0;

  const onChange = (file: string, emit: () => void): void => {
    const prev = debounceMap.get(file);
    if (prev) clearTimeout(prev);
    debounceMap.set(file, setTimeout(emit, 120));
  };

  const attachStateWatcher = (): void => {
    try {
      const initial = safeReadJson(statePath);
      if (initial) {
        hooks?.onState?.(initial);
        bus.emit('event', { type: 'run-state', state: initial });
      }
      const w = fs.watch(statePath, () => onChange(statePath, () => {
        const json = safeReadJson(statePath);
        if (json) {
          hooks?.onState?.(json);
          bus.emit('event', { type: 'run-state', state: json });
        }
      }));
      // Non-standard but helpful for reattachment guards
      (w as any)._filename = statePath;
      fileWatchers.push(w);
    } catch {}
  };

  const attachTraceWatcher = (): void => {
    try {
      // Initial snapshot: last 50 entries to avoid floods
      try {
        const raw = fs.readFileSync(tracePath, 'utf8');
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          const update = deriveTraceUpdates(arr as Record<string, unknown>[], 0);
          lastTraceLength = Array.isArray(arr) ? arr.length : 0;
          if (update) {
            bus.emit('event', { type: 'decision-trace-snapshot', entries: update.entries });
          }
        }
      } catch {}
      const w = fs.watch(tracePath, () => onChange(tracePath, () => {
        try {
          const raw = fs.readFileSync(tracePath, 'utf8');
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) {
            const update = deriveTraceUpdates(arr as Record<string, unknown>[], lastTraceLength);
            lastTraceLength = arr.length;
            if (!update) return;
            if (update.kind === 'snapshot') {
              bus.emit('event', { type: 'decision-trace-snapshot', entries: update.entries });
              return;
            }
            for (const entry of update.entries) {
              bus.emit('event', { type: 'decision-trace', entry });
            }
          }
        } catch {}
      }));
      (w as any)._filename = tracePath;
      fileWatchers.push(w);
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
      if (full === statePath && fs.existsSync(statePath)) {
        if (!fileWatchers.find((w) => (w as any)._filename === statePath)) {
          attachStateWatcher();
        }
      }
      if (full === tracePath && fs.existsSync(tracePath)) {
        if (!fileWatchers.find((w) => (w as any)._filename === tracePath)) {
          attachTraceWatcher();
        }
      }
    });
    rootWatchers.push(dirWatcher);
  } catch {}

  return {
    close: () => {
      for (const w of fileWatchers) { try { w.close(); } catch {} }
      for (const w of rootWatchers) { try { w.close(); } catch {} }
      for (const t of debounceMap.values()) clearTimeout(t);
    },
  };
}

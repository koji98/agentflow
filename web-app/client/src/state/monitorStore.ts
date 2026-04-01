import { useEffect, useMemo, useState } from 'react';

import type {
  RunArtifactItem,
  RunConsoleEntry,
  RunStateResponse,
  SandboxMode,
} from '../../../shared/contracts/monitor.ts';
import { api, deriveRunLoadIssue, type RunLoadIssue } from '../api/client.ts';
import {
  applyTraceSnapshot,
  countTotals,
  deriveBootstrapTrace,
  deriveRunControls,
  deriveRunStatus,
  inferRunResumable,
  normalizeRunState,
  type UiRunStatus,
} from '../lib/monitor.ts';

function readStoredValue<T>(key: string, initial: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : initial;
  } catch {
    return initial;
  }
}

export function useStoredValue<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => readStoredValue(key, initial));

  useEffect(() => {
    setValue(readStoredValue(key, initial));
  }, [key]);

  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue] as const;
}

export function useMonitorPreference<T>(key: string, initial: T) {
  return useStoredValue<T>(`af.monitor.${key}`, initial);
}

export function useRunScopedMonitorPreference<T>(runId: string | null, key: string, initial: T) {
  const suffix = runId ? `${key}.${runId}` : key;
  return useMonitorPreference<T>(suffix, initial);
}

function pushRecent(list: string[], value: string, max = 8) {
  return [value, ...list.filter((entry) => entry !== value)].slice(0, max);
}

export function useLocalSettings() {
  const [skipGitRepoCheck, setSkipGitRepoCheck] = useStoredValue<boolean>('af.skipGit', false);
  const [sandbox, setSandbox] = useStoredValue<SandboxMode>('af.sandbox', 'workspace-write');
  const [showHidden, setShowHidden] = useStoredValue<boolean>('af.showHidden', true);
  const [recentPlans, setRecentPlans] = useStoredValue<string[]>('af.recentPlans', []);
  const [recentRunDirs, setRecentRunDirs] = useStoredValue<string[]>('af.recentRunDirs', []);
  const [recentPickerPaths, setRecentPickerPaths] = useStoredValue<string[]>('af.recentPickerPaths', []);

  return {
    skipGitRepoCheck,
    setSkipGitRepoCheck,
    sandbox,
    setSandbox,
    showHidden,
    setShowHidden,
    recentPlans,
    recentRunDirs,
    recentPickerPaths,
    rememberPlan: (planPath: string) => setRecentPlans((list) => pushRecent(list, planPath)),
    rememberRunDir: (runDir: string) => setRecentRunDirs((list) => pushRecent(list, runDir)),
    rememberPickerPath: (pickerPath: string) => setRecentPickerPaths((list) => pushRecent(list, pickerPath, 12)),
  };
}

export function useRun(runId: string | null, refreshToken = 0) {
  const [state, setState] = useState<RunStateResponse | null>(null);
  const [trace, setTrace] = useState<Array<Record<string, unknown>>>([]);
  const [consoleEntries, setConsoleEntries] = useState<RunConsoleEntry[]>([]);
  const [status, setStatus] = useState<UiRunStatus>('IDLE');
  const [connected, setConnected] = useState(false);
  const [hydrating, setHydrating] = useState(Boolean(runId));
  const [loadIssue, setLoadIssue] = useState<RunLoadIssue | null>(null);

  useEffect(() => {
    setState(null);
    setTrace([]);
    setConsoleEntries([]);
    setStatus('IDLE');
    setConnected(false);
    setHydrating(Boolean(runId));
    setLoadIssue(null);
    if (!runId) return;
    let disposed = false;

    let source: EventSource | null = null;

    const startStream = () => {
      if (disposed || !runId || source) return;
      source = api.sse.events(runId);
      source.onopen = () => {
        if (!disposed) setConnected(true);
      };
      source.onerror = () => {
        if (!disposed) setConnected(false);
      };

      source.addEventListener('run-state', (event: MessageEvent) => {
        try {
          const payload = JSON.parse((event as MessageEvent).data) as { state?: Record<string, unknown> };
          setState((current) => {
            const incoming = (payload.state || payload) as Record<string, unknown>;
            const nextState = normalizeRunState({
              ...(current || {}),
              ...incoming,
              isActive: Object.prototype.hasOwnProperty.call(incoming, 'isActive')
                ? incoming.isActive
                : undefined,
            } as RunStateResponse);
            setStatus(deriveRunStatus(nextState));
            return nextState;
          });
        } catch {}
      });

      source.addEventListener('decision-trace-snapshot', (event: MessageEvent) => {
        try {
          const payload = JSON.parse((event as MessageEvent).data) as { entries?: Array<Record<string, unknown>>; nextLength?: number; startIndex?: number };
          if (Array.isArray(payload.entries)) {
            setTrace((current) => applyTraceSnapshot(current, payload));
          }
        } catch {}
      });

      source.addEventListener('decision-trace', (event: MessageEvent) => {
        try {
          const payload = JSON.parse((event as MessageEvent).data) as { entry?: Record<string, unknown> };
          if (payload.entry) setTrace((current) => [...current, payload.entry as Record<string, unknown>]);
        } catch {}
      });

      source.addEventListener('run-console-snapshot', (event: MessageEvent) => {
        try {
          const payload = JSON.parse((event as MessageEvent).data) as { entries?: RunConsoleEntry[] };
          if (Array.isArray(payload.entries)) setConsoleEntries(payload.entries);
        } catch {}
      });

      source.addEventListener('run-console', (event: MessageEvent) => {
        try {
          const payload = JSON.parse((event as MessageEvent).data) as { entries?: RunConsoleEntry[] };
          const entries = Array.isArray(payload.entries) ? payload.entries : [];
          if (entries.length === 0) return;
          setConsoleEntries((current) => [...current, ...entries].slice(-300));
        } catch {}
      });

      source.addEventListener('run-cancelled', () => {
        setState((current) => {
          if (!current) return current;
          const nextState = normalizeRunState({
            ...current,
            cancelRequested: true,
            canCancel: false,
            canResume: false,
          } as RunStateResponse);
          setStatus(deriveRunStatus(nextState));
          return nextState;
        });
      });

      source.addEventListener('run-exited', (event: MessageEvent) => {
        try {
          const payload = JSON.parse((event as MessageEvent).data) as { code?: number | null; cancelled?: boolean };
          setState((current) => {
            if (!current) return current;
            const nextState = normalizeRunState({
              ...current,
              isActive: false,
              lastExitCode: payload.code ?? null,
              cancelRequested: payload.cancelled ? true : current.cancelRequested,
              canCancel: false,
              canResume: inferRunResumable({
                ...current,
                isActive: false,
                lastExitCode: payload.code ?? null,
                cancelRequested: payload.cancelled ? true : current.cancelRequested,
              } as RunStateResponse),
            } as RunStateResponse);
            setStatus(deriveRunStatus(nextState));
            return nextState;
          });
        } catch {}
      });
    };

    const bootstrap = async () => {
      try {
        await api.runs.resolve(runId);
      } catch (error) {
        if (!disposed) {
          setConnected(false);
          setHydrating(false);
          setLoadIssue(deriveRunLoadIssue(error, runId));
        }
        return;
      }

      try {
        const [nextState, nextTrace, nextConsole] = await Promise.all([
          api.runs.state(runId),
          api.runs.trace(runId).catch(() => [] as Array<Record<string, unknown>>),
          api.runs.console(runId).catch(() => ({ entries: [] as RunConsoleEntry[] })),
        ]);
        if (disposed) return;
        const normalizedState = normalizeRunState(nextState);
        setState(normalizedState);
        setTrace(deriveBootstrapTrace(normalizedState, nextTrace));
        setConsoleEntries(Array.isArray(nextConsole.entries) ? nextConsole.entries : []);
        setStatus(deriveRunStatus(normalizedState));
        setLoadIssue(null);
        setHydrating(false);
        startStream();
      } catch (error) {
        if (!disposed) {
          setConnected(false);
          setHydrating(false);
          setLoadIssue(deriveRunLoadIssue(error, runId));
        }
        startStream();
      }
    };

    void bootstrap();

    return () => {
      disposed = true;
      source?.close();
    };
  }, [refreshToken, runId]);

  useEffect(() => {
    const traceTail = trace.slice(-50);
    setState((current) => {
      if (!current) return current;
      const currentTail = Array.isArray(current.decisionTrace) ? current.decisionTrace : [];
      const unchanged = currentTail.length === traceTail.length
        && currentTail.every((entry, index) => entry === traceTail[index]);
      if (unchanged) return current;
      return normalizeRunState({
        ...current,
        decisionTrace: traceTail,
      } as RunStateResponse);
    });
  }, [trace]);

  const totals = useMemo(() => countTotals(state), [state]);
  const controls = useMemo(() => deriveRunControls(state), [state]);

  return {
    state,
    trace,
    consoleEntries,
    status,
    connected,
    hydrating,
    loadIssue,
    totals,
    controls,
  };
}

export function useArtifactPreview(runId: string, artifact: RunArtifactItem | null) {
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!runId || !artifact?.path) {
      setContent('');
      setLoading(false);
      return;
    }
    let disposed = false;
    setContent('');
    setLoading(true);
    api.fs.read(artifact.path)
      .then((result) => {
        if (disposed) return;
        setContent(result.text || [result.head, result.tail].filter(Boolean).join('\n...\n'));
      })
      .catch(() => {
        if (!disposed) setContent('Unable to preview artifact.');
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [artifact?.path, runId]);

  return { content, loading };
}

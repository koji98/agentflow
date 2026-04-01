import type {
  CancelRunBody,
  OpenRunBody,
  PlanInspection,
  ResumeRunBody,
  RunArtifactItem,
  RunConsoleEntry,
  RunStateResponse,
  StartRunBody,
} from '../../../shared/contracts/monitor.ts';

const j = async <T>(input: RequestInfo, init?: RequestInit): Promise<T> => {
  const res = await fetch(String(input), { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
};

export const api = {
  health: () => j<{ ok: boolean }>('/api/health'),
  version: () => j<{ agentflowVersion: string; webAppVersion: string }>('/api/version'),
  fs: {
    roots: () => j<{ repoRoot: string; cwd: string; home: string; allowedRoots: string[] }>(`/api/fs/roots`),
    ls: (path: string) => j<{ items: any[] }>(`/api/fs/ls?path=${encodeURIComponent(path)}`),
    read: (path: string) => j<{ text?: string; head?: string; tail?: string; size: number; mtime: string; binary: boolean; tooLarge?: boolean }>(`/api/fs/read?path=${encodeURIComponent(path)}`),
    downloadUrl: (path: string) => `/api/fs/download?path=${encodeURIComponent(path)}`,
  },
  plan: {
    inspect: (path: string) => j<PlanInspection>(`/api/plan/inspect?path=${encodeURIComponent(path)}`),
  },
  runs: {
    start: (body: StartRunBody) => j<{ runId: string; runDir: string }>('POST:/api/runs/start'.replace(/^POST:/, ''), { method: 'POST', body: JSON.stringify(body) }),
    open: (body: OpenRunBody) => j<{ runId: string; runDir: string }>('POST:/api/runs/open'.replace(/^POST:/, ''), { method: 'POST', body: JSON.stringify(body) }),
    resume: (body: ResumeRunBody) => j<{ runId: string; runDir: string }>('POST:/api/runs/resume'.replace(/^POST:/, ''), { method: 'POST', body: JSON.stringify(body) }),
    resumeById: (runId: string, settings?: StartRunBody['settings']) => j<{ runId: string; runDir: string }>(`/api/runs/${encodeURIComponent(runId)}/resume`, { method: 'POST', body: JSON.stringify({ settings }) }),
    cancel: (body: CancelRunBody) => j<{ ok: boolean }>('POST:/api/runs/cancel'.replace(/^POST:/, ''), { method: 'POST', body: JSON.stringify(body) }),
    state: (runId: string) => j<RunStateResponse>(`/api/runs/${encodeURIComponent(runId)}/state`),
    trace: (runId: string) => j<any[]>(`/api/runs/${encodeURIComponent(runId)}/trace`),
    artifacts: (runId: string, taskKey: string) => j<{ items: RunArtifactItem[] }>(`/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(taskKey)}`),
    console: (runId: string) => j<{ entries: RunConsoleEntry[] }>(`/api/runs/${encodeURIComponent(runId)}/console`),
    logs: async (runId: string, taskKey: string) => {
      const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/logs/${encodeURIComponent(taskKey)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    },
  },
  sse: {
    events(runId: string): EventSource { return new EventSource(`/api/stream/run/${encodeURIComponent(runId)}/events`); },
    tail(runId: string, taskKey: string): EventSource { return new EventSource(`/api/stream/run/${encodeURIComponent(runId)}/tail?taskKey=${encodeURIComponent(taskKey)}`); },
  },
};

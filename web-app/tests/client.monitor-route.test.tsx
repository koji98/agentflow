// @vitest-environment happy-dom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

vi.mock('@mantine/charts', () => ({
  DonutChart: ({ chartLabel }: any) => <div data-testid="donut-chart">{chartLabel}</div>,
  Sparkline: () => <div data-testid="sparkline" />,
  AreaChart: () => <div data-testid="area-chart" />,
}));

vi.mock('../client/src/components/Graph.tsx', () => ({
  default: ({ selectedId }: any) => <div data-testid="graph-selected">{selectedId || 'none'}</div>,
}));

vi.mock('../client/src/components/NodeInspector.tsx', () => ({
  default: ({ selectedNode }: any) => (
    <div data-testid="node-inspector">
      {selectedNode ? selectedNode.label : 'none'}
    </div>
  ),
}));

import Monitor from '../client/src/routes/Monitor.tsx';

function mockJson(data: unknown) {
  return {
    ok: true,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as Response;
}

function mockErrorJson(status: number, data: unknown) {
  return {
    ok: false,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as Response;
}

class MockEventSource {
  static instances: MockEventSource[] = [];

  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;
  private readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
    queueMicrotask(() => {
      this.onopen?.();
    });
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    const bucket = this.listeners.get(type) || new Set<(event: MessageEvent) => void>();
    bucket.add(listener);
    this.listeners.set(type, bucket);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, payload: unknown) {
    const event = { data: JSON.stringify(payload) } as MessageEvent;
    for (const listener of this.listeners.get(type) || []) {
      listener(event);
    }
  }

  close() {}
}

describe('Monitor route', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource as any);
  });

  afterEach(() => {
    MockEventSource.instances = [];
    vi.unstubAllGlobals();
  });

  it('shows a dedicated resolving surface before the first run snapshot arrives', async () => {
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL) => new Promise<Response>(() => {})) as any);

    const router = createMemoryRouter(
      [{ path: '/run/:runId', element: <Monitor /> }],
      { initialEntries: ['/run/run-loading'] },
    );

    render(
      <MantineProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </MantineProvider>,
    );

    expect(await screen.findByText('Hydrating monitor surfaces')).toBeTruthy();
    expect(screen.getByText('run-loading')).toBeTruthy();
    expect(screen.queryByText('No graph available')).toBeNull();
    expect(screen.queryByText('No node selected')).toBeNull();
    expect(screen.queryByText('No evidence selected')).toBeNull();
  });

  it('hydrates from state when the bootstrap trace request is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/runs/run-trace-fallback/resolve')) {
        return mockJson({ runId: 'run-trace-fallback', runDir: '/tmp/run-trace-fallback', planPath: '/plan-trace-fallback.json', isActive: false });
      }
      if (url.includes('/api/runs/run-trace-fallback/state')) {
        return mockJson({
          runDir: '/tmp/run-trace-fallback',
          configPath: '/plan-trace-fallback.json',
          planPath: '/plan-trace-fallback.json',
          isActive: false,
          cancelRequested: false,
          canCancel: false,
          canResume: false,
          lastExitCode: 0,
          recentConsole: [],
          decisionTrace: [
            { atUtc: '1', type: 'while_gate_evaluation', detail: { iteration: 1, score: 0.9 } },
          ],
          totalLoopIterations: 1,
          tasks: {
            'g0:task_trace#a1': {
              taskKey: 'g0:task_trace#a1',
              taskId: 'task_trace',
              attempt: 1,
              status: 'DONE',
              nodePath: 'flow[0]',
            },
          },
        });
      }
      if (url.includes('/api/runs/run-trace-fallback/trace')) {
        throw new Error('trace bootstrap unavailable');
      }
      if (url.includes('/api/runs/run-trace-fallback/console')) {
        return mockJson({ entries: [] });
      }
      if (url.includes('/api/fs/read?path=%2Fplan-trace-fallback.json')) {
        return mockJson({ text: JSON.stringify({ flow: [{ type: 'task', id: 'task_trace', prompt: 'Trace fallback task' }] }), size: 10, mtime: '', binary: false });
      }
      if (url.includes('/api/runs/run-trace-fallback/artifacts/')) {
        return mockJson({ items: [] });
      }
      if (url.includes('/api/runs/run-trace-fallback/logs/')) {
        return { ok: true, text: async () => '' } as Response;
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as any);

    const router = createMemoryRouter(
      [{ path: '/run/:runId', element: <Monitor /> }],
      { initialEntries: ['/run/run-trace-fallback'] },
    );

    render(
      <MantineProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </MantineProvider>,
    );

    expect((await screen.findAllByText('Run completed')).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(screen.getByTestId('node-inspector').textContent).toContain('task_trace');
    });
    expect(screen.getByText('Execution status')).toBeTruthy();
    expect(screen.getByText('Graph lens')).toBeTruthy();
    expect(screen.getByText('Selected path')).toBeTruthy();
    expect(screen.getByText('Overview, Activity, Artifacts, and Raw logs stay on task_trace.')).toBeTruthy();
    expect(screen.queryByText('Unable to hydrate this run')).toBeNull();
  });

  it('shows a run-not-found recovery surface when the deep link cannot be resolved', async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/runs/run-missing/resolve')) {
        return mockErrorJson(404, { error: 'run_not_found', runId: 'run-missing' });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchSpy as any);

    const router = createMemoryRouter(
      [{ path: '/run/:runId', element: <Monitor /> }],
      { initialEntries: ['/run/run-missing'] },
    );

    render(
      <MantineProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </MantineProvider>,
    );

    expect(await screen.findByText('Run not found in the current local roots')).toBeTruthy();
    expect(screen.getByText('Open the run from Launch view or restore its local root.')).toBeTruthy();
    expect(fetchSpy.mock.calls.some(([input]) => String(input).includes('/api/runs/run-missing/state'))).toBe(false);
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('shows explicit ambiguity recovery when multiple persisted runs share the same runId', async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/runs/run-duplicate/resolve')) {
        return mockErrorJson(409, {
          error: 'run_id_ambiguous',
          runId: 'run-duplicate',
          matches: [
            {
              runDir: '/tmp/workspace-a/.tmp/agentflow_runs/run-duplicate',
              planPath: '/tmp/workspace-a/.tmp/sample-plan.json',
              updatedAtUtc: '2026-04-01T12:04:00Z',
            },
            {
              runDir: '/tmp/workspace-b/.tmp/agentflow_runs/run-duplicate',
              planPath: '/tmp/workspace-b/.tmp/sample-plan.json',
              updatedAtUtc: '2026-04-01T11:55:00Z',
            },
          ],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchSpy as any);

    const router = createMemoryRouter(
      [{ path: '/run/:runId', element: <Monitor /> }],
      { initialEntries: ['/run/run-duplicate'] },
    );

    render(
      <MantineProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </MantineProvider>,
    );

    expect(await screen.findByText('Choose the exact historical run')).toBeTruthy();
    expect(screen.getByText('/tmp/workspace-a/.tmp/agentflow_runs/run-duplicate')).toBeTruthy();
    expect(screen.getByText('/tmp/workspace-b/.tmp/agentflow_runs/run-duplicate')).toBeTruthy();
    expect(screen.getByText('/tmp/workspace-a/.tmp/sample-plan.json')).toBeTruthy();
    expect(fetchSpy.mock.calls.some(([input]) => String(input).includes('/api/runs/run-duplicate/state'))).toBe(false);
    expect(MockEventSource.instances).toHaveLength(0);
  });

  it('resets selection on run changes and labels inactive success runs as completed snapshots', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/runs/run-one/resolve')) {
        return mockJson({ runId: 'run-one', runDir: '/tmp/run-one', planPath: '/plan-one.json', isActive: false });
      }
      if (url.includes('/api/runs/run-two/resolve')) {
        return mockJson({ runId: 'run-two', runDir: '/tmp/run-two', planPath: '/plan-two.json', isActive: false });
      }
      if (url.includes('/api/runs/run-one/state')) {
        return mockJson({
          runDir: '/tmp/run-one',
          configPath: '/plan-one.json',
          planPath: '/plan-one.json',
          isActive: false,
          cancelRequested: false,
          canCancel: false,
          canResume: false,
          lastExitCode: 1,
          recentConsole: [],
          totalLoopIterations: 0,
          tasks: {
            'g0:task_one#a1': {
              taskKey: 'g0:task_one#a1',
              taskId: 'task_one',
              attempt: 1,
              status: 'DONE',
              nodePath: 'flow[0]',
            },
          },
        });
      }
      if (url.includes('/api/runs/run-two/state')) {
        return mockJson({
          runDir: '/tmp/run-two',
          configPath: '/plan-two.json',
          planPath: '/plan-two.json',
          isActive: false,
          cancelRequested: false,
          canCancel: false,
          canResume: false,
          lastExitCode: null,
          recentConsole: [],
          totalLoopIterations: 0,
          tasks: {
            'g0:task_two#a1': {
              taskKey: 'g0:task_two#a1',
              taskId: 'task_two',
              attempt: 1,
              status: 'DONE',
              nodePath: 'flow[0]',
            },
          },
        });
      }
      if (url.includes('/api/runs/run-one/trace') || url.includes('/api/runs/run-two/trace')) {
        return mockJson([]);
      }
      if (url.includes('/api/runs/run-one/console') || url.includes('/api/runs/run-two/console')) {
        return mockJson({ entries: [] });
      }
      if (url.includes('/api/fs/read?path=%2Fplan-one.json')) {
        return mockJson({ text: JSON.stringify({ flow: [{ type: 'task', id: 'task_one', prompt: 'First task' }] }), size: 10, mtime: '', binary: false });
      }
      if (url.includes('/api/fs/read?path=%2Fplan-two.json')) {
        return mockJson({ text: JSON.stringify({ flow: [{ type: 'task', id: 'task_two', prompt: 'Second task' }] }), size: 10, mtime: '', binary: false });
      }
      if (url.includes('/api/runs/run-one/artifacts/') || url.includes('/api/runs/run-two/artifacts/')) {
        return mockJson({ items: [] });
      }
      if (url.includes('/api/runs/run-one/logs/') || url.includes('/api/runs/run-two/logs/')) {
        return { ok: true, text: async () => '' } as Response;
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as any);

    const router = createMemoryRouter(
      [{ path: '/run/:runId', element: <Monitor /> }],
      { initialEntries: ['/run/run-one'] },
    );

    render(
      <MantineProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </MantineProvider>,
    );

    expect((await screen.findAllByText('Run completed')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Whole-run control flow')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Open run feed' })[0]);
    expect(await screen.findByText('Whole-run control flow')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId('node-inspector').textContent).toContain('task_one');
    });

    await act(async () => {
      await router.navigate('/run/run-two');
    });

    await waitFor(() => {
      expect(screen.getByTestId('node-inspector').textContent).toContain('task_two');
    });
    expect(screen.getAllByText('Viewing the final persisted success state.').length).toBeGreaterThan(0);
    expect((screen.getByRole('button', { name: 'Resume' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('reloads the same run after resume and swaps the operator actions back to a live state', async () => {
    let stateReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/runs/run-resume/resolve')) {
        return mockJson({ runId: 'run-resume', runDir: '/tmp/run-resume', planPath: '/plan-resume.json', isActive: stateReads > 0 });
      }
      if (url.includes('/api/runs/run-resume/state')) {
        stateReads += 1;
        return mockJson({
          runDir: '/tmp/run-resume',
          configPath: '/plan-resume.json',
          planPath: '/plan-resume.json',
          isActive: stateReads > 1,
          cancelRequested: false,
          canCancel: stateReads > 1,
          canResume: stateReads <= 1,
          lastExitCode: stateReads > 1 ? null : 17,
          recentConsole: [],
          totalFailureCount: stateReads > 1 ? 0 : 1,
          totalLoopIterations: 0,
          tasks: {
            'g0:task_resume#a1': {
              taskKey: 'g0:task_resume#a1',
              taskId: 'task_resume',
              attempt: 1,
              status: stateReads > 1 ? 'RUNNING' : 'FAILED',
              failureReason: stateReads > 1 ? null : 'retry_required',
              nodePath: 'flow[0]',
            },
          },
        });
      }
      if (url.includes('/api/runs/run-resume/trace')) {
        return mockJson([]);
      }
      if (url.includes('/api/runs/run-resume/console')) {
        return mockJson({ entries: [] });
      }
      if (url.includes('/api/runs/run-resume/resume') && init?.method === 'POST') {
        return mockJson({ runId: 'run-resume', runDir: '/tmp/run-resume' });
      }
      if (url.includes('/api/fs/read?path=%2Fplan-resume.json')) {
        return mockJson({ text: JSON.stringify({ flow: [{ type: 'task', id: 'task_resume', prompt: 'Resume task' }] }), size: 10, mtime: '', binary: false });
      }
      if (url.includes('/api/runs/run-resume/artifacts/')) {
        return mockJson({ items: [] });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as any);

    const router = createMemoryRouter(
      [{ path: '/run/:runId', element: <Monitor /> }],
      { initialEntries: ['/run/run-resume'] },
    );

    render(
      <MantineProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </MantineProvider>,
    );

    expect((await screen.findAllByText('Run failed')).length).toBeGreaterThan(0);
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));

    await waitFor(() => {
      expect(screen.getAllByText('Live stream connected').length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText('Live event stream connected.').length).toBeGreaterThan(0);
    expect((screen.getByRole('button', { name: 'Resume' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('falls back to last-message output when a scope has no execution log file', async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/runs/run-message/resolve')) {
        return mockJson({ runId: 'run-message', runDir: '/tmp/run-message', planPath: '/plan-message.json', isActive: false });
      }
      if (url.includes('/api/runs/run-message/state')) {
        return mockJson({
          runDir: '/tmp/run-message',
          configPath: '/plan-message.json',
          planPath: '/plan-message.json',
          isActive: false,
          cancelRequested: false,
          canCancel: false,
          canResume: false,
          lastExitCode: 0,
          recentConsole: [],
          totalLoopIterations: 0,
          tasks: {
            'g0:message_only#a1': {
              taskKey: 'g0:message_only#a1',
              taskId: 'message_only',
              attempt: 1,
              status: 'DONE',
              nodePath: 'flow[0]',
              lastMessagePath: '/tmp/message-only.md',
            },
          },
        });
      }
      if (url.includes('/api/runs/run-message/trace')) {
        return mockJson([]);
      }
      if (url.includes('/api/runs/run-message/console')) {
        return mockJson({ entries: [] });
      }
      if (url.includes('/api/fs/read?path=%2Fplan-message.json')) {
        return mockJson({ text: JSON.stringify({ flow: [{ type: 'task', id: 'message_only', prompt: 'Last message task' }] }), size: 10, mtime: '', binary: false });
      }
      if (url.includes('/api/runs/run-message/artifacts/')) {
        return mockJson({
          items: [{ key: 'message', label: 'Last Message / Stdout', path: '/tmp/message-only.md', exists: true }],
        });
      }
      if (url.includes('/api/fs/read?path=%2Ftmp%2Fmessage-only.md')) {
        return mockJson({ text: 'Final message from the task.', size: 10, mtime: '', binary: false });
      }
      if (url.includes('/api/runs/run-message/logs/')) {
        throw new Error(`log endpoint should not be used for ${url}`);
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchSpy as any);

    const router = createMemoryRouter(
      [{ path: '/run/:runId', element: <Monitor /> }],
      { initialEntries: ['/run/run-message'] },
    );

    render(
      <MantineProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </MantineProvider>,
    );

    expect((await screen.findAllByText('Run completed')).length).toBeGreaterThan(0);

    fireEvent.click(await screen.findByRole('tab', { name: 'Raw logs' }));

    await waitFor(() => {
      expect(screen.getByText('Last message / stdout')).toBeTruthy();
      expect(screen.getAllByText('Final message from the task.').length).toBeGreaterThan(0);
    });

    expect(fetchSpy.mock.calls.some(([input]) => String(input).includes('/api/runs/run-message/logs/'))).toBe(false);
  });

  it('updates live raw output for message-only scopes through tail snapshots', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/runs/run-message-live/resolve')) {
        return mockJson({ runId: 'run-message-live', runDir: '/tmp/run-message-live', planPath: '/plan-message-live.json', isActive: true });
      }
      if (url.includes('/api/runs/run-message-live/state')) {
        return mockJson({
          runDir: '/tmp/run-message-live',
          configPath: '/plan-message-live.json',
          planPath: '/plan-message-live.json',
          isActive: true,
          cancelRequested: false,
          canCancel: true,
          canResume: false,
          lastExitCode: null,
          recentConsole: [],
          totalLoopIterations: 0,
          tasks: {
            'g0:message_live#a1': {
              taskKey: 'g0:message_live#a1',
              taskId: 'message_live',
              attempt: 1,
              status: 'RUNNING',
              nodePath: 'flow[0]',
              lastMessagePath: '/tmp/message-live.md',
            },
          },
        });
      }
      if (url.includes('/api/runs/run-message-live/trace')) {
        return mockJson([]);
      }
      if (url.includes('/api/runs/run-message-live/console')) {
        return mockJson({ entries: [] });
      }
      if (url.includes('/api/fs/read?path=%2Fplan-message-live.json')) {
        return mockJson({ text: JSON.stringify({ flow: [{ type: 'task', id: 'message_live', prompt: 'Message live task' }] }), size: 10, mtime: '', binary: false });
      }
      if (url.includes('/api/runs/run-message-live/artifacts/')) {
        return mockJson({
          items: [{ key: 'message', label: 'Last Message / Stdout', path: '/tmp/message-live.md', exists: true }],
        });
      }
      if (url.includes('/api/fs/read?path=%2Ftmp%2Fmessage-live.md')) {
        return mockJson({ text: 'Initial streamed message.', size: 10, mtime: '', binary: false });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as any);

    const router = createMemoryRouter(
      [{ path: '/run/:runId', element: <Monitor /> }],
      { initialEntries: ['/run/run-message-live'] },
    );

    render(
      <MantineProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </MantineProvider>,
    );

    expect((await screen.findAllByText('Live stream connected')).length).toBeGreaterThan(0);
    fireEvent.click(await screen.findByRole('tab', { name: 'Raw logs' }));

    await waitFor(() => {
      expect(screen.getAllByText('Initial streamed message.').length).toBeGreaterThan(0);
    });

    const tailSource = MockEventSource.instances
      .filter((source) => source.url.includes('/api/stream/run/run-message-live/tail?taskKey='))
      .at(-1);
    expect(tailSource).toBeTruthy();

    act(() => {
      tailSource?.emit('log-snapshot', {
        type: 'log-snapshot',
        taskKey: 'g0:message_live#a1',
        text: 'Updated streamed message.',
        source: 'last_message',
      });
    });

    await waitFor(() => {
      expect(screen.getAllByText('Updated streamed message.').length).toBeGreaterThan(0);
    });
  });

  it('reclassifies externally updated runs from live to historical failure without a manual refresh', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/runs/run-external/resolve')) {
        return mockJson({ runId: 'run-external', runDir: '/tmp/run-external', planPath: '/plan-external.json', isActive: true });
      }
      if (url.includes('/api/runs/run-external/state')) {
        return mockJson({
          runDir: '/tmp/run-external',
          configPath: '/plan-external.json',
          planPath: '/plan-external.json',
          isActive: true,
          cancelRequested: false,
          canCancel: false,
          canResume: false,
          lastExitCode: null,
          recentConsole: [],
          totalFailureCount: 0,
          totalLoopIterations: 0,
          tasks: {
            'g0:task_external#a1': {
              taskKey: 'g0:task_external#a1',
              taskId: 'task_external',
              attempt: 1,
              status: 'RUNNING',
              nodePath: 'flow[0]',
            },
          },
        });
      }
      if (url.includes('/api/runs/run-external/trace')) {
        return mockJson([]);
      }
      if (url.includes('/api/runs/run-external/console')) {
        return mockJson({ entries: [] });
      }
      if (url.includes('/api/fs/read?path=%2Fplan-external.json')) {
        return mockJson({ text: JSON.stringify({ flow: [{ type: 'task', id: 'task_external', prompt: 'External task' }] }), size: 10, mtime: '', binary: false });
      }
      if (url.includes('/api/runs/run-external/artifacts/')) {
        return mockJson({ items: [] });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as any);

    const router = createMemoryRouter(
      [{ path: '/run/:runId', element: <Monitor /> }],
      { initialEntries: ['/run/run-external'] },
    );

    render(
      <MantineProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </MantineProvider>,
    );

    expect((await screen.findAllByText('Live stream connected')).length).toBeGreaterThan(0);
    expect((screen.getByRole('button', { name: 'Resume' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);

    const runSource = MockEventSource.instances.find((source) => source.url.includes('/api/stream/run/run-external/events'));
    expect(runSource).toBeTruthy();

    act(() => {
      runSource?.emit('run-state', {
        type: 'run-state',
        state: {
          totalFailureCount: 1,
          runFailureReasons: ['retry_required'],
          tasks: {
            'g0:task_external#a1': {
              taskKey: 'g0:task_external#a1',
              taskId: 'task_external',
              attempt: 1,
              status: 'FAILED',
              failureReason: 'retry_required',
              nodePath: 'flow[0]',
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(screen.getAllByText('Run failed').length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText('Viewing the final persisted failure state.').length).toBeGreaterThan(0);
    expect((screen.getByRole('button', { name: 'Resume' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

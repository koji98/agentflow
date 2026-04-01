// @vitest-environment happy-dom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
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

class MockEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;
  private readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
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

  close() {}
}

describe('Monitor route', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', MockEventSource as any);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resets selection on run changes and labels inactive runs as historical snapshots', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/runs/run-one/state')) {
        return mockJson({
          runDir: '/tmp/run-one',
          configPath: '/plan-one.json',
          planPath: '/plan-one.json',
          isActive: false,
          cancelRequested: false,
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

    expect(await screen.findByText('Historical run snapshot')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId('node-inspector').textContent).toContain('task_one');
    });

    await act(async () => {
      await router.navigate('/run/run-two');
    });

    await waitFor(() => {
      expect(screen.getByTestId('node-inspector').textContent).toContain('task_two');
    });
    expect(screen.getByText('Viewing the final persisted success state.')).toBeTruthy();
  });
});

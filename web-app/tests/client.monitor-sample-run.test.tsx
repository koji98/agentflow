// @vitest-environment happy-dom

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

import { createSampleAgentflowFixture } from './helpers/sample_agentflow.ts';

vi.mock('@mantine/charts', () => ({
  DonutChart: ({ chartLabel }: any) => <div data-testid="donut-chart">{chartLabel}</div>,
  Sparkline: () => <div data-testid="sparkline" />,
  AreaChart: () => <div data-testid="area-chart" />,
}));

vi.mock('../client/src/components/Graph.tsx', async () => {
  const monitor = await vi.importActual<typeof import('../client/src/lib/monitor.ts')>('../client/src/lib/monitor.ts');
  return {
    default: (props: any) => {
      const graph = monitor.buildWorkflowGraph(props.plan, props.state, props.trace);
      return (
        <div data-testid="graph-mock">
          {graph.items.map((item) => (
            <button
              key={item.graphId}
              type="button"
              onClick={() => props.onSelectNode(props.selectionKey === 'graphId' ? item.graphId : item.workflowId)}
            >
              {item.label}
            </button>
          ))}
        </div>
      );
    },
  };
});

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

  constructor(_url: string) {
    queueMicrotask(() => this.onopen?.());
  }

  addEventListener() {}
  removeEventListener() {}
  close() {}
}

describe('Monitor sample run integration', () => {
  const cleanupDirs: string[] = [];

  beforeEach(() => {
    vi.stubGlobal('EventSource', MockEventSource as any);
  });

  afterEach(() => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
    vi.unstubAllGlobals();
  });

  it('renders a realistic sample run, loads plan data via planPath fallback, and shows artifacts and judge output', async () => {
    const fixture = createSampleAgentflowFixture();
    const taskRows = fixture.runState.tasks as Record<string, Record<string, unknown>>;
    cleanupDirs.push(fixture.workspaceRoot);
    const statePayload = {
      ...fixture.runState,
      runDir: fixture.runDir,
      planPath: fixture.planPath,
      configPath: null,
      isActive: false,
      cancelRequested: false,
      lastExitCode: 0,
      recentConsole: [
        {
          atUtc: '2026-03-31T16:00:10Z',
          source: 'stdout',
          text: 'sample monitor console ready',
        },
      ],
    };

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes(`/api/runs/${fixture.runId}/state`)) {
        return mockJson(statePayload);
      }
      if (url.includes(`/api/runs/${fixture.runId}/trace`)) {
        return mockJson(fixture.trace);
      }
      if (url.includes(`/api/runs/${fixture.runId}/console`)) {
        return mockJson({ entries: statePayload.recentConsole });
      }
      if (url.includes(`/api/fs/read?path=${encodeURIComponent(fixture.planPath)}`)) {
        return mockJson({
          text: fs.readFileSync(fixture.planPath, 'utf8'),
          size: 100,
          mtime: '2026-03-31T16:00:00Z',
          binary: false,
        });
      }
      if (url.includes(`/api/runs/${fixture.runId}/artifacts/`)) {
        const taskKey = decodeURIComponent(url.split('/artifacts/')[1] || '');
        return mockJson({
          items: buildArtifactItems(taskRows[taskKey] || {}),
        });
      }
      if (url.includes(`/api/runs/${fixture.runId}/logs/`)) {
        const taskKey = decodeURIComponent(url.split('/logs/')[1] || '');
        return {
          ok: true,
          text: async () => fs.readFileSync(String(taskRows[taskKey]?.logPath || ''), 'utf8'),
        } as Response;
      }
      if (url.includes('/api/fs/read?path=')) {
        const filePath = decodeURIComponent(url.split('path=')[1] || '');
        return mockJson({
          text: fs.readFileSync(filePath, 'utf8'),
          size: 100,
          mtime: '2026-03-31T16:00:00Z',
          binary: false,
        });
      }

      throw new Error(`unexpected fetch ${url}`);
    }) as any);

    const router = createMemoryRouter(
      [{ path: '/run/:runId', element: <Monitor /> }],
      { initialEntries: [`/run/${fixture.runId}`] },
    );

    render(
      <MantineProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </MantineProvider>,
    );

    expect(await screen.findByText('Historical run snapshot')).toBeTruthy();
    expect(await screen.findByText(fixture.planPath)).toBeTruthy();
    expect(await screen.findByText('setup_agent')).toBeTruthy();
    expect(await screen.findByText('Viewing the final persisted success state.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'echo_status' }));

    await waitFor(() => {
      expect(screen.getAllByText('/bin/sh -c echo pipeline_ready').length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Artifacts' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Command Result' }));
    await waitFor(() => {
      expect(screen.getAllByText(/pipeline_ready/).length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByRole('button', { name: 'quality_gate' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Judge / Loop' }));

    expect(await screen.findByText('Iteration 1 · post_body')).toBeTruthy();
    expect(await screen.findByText('The revised joke lands cleanly and stays memorable.')).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByTestId('graph-mock')).toBeTruthy();
    });
  });
});

function buildArtifactItems(row: Record<string, unknown>) {
  const items = [
    { key: 'prompt', label: 'Prompt', path: String(row.promptPath || '') },
    { key: 'log', label: 'Execution Log', path: String(row.logPath || '') },
    { key: 'message', label: 'Last Message / Stdout', path: String(row.lastMessagePath || '') },
    { key: 'report', label: 'Report', path: String(row.reportPath || '') },
    { key: 'summary', label: 'Summary', path: String(row.summaryPath || '') },
  ];
  const taskDir = path.dirname(String(row.promptPath || ''));
  if (taskDir) {
    items.push(
      { key: 'result', label: 'Command Result', path: path.join(taskDir, 'command_result.json') },
      { key: 'worker_report', label: 'Worker Report', path: path.join(taskDir, 'worker_report.md') },
      { key: 'worker_summary', label: 'Worker Summary', path: path.join(taskDir, 'worker_summary.md') },
    );
  }

  const seenPaths = new Set<string>();
  return items
    .filter((item) => item.path && fs.existsSync(item.path))
    .filter((item) => {
      if (seenPaths.has(item.path)) return false;
      seenPaths.add(item.path);
      return true;
    })
    .map((item) => ({ ...item, exists: true }));
}

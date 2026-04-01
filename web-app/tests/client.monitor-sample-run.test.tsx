// @vitest-environment happy-dom

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';

import { createSampleAgentflowFixture, type SampleAgentflowFixture } from './helpers/sample_agentflow.ts';

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

function installFixtureFetchStub(
  fixture: SampleAgentflowFixture,
  statePayload: Record<string, unknown>,
): void {
  const taskRows = statePayload.tasks as Record<string, Record<string, unknown>>;

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes(`/api/runs/${fixture.runId}/resolve`)) {
      return mockJson({
        runId: fixture.runId,
        runDir: fixture.runDir,
        planPath: fixture.planPath,
        isActive: false,
      });
    }
    if (url.includes(`/api/runs/${fixture.runId}/state`)) {
      return mockJson(statePayload);
    }
    if (url.includes(`/api/runs/${fixture.runId}/trace`)) {
      return mockJson(fixture.trace);
    }
    if (url.includes(`/api/runs/${fixture.runId}/console`)) {
      return mockJson({ entries: statePayload.recentConsole || [] });
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

  it('renders a realistic sample run, loads plan data via planPath fallback, and shows artifacts plus judge activity', async () => {
    const fixture = createSampleAgentflowFixture();
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

    installFixtureFetchStub(fixture, statePayload);

    const router = createMemoryRouter(
      [{ path: '/run/:runId', element: <Monitor /> }],
      { initialEntries: [`/run/${fixture.runId}`] },
    );

    render(
      <MantineProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </MantineProvider>,
    );

    expect((await screen.findAllByText('Run completed')).length).toBeGreaterThan(0);
    expect(await screen.findByText(fixture.planPath)).toBeTruthy();
    expect(await screen.findByText('setup_agent')).toBeTruthy();
    expect(await screen.findByText('fact_agent')).toBeTruthy();
    expect((await screen.findAllByText('Viewing the final persisted success state.')).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'echo_status' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Raw logs' }));

    await waitFor(() => {
      expect(screen.getAllByText('/bin/sh -c echo pipeline_ready').length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Artifacts' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Command Result' }));
    await waitFor(() => {
      expect(screen.getAllByText(/pipeline_ready/).length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByRole('button', { name: 'quality_gate' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Activity' }));

    expect(await screen.findByText('Judge trail')).toBeTruthy();
    expect(await screen.findByText('Iteration 1 · post_body')).toBeTruthy();
    expect((await screen.findAllByText('The revised joke lands cleanly and stays memorable.')).length).toBeGreaterThan(0);

    await waitFor(() => {
      expect(screen.getByTestId('graph-mock')).toBeTruthy();
    });
  });

  it('renders a historical failed sample run with resume-ready evidence and failed-command logs', async () => {
    const fixture = createSampleAgentflowFixture({ scenario: 'resume_failure' });
    cleanupDirs.push(fixture.workspaceRoot);
    const statePayload = {
      ...fixture.runState,
      runDir: fixture.runDir,
      planPath: fixture.planPath,
      configPath: null,
      isActive: false,
      cancelRequested: false,
      lastExitCode: null,
      recentConsole: [
        {
          atUtc: '2026-04-01T09:00:08Z',
          source: 'stderr',
          text: 'resume probe requires follow-up before the run can continue',
        },
      ],
    };

    installFixtureFetchStub(fixture, statePayload);

    const router = createMemoryRouter(
      [{ path: '/run/:runId', element: <Monitor /> }],
      { initialEntries: [`/run/${fixture.runId}`] },
    );

    render(
      <MantineProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </MantineProvider>,
    );

    expect((await screen.findAllByText('Run failed')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('Viewing the final persisted failure state.')).length).toBeGreaterThan(0);
    expect((screen.getByRole('button', { name: 'Resume' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'resume_probe' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Raw logs' }));

    await waitFor(() => {
      expect(screen.getAllByText(/retry_required/).length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Artifacts' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Command Result' }));

    await waitFor(() => {
      expect(screen.getAllByText(/17/).length).toBeGreaterThan(0);
    });
  });

  it('renders a loop_judge failure fixture with a post-body no-score judge trail', async () => {
    const fixture = createSampleAgentflowFixture({ scenario: 'loop_judge_failure' });
    cleanupDirs.push(fixture.workspaceRoot);
    const statePayload = {
      ...fixture.runState,
      runDir: fixture.runDir,
      planPath: fixture.planPath,
      configPath: null,
      isActive: false,
      cancelRequested: false,
      lastExitCode: null,
      recentConsole: [
        {
          atUtc: '2026-04-01T11:01:09Z',
          source: 'stderr',
          text: 'post-body judge timed out before it returned a score',
        },
      ],
    };

    installFixtureFetchStub(fixture, statePayload);

    const router = createMemoryRouter(
      [{ path: '/run/:runId', element: <Monitor /> }],
      { initialEntries: [`/run/${fixture.runId}`] },
    );

    render(
      <MantineProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </MantineProvider>,
    );

    expect((await screen.findAllByText('Run failed')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('No score')).length).toBeGreaterThan(0);
    expect((screen.getByRole('button', { name: 'Resume' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'monitor_quality_gate' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Activity' }));

    expect(await screen.findByText('Judge trail')).toBeTruthy();
    expect(await screen.findByText('Iteration 1 · post_body')).toBeTruthy();
    expect(await screen.findByText('No score recorded · retry')).toBeTruthy();
    expect((await screen.findAllByText('ai gate error: Error: spawnSync codex ETIMEDOUT')).length).toBeGreaterThan(0);
  });

  it('renders a builder snapshot fixture with launch-path context and command evidence', async () => {
    const fixture = createSampleAgentflowFixture({ scenario: 'builder_snapshot' });
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
          atUtc: '2026-04-01T07:00:47Z',
          source: 'stdout',
          text: 'builder snapshot metadata captured',
        },
      ],
    };

    installFixtureFetchStub(fixture, statePayload);

    const router = createMemoryRouter(
      [{ path: '/run/:runId', element: <Monitor /> }],
      { initialEntries: [`/run/${fixture.runId}`] },
    );

    render(
      <MantineProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </MantineProvider>,
    );

    expect((await screen.findAllByText('Run completed')).length).toBeGreaterThan(0);
    expect(await screen.findByText(fixture.planPath)).toBeTruthy();
    expect(fixture.planPath).toContain(`${path.sep}web_builder_drafts${path.sep}`);
    expect(fixture.planPath).toContain(`${path.sep}launches${path.sep}`);
    expect(await screen.findByRole('button', { name: 'builder_parallel_checks' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'draft_polish' })).toBeTruthy();
    expect((await screen.findAllByText('Viewing the final persisted success state.')).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'snapshot_metadata' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Raw logs' }));

    await waitFor(() => {
      expect(screen.getAllByText(/builder_snapshot_ready/).length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Artifacts' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Command Result' }));

    await waitFor(() => {
      expect(screen.getAllByText(/builder_snapshot_ready/).length).toBeGreaterThan(0);
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

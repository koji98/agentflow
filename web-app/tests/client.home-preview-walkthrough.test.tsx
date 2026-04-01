import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('@mantine/charts', () => ({
  DonutChart: () => <div data-testid="donut-chart" />,
}));

vi.mock('../client/src/components/Graph.tsx', () => ({
  default: () => <div data-testid="graph-preview" />,
}));

import Home from '../client/src/routes/Home.tsx';
import PreviewWalkthrough from '../client/src/components/PreviewWalkthrough.tsx';

function mockJson(data: unknown) {
  return { ok: true, json: async () => data } as Response;
}

describe('Home preview walkthrough', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows an attached walkthrough, steps through nodes, and toggles filters', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/version')) {
        return mockJson({ agentflowVersion: '0.1.0', webAppVersion: '0.1.0' });
      }
      if (url.startsWith('/api/plan/inspect')) {
        return mockJson({
          planPath: '/workspace/demo.json',
          valid: true,
          errors: [],
          plan: {
            flow: [
              { type: 'task', id: 't1', prompt: 'Write code for the UI.' },
              { type: 'command', id: 'build', command: 'echo', args: ['hi'] },
              { type: 'loop_judge', id: 'judge_loop', pass_threshold: 8, body: [
                { type: 'task', id: 'inside', prompt: 'Inner loop task.' },
              ] },
            ],
          },
          repos: [],
          runRootCandidates: [],
          contextFiles: [],
          nearbyDocs: [],
          workflow: { totalNodes: 4, executableCount: 3, tasks: ['t1','inside'], groups: [], loops: [{ id: 'judge_loop', type: 'loop_judge' }] },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as any);

    render(
      <MantineProvider>
        <Notifications />
        <MemoryRouter
          initialEntries={["/?plan=/workspace/demo.json"]}
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        >
          <Routes>
            <Route path="/" element={<Home />} />
          </Routes>
        </MemoryRouter>
      </MantineProvider>,
    );

    // Walkthrough empty state visible
    await screen.findByText('Workflow preview');
    expect(await screen.findByText('No node selected')).toBeTruthy();
    const firstAction = await screen.findByRole('button', { name: /First action/i });
    fireEvent.click(firstAction);

    // Inspector shows selected node details and request preview
    expect(await screen.findByText('Prompt / command')).toBeTruthy();
    const promptMatches = await screen.findAllByText(/Write code for the UI/);
    expect(promptMatches.length).toBeGreaterThan(0);

    // Next should step to command node
    const nextBtn = await screen.findByRole('button', { name: /Next action/i });
    fireEvent.click(nextBtn);
    const cmdMatches = await screen.findAllByText(/echo hi/);
    expect(cmdMatches.length).toBeGreaterThan(0);

    // Toggle to All and see step count update
    fireEvent.click(await screen.findByText('All'));
    expect(await screen.findByText(/\/ 4$/)).toBeTruthy(); // e.g., "2 / 4"
  });

  it('keeps explicit loop or group selections even when actionable filtering is active', async () => {
    const graph = {
      items: [
        {
          graphId: 'loop:0:0',
          workflowId: 'loop_gate',
          type: 'loop_judge',
          label: 'loop_gate',
          depth: 0,
          order: 0,
          raw: { type: 'loop_judge', id: 'loop_gate', rubric: { criteria: [{ label: 'Correctness', weight: 1 }] } },
          status: 'PENDING',
          subtitle: 'Pass threshold 8',
        },
        {
          graphId: 'task:1:1',
          workflowId: 'inside_task',
          type: 'task',
          label: 'inside_task',
          depth: 1,
          order: 1,
          raw: { type: 'task', id: 'inside_task', prompt: 'Implement the fix.' },
          status: 'PENDING',
          subtitle: 'Implement the fix.',
          ancestors: [{ workflowId: 'loop_gate', type: 'loop_judge', label: 'loop_gate' }],
        },
      ],
      edges: [
        { id: 'loop->task', source: 'loop:0:0', target: 'task:1:1' },
      ],
    };

    const onSelect = vi.fn();

    render(
      <MantineProvider>
        <PreviewWalkthrough
          graph={graph}
          selectedGraphId="loop:0:0"
          onSelect={onSelect}
          filter="actionable"
          onChangeFilter={() => undefined}
        />
      </MantineProvider>,
    );

    expect(screen.getByText('loop_gate')).toBeTruthy();
    expect(screen.getByText('Judge rubric')).toBeTruthy();
    expect(screen.getByText(/Correctness/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Next action: inside_task/i }));
    expect(onSelect).toHaveBeenCalledWith('task:1:1');
  });
});

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

function mockJson(data: unknown) {
  return { ok: true, json: async () => data } as Response;
}

describe('Home bootstrap', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preloads a plan from query params', async () => {
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
          repos: [{ alias: 'main', root: '/workspace', exists: true, isGitRepo: true }],
          runRootCandidates: ['/workspace/.tmp/runs'],
          contextFiles: [],
          nearbyDocs: ['/workspace/README.md'],
          workflow: { totalNodes: 3, executableCount: 2, tasks: ['t1'], commands: ['lint'], groups: [], loops: [{ id: 'judge_loop', type: 'loop_judge', passThreshold: 8 }] },
          plan: {
            flow: [
              { type: 'task', id: 't1', prompt: 'Do the work.' },
              { type: 'command', id: 'lint', command: 'npm', args: ['run', 'lint'] },
              { type: 'loop_judge', id: 'judge_loop', pass_threshold: 8, body: [] },
            ],
          },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as any);

    render(
      <MantineProvider>
        <Notifications />
        <MemoryRouter
          initialEntries={['/?plan=/workspace/demo.json']}
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        >
          <Routes>
            <Route path="/" element={<Home />} />
          </Routes>
        </MemoryRouter>
      </MantineProvider>,
    );

    const matches = await screen.findAllByText('/workspace/demo.json');
    expect(matches.length).toBeGreaterThan(0);
    expect(screen.getByText('valid')).toBeTruthy();
    expect(screen.getByText('Commands')).toBeTruthy();
    expect(screen.getByText('Loops')).toBeTruthy();
  });
});

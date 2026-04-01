import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';

import Graph from '../client/src/components/Graph.tsx';

describe('Graph overlay', () => {
  it('renders a real react-flow graph and emits workflow selection', async () => {
    const onSelect = vi.fn();
    const plan = {
      flow: [
        { type: 'task', id: 't1', taskId: 't1', prompt: 'Implement the UI.' },
        { type: 'loop_judge', id: 'judge_loop', pass_threshold: 8, body: [] },
      ],
    };
    const state = {
      runDir: '/tmp/run',
      planPath: '/tmp/plan.json',
      isActive: true,
      cancelRequested: false,
      lastExitCode: null,
      recentConsole: [],
      tasks: {
        'g0:t1#a1': { taskKey: 'g0:t1#a1', taskId: 't1', attempt: 1, status: 'RUNNING', nodePath: 'flow[0]' },
      },
    } as any;

    const { container } = render(
      <MantineProvider>
        <div style={{ height: 500 }}>
          <Graph plan={plan as any} state={state} trace={[]} onSelectNode={onSelect} />
        </div>
      </MantineProvider>,
    );

    expect(container.querySelector('.react-flow')).toBeTruthy();
    fireEvent.click(await screen.findByText('t1'));
    expect(onSelect).toHaveBeenCalledWith('t1');
  });

  it('emits graph ids for non-actionable nodes when selectionKey=graphId', async () => {
    const onSelect = vi.fn();
    const plan = {
      flow: [
        {
          type: 'group',
          id: 'validation_pass_one',
          steps: [
            { type: 'command', id: 'typecheck_pass_one', command: 'npm', args: ['run', 'typecheck'] },
          ],
        },
      ],
    };

    render(
      <MantineProvider>
        <div style={{ height: 500 }}>
          <Graph
            plan={plan as any}
            state={null}
            trace={[]}
            onSelectNode={onSelect}
            selectionKey="graphId"
          />
        </div>
      </MantineProvider>,
    );

    fireEvent.click(await screen.findByText('validation_pass_one'));
    expect(onSelect).toHaveBeenCalledWith(expect.stringMatching(/^validation_pass_one:/));
  });
});

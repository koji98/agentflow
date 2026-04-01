// @vitest-environment happy-dom

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';

import NodeInspector from '../client/src/components/NodeInspector.tsx';

vi.mock('@mantine/charts', () => ({
  AreaChart: () => <div data-testid="area-chart" />,
}));

describe('NodeInspector', () => {
  it('renders a structured activity view, strips ansi noise from raw logs, and renders markdown artifacts', async () => {
    render(
      <MantineProvider>
        <NodeInspector
          selectedNode={{
            graphId: 'alpha:0:0',
            workflowId: 'alpha',
            type: 'task',
            label: 'alpha',
            depth: 0,
            order: 0,
            raw: {
              type: 'task',
              id: 'alpha',
              prompt: '## Solve it\n\n- tell a concise joke',
            },
            status: 'DONE',
            subtitle: 'Tell a concise joke',
          }}
          taskRow={{
            taskKey: 'g01:alpha#a1',
            taskId: 'alpha',
            nodePath: 'workflow[0]/task:alpha',
            attempt: 1,
            status: 'DONE',
            startedAtUtc: '2026-04-01T01:00:00Z',
            endedAtUtc: '2026-04-01T01:00:10Z',
            durationSec: 10,
            provider: 'codex',
            model: 'gpt-5.4-mini',
          } as any}
          artifacts={[
            {
              key: 'report',
              label: 'Report',
              path: '/tmp/worker_report.md',
              exists: true,
            },
          ]}
          selectedArtifact={{
            key: 'report',
            label: 'Report',
            path: '/tmp/worker_report.md',
            exists: true,
          }}
          onSelectArtifact={() => undefined}
          artifactPreview={'# Inspector heading\n\n- bullet one'}
          artifactPreviewLoading={false}
          selectedLogText={[
            '\u001b[35m\u001b[3mthinking\u001b[0m\u001b[0m',
            'Drafting a lighter response.',
            '\u001b[35m\u001b[3mexec\u001b[0m\u001b[0m',
            '\u001b[1m/bin/zsh -lc pwd\u001b[0m in /tmp/project',
            '\u001b[35m\u001b[3mcodex\u001b[0m\u001b[0m',
            'Completed the response.',
          ].join('\n')}
          judgeEvaluations={[]}
          judgeChartData={[]}
          traceEntries={[
            {
              atUtc: '2026-04-01T01:00:05Z',
              type: 'task_retry',
              detail: { taskId: 'alpha', attempt: 1, nextAttempt: 2 },
            },
          ]}
        />
      </MantineProvider>,
    );

    expect(screen.getByText('Prompt / command')).toBeTruthy();
    expect(screen.getByText(/Solve it/)).toBeTruthy();
    expect(screen.getByText('Reasoning summary')).toBeTruthy();
    expect(screen.getByText('Drafting a lighter response.')).toBeTruthy();
    expect(screen.getByText('Tool call')).toBeTruthy();
    expect(screen.getByText('/bin/zsh -lc pwd in /tmp/project')).toBeTruthy();
    expect(screen.getByText('Retry alpha from attempt 1 to 2')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Raw log' }));
    expect(screen.getAllByText(/\/bin\/zsh -lc pwd/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Completed the response\./).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/thinking/).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('tab', { name: 'Artifacts' }));
    expect(await screen.findByText('Inspector heading')).toBeTruthy();
    expect(screen.getByText('bullet one')).toBeTruthy();
  });
});

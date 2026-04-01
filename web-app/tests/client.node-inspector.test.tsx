// @vitest-environment happy-dom

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';

import NodeInspector from '../client/src/components/NodeInspector.tsx';

describe('NodeInspector', () => {
  it('renders a summary-first overview with activity-first actions and followed-child evidence guidance', async () => {
    const onOpenEvidenceTab = vi.fn();
    const onJumpToFollowNode = vi.fn();

    render(
      <MantineProvider>
        <NodeInspector
          selectedNode={{
            graphId: 'quality_gate:0:2',
            workflowId: 'quality_gate',
            type: 'loop_judge',
            label: 'quality_gate',
            depth: 0,
            order: 2,
            raw: {
              type: 'loop_judge',
              id: 'quality_gate',
              pass_threshold: 8,
            },
            status: 'RUNNING',
            subtitle: 'Pre-body judge scored 6 against 8 and kept the loop active.',
          }}
          summary={{
            identity: {
              nodeId: 'quality_gate',
              type: 'loop_judge',
              label: 'quality_gate',
              breadcrumb: ['root', 'quality_gate'],
            },
            stateNow: {
              status: 'RUNNING',
              phase: 'pre_body_gate',
              sinceAtUtc: '2026-04-01T01:00:00Z',
            },
            whyNow: {
              reasonCode: 'judge_pre_body',
              message: 'Pre-body judge scored 6 against 8 and kept the loop active.',
              retryFailureReason: 'The previous draft was too vague.',
            },
            next: {
              transition: 'enter_body',
              label: 'Run body iteration 1',
              targetNodeIds: ['refine_agent'],
            },
            progressItems: [
              { label: 'Iteration', value: '1' },
              { label: 'Max iterations', value: '2' },
              { label: 'Score', value: '6 / 8' },
            ],
            graphMetrics: ['Iter 1 / 2', '6 / 8'],
            evidence: {
              summary: true,
              report: true,
              artifacts: 3,
              logs: true,
              traceEvents: 4,
            },
            alerts: [],
            evidenceRow: {
              taskKey: 'g04:refine_agent#a2',
              taskId: 'refine_agent',
              nodePath: 'workflow[2]/while:quality_gate/body[0]/task:refine_agent',
              attempt: 2,
              status: 'RUNNING',
              failureReason: 'The previous draft was too vague.',
            },
            followTarget: {
              descendant: true,
              workflowId: 'refine_agent',
              label: 'refine_agent',
              type: 'task',
              reason: 'active_body_child',
              description: 'Artifacts and raw logs follow current body child refine_agent.',
            },
            judge: {
              phase: 'pre_body',
              score: 6,
              threshold: 8,
              result: 'enter_body',
              reasons: ['Make the punchline more specific and easier to repeat.'],
              atUtc: '2026-04-01T01:00:03Z',
            },
            retry: {
              attempt: 2,
              previousAttempts: 1,
              latestFailureReason: 'The previous draft was too vague.',
              state: 'in_progress',
              nextTarget: 'refine_agent',
            },
          }}
          activeDetailTab="activity"
          focusLabel="Selected scope"
          onOpenEvidenceTab={onOpenEvidenceTab}
          onJumpToFollowNode={onJumpToFollowNode}
        />
      </MantineProvider>,
    );

    expect(screen.getAllByText('quality_gate').length).toBeGreaterThan(0);
    expect(screen.getByText(/Pre-body judge scored 6 against 8/)).toBeTruthy();
    expect(screen.getByText('Activity briefing')).toBeTruthy();
    expect(screen.getByText('Artifacts handoff')).toBeTruthy();
    expect(screen.getAllByText('Selected scope').length).toBeGreaterThan(0);
    expect(screen.getByText('Proof ready')).toBeTruthy();
    expect(screen.getByText('Detail order')).toBeTruthy();
    expect(screen.getByText('Read this node from summary to raw')).toBeTruthy();
    expect(screen.getByText('Overview')).toBeTruthy();
    expect(screen.getByText('Deep inspection')).toBeTruthy();
    expect(screen.getByText('Artifacts + raw logs')).toBeTruthy();
    expect(screen.getByText(/Selected-node summary for quality_gate/)).toBeTruthy();
    expect(screen.getAllByText(/Judge, retry, and control flow stay on quality_gate/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('refine_agent').length).toBeGreaterThan(0);
    expect(screen.getByText('Judge state')).toBeTruthy();
    expect(screen.getByText(/Attempt 2 · in progress/)).toBeTruthy();
    expect(screen.getAllByText('Activity').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Artifacts').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Activity' }));
    expect(onOpenEvidenceTab).toHaveBeenCalledWith('activity');

    fireEvent.click(screen.getByRole('button', { name: 'Artifacts' }));
    expect(onOpenEvidenceTab).toHaveBeenCalledWith('artifacts');

    fireEvent.click(screen.getByRole('button', { name: 'Jump to refine_agent' }));
    expect(onJumpToFollowNode).toHaveBeenCalledTimes(1);
  });
});

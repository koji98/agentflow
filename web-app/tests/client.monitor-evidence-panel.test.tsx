// @vitest-environment happy-dom

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';

vi.mock('@mantine/charts', () => ({
  AreaChart: () => <div data-testid="area-chart" />,
}));

vi.mock('../client/src/api/client.ts', () => ({
  api: {
    fs: {
      read: vi.fn(async (path: string) => {
        if (path === '/tmp/alpha-summary.md') {
          return { text: '## Summary\n\n- concise summary', size: 10, mtime: '', binary: false };
        }
        if (path === '/tmp/alpha-report.md') {
          return { text: '## Report\n\n- detailed output', size: 10, mtime: '', binary: false };
        }
        if (path === '/tmp/alpha-last.md') {
          return { text: 'Latest message', size: 10, mtime: '', binary: false };
        }
        return { text: '', size: 0, mtime: '', binary: false };
      }),
      downloadUrl: (path: string) => `/api/fs/download?path=${encodeURIComponent(path)}`,
    },
  },
}));

import MonitorEvidencePanel from '../client/src/components/MonitorEvidencePanel.tsx';

describe('MonitorEvidencePanel', () => {
  it('keeps activity first, then artifacts, then raw logs behind explicit tabs', async () => {
    function Wrapper() {
      const [tab, setTab] = React.useState<'activity' | 'artifacts' | 'raw'>('activity');
      return (
        <MonitorEvidencePanel
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
            subtitle: 'Attempt 1 completed successfully.',
          }}
          followNode={{
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
            subtitle: 'Attempt 1 completed successfully.',
          }}
          summary={{
            identity: {
              nodeId: 'alpha',
              type: 'task',
              label: 'alpha',
              breadcrumb: ['root', 'alpha'],
            },
            stateNow: {
              status: 'DONE',
              phase: 'done',
              sinceAtUtc: '2026-04-01T01:00:10Z',
            },
            whyNow: {
              reasonCode: 'task_done',
              message: 'Attempt 1 completed successfully.',
            },
            next: {
              transition: 'continue_flow',
              label: 'Continue to the next eligible node',
              targetNodeIds: [],
            },
            progressItems: [
              { label: 'Attempt', value: '1' },
              { label: 'Duration', value: '10s' },
            ],
            graphMetrics: ['Attempt 1', '10s'],
            evidence: {
              summary: true,
              report: true,
              artifacts: 4,
              logs: true,
              traceEvents: 1,
            },
            alerts: [],
            evidenceRow: {
              taskKey: 'g01:alpha#a1',
              taskId: 'alpha',
              nodePath: 'workflow[0]/task:alpha',
              attempt: 1,
              status: 'DONE',
              startedAtUtc: '2026-04-01T01:00:00Z',
              endedAtUtc: '2026-04-01T01:00:10Z',
              durationSec: 10,
              promptPath: '/tmp/alpha-prompt.md',
              summaryPath: '/tmp/alpha-summary.md',
              reportPath: '/tmp/alpha-report.md',
              lastMessagePath: '/tmp/alpha-last.md',
              logPath: '/tmp/alpha.log',
            },
            followTarget: {
              descendant: false,
              workflowId: 'alpha',
              label: 'alpha',
              type: 'task',
              reason: 'selected_node',
              description: 'Artifacts and raw logs attach directly to this node.',
            },
          }}
          artifacts={[
            { key: 'prompt', label: 'Prompt', path: '/tmp/alpha-prompt.md', exists: true },
            { key: 'log', label: 'Execution Log', path: '/tmp/alpha.log', exists: true },
            { key: 'artifact', label: 'Worker Report', path: '/tmp/worker_report.md', exists: true },
          ]}
          selectedArtifact={{
            key: 'artifact',
            label: 'Worker Report',
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
          rawOutputLabel="Execution log"
          judgeEvaluations={[]}
          judgeChartData={[]}
          traceEntries={[
            {
              atUtc: '2026-04-01T01:00:05Z',
              type: 'task_retry',
              detail: { taskId: 'alpha', attempt: 1, nextAttempt: 2 },
            },
          ]}
          tab={tab}
          onChangeTab={setTab}
        />
      );
    }

    render(
      <MantineProvider>
        <Wrapper />
      </MantineProvider>,
    );

    expect(screen.getByText('What happened here')).toBeTruthy();
    expect(screen.getByText('Activity')).toBeTruthy();
    expect(screen.getAllByText('Continue to the next eligible node').length).toBeGreaterThan(0);
    expect(await screen.findByText('Activity highlights')).toBeTruthy();
    expect(await screen.findByText('Artifacts ready')).toBeTruthy();
    expect(screen.queryByText('Summary note')).toBeNull();
    expect(screen.getByText('Reasoning summary')).toBeTruthy();
    expect(screen.getByText('Drafting a lighter response.')).toBeTruthy();
    expect(screen.getByText('Tool call')).toBeTruthy();
    expect(screen.getByText('/bin/zsh -lc pwd in /tmp/project')).toBeTruthy();
    expect(screen.getAllByText('Retry alpha from attempt 1 to 2').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('tab', { name: 'Artifacts' }));
    expect(await screen.findByText('Artifacts at this scope')).toBeTruthy();
    expect((await screen.findAllByText('Key artifact')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/concise summary/).length).toBeGreaterThan(0);
    expect(await screen.findByText('Selected artifact')).toBeTruthy();
    expect(await screen.findByText('Inspector heading')).toBeTruthy();
    expect(screen.getByText('bullet one')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Raw logs' }));
    await waitFor(() => {
      expect(screen.getAllByText(/Solve it/).length).toBeGreaterThan(0);
    });
  });

  it('keeps composite activity timing scoped to the selected node instead of followed-child timestamps', () => {
    render(
      <MantineProvider>
        <MonitorEvidencePanel
          selectedNode={{
            graphId: 'quality_gate:0:0',
            workflowId: 'quality_gate',
            type: 'loop_judge',
            label: 'quality_gate',
            depth: 0,
            order: 0,
            raw: {
              type: 'loop_judge',
              id: 'quality_gate',
            },
            status: 'DONE',
            subtitle: 'Post Body judge scored 9 against 8 and cleared the gate.',
          }}
          followNode={{
            graphId: 'refine_agent:1:1',
            workflowId: 'refine_agent',
            type: 'task',
            label: 'refine_agent',
            depth: 1,
            order: 1,
            raw: {
              type: 'task',
              id: 'refine_agent',
              prompt: 'Tighten the punchline.',
            },
            status: 'DONE',
            subtitle: 'Attempt 1 completed successfully.',
          }}
          summary={{
            identity: {
              nodeId: 'quality_gate',
              type: 'loop_judge',
              label: 'quality_gate',
              breadcrumb: ['root', 'quality_gate'],
            },
            stateNow: {
              status: 'DONE',
              phase: 'satisfied',
              sinceAtUtc: '2026-04-01T01:03:30Z',
            },
            whyNow: {
              reasonCode: 'judge_post_body',
              message: 'Post Body judge scored 9 against 8 and cleared the gate.',
            },
            next: {
              transition: 'exit_loop',
              label: 'Exit the loop',
              targetNodeIds: [],
            },
            progressItems: [
              { label: 'Iteration', value: '1' },
              { label: 'Max iterations', value: '2' },
              { label: 'Score', value: '9 / 8' },
            ],
            graphMetrics: ['Iter 1 / 2', '9 / 8'],
            evidence: {
              summary: true,
              report: true,
              artifacts: 3,
              logs: true,
              traceEvents: 4,
            },
            alerts: [],
            evidenceRow: {
              taskKey: 'g04:refine_agent#a1',
              taskId: 'refine_agent',
              nodePath: 'workflow[2]/while:quality_gate/body[0]/task:refine_agent',
              attempt: 1,
              status: 'DONE',
              startedAtUtc: '2026-04-01T01:00:00Z',
              endedAtUtc: '2026-04-01T01:01:00Z',
              durationSec: 60,
              summaryPath: '/tmp/alpha-summary.md',
              reportPath: '/tmp/alpha-report.md',
              lastMessagePath: '/tmp/alpha-last.md',
              logPath: '/tmp/alpha.log',
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
              phase: 'post_body',
              score: 9,
              threshold: 8,
              result: 'exit_loop',
              reasons: ['The revised joke lands cleanly and stays memorable.'],
              atUtc: '2026-04-01T01:03:30Z',
            },
          }}
          artifacts={[]}
          selectedArtifact={null}
          onSelectArtifact={() => undefined}
          artifactPreview=""
          artifactPreviewLoading={false}
          selectedLogText=""
          rawOutputLabel="Execution log"
          judgeEvaluations={[]}
          judgeChartData={[]}
          traceEntries={[]}
          tab="activity"
          onChangeTab={() => undefined}
        />
      </MantineProvider>,
    );

    const activityCard = screen.getByText('What happened here').closest('.af-activity-card');
    expect(activityCard).toBeTruthy();
    expect(within(activityCard as HTMLElement).getByText('Updated')).toBeTruthy();
    expect(within(activityCard as HTMLElement).queryByText('Started')).toBeNull();
    expect(within(activityCard as HTMLElement).queryByText('Ended')).toBeNull();
    expect(within(activityCard as HTMLElement).queryByText('Duration')).toBeNull();
  });

  it('deduplicates judge evaluations from generic control flow and lets older structured activity expand on demand', async () => {
    function Wrapper() {
      const [tab, setTab] = React.useState<'activity' | 'artifacts' | 'raw'>('activity');
      return (
        <MonitorEvidencePanel
          selectedNode={{
            graphId: 'quality_gate:0:0',
            workflowId: 'quality_gate',
            type: 'loop_judge',
            label: 'quality_gate',
            depth: 0,
            order: 0,
            raw: {
              type: 'loop_judge',
              id: 'quality_gate',
            },
            status: 'FAILED',
            subtitle: 'The loop exhausted 1 iterations without meeting the threshold.',
          }}
          followNode={{
            graphId: 'rewrite_brief:1:1',
            workflowId: 'rewrite_brief',
            type: 'task',
            label: 'rewrite_brief',
            depth: 1,
            order: 1,
            raw: {
              type: 'task',
              id: 'rewrite_brief',
              prompt: 'Tighten the brief.',
            },
            status: 'DONE',
            subtitle: 'Attempt 1 completed successfully.',
          }}
          summary={{
            identity: {
              nodeId: 'quality_gate',
              type: 'loop_judge',
              label: 'quality_gate',
              breadcrumb: ['root', 'quality_gate'],
            },
            stateNow: {
              status: 'FAILED',
              phase: 'exhausted',
              sinceAtUtc: '2026-04-01T07:01:08Z',
            },
            whyNow: {
              reasonCode: 'loop_exhausted',
              message: 'The loop exhausted 1 iterations without meeting the threshold.',
            },
            next: {
              transition: 'fail_loop',
              label: 'Loop stops here',
              targetNodeIds: [],
            },
            progressItems: [
              { label: 'Iteration', value: '1' },
              { label: 'Max iterations', value: '1' },
              { label: 'Score', value: 'Threshold 9.2' },
            ],
            graphMetrics: ['Iter 1 / 1', 'Threshold 9.2'],
            evidence: {
              summary: true,
              report: true,
              artifacts: 3,
              logs: true,
              traceEvents: 6,
            },
            alerts: [],
            evidenceRow: {
              taskKey: 'g01:rewrite_brief#a1',
              taskId: 'rewrite_brief',
              nodePath: 'workflow[0]/while:quality_gate/body[0]/task:rewrite_brief',
              attempt: 1,
              status: 'DONE',
              summaryPath: '/tmp/alpha-summary.md',
              reportPath: '/tmp/alpha-report.md',
              lastMessagePath: '/tmp/alpha-last.md',
              logPath: '/tmp/alpha.log',
            },
            followTarget: {
              descendant: true,
              workflowId: 'rewrite_brief',
              label: 'rewrite_brief',
              type: 'task',
              reason: 'latest_descendant',
              description: 'Artifacts and raw logs follow the most relevant actionable child, rewrite_brief.',
            },
            judge: {
              phase: 'post_body',
              score: null,
              threshold: 9.2,
              result: 'retry_body',
              reasons: ['ai gate error: Error: spawnSync codex ETIMEDOUT'],
              atUtc: '2026-04-01T07:01:08Z',
            },
          }}
          artifacts={[]}
          selectedArtifact={null}
          onSelectArtifact={() => undefined}
          artifactPreview=""
          artifactPreviewLoading={false}
          selectedLogText=""
          rawOutputLabel="Execution log"
          judgeEvaluations={[]}
          judgeChartData={[]}
          traceEntries={[
            {
              atUtc: '2026-04-01T07:01:09Z',
              type: 'run_failed',
              detail: { reason: 'The post-body judge timed out before it could return a score.' },
            },
            {
              atUtc: '2026-04-01T07:01:09Z',
              type: 'while_exhausted',
              detail: { iteration: 1, maxIterations: 1 },
            },
            {
              atUtc: '2026-04-01T07:01:08Z',
              type: 'while_gate_evaluation',
              detail: { phase: 'post_body', score: null, passed: false, reasons: ['ai gate error: Error: spawnSync codex ETIMEDOUT'] },
            },
            {
              atUtc: '2026-04-01T07:01:07Z',
              type: 'command_completed',
              detail: {},
            },
            {
              atUtc: '2026-04-01T07:00:29Z',
              type: 'while_iteration_started',
              detail: { iteration: 1 },
            },
          ]}
          tab={tab}
          onChangeTab={setTab}
        />
      );
    }

    render(
      <MantineProvider>
        <Wrapper />
      </MantineProvider>,
    );

    expect(screen.getByText('Terminal outcome')).toBeTruthy();
    expect(screen.getAllByText('Run failed').length).toBeGreaterThan(0);
    expect(screen.getAllByText('The post-body judge timed out before it could return a score.').length).toBeGreaterThan(0);
    expect(screen.queryByText('while_gate_evaluation')).toBeNull();
    expect(screen.getByText('while_exhausted')).toBeTruthy();
    expect(screen.queryByText('while_iteration_started')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show 1 older event' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Show 1 older event' }));

    await waitFor(() => {
      expect(screen.getAllByText('while_iteration_started').length).toBeGreaterThan(0);
    });
    expect(screen.getByRole('button', { name: 'Show fewer activity events' })).toBeTruthy();
  });
});

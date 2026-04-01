import { describe, expect, it } from 'vitest';

import {
  deriveRunStatus,
  getRepresentativeTaskRow,
  parseLogActivityEvents,
  pickInitialGraphSelection,
  requestPreviewForWorkflowItem,
  stripAnsi,
} from '../client/src/lib/monitor.ts';

describe('deriveRunStatus', () => {
  it('returns RUNNING for active runs', () => {
    expect(deriveRunStatus({
      runDir: '/tmp/run',
      planPath: '/tmp/plan.json',
      isActive: true,
      cancelRequested: false,
      lastExitCode: null,
      recentConsole: [],
      tasks: {},
    } as any)).toBe('RUNNING');
  });

  it('returns FAILED for historical runs with failure reasons', () => {
    expect(deriveRunStatus({
      runDir: '/tmp/run',
      planPath: '/tmp/plan.json',
      isActive: false,
      cancelRequested: false,
      lastExitCode: 1,
      recentConsole: [],
      totalFailureCount: 1,
      runFailureReasons: ['loop exhausted'],
      tasks: {},
    } as any)).toBe('FAILED');
  });

  it('returns CANCELLED for cancelled runs', () => {
    expect(deriveRunStatus({
      runDir: '/tmp/run',
      planPath: '/tmp/plan.json',
      isActive: false,
      cancelRequested: true,
      lastExitCode: 130,
      recentConsole: [],
      tasks: {},
    } as any)).toBe('CANCELLED');
  });

  it('prefers FAILED over stale cancelRequested flags when tasks actually failed', () => {
    expect(deriveRunStatus({
      runDir: '/tmp/run',
      planPath: '/tmp/plan.json',
      isActive: false,
      cancelRequested: true,
      lastExitCode: null,
      recentConsole: [],
      totalFailureCount: 3,
      runFailureReasons: [],
      tasks: {
        'g01:task#a1': {
          taskKey: 'g01:task#a1',
          taskId: 'task',
          attempt: 1,
          status: 'FAILED',
          failureReason: 'nonzero_exit',
        },
      },
    } as any)).toBe('FAILED');
  });

  it('formats loop_judge rubric objects into readable preview text', () => {
    const preview = requestPreviewForWorkflowItem({
      graphId: 'quality:0:0',
      workflowId: 'quality',
      type: 'loop_judge',
      label: 'quality',
      depth: 0,
      order: 0,
      raw: {
        rubric: {
          criteria: [
            { id: 'correctness', label: 'Correctness', weight: 0.7 },
            { id: 'clarity', label: 'Clarity', weight: 0.3, guidance: 'Be easy to follow' },
          ],
        },
      },
      status: 'PENDING',
      subtitle: '',
    });

    expect(preview).toContain('Correctness (0.7)');
    expect(preview).toContain('Clarity (0.3): Be easy to follow');
    expect(preview).not.toContain('[object Object]');
  });

  it('picks the first actionable failed node for initial graph selection', () => {
    expect(pickInitialGraphSelection({
      items: [
        {
          graphId: 'parallel:0:0',
          workflowId: 'parallel',
          type: 'group',
          label: 'parallel',
          depth: 0,
          order: 0,
          raw: { type: 'group', id: 'parallel' },
          status: 'FAILED',
          subtitle: 'GROUP',
        },
        {
          graphId: 'alpha:1:1',
          workflowId: 'alpha',
          type: 'task',
          label: 'alpha',
          depth: 1,
          order: 1,
          raw: { type: 'task', id: 'alpha' },
          status: 'FAILED',
          subtitle: 'alpha task',
        },
        {
          graphId: 'beta:1:2',
          workflowId: 'beta',
          type: 'task',
          label: 'beta',
          depth: 1,
          order: 2,
          raw: { type: 'task', id: 'beta' },
          status: 'FAILED',
          subtitle: 'beta task',
        },
      ],
    } as any)).toBe('alpha:1:1');
  });

  it('uses descendant task rows when a group node is selected', () => {
    const row = getRepresentativeTaskRow({
      runDir: '/tmp/run',
      planPath: '/tmp/plan.json',
      isActive: false,
      cancelRequested: false,
      lastExitCode: 1,
      recentConsole: [],
      tasks: {
        'g01:alpha#a1': {
          taskKey: 'g01:alpha#a1',
          taskId: 'alpha',
          attempt: 1,
          status: 'FAILED',
          failureReason: 'nonzero_exit',
          logPath: '/tmp/alpha.log',
        },
        'g02:beta#a1': {
          taskKey: 'g02:beta#a1',
          taskId: 'beta',
          attempt: 1,
          status: 'DONE',
          logPath: '/tmp/beta.log',
        },
      },
    } as any, {
      graphId: 'parallel:0:0',
      workflowId: 'parallel',
      type: 'group',
      label: 'parallel',
      depth: 0,
      order: 0,
      raw: {
        type: 'group',
        id: 'parallel',
        steps: [
          { type: 'task', id: 'alpha' },
          { type: 'task', id: 'beta' },
        ],
      },
      status: 'FAILED',
      subtitle: 'GROUP',
    });

    expect(row?.taskId).toBe('alpha');
    expect(row?.logPath).toBe('/tmp/alpha.log');
  });

  it('parses structured log activity events and strips ansi noise', () => {
    const parsed = parseLogActivityEvents([
      '\u001b[35m\u001b[3mthinking\u001b[0m\u001b[0m',
      'Drafting a cleaner plan.',
      '\u001b[35m\u001b[3mexec\u001b[0m\u001b[0m',
      '\u001b[1m/bin/zsh -lc pwd\u001b[0m in /tmp/project',
      '\u001b[35m\u001b[3mcodex\u001b[0m\u001b[0m',
      'Applied the fix and wrote the report.',
    ].join('\n'));

    expect(stripAnsi('\u001b[35mthinking\u001b[0m')).toBe('thinking');
    expect(parsed.map((entry) => entry.kind)).toEqual(['thinking', 'tool', 'assistant']);
    expect(parsed[0]?.body).toContain('Drafting a cleaner plan.');
    expect(parsed[1]?.body).toContain('/bin/zsh -lc pwd');
  });
});

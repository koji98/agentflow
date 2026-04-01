import { describe, expect, it } from 'vitest';

import {
  applyTraceSnapshot,
  buildFocusedWorkflowGraph,
  buildNodeSummary,
  buildWorkflowGraph,
  countTotals,
  deriveBootstrapTrace,
  deriveRunControls,
  deriveRunStatus,
  getRepresentativeTaskRow,
  inferRunActive,
  inferRunResumable,
  normalizeRunState,
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

  it('does not mark completed-success runs as resumable', () => {
    expect(inferRunResumable({
      runDir: '/tmp/run',
      planPath: '/tmp/plan.json',
      isActive: false,
      cancelRequested: false,
      lastExitCode: 0,
      recentConsole: [],
      totalFailureCount: 0,
      tasks: {
        'g01:task#a1': {
          taskKey: 'g01:task#a1',
          taskId: 'task',
          attempt: 1,
          status: 'DONE',
        },
      },
    } as any)).toBe(false);
  });

  it('honors explicit control flags for active runs reopened without bridge ownership', () => {
    expect(deriveRunControls({
      runDir: '/tmp/run',
      planPath: '/tmp/plan.json',
      isActive: true,
      cancelRequested: false,
      canCancel: false,
      canResume: false,
      lastExitCode: null,
      recentConsole: [],
      tasks: {
        'g01:task#a1': {
          taskKey: 'g01:task#a1',
          taskId: 'task',
          attempt: 1,
          status: 'RUNNING',
        },
      },
    } as any)).toEqual({
      canCancel: false,
      canResume: false,
    });
  });

  it('reclassifies stale persisted isActive flags as historical when rows are terminal', () => {
    expect(normalizeRunState({
      runDir: '/tmp/run',
      planPath: '/tmp/plan.json',
      isActive: true,
      cancelRequested: false,
      canCancel: false,
      canResume: false,
      lastExitCode: null,
      recentConsole: [],
      totalFailureCount: 1,
      runFailureReasons: ['retry_required'],
      tasks: {
        'g01:task#a1': {
          taskKey: 'g01:task#a1',
          taskId: 'task',
          attempt: 1,
          status: 'FAILED',
          failureReason: 'retry_required',
        },
      },
    } as any)).toMatchObject({
      isActive: false,
      canCancel: false,
      canResume: true,
    });
  });

  it('keeps loop-gate snapshots active when a failed gate evaluation is the latest trace state', () => {
    expect(normalizeRunState({
      runDir: '/tmp/run',
      planPath: '/tmp/plan.json',
      isActive: false,
      cancelRequested: false,
      canCancel: false,
      canResume: false,
      lastExitCode: null,
      recentConsole: [],
      totalFailureCount: 0,
      totalLoopIterations: 1,
      decisionTrace: [
        {
          atUtc: '2026-04-01T11:00:29Z',
          type: 'while_iteration_started',
          detail: { whileId: 'quality_gate', iteration: 1 },
        },
        {
          atUtc: '2026-04-01T11:01:08Z',
          type: 'while_gate_evaluation',
          detail: {
            whileId: 'quality_gate',
            iteration: 1,
            phase: 'post_body',
            passed: false,
            score: null,
          },
        },
      ],
      tasks: {
        'g01:rewrite_brief#a1': {
          taskKey: 'g01:rewrite_brief#a1',
          taskId: 'rewrite_brief',
          attempt: 1,
          status: 'DONE',
        },
      },
    } as any)).toMatchObject({
      isActive: true,
      canCancel: false,
      canResume: false,
    });
  });

  it('keeps loop-gate snapshots active when the latest gate evaluation passed but the terminal marker is not durable yet', () => {
    expect(normalizeRunState({
      runDir: '/tmp/run',
      planPath: '/tmp/plan.json',
      isActive: false,
      cancelRequested: false,
      canCancel: false,
      canResume: false,
      lastExitCode: null,
      recentConsole: [],
      totalFailureCount: 0,
      totalLoopIterations: 1,
      decisionTrace: [
        {
          atUtc: '2026-04-01T11:00:29Z',
          type: 'while_iteration_started',
          detail: { whileId: 'quality_gate', iteration: 1 },
        },
        {
          atUtc: '2026-04-01T11:00:31Z',
          type: 'while_gate_evaluation',
          detail: {
            whileId: 'quality_gate',
            iteration: 1,
            phase: 'pre_body',
            passed: true,
            score: 9.4,
          },
        },
      ],
      tasks: {},
    } as any)).toMatchObject({
      isActive: true,
      canCancel: false,
      canResume: false,
    });
  });

  it('preserves earlier decision-trace entries when a same-length tail snapshot rewrites only the newest slice', () => {
    const current = Array.from({ length: 60 }, (_, index) => ({
      atUtc: String(index + 1),
      type: 'gate',
      detail: { iteration: index + 1 },
    }));
    const rewrittenTail = Array.from({ length: 50 }, (_, index) => ({
      atUtc: `rewrite-${index + 11}`,
      type: 'gate',
      detail: { iteration: index + 11 },
    }));

    expect(applyTraceSnapshot(current, {
      entries: rewrittenTail,
      nextLength: 60,
      startIndex: 10,
    })).toEqual([
      ...current.slice(0, 10),
      ...rewrittenTail,
    ]);
  });

  it('replaces a bootstrapped trace tail instead of duplicating it when a tail snapshot arrives later', () => {
    const currentTail = Array.from({ length: 50 }, (_, index) => ({
      atUtc: `tail-${index + 11}`,
      type: 'gate',
      detail: { iteration: index + 11 },
    }));
    const rewrittenTail = Array.from({ length: 50 }, (_, index) => ({
      atUtc: `rewrite-${index + 11}`,
      type: 'gate',
      detail: { iteration: index + 11 },
    }));

    expect(applyTraceSnapshot(currentTail, {
      entries: rewrittenTail,
      nextLength: 60,
      startIndex: 10,
    })).toEqual(rewrittenTail);
  });

  it('counts persisted run-level failures even when task rows are all done', () => {
    expect(countTotals({
      runDir: '/tmp/run',
      planPath: '/tmp/plan.json',
      isActive: false,
      cancelRequested: false,
      lastExitCode: 1,
      recentConsole: [],
      totalFailureCount: 1,
      totalRunFailureCount: 1,
      tasks: {
        'g01:rewrite_brief#a1': {
          taskKey: 'g01:rewrite_brief#a1',
          taskId: 'rewrite_brief',
          attempt: 1,
          status: 'DONE',
        },
      },
    } as any)).toMatchObject({
      tasks: 1,
      done: 1,
      failed: 1,
      running: 0,
      pending: 0,
    });
  });

  it('falls back to the state trace tail when bootstrap trace loading returns nothing', () => {
    expect(deriveBootstrapTrace({
      runDir: '/tmp/run',
      planPath: '/tmp/plan.json',
      isActive: false,
      cancelRequested: false,
      canCancel: false,
      canResume: false,
      lastExitCode: 1,
      recentConsole: [],
      decisionTrace: [
        { atUtc: '1', type: 'while_gate_evaluation', detail: { iteration: 1, score: 0.7 } },
      ],
      tasks: {},
    } as any, [])).toEqual([
      { atUtc: '1', type: 'while_gate_evaluation', detail: { iteration: 1, score: 0.7 } },
    ]);
  });

  it('prefers the full trace payload when bootstrap trace loading succeeds', () => {
    expect(deriveBootstrapTrace({
      runDir: '/tmp/run',
      planPath: '/tmp/plan.json',
      isActive: false,
      cancelRequested: false,
      canCancel: false,
      canResume: false,
      lastExitCode: 1,
      recentConsole: [],
      decisionTrace: [
        { atUtc: 'tail', type: 'while_gate_evaluation', detail: { iteration: 2, score: 0.9 } },
      ],
      tasks: {},
    } as any, [
      { atUtc: 'full', type: 'while_gate_evaluation', detail: { iteration: 1, score: 0.7 } },
      { atUtc: 'tail', type: 'while_gate_evaluation', detail: { iteration: 2, score: 0.9 } },
    ])).toEqual([
      { atUtc: 'full', type: 'while_gate_evaluation', detail: { iteration: 1, score: 0.7 } },
      { atUtc: 'tail', type: 'while_gate_evaluation', detail: { iteration: 2, score: 0.9 } },
    ]);
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

  it('prefers a failed composite scope for initial graph selection when it explains the failure better', () => {
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
    } as any)).toBe('parallel:0:0');
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

  it('keeps loop summaries scoped to the loop while deeper inspection follows the actionable child', () => {
    const plan = {
      flow: [
        {
          type: 'loop_judge',
          id: 'quality_gate',
          max_iterations: 2,
          pass_threshold: 8,
          body: [
            { type: 'task', id: 'refine_agent', prompt: 'Improve the draft.' },
          ],
        },
      ],
    };
    const state = {
      runDir: '/tmp/run',
      planPath: '/tmp/plan.json',
      isActive: false,
      cancelRequested: false,
      lastExitCode: 0,
      recentConsole: [],
      tasks: {
        'g01:refine_agent#a1': {
          taskKey: 'g01:refine_agent#a1',
          taskId: 'refine_agent',
          attempt: 1,
          status: 'DONE',
          startedAtUtc: '2026-04-01T01:00:00Z',
          endedAtUtc: '2026-04-01T01:01:00Z',
          summaryPath: '/tmp/refine_agent_summary.md',
          reportPath: '/tmp/refine_agent_report.md',
          logPath: '/tmp/refine_agent.log',
        },
      },
    } as any;
    const trace = [
      {
        atUtc: '2026-04-01T01:00:10Z',
        type: 'while_gate_evaluation',
        nodePath: 'workflow[0]/while:quality_gate',
        detail: {
          whileId: 'quality_gate',
          iteration: 1,
          phase: 'pre_body',
          score: 6,
          passed: false,
          reasons: ['Need a more specific punchline.'],
        },
      },
      {
        atUtc: '2026-04-01T01:01:10Z',
        type: 'while_gate_evaluation',
        nodePath: 'workflow[0]/while:quality_gate',
        detail: {
          whileId: 'quality_gate',
          iteration: 1,
          phase: 'post_body',
          score: 9,
          passed: true,
          reasons: ['The revised joke lands cleanly and stays memorable.'],
        },
      },
      {
        atUtc: '2026-04-01T01:01:11Z',
        type: 'while_satisfied',
        nodePath: 'workflow[0]/while:quality_gate',
        detail: {
          whileId: 'quality_gate',
          iteration: 1,
          phase: 'post_body',
        },
      },
    ] as Array<Record<string, unknown>>;

    const graph = buildWorkflowGraph(plan as any, state, trace);
    const loopNode = graph.nodeByWorkflowId.get('quality_gate') || null;
    const summary = buildNodeSummary(graph, loopNode, state, trace, { artifactCount: 3 });

    expect(summary?.identity.label).toBe('quality_gate');
    expect(summary?.whyNow.message).toContain('Post Body judge scored 9');
    expect(summary?.followTarget?.workflowId).toBe('refine_agent');
    expect(summary?.followTarget?.reason).toBe('latest_descendant');
    expect(summary?.evidenceRow?.taskId).toBe('refine_agent');
  });

  it('uses a latest-descendant evidence handoff once a loop is exhausted instead of implying another body iteration', () => {
    const plan = {
      flow: [
        {
          type: 'loop_judge',
          id: 'monitor_quality_gate',
          max_iterations: 1,
          pass_threshold: 9.2,
          body: [
            { type: 'task', id: 'rewrite_brief', prompt: 'Tighten the brief.' },
            { type: 'command', id: 'capture_gate_context', command: '/bin/sh', args: ['-c', 'printf gate_context_saved'] },
          ],
        },
      ],
    };
    const state = {
      runDir: '/tmp/run',
      planPath: '/tmp/plan.json',
      isActive: false,
      cancelRequested: false,
      lastExitCode: 1,
      recentConsole: [],
      tasks: {
        'g01:rewrite_brief#a1': {
          taskKey: 'g01:rewrite_brief#a1',
          taskId: 'rewrite_brief',
          attempt: 1,
          status: 'DONE',
          endedAtUtc: '2026-04-01T07:01:04Z',
          summaryPath: '/tmp/rewrite_summary.md',
          reportPath: '/tmp/rewrite_report.md',
          logPath: '/tmp/rewrite.log',
        },
        'g02:capture_gate_context#a1': {
          taskKey: 'g02:capture_gate_context#a1',
          taskId: 'capture_gate_context',
          attempt: 1,
          status: 'DONE',
          endedAtUtc: '2026-04-01T07:01:07Z',
          logPath: '/tmp/capture.log',
        },
      },
    } as any;
    const trace = [
      {
        atUtc: '2026-04-01T07:00:29Z',
        type: 'while_gate_evaluation',
        nodePath: 'workflow[0]/while:monitor_quality_gate',
        detail: {
          whileId: 'monitor_quality_gate',
          iteration: 1,
          phase: 'pre_body',
          score: 8.8,
          passed: false,
          reasons: ['The brief still needs a clearer operator promise before it can ship.'],
        },
      },
      {
        atUtc: '2026-04-01T07:01:08Z',
        type: 'while_gate_evaluation',
        nodePath: 'workflow[0]/while:monitor_quality_gate',
        detail: {
          whileId: 'monitor_quality_gate',
          iteration: 1,
          phase: 'post_body',
          score: null,
          passed: false,
          reasons: ['ai gate error: Error: spawnSync codex ETIMEDOUT'],
        },
      },
      {
        atUtc: '2026-04-01T07:01:09Z',
        type: 'while_exhausted',
        nodePath: 'workflow[0]/while:monitor_quality_gate',
        detail: {
          whileId: 'monitor_quality_gate',
          iteration: 1,
          phase: 'post_body',
          maxIterations: 1,
        },
      },
    ] as Array<Record<string, unknown>>;

    const graph = buildWorkflowGraph(plan as any, state, trace);
    const loopNode = graph.nodeByWorkflowId.get('monitor_quality_gate') || null;
    const summary = buildNodeSummary(graph, loopNode, state, trace, { artifactCount: 3 });

    expect(summary?.stateNow.phase).toBe('exhausted');
    expect(summary?.followTarget?.workflowId).toBe('rewrite_brief');
    expect(summary?.followTarget?.reason).toBe('latest_descendant');
    expect(summary?.followTarget?.description).toContain('most relevant actionable child');
  });

  it('does not fall back to an older descendant row when a group follows the next actionable child', () => {
    const plan = {
      flow: [
        {
          type: 'group',
          id: 'serial_review',
          steps: [
            { type: 'task', id: 'outline' },
            { type: 'task', id: 'rewrite' },
          ],
        },
      ],
    };
    const state = {
      runDir: '/tmp/run',
      planPath: '/tmp/plan.json',
      isActive: false,
      cancelRequested: false,
      lastExitCode: 0,
      recentConsole: [],
      tasks: {
        'g01:outline#a1': {
          taskKey: 'g01:outline#a1',
          taskId: 'outline',
          attempt: 1,
          status: 'DONE',
          endedAtUtc: '2026-04-01T01:01:00Z',
          summaryPath: '/tmp/outline-summary.md',
          reportPath: '/tmp/outline-report.md',
          logPath: '/tmp/outline.log',
        },
      },
    } as any;

    const graph = buildWorkflowGraph(plan as any, state, []);
    const groupNode = graph.nodeByWorkflowId.get('serial_review') || null;
    const summary = buildNodeSummary(graph, groupNode, state, [], { artifactCount: 1 });

    expect(summary?.followTarget?.workflowId).toBe('rewrite');
    expect(summary?.followTarget?.reason).toBe('next_eligible_child');
    expect(summary?.evidenceRow).toBeNull();
  });

  it('treats last-message output as raw evidence when no execution log exists', () => {
    const plan = {
      flow: [
        { type: 'task', id: 'message_only', prompt: 'Return a final status update.' },
      ],
    };
    const state = {
      runDir: '/tmp/run',
      planPath: '/tmp/plan.json',
      isActive: false,
      cancelRequested: false,
      lastExitCode: 0,
      recentConsole: [],
      tasks: {
        'g01:message_only#a1': {
          taskKey: 'g01:message_only#a1',
          taskId: 'message_only',
          attempt: 1,
          status: 'DONE',
          lastMessagePath: '/tmp/message_only.md',
        },
      },
    } as any;

    const graph = buildWorkflowGraph(plan as any, state, []);
    const taskNode = graph.nodeByWorkflowId.get('message_only') || null;
    const summary = buildNodeSummary(graph, taskNode, state, [], { artifactCount: 1 });

    expect(summary?.evidence.logs).toBe(true);
    expect(summary?.evidenceRow?.lastMessagePath).toBe('/tmp/message_only.md');
  });

  it('highlights the selected scope and the deeper evidence path inside focused graph state', () => {
    const plan = {
      flow: [
        {
          type: 'group',
          id: 'parallel_review',
          steps: [
            { type: 'task', id: 'outline' },
            { type: 'task', id: 'rewrite' },
          ],
        },
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
        'g01:outline#a1': {
          taskKey: 'g01:outline#a1',
          taskId: 'outline',
          attempt: 1,
          status: 'DONE',
        },
        'g02:rewrite#a1': {
          taskKey: 'g02:rewrite#a1',
          taskId: 'rewrite',
          attempt: 1,
          status: 'RUNNING',
        },
      },
    } as any;

    const graph = buildWorkflowGraph(plan as any, state, []);
    const selectedNode = graph.nodeByWorkflowId.get('parallel_review');
    const focused = buildFocusedWorkflowGraph(graph, {
      selectedId: selectedNode?.graphId,
      selectionKey: 'graphId',
      mode: 'selected',
      followId: 'rewrite',
    });

    expect(focused.emphasis.get(selectedNode?.graphId || '')).toBe('primary');
    expect(focused.emphasis.get(graph.nodeByWorkflowId.get('rewrite')?.graphId || '')).toBe('primary');
    expect(focused.counts.primary).toBeGreaterThanOrEqual(2);
    expect(focused.counts.visible).toBe(3);
  });

  it('selected focus mode hides unrelated branches while keeping the local path visible', () => {
    const plan = {
      flow: [
        { type: 'task', id: 'setup' },
        {
          type: 'group',
          id: 'parallel_review',
          steps: [
            { type: 'task', id: 'outline' },
            { type: 'task', id: 'rewrite' },
          ],
        },
        { type: 'task', id: 'publish' },
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
        'g01:setup#a1': {
          taskKey: 'g01:setup#a1',
          taskId: 'setup',
          attempt: 1,
          status: 'DONE',
        },
        'g02:outline#a1': {
          taskKey: 'g02:outline#a1',
          taskId: 'outline',
          attempt: 1,
          status: 'DONE',
        },
        'g03:rewrite#a1': {
          taskKey: 'g03:rewrite#a1',
          taskId: 'rewrite',
          attempt: 1,
          status: 'RUNNING',
        },
        'g04:publish#a1': {
          taskKey: 'g04:publish#a1',
          taskId: 'publish',
          attempt: 1,
          status: 'PENDING',
        },
      },
    } as any;

    const graph = buildWorkflowGraph(plan as any, state, []);
    const focused = buildFocusedWorkflowGraph(graph, {
      selectedId: graph.nodeByWorkflowId.get('rewrite')?.graphId,
      selectionKey: 'graphId',
      mode: 'selected',
      followId: 'rewrite',
    });

    expect(focused.items.map((item) => item.workflowId)).toEqual(['parallel_review', 'outline', 'rewrite']);
    expect(focused.counts.hidden).toBe(2);
  });

  it('active focus mode limits the topology to the live path instead of rendering the full plan', () => {
    const plan = {
      flow: [
        { type: 'task', id: 'setup' },
        {
          type: 'group',
          id: 'parallel_review',
          steps: [
            { type: 'task', id: 'outline' },
            { type: 'task', id: 'rewrite' },
          ],
        },
        { type: 'task', id: 'publish' },
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
        'g01:setup#a1': {
          taskKey: 'g01:setup#a1',
          taskId: 'setup',
          attempt: 1,
          status: 'DONE',
        },
        'g02:outline#a1': {
          taskKey: 'g02:outline#a1',
          taskId: 'outline',
          attempt: 1,
          status: 'DONE',
        },
        'g03:rewrite#a1': {
          taskKey: 'g03:rewrite#a1',
          taskId: 'rewrite',
          attempt: 1,
          status: 'RUNNING',
        },
        'g04:publish#a1': {
          taskKey: 'g04:publish#a1',
          taskId: 'publish',
          attempt: 1,
          status: 'PENDING',
        },
      },
    } as any;

    const graph = buildWorkflowGraph(plan as any, state, []);
    const focused = buildFocusedWorkflowGraph(graph, {
      selectedId: graph.nodeByWorkflowId.get('rewrite')?.graphId,
      selectionKey: 'graphId',
      mode: 'active',
      followId: 'rewrite',
    });

    expect(focused.items.map((item) => item.workflowId)).toEqual(['parallel_review', 'outline', 'rewrite']);
    expect(focused.counts.hidden).toBe(2);
    expect(focused.emphasis.get(graph.nodeByWorkflowId.get('rewrite')?.graphId || '')).toBe('primary');
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

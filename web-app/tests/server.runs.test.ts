import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createServer } from '../server/index.ts';
import { createSampleAgentflowFixture } from './helpers/sample_agentflow.ts';

let app: any;
const cleanupDirs: string[] = [];

describe('runs router', () => {
  beforeAll(async () => { app = await createServer(); });
  afterEach(() => {
    delete process.env.AGENTFLOW_WEB_ALLOWED_ROOTS;
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  afterAll(async () => { await app?.close?.(); });
  it('errors when starting with non-absolute plan', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/runs/start', payload: { planPath: 'foo.json' } });
    expect(res.statusCode).toBe(400);
  });

  it('state includes trace tail when run is opened', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-web-test-'));
    cleanupDirs.push(dir);
    const runDir = path.join(dir, 'run');
    fs.mkdirSync(runDir);
    fs.writeFileSync(path.join(runDir, 'run_state.json'), JSON.stringify({ runId: 'r1', configPath: '/abs/plan.json', workflowLength: 0, totalTaskCount: 0, totalFailureCount: 0, totalLoopIterations: 0, groups: {}, tasks: {} }));
    fs.writeFileSync(path.join(runDir, 'decision_trace.json'), JSON.stringify([{ atUtc: 'x', type: 'while_gate_evaluation', nodePath: 'workflow[0]/while:x', detail: { iteration: 1 } }]));
    const resOpen = await app.inject({ method: 'POST', url: '/api/runs/open', payload: { runDir } });
    expect(resOpen.statusCode).toBe(200);
    const { runId } = resOpen.json();
    const res = await app.inject({ method: 'GET', url: `/api/runs/${encodeURIComponent(runId)}/state` });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(Array.isArray(json.decisionTrace)).toBe(true);
    expect(json.runDir).toBe(runDir);
    expect(Array.isArray(json.recentConsole)).toBe(true);
  });

  it('marks opened external runs active when persisted state is still running', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-web-active-run-'));
    cleanupDirs.push(dir);
    const runDir = path.join(dir, 'run');
    fs.mkdirSync(runDir);
    fs.writeFileSync(
      path.join(runDir, 'run_state.json'),
      JSON.stringify({
        runId: 'r-active',
        configPath: '/abs/plan.json',
        workflowLength: 1,
        totalTaskCount: 1,
        totalFailureCount: 0,
        totalLoopIterations: 0,
        groups: {},
        tasks: {
          'g0:task#a1': {
            taskKey: 'g0:task#a1',
            taskId: 'task',
            attempt: 1,
            status: 'RUNNING',
            nodePath: 'flow[0]',
          },
        },
      }),
    );

    const resOpen = await app.inject({ method: 'POST', url: '/api/runs/open', payload: { runDir } });
    expect(resOpen.statusCode).toBe(200);
    const { runId } = resOpen.json();
    const res = await app.inject({ method: 'GET', url: `/api/runs/${encodeURIComponent(runId)}/state` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      isActive: true,
      canCancel: false,
      canResume: false,
    });
  });

  it('reclassifies stale persisted isActive flags as historical when terminal rows are already recorded', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-web-stale-active-'));
    cleanupDirs.push(dir);
    const runDir = path.join(dir, 'run');
    fs.mkdirSync(runDir);
    fs.writeFileSync(
      path.join(runDir, 'run_state.json'),
      JSON.stringify({
        runId: 'r-stale-active',
        configPath: '/abs/plan.json',
        isActive: true,
        workflowLength: 1,
        totalTaskCount: 1,
        totalFailureCount: 1,
        totalLoopIterations: 0,
        runFailureReasons: ['retry_required'],
        groups: {},
        tasks: {
          'g0:task#a1': {
            taskKey: 'g0:task#a1',
            taskId: 'task',
            attempt: 1,
            status: 'FAILED',
            failureReason: 'retry_required',
            nodePath: 'flow[0]',
          },
        },
      }),
    );

    const openRes = await app.inject({ method: 'POST', url: '/api/runs/open', payload: { runDir } });
    expect(openRes.statusCode).toBe(200);

    const stateRes = await app.inject({ method: 'GET', url: '/api/runs/r-stale-active/state' });
    expect(stateRes.statusCode).toBe(200);
    expect(stateRes.json()).toMatchObject({
      isActive: false,
      canCancel: false,
      canResume: true,
    });
  });

  it('treats loop-gate snapshots with a pending failed evaluation as active even without running task rows', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-web-active-loop-gate-'));
    cleanupDirs.push(dir);
    const runDir = path.join(dir, 'run');
    fs.mkdirSync(runDir);
    fs.writeFileSync(
      path.join(runDir, 'run_state.json'),
      JSON.stringify({
        runId: 'r-active-loop-gate',
        configPath: '/abs/plan.json',
        isActive: false,
        workflowLength: 1,
        totalTaskCount: 1,
        totalFailureCount: 0,
        totalLoopIterations: 1,
        groups: {},
        tasks: {
          'g0:rewrite_brief#a1': {
            taskKey: 'g0:rewrite_brief#a1',
            taskId: 'rewrite_brief',
            attempt: 1,
            status: 'DONE',
            nodePath: 'workflow[0]/while:quality_gate/body[0]',
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(runDir, 'decision_trace.json'),
      JSON.stringify([
        {
          atUtc: '2026-04-01T11:00:29Z',
          type: 'while_iteration_started',
          nodePath: 'workflow[0]/while:quality_gate',
          detail: { whileId: 'quality_gate', iteration: 1 },
        },
        {
          atUtc: '2026-04-01T11:01:08Z',
          type: 'while_gate_evaluation',
          nodePath: 'workflow[0]/while:quality_gate',
          detail: {
            whileId: 'quality_gate',
            iteration: 1,
            phase: 'post_body',
            passed: false,
            score: null,
            reasons: ['ai gate error: Error: spawnSync codex ETIMEDOUT'],
          },
        },
      ]),
      'utf8',
    );

    const openRes = await app.inject({ method: 'POST', url: '/api/runs/open', payload: { runDir } });
    expect(openRes.statusCode).toBe(200);

    const stateRes = await app.inject({ method: 'GET', url: '/api/runs/r-active-loop-gate/state' });
    expect(stateRes.statusCode).toBe(200);
    expect(stateRes.json()).toMatchObject({
      isActive: true,
      canCancel: false,
      canResume: false,
    });

    const resumeRes = await app.inject({ method: 'POST', url: '/api/runs/r-active-loop-gate/resume' });
    expect(resumeRes.statusCode).toBe(409);
    expect(resumeRes.json()).toEqual({ error: 'run_already_active' });
  });

  it('treats loop-gate snapshots with a passed evaluation as active until a terminal trace marker lands', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-web-active-loop-gate-pass-'));
    cleanupDirs.push(dir);
    const runDir = path.join(dir, 'run');
    fs.mkdirSync(runDir);
    fs.writeFileSync(
      path.join(runDir, 'run_state.json'),
      JSON.stringify({
        runId: 'r-active-loop-gate-pass',
        configPath: '/abs/plan.json',
        isActive: false,
        workflowLength: 1,
        totalTaskCount: 0,
        totalFailureCount: 0,
        totalLoopIterations: 1,
        groups: {},
        tasks: {},
      }),
    );
    fs.writeFileSync(
      path.join(runDir, 'decision_trace.json'),
      JSON.stringify([
        {
          atUtc: '2026-04-01T11:00:29Z',
          type: 'while_iteration_started',
          nodePath: 'workflow[0]/while:quality_gate',
          detail: { whileId: 'quality_gate', iteration: 1 },
        },
        {
          atUtc: '2026-04-01T11:00:31Z',
          type: 'while_gate_evaluation',
          nodePath: 'workflow[0]/while:quality_gate',
          detail: {
            whileId: 'quality_gate',
            iteration: 1,
            phase: 'pre_body',
            passed: true,
            score: 9.4,
            reasons: ['threshold satisfied'],
          },
        },
      ]),
      'utf8',
    );

    const openRes = await app.inject({ method: 'POST', url: '/api/runs/open', payload: { runDir } });
    expect(openRes.statusCode).toBe(200);

    const stateRes = await app.inject({ method: 'GET', url: '/api/runs/r-active-loop-gate-pass/state' });
    expect(stateRes.statusCode).toBe(200);
    expect(stateRes.json()).toMatchObject({
      isActive: true,
      canCancel: false,
      canResume: false,
    });

    const resumeRes = await app.inject({ method: 'POST', url: '/api/runs/r-active-loop-gate-pass/resume' });
    expect(resumeRes.statusCode).toBe(409);
    expect(resumeRes.json()).toEqual({ error: 'run_already_active' });
  });

  it('treats stopped incomplete runs as historical snapshots instead of active handles', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-web-stopped-run-'));
    cleanupDirs.push(dir);
    const runDir = path.join(dir, 'run');
    fs.mkdirSync(runDir);
    fs.writeFileSync(
      path.join(runDir, 'run_state.json'),
      JSON.stringify({
        runId: 'r-stopped',
        configPath: '/abs/plan.json',
        workflowLength: 2,
        totalTaskCount: 2,
        totalFailureCount: 0,
        totalLoopIterations: 0,
        groups: {},
        tasks: {
          'g0:done#a1': {
            taskKey: 'g0:done#a1',
            taskId: 'done',
            attempt: 1,
            status: 'DONE',
            nodePath: 'flow[0]',
          },
          'g0:pending#a1': {
            taskKey: 'g0:pending#a1',
            taskId: 'pending',
            attempt: 1,
            status: 'PENDING',
            nodePath: 'flow[1]',
          },
        },
      }),
    );

    const openRes = await app.inject({ method: 'POST', url: '/api/runs/open', payload: { runDir } });
    expect(openRes.statusCode).toBe(200);

    const stateRes = await app.inject({ method: 'GET', url: '/api/runs/r-stopped/state' });
    expect(stateRes.statusCode).toBe(200);
    expect(stateRes.json()).toMatchObject({
      isActive: false,
      cancelRequested: false,
      canCancel: false,
      canResume: true,
    });
  });

  it('serves cached state, logs, and artifacts while run_state.json is mid-rewrite', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-web-cached-state-'));
    cleanupDirs.push(dir);
    process.env.AGENTFLOW_WEB_ALLOWED_ROOTS = dir;

    const runDir = path.join(dir, 'run');
    const taskDir = path.join(runDir, 'group_01', 'task_resume-probe-a1');
    fs.mkdirSync(taskDir, { recursive: true });

    const logPath = path.join(taskDir, 'command_exec.log');
    const lastMessagePath = path.join(taskDir, 'worker_last_message.md');
    const summaryPath = path.join(taskDir, 'worker_summary.md');
    fs.writeFileSync(logPath, 'resume_probe finished\n', 'utf8');
    fs.writeFileSync(lastMessagePath, 'resumed_ok\n', 'utf8');
    fs.writeFileSync(summaryPath, 'probe summary\n', 'utf8');

    fs.writeFileSync(
      path.join(runDir, 'run_state.json'),
      JSON.stringify({
        runId: 'r-cached-state',
        configPath: '/abs/plan.json',
        workflowLength: 1,
        totalTaskCount: 1,
        totalFailureCount: 0,
        totalLoopIterations: 0,
        groups: {},
        tasks: {
          'g01:resume_probe#a1': {
            taskKey: 'g01:resume_probe#a1',
            taskId: 'resume_probe',
            attempt: 1,
            status: 'DONE',
            nodePath: 'flow[0]',
            logPath,
            lastMessagePath,
            summaryPath,
          },
        },
      }),
      'utf8',
    );

    const openRes = await app.inject({ method: 'POST', url: '/api/runs/open', payload: { runDir } });
    expect(openRes.statusCode).toBe(200);

    fs.writeFileSync(path.join(runDir, 'run_state.json'), '{"runId":"r-cached-state"', 'utf8');

    const stateRes = await app.inject({ method: 'GET', url: '/api/runs/r-cached-state/state' });
    expect(stateRes.statusCode).toBe(200);
    expect(stateRes.json()).toMatchObject({
      runDir,
      planPath: '/abs/plan.json',
      isActive: false,
    });

    const artifactsRes = await app.inject({
      method: 'GET',
      url: '/api/runs/r-cached-state/artifacts/g01%3Aresume_probe%23a1',
    });
    expect(artifactsRes.statusCode).toBe(200);
    expect(artifactsRes.json().items.some((item: { label: string }) => item.label === 'Execution Log')).toBe(true);

    const logsRes = await app.inject({
      method: 'GET',
      url: '/api/runs/r-cached-state/logs/g01%3Aresume_probe%23a1',
    });
    expect(logsRes.statusCode).toBe(200);
    expect(logsRes.body).toContain('resume_probe finished');
  });

  it('serves cached decision traces while decision_trace.json is mid-rewrite', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-web-cached-trace-'));
    cleanupDirs.push(dir);
    process.env.AGENTFLOW_WEB_ALLOWED_ROOTS = dir;

    const runDir = path.join(dir, 'run');
    fs.mkdirSync(runDir, { recursive: true });
    const trace = [
      { atUtc: '1', type: 'while_gate_evaluation', detail: { iteration: 1, score: 0.4 } },
      { atUtc: '2', type: 'while_gate_evaluation', detail: { iteration: 2, score: 0.8 } },
    ];

    fs.writeFileSync(
      path.join(runDir, 'run_state.json'),
      JSON.stringify({
        runId: 'r-cached-trace',
        configPath: '/abs/plan.json',
        workflowLength: 1,
        totalTaskCount: 0,
        totalFailureCount: 0,
        totalLoopIterations: 2,
        groups: {},
        tasks: {},
      }),
      'utf8',
    );
    fs.writeFileSync(path.join(runDir, 'decision_trace.json'), JSON.stringify(trace), 'utf8');

    const openRes = await app.inject({ method: 'POST', url: '/api/runs/open', payload: { runDir } });
    expect(openRes.statusCode).toBe(200);

    fs.writeFileSync(path.join(runDir, 'decision_trace.json'), '[{"atUtc":"1"', 'utf8');

    const traceRes = await app.inject({ method: 'GET', url: '/api/runs/r-cached-trace/trace' });
    expect(traceRes.statusCode).toBe(200);
    expect(traceRes.json()).toEqual(trace);

    const stateRes = await app.inject({ method: 'GET', url: '/api/runs/r-cached-trace/state' });
    expect(stateRes.statusCode).toBe(200);
    expect(stateRes.json()).toMatchObject({
      decisionTrace: trace,
      isActive: false,
      canCancel: false,
      canResume: false,
    });
  });

  it('rejects resume requests for externally active runs even when the bridge does not own the process', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-web-external-active-run-'));
    cleanupDirs.push(dir);
    const runDir = path.join(dir, 'run');
    fs.mkdirSync(runDir);
    fs.writeFileSync(
      path.join(runDir, 'run_state.json'),
      JSON.stringify({
        runId: 'r-external-active',
        configPath: '/abs/plan.json',
        workflowLength: 1,
        totalTaskCount: 1,
        totalFailureCount: 0,
        totalLoopIterations: 0,
        groups: {},
        tasks: {
          'g0:task#a1': {
            taskKey: 'g0:task#a1',
            taskId: 'task',
            attempt: 1,
            status: 'RUNNING',
            nodePath: 'flow[0]',
          },
        },
      }),
    );

    const openRes = await app.inject({ method: 'POST', url: '/api/runs/open', payload: { runDir } });
    expect(openRes.statusCode).toBe(200);

    const byIdRes = await app.inject({ method: 'POST', url: '/api/runs/r-external-active/resume' });
    expect(byIdRes.statusCode).toBe(409);
    expect(byIdRes.json()).toEqual({ error: 'run_already_active' });

    const byDirRes = await app.inject({
      method: 'POST',
      url: '/api/runs/resume',
      payload: { runDir },
    });
    expect(byDirRes.statusCode).toBe(409);
    expect(byDirRes.json()).toEqual({ error: 'run_already_active' });

    const cancelRes = await app.inject({
      method: 'POST',
      url: '/api/runs/cancel',
      payload: { runId: 'r-external-active' },
    });
    expect(cancelRes.statusCode).toBe(409);
    expect(cancelRes.json()).toEqual({ error: 'run_not_controllable' });
  });

  it('rejects resume requests for historical runs that already completed successfully', async () => {
    const fixture = createSampleAgentflowFixture();
    cleanupDirs.push(fixture.workspaceRoot);
    process.env.AGENTFLOW_WEB_ALLOWED_ROOTS = fixture.workspaceRoot;

    const byIdRes = await app.inject({
      method: 'POST',
      url: `/api/runs/${encodeURIComponent(fixture.runId)}/resume`,
    });
    expect(byIdRes.statusCode).toBe(409);
    expect(byIdRes.json()).toEqual({ error: 'run_not_resumable' });

    const byDirRes = await app.inject({
      method: 'POST',
      url: '/api/runs/resume',
      payload: { runDir: fixture.runDir },
    });
    expect(byDirRes.statusCode).toBe(409);
    expect(byDirRes.json()).toEqual({ error: 'run_not_resumable' });
  });

  it('resolves historical runs by runId without requiring an explicit open call first', async () => {
    const fixture = createSampleAgentflowFixture();
    cleanupDirs.push(fixture.workspaceRoot);
    process.env.AGENTFLOW_WEB_ALLOWED_ROOTS = fixture.workspaceRoot;

    const resolveRes = await app.inject({
      method: 'GET',
      url: `/api/runs/${encodeURIComponent(fixture.runId)}/resolve`,
    });
    expect(resolveRes.statusCode).toBe(200);
    expect(resolveRes.json()).toMatchObject({
      runId: fixture.runId,
      runDir: fixture.runDir,
      planPath: fixture.planPath,
      isActive: false,
    });

    const stateRes = await app.inject({
      method: 'GET',
      url: `/api/runs/${encodeURIComponent(fixture.runId)}/state`,
    });
    expect(stateRes.statusCode).toBe(200);
    expect(stateRes.json()).toMatchObject({
      runDir: fixture.runDir,
      planPath: fixture.planPath,
      isActive: false,
      cancelRequested: false,
      canCancel: false,
      canResume: false,
    });

    const traceRes = await app.inject({
      method: 'GET',
      url: `/api/runs/${encodeURIComponent(fixture.runId)}/trace`,
    });
    expect(traceRes.statusCode).toBe(200);
    expect(traceRes.json()).toHaveLength(fixture.trace.length);

    const artifactsRes = await app.inject({
      method: 'GET',
      url: `/api/runs/${encodeURIComponent(fixture.runId)}/artifacts/${encodeURIComponent(fixture.taskKeys.echoStatus)}`,
    });
    expect(artifactsRes.statusCode).toBe(200);
    expect(artifactsRes.json().items.some((item: { label: string }) => item.label === 'Command Result')).toBe(true);

    const logsRes = await app.inject({
      method: 'GET',
      url: `/api/runs/${encodeURIComponent(fixture.runId)}/logs/${encodeURIComponent(fixture.taskKeys.echoStatus)}`,
    });
    expect(logsRes.statusCode).toBe(200);
    expect(logsRes.body).toContain('pipeline_ready');
  });

  it('resolves historical runs nested inside a workspace under an allowed root', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-web-nested-run-root-'));
    cleanupDirs.push(rootDir);
    const nestedWorkspace = path.join(rootDir, '.tmp', 'playwright-monitor-success');
    const fixture = createSampleAgentflowFixture({ rootDir: nestedWorkspace });
    process.env.AGENTFLOW_WEB_ALLOWED_ROOTS = rootDir;

    const resolveRes = await app.inject({
      method: 'GET',
      url: `/api/runs/${encodeURIComponent(fixture.runId)}/resolve`,
    });
    expect(resolveRes.statusCode).toBe(200);
    expect(resolveRes.json()).toMatchObject({
      runId: fixture.runId,
      runDir: fixture.runDir,
      planPath: fixture.planPath,
      isActive: false,
    });

    const stateRes = await app.inject({
      method: 'GET',
      url: `/api/runs/${encodeURIComponent(fixture.runId)}/state`,
    });
    expect(stateRes.statusCode).toBe(200);
    expect(stateRes.json()).toMatchObject({
      runDir: fixture.runDir,
      planPath: fixture.planPath,
      isActive: false,
    });
  });

  it('drops stale cached handles when the persisted historical run disappears', async () => {
    const fixture = createSampleAgentflowFixture();
    cleanupDirs.push(fixture.workspaceRoot);
    process.env.AGENTFLOW_WEB_ALLOWED_ROOTS = fixture.workspaceRoot;

    const firstResolve = await app.inject({
      method: 'GET',
      url: `/api/runs/${encodeURIComponent(fixture.runId)}/resolve`,
    });
    expect(firstResolve.statusCode).toBe(200);

    fs.rmSync(path.join(fixture.runDir, 'run_state.json'));

    const secondResolve = await app.inject({
      method: 'GET',
      url: `/api/runs/${encodeURIComponent(fixture.runId)}/resolve`,
    });
    expect(secondResolve.statusCode).toBe(404);
    expect(secondResolve.json()).toEqual({ error: 'run_not_found', runId: fixture.runId });
  });

  it('rejects ambiguous historical deep links instead of opening the first matching run directory', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-web-ambiguous-run-root-'));
    cleanupDirs.push(rootDir);
    process.env.AGENTFLOW_WEB_ALLOWED_ROOTS = rootDir;

    const fixtureA = createSampleAgentflowFixture({
      rootDir: path.join(rootDir, 'workspace-a', 'playwright-monitor-success'),
    });
    const fixtureB = createSampleAgentflowFixture({
      rootDir: path.join(rootDir, 'workspace-b', 'playwright-monitor-success'),
    });

    const resolveRes = await app.inject({
      method: 'GET',
      url: `/api/runs/${encodeURIComponent(fixtureA.runId)}/resolve`,
    });
    expect(resolveRes.statusCode).toBe(409);
    expect(resolveRes.json()).toMatchObject({
      error: 'run_id_ambiguous',
      runId: fixtureA.runId,
      matches: [
        { runDir: fixtureA.runDir, planPath: fixtureA.planPath },
        { runDir: fixtureB.runDir, planPath: fixtureB.planPath },
      ],
    });

    const stateRes = await app.inject({
      method: 'GET',
      url: `/api/runs/${encodeURIComponent(fixtureA.runId)}/state`,
    });
    expect(stateRes.statusCode).toBe(409);
    expect(stateRes.json()).toMatchObject({
      error: 'run_id_ambiguous',
      runId: fixtureA.runId,
    });
  });

  it('refreshes existing handles from disk when a run transitions from active to historical', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-web-refresh-run-'));
    cleanupDirs.push(dir);
    process.env.AGENTFLOW_WEB_ALLOWED_ROOTS = dir;

    const runDir = path.join(dir, 'run');
    fs.mkdirSync(runDir);
    const statePath = path.join(runDir, 'run_state.json');
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        runId: 'r-refresh',
        configPath: '/abs/plan.json',
        workflowLength: 1,
        totalTaskCount: 1,
        totalFailureCount: 0,
        totalLoopIterations: 0,
        cancelRequested: false,
        groups: {},
        tasks: {
          'g0:task#a1': {
            taskKey: 'g0:task#a1',
            taskId: 'task',
            attempt: 1,
            status: 'RUNNING',
            nodePath: 'flow[0]',
          },
        },
      }),
    );

    const firstOpen = await app.inject({ method: 'POST', url: '/api/runs/open', payload: { runDir } });
    expect(firstOpen.statusCode).toBe(200);

    const firstState = await app.inject({ method: 'GET', url: '/api/runs/r-refresh/state' });
    expect(firstState.statusCode).toBe(200);
    expect(firstState.json().isActive).toBe(true);

    fs.writeFileSync(
      statePath,
      JSON.stringify({
        runId: 'r-refresh',
        configPath: '/abs/plan.json',
        workflowLength: 1,
        totalTaskCount: 1,
        totalFailureCount: 0,
        totalLoopIterations: 0,
        cancelRequested: true,
        groups: {},
        tasks: {
          'g0:task#a1': {
            taskKey: 'g0:task#a1',
            taskId: 'task',
            attempt: 1,
            status: 'DONE',
            nodePath: 'flow[0]',
          },
        },
      }),
    );

    const reopen = await app.inject({ method: 'POST', url: '/api/runs/open', payload: { runDir } });
    expect(reopen.statusCode).toBe(200);

    const nextState = await app.inject({ method: 'GET', url: '/api/runs/r-refresh/state' });
    expect(nextState.statusCode).toBe(200);
    expect(nextState.json()).toMatchObject({
      isActive: false,
      cancelRequested: true,
      canCancel: false,
      canResume: false,
    });
  });

  it('rejects cancellation for runs that are no longer active', async () => {
    const fixture = createSampleAgentflowFixture();
    cleanupDirs.push(fixture.workspaceRoot);
    process.env.AGENTFLOW_WEB_ALLOWED_ROOTS = fixture.workspaceRoot;

    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/cancel',
      payload: { runId: fixture.runId },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'run_not_active' });
  });

  it('discovers command-result artifacts even when the task row only exposes a log path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-web-log-only-artifacts-'));
    cleanupDirs.push(dir);
    process.env.AGENTFLOW_WEB_ALLOWED_ROOTS = dir;

    const runDir = path.join(dir, 'run');
    const taskDir = path.join(runDir, 'group_01', 'task_log_only-a1');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'exec.log'), 'hello\n', 'utf8');
    fs.writeFileSync(path.join(taskDir, 'command_result.json'), JSON.stringify({ ok: true }), 'utf8');
    fs.writeFileSync(path.join(runDir, 'run_state.json'), JSON.stringify({
      runId: 'r-log-only',
      configPath: '/abs/plan.json',
      workflowLength: 1,
      totalTaskCount: 1,
      totalFailureCount: 0,
      totalLoopIterations: 0,
      groups: {},
      tasks: {
        'g01:log_only#a1': {
          taskKey: 'g01:log_only#a1',
          taskId: 'log_only',
          attempt: 1,
          status: 'DONE',
          nodePath: 'flow[0]',
          logPath: path.join(taskDir, 'exec.log'),
        },
      },
    }));

    const openRes = await app.inject({ method: 'POST', url: '/api/runs/open', payload: { runDir } });
    expect(openRes.statusCode).toBe(200);

    const artifactsRes = await app.inject({
      method: 'GET',
      url: '/api/runs/r-log-only/artifacts/g01%3Alog_only%23a1',
    });
    expect(artifactsRes.statusCode).toBe(200);
    expect(artifactsRes.json().items.some((item: { label: string }) => item.label === 'Command Result')).toBe(true);
  });

  it('falls back to last-message output when a stale log path no longer exists', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-web-log-fallback-'));
    cleanupDirs.push(dir);
    process.env.AGENTFLOW_WEB_ALLOWED_ROOTS = dir;

    const runDir = path.join(dir, 'run');
    const taskDir = path.join(runDir, 'group_01', 'task_message_fallback-a1');
    fs.mkdirSync(taskDir, { recursive: true });
    const missingLogPath = path.join(taskDir, 'missing.log');
    const lastMessagePath = path.join(taskDir, 'worker_last_message.md');
    fs.writeFileSync(lastMessagePath, 'final task message\n', 'utf8');
    fs.writeFileSync(path.join(runDir, 'run_state.json'), JSON.stringify({
      runId: 'r-log-fallback',
      configPath: '/abs/plan.json',
      workflowLength: 1,
      totalTaskCount: 1,
      totalFailureCount: 0,
      totalLoopIterations: 0,
      groups: {},
      tasks: {
        'g01:message_fallback#a1': {
          taskKey: 'g01:message_fallback#a1',
          taskId: 'message_fallback',
          attempt: 1,
          status: 'DONE',
          nodePath: 'flow[0]',
          logPath: missingLogPath,
          lastMessagePath,
        },
      },
    }));

    const openRes = await app.inject({ method: 'POST', url: '/api/runs/open', payload: { runDir } });
    expect(openRes.statusCode).toBe(200);

    const logsRes = await app.inject({
      method: 'GET',
      url: '/api/runs/r-log-fallback/logs/g01%3Amessage_fallback%23a1',
    });
    expect(logsRes.statusCode).toBe(200);
    expect(logsRes.body).toContain('final task message');
  });
});

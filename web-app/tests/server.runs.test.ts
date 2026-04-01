import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../server/index.ts';

let app: any;
describe('runs router', () => {
  beforeAll(async () => { app = await createServer(); });
  afterAll(async () => { await app?.close?.(); });
  it('errors when starting with non-absolute plan', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/runs/start', payload: { planPath: 'foo.json' } });
    expect(res.statusCode).toBe(400);
  });

  it('state includes trace tail when run is opened', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-web-test-'));
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
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-web-active-run-'));
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
    expect(res.json().isActive).toBe(true);
  });
});

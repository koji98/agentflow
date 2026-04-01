import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../server/index.ts';

let app: any;
describe('plan inspector', () => {
  beforeAll(async () => { app = await createServer(); });
  afterAll(async () => { await app?.close?.(); });

  it('requires absolute path', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/plan/inspect' });
    expect(res.statusCode).toBe(400);
  });

  it('summarizes normalized tasks, groups, and loop_judge workflows', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'af-web-plan-'));
    const planDir = path.join(repoRoot, '.tmp');
    fs.mkdirSync(planDir);
    const planPath = path.join(planDir, 'demo-plan.json');
    fs.writeFileSync(
      planPath,
      JSON.stringify({
        setup: 'demo',
        repos: { main: repoRoot },
        options: { run_root: 'agentflow_runs' },
        flow: [
          { type: 'task', id: 'prepare', prompt: 'Prepare the work.' },
          {
            type: 'group',
            id: 'parallel_group',
            parallel: true,
            steps: [
              { type: 'task', id: 'nested', prompt: 'Nested task.' },
            ],
          },
          { type: 'command', id: 'lint', command: 'npm', args: ['run', 'lint'] },
          {
            type: 'loop_judge',
            id: 'quality_gate',
            pass_threshold: 8,
            rubric: {
              criteria: [{ id: 'correctness', label: 'Correctness', weight: 1 }],
            },
            body: [
              { type: 'task', id: 'improve', prompt: 'Improve based on feedback.' },
            ],
          },
        ],
      }),
      'utf8',
    );

    const res = await app.inject({
      method: 'GET',
      url: `/api/plan/inspect?path=${encodeURIComponent(planPath)}`,
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.valid).toBe(true);
    expect(json.plan.flow[3].type).toBe('loop_judge');
    expect(json.workflow.totalNodes).toBe(6);
    expect(json.workflow.executableCount).toBe(4);
    expect(json.workflow.tasks).toEqual(['prepare', 'nested', 'improve']);
    expect(json.workflow.commands).toEqual(['lint']);
    expect(json.workflow.groups).toEqual(['parallel_group']);
    expect(json.workflow.loops).toEqual([
      { id: 'quality_gate', type: 'while', passThreshold: 8 },
    ]);
    expect(json.runRootCandidates).toContain(path.join(repoRoot, '.tmp', 'agentflow_runs'));
    expect(json.runRootCandidates).not.toContain(path.join(repoRoot, '.tmp', 'tmp', 'agentflow_runs'));
  });
});

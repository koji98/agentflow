import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createServer } from '../server/index.ts';

let app: any;
const cleanupDirs: string[] = [];

async function waitForRunCompletion(runId: string, attempts = 80): Promise<any> {
  for (let index = 0; index < attempts; index += 1) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/runs/${encodeURIComponent(runId)}/state`,
    });
    expect(res.statusCode).toBe(200);
    const state = res.json();
    if (!state.isActive) return state;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`run ${runId} did not finish within the timeout window`);
}

describe('live command-only run integration', () => {
  beforeAll(async () => {
    app = await createServer();
  });

  afterEach(() => {
    delete process.env.AGENTFLOW_WEB_ALLOWED_ROOTS;
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await app?.close?.();
  });

  it('starts a real command-only run and exposes its outputs through the web backend', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'af-web-live-run-'));
    cleanupDirs.push(workspaceRoot);
    process.env.AGENTFLOW_WEB_ALLOWED_ROOTS = workspaceRoot;

    const planPath = path.join(workspaceRoot, 'live_command_plan.json');
    fs.writeFileSync(
      planPath,
      JSON.stringify(
        {
          repos: { main: '.' },
          on_failure: 'stop',
          options: { run_root: 'tmp/web_live_runs' },
          flow: [
            {
              type: 'group',
              id: 'parallel_announcements',
              parallel: true,
              steps: [
                { type: 'command', id: 'say_alpha', command: '/bin/sh', args: ['-c', 'printf alpha_ready'] },
                { type: 'command', id: 'say_beta', command: '/bin/sh', args: ['-c', 'printf beta_ready'] },
              ],
            },
            { type: 'command', id: 'say_gamma', command: '/bin/sh', args: ['-c', 'printf gamma_ready'] },
          ],
        },
        null,
        2,
      ),
      'utf8',
    );

    const startRes = await app.inject({
      method: 'POST',
      url: '/api/runs/start',
      payload: {
        planPath,
        settings: {
          skipGitRepoCheck: true,
          sandbox: 'workspace-write',
        },
      },
    });
    expect(startRes.statusCode).toBe(200);

    const { runId } = startRes.json();
    const state = await waitForRunCompletion(runId);

    expect(state.isActive).toBe(false);
    expect(state.lastExitCode).toBe(0);
    expect(state.planPath).toBe(planPath);

    const taskRows = Object.values(state.tasks as Record<string, Record<string, unknown>>);
    expect(taskRows).toHaveLength(3);
    expect(taskRows.every((row) => row.status === 'DONE')).toBe(true);

    const gammaRow = taskRows.find((row) => row.taskId === 'say_gamma');
    if (!gammaRow) {
      throw new Error('expected say_gamma row to exist');
    }

    const logsRes = await app.inject({
      method: 'GET',
      url: `/api/runs/${encodeURIComponent(runId)}/logs/${encodeURIComponent(String(gammaRow.taskKey))}`,
    });
    expect(logsRes.statusCode).toBe(200);
    expect(logsRes.body).toContain('gamma_ready');

    const artifactsRes = await app.inject({
      method: 'GET',
      url: `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(String(gammaRow.taskKey))}`,
    });
    expect(artifactsRes.statusCode).toBe(200);
    const artifacts = artifactsRes.json().items as Array<{ label: string }>;
    expect(artifacts.some((item) => item.label === 'Command Result')).toBe(true);

    const traceRes = await app.inject({
      method: 'GET',
      url: `/api/runs/${encodeURIComponent(runId)}/trace`,
    });
    expect(traceRes.statusCode).toBe(200);
    expect(Array.isArray(traceRes.json())).toBe(true);
  }, 20000);
});

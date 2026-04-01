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

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
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

  it('resumes a failed command-only run by rerunning only the blocking command', async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'af-web-live-resume-'));
    cleanupDirs.push(workspaceRoot);
    process.env.AGENTFLOW_WEB_ALLOWED_ROOTS = workspaceRoot;

    const markerPath = path.join(workspaceRoot, 'resume-ok.flag');
    const seedCallsPath = path.join(workspaceRoot, 'seed_calls.log');
    const probeCallsPath = path.join(workspaceRoot, 'probe_calls.log');
    const publishCallsPath = path.join(workspaceRoot, 'publish_calls.log');
    const planPath = path.join(workspaceRoot, 'live_command_resume_plan.json');

    fs.writeFileSync(
      planPath,
      JSON.stringify(
        {
          repos: { main: '.' },
          on_failure: 'stop',
          options: { run_root: 'tmp/web_live_resume_runs' },
          flow: [
            {
              type: 'command',
              id: 'seed_workspace',
              command: '/bin/sh',
              args: ['-c', `printf 'seed\\n' >> ${shQuote(seedCallsPath)}`],
            },
            {
              type: 'command',
              id: 'resume_probe',
              command: '/bin/sh',
              args: [
                '-c',
                `printf 'probe\\n' >> ${shQuote(probeCallsPath)}; if [ -f ${shQuote(markerPath)} ]; then printf resumed_ok; else printf retry_required >&2; exit 17; fi`,
              ],
            },
            {
              type: 'command',
              id: 'publish_status',
              command: '/bin/sh',
              args: ['-c', `printf 'publish\\n' >> ${shQuote(publishCallsPath)}`],
            },
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
    const failedState = await waitForRunCompletion(runId);

    expect(failedState.isActive).toBe(false);
    expect(failedState.lastExitCode).not.toBe(0);

    const failedRows = Object.values(failedState.tasks as Record<string, Record<string, unknown>>);
    expect(failedRows.some((row) => row.taskId === 'seed_workspace' && row.status === 'DONE')).toBe(true);
    expect(failedRows.some((row) => row.taskId === 'resume_probe' && row.status === 'FAILED')).toBe(true);
    expect(failedRows.some((row) => row.taskId === 'publish_status')).toBe(false);

    expect(readLines(seedCallsPath)).toEqual(['seed']);
    expect(readLines(probeCallsPath)).toEqual(['probe']);
    expect(readLines(publishCallsPath)).toEqual([]);

    const statePath = path.join(String(failedState.runDir), 'run_state.json');
    const originalFailedStateText = fs.readFileSync(statePath, 'utf8');
    const staleActiveState = JSON.parse(originalFailedStateText) as {
      isActive?: boolean;
      tasks?: Record<string, { status?: string }>;
    };
    staleActiveState.isActive = true;
    const staleProbeRow = Object.values(staleActiveState.tasks || {}).find(
      (row) => row && row.status === 'FAILED',
    );
    if (staleProbeRow) staleProbeRow.status = 'RUNNING';
    fs.writeFileSync(statePath, JSON.stringify(staleActiveState, null, 2), 'utf8');

    const staleStateRes = await app.inject({
      method: 'GET',
      url: `/api/runs/${encodeURIComponent(runId)}/state`,
    });
    expect(staleStateRes.statusCode).toBe(200);
    expect(staleStateRes.json()).toMatchObject({
      isActive: false,
      canCancel: false,
      canResume: true,
    });

    const staleResolveRes = await app.inject({
      method: 'GET',
      url: `/api/runs/${encodeURIComponent(runId)}/resolve`,
    });
    expect(staleResolveRes.statusCode).toBe(200);
    expect(staleResolveRes.json()).toMatchObject({
      runId,
      isActive: false,
    });

    const staleCancelRes = await app.inject({
      method: 'POST',
      url: '/api/runs/cancel',
      payload: { runId },
    });
    expect(staleCancelRes.statusCode).toBe(409);
    expect(staleCancelRes.json()).toEqual({ error: 'run_not_active' });

    fs.writeFileSync(statePath, originalFailedStateText, 'utf8');

    fs.writeFileSync(markerPath, 'ok\n', 'utf8');

    const resumeRes = await app.inject({
      method: 'POST',
      url: `/api/runs/${encodeURIComponent(runId)}/resume`,
      payload: {
        settings: {
          skipGitRepoCheck: true,
          sandbox: 'workspace-write',
        },
      },
    });
    expect(resumeRes.statusCode).toBe(200);
    expect(resumeRes.json()).toMatchObject({ runId });

    const resumedState = await waitForRunCompletion(runId);

    expect(resumedState.isActive).toBe(false);
    expect(resumedState.lastExitCode).toBe(0);

    const resumedRows = Object.values(resumedState.tasks as Record<string, Record<string, unknown>>);
    expect(resumedRows.some((row) => row.taskId === 'publish_status' && row.status === 'DONE')).toBe(true);

    const successfulProbeRow = resumedRows.find((row) => row.taskId === 'resume_probe' && row.status === 'DONE');
    if (!successfulProbeRow) {
      throw new Error('expected resume_probe success row after resume');
    }

    expect(readLines(seedCallsPath)).toEqual(['seed']);
    expect(readLines(probeCallsPath)).toEqual(['probe', 'probe']);
    expect(readLines(publishCallsPath)).toEqual(['publish']);

    const logsRes = await app.inject({
      method: 'GET',
      url: `/api/runs/${encodeURIComponent(runId)}/logs/${encodeURIComponent(String(successfulProbeRow.taskKey))}`,
    });
    expect(logsRes.statusCode).toBe(200);
    expect(logsRes.body).toContain('resumed_ok');
  }, 30000);
});

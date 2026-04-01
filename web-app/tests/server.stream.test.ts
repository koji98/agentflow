import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createServer } from '../server/index.ts';
import { createSampleAgentflowFixture } from './helpers/sample_agentflow.ts';

let app: any;
const cleanupDirs: string[] = [];

describe('stream routes', () => {
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

  it('rejects event subscriptions for runs that are not open', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/stream/run/missing-run/events',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'run_not_open' });
  });

  it('blocks tail subscriptions when the log path escapes the allowlist', async () => {
    const fixture = createSampleAgentflowFixture();
    cleanupDirs.push(fixture.workspaceRoot);
    process.env.AGENTFLOW_WEB_ALLOWED_ROOTS = fixture.workspaceRoot;

    const outsideLog = path.join(path.dirname(fixture.workspaceRoot), 'outside.log');
    fs.writeFileSync(outsideLog, 'secret log', 'utf8');

    const statePath = path.join(fixture.runDir, 'run_state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as any;
    state.tasks[fixture.taskKeys.echoStatus].logPath = outsideLog;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    const openRes = await app.inject({
      method: 'POST',
      url: '/api/runs/open',
      payload: { runDir: fixture.runDir },
    });
    expect(openRes.statusCode).toBe(200);
    const { runId } = openRes.json();

    const res = await app.inject({
      method: 'GET',
      url: `/api/stream/run/${encodeURIComponent(runId)}/tail?taskKey=${encodeURIComponent(fixture.taskKeys.echoStatus)}`,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'path_not_allowed' });
  });
});

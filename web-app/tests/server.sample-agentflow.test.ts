import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createServer } from '../server/index.ts';
import { createSampleAgentflowFixture, type SampleAgentflowFixture } from './helpers/sample_agentflow.ts';

let app: any;
const cleanupDirs: string[] = [];

function trackFixture(): SampleAgentflowFixture {
  const fixture = createSampleAgentflowFixture();
  cleanupDirs.push(fixture.workspaceRoot);
  return fixture;
}

describe('sample agentflow backend integration', () => {
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

  it('serves a realistic sample plan and run with artifacts, logs, and trace data', async () => {
    const fixture = trackFixture();
    process.env.AGENTFLOW_WEB_ALLOWED_ROOTS = fixture.workspaceRoot;

    const inspectRes = await app.inject({
      method: 'GET',
      url: `/api/plan/inspect?path=${encodeURIComponent(fixture.planPath)}`,
    });
    expect(inspectRes.statusCode).toBe(200);

    const inspect = inspectRes.json();
    expect(inspect.valid).toBe(true);
    expect(inspect.plan.flow[2].type).toBe('loop_judge');
    expect(inspect.workflow).toMatchObject({
      totalNodes: 7,
      executableCount: 5,
      tasks: ['setup_agent', 'joke_agent', 'refine_agent', 'final_agent'],
      commands: ['echo_status'],
      groups: ['parallel_fun'],
      loops: [{ id: 'quality_gate', type: 'while', passThreshold: 8 }],
    });
    expect(inspect.nearbyDocs).toContain(path.join(fixture.workspaceRoot, 'README.md'));
    expect(inspect.runRootCandidates).toContain(path.join(fixture.workspaceRoot, '.tmp', 'agentflow_runs'));

    const openRes = await app.inject({
      method: 'POST',
      url: '/api/runs/open',
      payload: { runDir: fixture.runDir },
    });
    expect(openRes.statusCode).toBe(200);
    const { runId } = openRes.json();

    const stateRes = await app.inject({
      method: 'GET',
      url: `/api/runs/${encodeURIComponent(runId)}/state`,
    });
    expect(stateRes.statusCode).toBe(200);
    const state = stateRes.json();
    expect(state.isActive).toBe(false);
    expect(state.planPath).toBe(fixture.planPath);
    expect(state.decisionTrace).toHaveLength(4);

    const artifactsRes = await app.inject({
      method: 'GET',
      url: `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(fixture.taskKeys.echoStatus)}`,
    });
    expect(artifactsRes.statusCode).toBe(200);
    const artifacts = artifactsRes.json().items;
    const artifactPaths = artifacts.map((item: any) => item.path);
    expect(new Set(artifactPaths).size).toBe(artifactPaths.length);
    expect(artifacts.some((item: any) => item.label === 'Command Result')).toBe(true);

    const logsRes = await app.inject({
      method: 'GET',
      url: `/api/runs/${encodeURIComponent(runId)}/logs/${encodeURIComponent(fixture.taskKeys.echoStatus)}`,
    });
    expect(logsRes.statusCode).toBe(200);
    expect(logsRes.body).toContain('pipeline_ready');
  });
});

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

function trackResumeFixture() {
  const fixture = createSampleAgentflowFixture({ scenario: 'resume_failure' });
  cleanupDirs.push(fixture.workspaceRoot);
  return fixture;
}

function trackLoopJudgeFailureFixture() {
  const fixture = createSampleAgentflowFixture({ scenario: 'loop_judge_failure' });
  cleanupDirs.push(fixture.workspaceRoot);
  return fixture;
}

function trackBuilderFixture() {
  const fixture = createSampleAgentflowFixture({ scenario: 'builder_snapshot' });
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
      totalNodes: 8,
      executableCount: 6,
      tasks: ['setup_agent', 'joke_agent', 'fact_agent', 'refine_agent', 'final_agent'],
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
    expect(state.canCancel).toBe(false);
    expect(state.canResume).toBe(false);
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

  it('serves a deterministic resume-ready failure fixture with command evidence and historical failure state', async () => {
    const fixture = trackResumeFixture();
    process.env.AGENTFLOW_WEB_ALLOWED_ROOTS = fixture.workspaceRoot;

    const inspectRes = await app.inject({
      method: 'GET',
      url: `/api/plan/inspect?path=${encodeURIComponent(fixture.planPath)}`,
    });
    expect(inspectRes.statusCode).toBe(200);

    const inspect = inspectRes.json();
    expect(inspect.valid).toBe(true);
    expect(inspect.workflow).toMatchObject({
      totalNodes: 5,
      executableCount: 4,
      commands: ['prepare_workspace', 'lint_workspace', 'resume_probe', 'publish_status'],
      groups: ['verification_fanout'],
      loops: [],
    });

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
      totalFailureCount: 1,
      totalRunFailureCount: 1,
      planPath: fixture.planPath,
      isActive: false,
      canCancel: false,
      canResume: true,
    });
    expect(stateRes.json().runFailureReasons).toContain('resume_probe exited with code 17 before publish_status could run.');

    const artifactsRes = await app.inject({
      method: 'GET',
      url: `/api/runs/${encodeURIComponent(fixture.runId)}/artifacts/${encodeURIComponent(fixture.taskKeys.resumeProbe)}`,
    });
    expect(artifactsRes.statusCode).toBe(200);
    expect(artifactsRes.json().items.some((item: { label: string }) => item.label === 'Command Result')).toBe(true);

    const logsRes = await app.inject({
      method: 'GET',
      url: `/api/runs/${encodeURIComponent(fixture.runId)}/logs/${encodeURIComponent(fixture.taskKeys.resumeProbe)}`,
    });
    expect(logsRes.statusCode).toBe(200);
    expect(logsRes.body).toContain('retry_required');
  });

  it('serves a deterministic loop_judge failure fixture with a post-body null-score gate result', async () => {
    const fixture = trackLoopJudgeFailureFixture();
    process.env.AGENTFLOW_WEB_ALLOWED_ROOTS = fixture.workspaceRoot;

    const inspectRes = await app.inject({
      method: 'GET',
      url: `/api/plan/inspect?path=${encodeURIComponent(fixture.planPath)}`,
    });
    expect(inspectRes.statusCode).toBe(200);

    const inspect = inspectRes.json();
    expect(inspect.valid).toBe(true);
    expect(inspect.workflow).toMatchObject({
      totalNodes: 5,
      executableCount: 4,
      tasks: ['seed_brief', 'rewrite_brief', 'publish_brief'],
      commands: ['capture_gate_context'],
      groups: [],
      loops: [{ id: 'monitor_quality_gate', type: 'while', passThreshold: 9.2 }],
    });

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
      totalFailureCount: 1,
      totalRunFailureCount: 1,
      planPath: fixture.planPath,
      isActive: false,
      canCancel: false,
      canResume: true,
    });
    expect(stateRes.json().runFailureReasons).toContain(
      'monitor_quality_gate exhausted after a post-body gate error: ai gate error: Error: spawnSync codex ETIMEDOUT',
    );
    expect(
      stateRes.json().decisionTrace.some(
        (entry: { type: string; detail?: { score?: number | null; phase?: string } }) =>
          entry.type === 'while_gate_evaluation'
          && entry.detail?.phase === 'post_body'
          && entry.detail?.score === null,
      ),
    ).toBe(true);

    const logsRes = await app.inject({
      method: 'GET',
      url: `/api/runs/${encodeURIComponent(fixture.runId)}/logs/${encodeURIComponent(fixture.taskKeys.captureGateContext)}`,
    });
    expect(logsRes.statusCode).toBe(200);
    expect(logsRes.body).toContain('gate_context_saved');
  });

  it('serves a builder launch snapshot fixture with explicit source-to-launch lineage and plain persona strings', async () => {
    const fixture = trackBuilderFixture();
    process.env.AGENTFLOW_WEB_ALLOWED_ROOTS = fixture.workspaceRoot;

    const inspectRes = await app.inject({
      method: 'GET',
      url: `/api/plan/inspect?path=${encodeURIComponent(fixture.planPath)}`,
    });
    expect(inspectRes.statusCode).toBe(200);

    const inspect = inspectRes.json();
    expect(inspect.valid).toBe(true);
    expect(inspect.workflow).toMatchObject({
      totalNodes: 5,
      executableCount: 4,
      tasks: ['draft_outline', 'draft_polish', 'publish_summary'],
      commands: ['snapshot_metadata'],
      groups: ['builder_parallel_checks'],
      loops: [],
    });
    expect(fixture.draft?.draftDir).toBeTruthy();
    expect(fixture.draft?.sourcePlanPath).toBeTruthy();
    expect(fixture.draft?.draftPlanPath).toBeTruthy();
    expect(fixture.draft?.launchPlanPath).toBeTruthy();
    expect(fixture.planPath).toContain(`${path.sep}web_builder_drafts${path.sep}`);
    expect(fixture.planPath).toContain(`${path.sep}launches${path.sep}`);
    expect(JSON.stringify(inspect.plan)).not.toContain('persona_ref');
    expect(inspect.plan.flow[0].persona).toContain('graph-first product strategist');
    expect(fs.existsSync(String(fixture.draft?.sourcePlanPath))).toBe(true);
    expect(fs.existsSync(String(fixture.draft?.draftPlanPath))).toBe(true);
    expect(fs.existsSync(String(fixture.draft?.launchPlanPath))).toBe(true);
    const sourcePlan = JSON.parse(fs.readFileSync(String(fixture.draft?.sourcePlanPath), 'utf8'));
    const draftPlan = JSON.parse(fs.readFileSync(String(fixture.draft?.draftPlanPath), 'utf8'));
    const launchPlan = JSON.parse(fs.readFileSync(String(fixture.draft?.launchPlanPath), 'utf8'));
    expect(draftPlan).toEqual(launchPlan);
    expect(draftPlan).not.toEqual(sourcePlan);
    expect(JSON.stringify(sourcePlan)).not.toContain('persona_ref');
    expect(JSON.stringify(draftPlan)).not.toContain('persona_ref');
    expect(JSON.stringify(launchPlan)).not.toContain('persona_ref');
    expect(sourcePlan.flow[0].persona).toBeUndefined();
    expect(sourcePlan.flow[1].steps[1].persona).toBeUndefined();
    expect(draftPlan.flow[1].steps[1].persona).toContain('release copy editor');
    expect(launchPlan.flow[1].steps[1].persona).toContain('release copy editor');
    expect(draftPlan.flow[0].persona).toContain('graph-first product strategist');
    expect(inspect.runRootCandidates).toContain(path.join(fixture.workspaceRoot, '.tmp', 'agentflow_runs'));

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
      planPath: fixture.planPath,
      isActive: false,
      canCancel: false,
      canResume: false,
    });

    const draftMetaPath = path.join(String(fixture.draft?.draftDir || ''), 'draft.meta.json');
    expect(fs.existsSync(draftMetaPath)).toBe(true);

    const artifactsRes = await app.inject({
      method: 'GET',
      url: `/api/runs/${encodeURIComponent(fixture.runId)}/artifacts/${encodeURIComponent(fixture.taskKeys.snapshotMetadata)}`,
    });
    expect(artifactsRes.statusCode).toBe(200);
    expect(artifactsRes.json().items.some((item: { label: string }) => item.label === 'Command Result')).toBe(true);
  });
});

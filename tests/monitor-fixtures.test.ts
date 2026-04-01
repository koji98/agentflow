import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { writeMonitorSampleCatalog } from '../scripts/refresh-monitor-sample-fixtures.ts';

function resolveCatalogPath(rootDir: string, relativePath: string): string {
  return path.join(rootDir, relativePath.replace(/^\.\//, ''));
}

const actualRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('writeMonitorSampleCatalog writes a self-describing fixture catalog with acceptance docs', (t) => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentflow-monitor-fixtures-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const catalog = writeMonitorSampleCatalog(repoRoot);

  assert.equal(catalog.schemaVersion, 4);
  assert.equal(catalog.smokePlan.model, 'gpt-5.4-mini');
  assert.deepEqual(
    catalog.fixtures.map((fixture) => fixture.scenario),
    ['success', 'resume_failure', 'loop_judge_failure', 'builder_snapshot'],
  );

  for (const fixture of catalog.fixtures) {
    assert.ok(fixture.headline.length > 0);
    assert.ok(fixture.deepLinkChecks.length > 0);
    assert.ok(fixture.docs.some((doc) => doc.kind === 'readme'));
    assert.ok(fixture.docs.some((doc) => doc.kind === 'sample_guide'));
    assert.ok(fixture.supportingPaths.length >= 2);
    for (const doc of fixture.docs) {
      assert.ok(fs.existsSync(resolveCatalogPath(repoRoot, doc.path)));
    }
    for (const supportingPath of fixture.supportingPaths) {
      assert.ok(fs.existsSync(resolveCatalogPath(repoRoot, supportingPath.path)));
      assert.ok(supportingPath.purpose.length > 0);
    }
  }

  const successFixture = catalog.fixtures.find((fixture) => fixture.scenario === 'success');
  assert.ok(successFixture);
  assert.ok(successFixture.supportingPaths.some((entry) => entry.kind === 'plan'));
  assert.ok(successFixture.supportingPaths.some((entry) => entry.kind === 'last_message'));
  assert.ok(successFixture.supportingPaths.some((entry) => entry.kind === 'command_result'));
  assert.ok(successFixture.supportingPaths.some((entry) => entry.kind === 'report'));

  const resumeFixture = catalog.fixtures.find((fixture) => fixture.scenario === 'resume_failure');
  assert.ok(resumeFixture);
  assert.ok(resumeFixture.supportingPaths.some((entry) => entry.kind === 'plan'));
  assert.ok(resumeFixture.supportingPaths.some((entry) => entry.kind === 'command_result'));
  assert.ok(resumeFixture.supportingPaths.some((entry) => entry.kind === 'log'));

  const builderFixture = catalog.fixtures.find((fixture) => fixture.scenario === 'builder_snapshot');
  assert.ok(builderFixture);
  assert.match(builderFixture.planPath, /web_builder_drafts/);
  assert.match(builderFixture.planPath, /launches/);
  assert.ok(builderFixture.docs.some((doc) => doc.kind === 'acceptance'));
  assert.ok(builderFixture.supportingPaths.some((entry) => entry.kind === 'source_plan'));
  assert.ok(builderFixture.supportingPaths.some((entry) => entry.kind === 'draft_plan'));
  assert.ok(builderFixture.supportingPaths.some((entry) => entry.kind === 'launch_plan'));
  assert.ok(builderFixture.supportingPaths.some((entry) => entry.kind === 'draft_meta'));
  assert.ok(builderFixture.supportingPaths.some((entry) => entry.kind === 'command_result'));
  assert.ok(builderFixture.supportingPaths.some((entry) => entry.kind === 'report'));
  assert.ok(builderFixture.deepLinkChecks.some((check) => check.includes('builder-source-plan.json')));

  const sourcePlan = JSON.parse(
    fs.readFileSync(resolveCatalogPath(repoRoot, String(builderFixture.draft?.sourcePlanPath)), 'utf8'),
  );
  const draftPlan = JSON.parse(
    fs.readFileSync(resolveCatalogPath(repoRoot, String(builderFixture.draft?.draftPlanPath)), 'utf8'),
  );
  const launchPlan = JSON.parse(
    fs.readFileSync(resolveCatalogPath(repoRoot, String(builderFixture.draft?.launchPlanPath)), 'utf8'),
  );
  assert.equal(sourcePlan.flow[0].persona, undefined);
  assert.equal(sourcePlan.flow[1].steps[1].persona, undefined);
  assert.equal(draftPlan.flow[0].persona, 'You are a graph-first product strategist focused on monitor clarity.');
  assert.equal(launchPlan.flow[1].steps[1].persona, 'You are a release copy editor for local orchestration tools.');
  assert.notDeepEqual(sourcePlan, draftPlan);
  assert.deepEqual(draftPlan, launchPlan);
  assert.doesNotMatch(JSON.stringify(sourcePlan), /persona_ref/);
  assert.doesNotMatch(JSON.stringify(launchPlan), /persona_ref/);

  const loopJudgeFixture = catalog.fixtures.find((fixture) => fixture.scenario === 'loop_judge_failure');
  assert.ok(loopJudgeFixture);
  assert.ok(loopJudgeFixture.deepLinkChecks.some((check) => check.includes('spawnSync codex ETIMEDOUT')));
  assert.ok(loopJudgeFixture.supportingPaths.some((entry) => entry.kind === 'plan'));
  assert.ok(loopJudgeFixture.supportingPaths.some((entry) => entry.kind === 'report'));
  assert.ok(loopJudgeFixture.supportingPaths.some((entry) => entry.kind === 'command_result'));

  assert.match(catalog.liveAcceptance.testPath, /server\.live-command-run\.test\.ts$/);
  assert.match(catalog.liveAcceptance.command, /tests\/server\.live-command-run\.test\.ts$/);
  assert.ok(catalog.liveAcceptance.validates.some((entry) => entry.includes('resume')));

  const savedCatalogPath = path.join(repoRoot, '.tmp', 'web_studio_vision', 'monitor_sample_catalog.json');
  assert.ok(fs.existsSync(savedCatalogPath));

  const coveragePath = path.join(repoRoot, '.tmp', 'web_studio_vision', 'monitor_sample_coverage.md');
  assert.ok(fs.existsSync(coveragePath));
  const coverageText = fs.readFileSync(coveragePath, 'utf8');
  assert.match(coverageText, /Catalog schema version: `4`/);
  assert.match(coverageText, /npm test -- tests\/monitor-fixtures\.test\.ts/);
  assert.match(coverageText, /echo_status command result/);
  assert.match(coverageText, /resume_probe execution log/);
  assert.match(coverageText, /capture_gate_context command result/);
  assert.match(coverageText, /snapshot_metadata command result/);
  assert.match(coverageText, /builder-source-plan\.json/);
});

test('the lightweight smoke plan stays pinned to gpt-5.4-mini', () => {
  const smokePlanPath = path.join(actualRepoRoot, '.tmp', 'joke-demo-plan.json');
  const smokePlan = JSON.parse(fs.readFileSync(smokePlanPath, 'utf8'));
  assert.equal(smokePlan.model, 'gpt-5.4-mini');
});

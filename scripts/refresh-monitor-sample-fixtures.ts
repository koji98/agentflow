import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createSampleAgentflowFixture,
  type SampleAgentflowFixture,
  type SampleAgentflowScenario,
  type SampleFixtureSupportingFile,
} from '../web-app/tests/helpers/sample_agentflow.ts';

type TrackedFixtureSpec = {
  scenario: SampleAgentflowScenario;
  workspaceRelPath: string;
  title: string;
  headline: string;
  deepLinkChecks: string[];
  extraDoc?: {
    fileName: string;
    title: string;
    checks: string[];
  };
  legacyAliasOf?: string;
};

type CatalogEntry = {
  scenario: SampleAgentflowScenario;
  title: string;
  headline: string;
  workspacePath: string;
  planPath: string;
  runDir: string;
  runId: string;
  deepLinkChecks: string[];
  docs: CatalogDocEntry[];
  supportingPaths: CatalogSupportingPathEntry[];
  validates: string[];
  laterLoopUse: string[];
  legacyAliasOf?: string;
  draft?: {
    draftId: string;
    draftDir: string;
    sourcePlanPath: string;
    draftPlanPath: string;
    launchPlanPath: string;
  };
};

type CatalogDocEntry = {
  kind: 'readme' | 'sample_guide' | 'acceptance';
  title: string;
  path: string;
};

type CatalogSupportingPathEntry = {
  kind: SampleFixtureSupportingFile['kind'];
  title: string;
  path: string;
  purpose: string;
};

type MonitorSampleCatalog = {
  schemaVersion: number;
  refreshCommand: string;
  smokePlan: {
    path: string;
    model: string;
    purpose: string;
  };
  validationCommands: string[];
  liveAcceptance: {
    title: string;
    testPath: string;
    command: string;
    validates: string[];
    laterLoopUse: string[];
  };
  fixtures: CatalogEntry[];
  legacyAliases: CatalogEntry[];
};

const defaultRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureSpecs: TrackedFixtureSpec[] = [
  {
    scenario: 'success',
    workspaceRelPath: '.tmp/playwright-monitor-success',
    title: 'Playwright Monitor Success Fixture',
    headline: 'Deterministic happy-path historical run with parallel agents, one command node, and one loop_judge.',
    deepLinkChecks: [
      'Open `/run/run_sample_fun_playwright-monitor-success` and confirm the monitor resolves directly into a completed historical run.',
      'Select `echo_status`, open `Raw logs`, and confirm `/bin/sh -c echo pipeline_ready` is available.',
      'Select `quality_gate`, open `Activity`, and confirm the post-body judge result explains why iteration 1 satisfied the loop.',
    ],
    extraDoc: {
      fileName: 'monitor-happy-path.md',
      title: 'Happy-path monitor acceptance',
      checks: [
        'Graph shows `setup_agent`, `parallel_fun`, `quality_gate`, and `final_agent` without requiring a manual open step.',
        'The parallel group exposes two agent tasks plus the `echo_status` command node.',
        'Judge activity surfaces both pre-body and post-body decisions under the selected `quality_gate` scope.',
      ],
    },
  },
  {
    scenario: 'resume_failure',
    workspaceRelPath: '.tmp/playwright-monitor-resume',
    title: 'Playwright Monitor Resume Fixture',
    headline: 'Deterministic stopped historical run with one failed command, one successful sibling, and resume-ready state.',
    deepLinkChecks: [
      'Open `/run/run_sample_resume_failure_playwright-monitor-resume` and confirm the monitor resolves directly into a failed historical run.',
      'Confirm `Resume` is enabled, `Cancel` is disabled, and the run explains that the final persisted failure state is being shown.',
      'Select `resume_probe`, open `Artifacts`, and confirm `Command Result` contains exit code `17` and `retry_required` stderr.',
    ],
    extraDoc: {
      fileName: 'resume-playbook.md',
      title: 'Resume acceptance',
      checks: [
        'Failure copy stays historical-first and does not pretend the run is still live.',
        'The failed command exposes stderr and `command_result.json` deterministically.',
        'Use the live command-only resume test when you need to prove actual rerun semantics beyond this fixture-backed preflight state.',
      ],
    },
  },
  {
    scenario: 'loop_judge_failure',
    workspaceRelPath: '.tmp/playwright-monitor-loop-judge-failure',
    title: 'Playwright Loop Judge Failure Fixture',
    headline: 'Deterministic historical loop_judge failure with a post-body gate error and no numeric score.',
    deepLinkChecks: [
      'Open `/run/run_sample_loop_judge_failure_playwright-monitor-loop-judge-failure` and confirm the monitor resolves directly into a failed historical run.',
      'Select `monitor_quality_gate` and confirm the overview shows `No score` for the judge state instead of a numeric badge.',
      'Open `Activity` and confirm `Iteration 1 · post_body` shows `No score recorded` plus `ai gate error: Error: spawnSync codex ETIMEDOUT`.',
    ],
    extraDoc: {
      fileName: 'loop-judge-failure.md',
      title: 'Loop judge failure acceptance',
      checks: [
        'Historical failure copy stays graph-first even when the loop exits on a judge error rather than a failed descendant task.',
        'The selected loop exposes `No score` cleanly in overview and activity instead of collapsing or hiding the judge state.',
        'Use this fixture when gate or timeout handling changes, especially around post-body summaries and null-score rendering.',
      ],
    },
  },
  {
    scenario: 'builder_snapshot',
    workspaceRelPath: '.tmp/playwright-monitor-builder',
    title: 'Playwright Builder Snapshot Fixture',
    headline: 'Tracked builder source-to-draft-to-launch lineage with plain persona strings and a stable draft-to-monitor handoff path.',
    deepLinkChecks: [
      'Open `/run/run_builder_snapshot_playwright-monitor-builder` and confirm the monitor resolves a completed historical run.',
      'Confirm the plan path lives under `.tmp/web_builder_drafts/draft_local_orchestration_studio/launches/`.',
      'Compare `.tmp/plans/builder-source-plan.json` with the launch snapshot and confirm builder edits were applied in plain JSON before launch.',
      'Inspect the launch plan JSON and confirm it contains plain `persona` strings with no `persona_ref` field.',
    ],
    extraDoc: {
      fileName: 'builder-handoff.md',
      title: 'Builder handoff acceptance',
      checks: [
        'The launch snapshot is runnable as a plain plan and keeps a stable path back to the draft lineage.',
        'The source plan differs from the autosaved draft and launch snapshot, so later loops can inspect a realistic builder edit path.',
        'Builder-generated plans stay provider-agnostic and compile persona templates by copy.',
        'Later builder loops should use this fixture until `/builder` can generate and reopen real launch snapshots end to end.',
      ],
    },
  },
  {
    scenario: 'success',
    workspaceRelPath: '.tmp/playwright_monitor_fixture',
    title: 'Legacy Success Fixture Alias',
    headline: 'Legacy success-fixture alias kept in sync so older notes do not point at stale sample data.',
    deepLinkChecks: [
      'Prefer `.tmp/playwright-monitor-success` for new work.',
      'This alias stays refreshed so existing references do not regress onto the older one-task sample.',
    ],
    legacyAliasOf: '.tmp/playwright-monitor-success',
  },
];

function repoRelativePath(targetPath: string, repoRootDir = defaultRepoRoot): string {
  const relativePath = path.relative(repoRootDir, targetPath).split(path.sep).join('/');
  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
}

function writeText(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function writeJson(filePath: string, value: unknown): void {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeWorkspaceDocs(spec: TrackedFixtureSpec, fixture: SampleAgentflowFixture, repoRootDir = defaultRepoRoot): void {
  const relativeWorkspacePath = repoRelativePath(fixture.workspaceRoot, repoRootDir);
  const relativePlanPath = repoRelativePath(fixture.planPath, repoRootDir);
  const relativeRunDir = repoRelativePath(fixture.runDir, repoRootDir);
  const relativeDraftDir = fixture.draft ? repoRelativePath(fixture.draft.draftDir, repoRootDir) : null;
  const supportingPaths = buildSupportingPaths(fixture, repoRootDir);
  const legacyNote = spec.legacyAliasOf
    ? `\n## Legacy Alias\n- Canonical workspace: \`${spec.legacyAliasOf}\`\n- Keep new browser checks pointed at the canonical workspace unless an older note explicitly names this alias.\n`
    : '';

  const readme = [
    `# ${spec.title}`,
    '',
    spec.headline,
    '',
    '## Stable Values',
    `- Scenario: \`${fixture.scenario}\``,
    `- Workspace: \`${relativeWorkspacePath}\``,
    `- Plan: \`${relativePlanPath}\``,
    `- Run directory: \`${relativeRunDir}\``,
    `- Run ID: \`${fixture.runId}\``,
    relativeDraftDir ? `- Draft directory: \`${relativeDraftDir}\`` : null,
    '',
    '## Validates',
    ...fixture.acceptance.validates.map((entry) => `- ${entry}`),
    '',
    '## Later Loop Use',
    ...fixture.acceptance.laterLoopUse.map((entry) => `- ${entry}`),
    '',
    '## Supporting Files',
    ...supportingPaths.map((entry) => `- ${entry.title}: \`${entry.path}\` - ${entry.purpose}`),
    '',
    '## Refresh',
    '- Command: `npm run fixtures:refresh-monitor`',
    legacyNote.trimEnd(),
    '',
  ].filter(Boolean).join('\n');

  const sampleGuide = [
    '# Sample Guide',
    '',
    `Use \`${relativeWorkspacePath}\` when you need a deterministic \`${fixture.scenario}\` monitor workspace with a stable run ID.`,
    '',
    '## Quick Start',
    '- Start the bridge and web app locally.',
    `- Open \`/run/${fixture.runId}\` in the browser.`,
    `- If you need the source plan, open \`${relativePlanPath}\`.`,
    '',
    '## Supporting Files',
    ...supportingPaths.map((entry) => `- ${entry.title}: \`${entry.path}\` - ${entry.purpose}`),
    '',
    '## Deep-link Checks',
    ...spec.deepLinkChecks.map((entry) => `- ${entry}`),
    '',
    '## Acceptance Surface',
    ...fixture.acceptance.validates.map((entry) => `- ${entry}`),
    '',
    spec.legacyAliasOf
      ? `This workspace is a legacy alias of \`${spec.legacyAliasOf}\`. Prefer the canonical workspace for new notes and browser scripts.`
      : `Refresh this workspace with \`npm run fixtures:refresh-monitor\` whenever the helper-backed sample data changes.`,
    '',
  ].join('\n');

  writeText(path.join(fixture.workspaceRoot, 'README.md'), `${readme}\n`);
  writeText(path.join(fixture.workspaceRoot, 'docs', 'sample-guide.md'), `${sampleGuide}\n`);

  if (!spec.extraDoc) return;

  const extraDoc = [
    `# ${spec.extraDoc.title}`,
    '',
    `Workspace: \`${relativeWorkspacePath}\``,
    `Run ID: \`${fixture.runId}\``,
    '',
    '## Checks',
    ...spec.extraDoc.checks.map((entry) => `- ${entry}`),
    '',
    '## Primary Supporting Files',
    ...supportingPaths.map((entry) => `- ${entry.title}: \`${entry.path}\` - ${entry.purpose}`),
    '',
    '## Later Loop Use',
    ...fixture.acceptance.laterLoopUse.map((entry) => `- ${entry}`),
    '',
  ].join('\n');

  writeText(path.join(fixture.workspaceRoot, 'docs', spec.extraDoc.fileName), `${extraDoc}\n`);
}

function buildCatalogDocs(
  spec: TrackedFixtureSpec,
  fixture: SampleAgentflowFixture,
  repoRootDir = defaultRepoRoot,
): CatalogDocEntry[] {
  const docs: CatalogDocEntry[] = [
    {
      kind: 'readme',
      title: `${spec.title} README`,
      path: repoRelativePath(path.join(fixture.workspaceRoot, 'README.md'), repoRootDir),
    },
    {
      kind: 'sample_guide',
      title: `${spec.title} Sample Guide`,
      path: repoRelativePath(path.join(fixture.workspaceRoot, 'docs', 'sample-guide.md'), repoRootDir),
    },
  ];

  if (spec.extraDoc) {
    docs.push({
      kind: 'acceptance',
      title: spec.extraDoc.title,
      path: repoRelativePath(path.join(fixture.workspaceRoot, 'docs', spec.extraDoc.fileName), repoRootDir),
    });
  }

  return docs;
}

function buildSupportingPaths(
  fixture: SampleAgentflowFixture,
  repoRootDir = defaultRepoRoot,
): CatalogSupportingPathEntry[] {
  const supportingPaths: CatalogSupportingPathEntry[] = fixture.supportingFiles.map((entry) => ({
    kind: entry.kind,
    title: entry.title,
    path: repoRelativePath(entry.path, repoRootDir),
    purpose: entry.purpose,
  }));

  if (!fixture.draft) return supportingPaths;

  supportingPaths.push(
    {
      kind: 'source_plan',
      title: 'Builder source plan',
      path: repoRelativePath(fixture.draft.sourcePlanPath, repoRootDir),
      purpose: 'Inspect the source plan that the builder draft and launch snapshot were derived from.',
    },
    {
      kind: 'draft_plan',
      title: 'Builder draft plan',
      path: repoRelativePath(fixture.draft.draftPlanPath, repoRootDir),
      purpose: 'Inspect the autosaved builder working plan that should survive refresh before launch.',
    },
    {
      kind: 'launch_plan',
      title: 'Builder launch snapshot',
      path: repoRelativePath(fixture.draft.launchPlanPath, repoRootDir),
      purpose: 'Inspect the exact plain JSON plan handed to the runtime and later reopened by the monitor.',
    },
    {
      kind: 'draft_meta',
      title: 'Builder draft metadata',
      path: repoRelativePath(path.join(fixture.draft.draftDir, 'draft.meta.json'), repoRootDir),
      purpose: 'Inspect the durable draft identity and source-plan linkage used for builder reopen behavior.',
    },
  );

  return supportingPaths;
}

function sourceExpressionForScenario(scenario: SampleAgentflowScenario): string {
  if (scenario === 'success') return 'createSampleAgentflowFixture()';
  return `createSampleAgentflowFixture({ scenario: '${scenario}' })`;
}

function writeMonitorSampleCoverage(catalog: MonitorSampleCatalog, repoRootDir = defaultRepoRoot): void {
  const lines: string[] = [
    '# Monitor Sample Coverage',
    '',
    '## Purpose',
    '- Keep one deterministic fixture catalog for monitor, run-reliability, and future builder-handoff validation.',
    '- Prefer fixture-backed monitor coverage and command-only live runs over provider-auth-dependent flows.',
    '- Keep `.tmp/joke-demo-plan.json` as the lightweight smoke plan for quick manual launch checks on `gpt-5.4-mini`.',
    '- Refresh the tracked workspaces, machine-readable catalog, and acceptance notes from one command so later loops do not drift onto stale sample data.',
    '',
    '## Refresh Workflow',
    `- Command: \`${catalog.refreshCommand}\``,
    '- Machine-readable catalog: `.tmp/web_studio_vision/monitor_sample_catalog.json`',
    `- Catalog schema version: \`${catalog.schemaVersion}\``,
    '- Human-readable coverage note: `.tmp/web_studio_vision/monitor_sample_coverage.md`',
    '- Canonical tracked workspaces:',
    ...catalog.fixtures.map((fixture) => `- \`${fixture.workspacePath}\``),
    ...catalog.legacyAliases.map((fixture) => `- Legacy alias: \`${fixture.workspacePath}\` -> \`${fixture.legacyAliasOf}\``),
    '',
    '## Fixture Catalog',
    '',
  ];

  for (const fixture of catalog.fixtures) {
    lines.push(
      `### \`${fixture.scenario}\``,
      `- Source: \`${sourceExpressionForScenario(fixture.scenario)}\``,
      `- Tracked workspace: \`${fixture.workspacePath}\``,
      `- Run ID: \`${fixture.runId}\``,
      `- Plan: \`${fixture.planPath}\``,
      '- Validates:',
      ...fixture.validates.map((entry) => `- ${entry}`),
      '- Use it when:',
      ...fixture.laterLoopUse.map((entry) => `- ${entry}`),
      '- Primary supporting files:',
      ...fixture.supportingPaths.map((entry) => `- ${entry.title}: \`${entry.path}\` - ${entry.purpose}`),
      '- Deep-link checks:',
      ...fixture.deepLinkChecks.map((entry) => `- ${entry}`),
      '- Acceptance docs:',
      ...fixture.docs.map((entry) => `- ${entry.title}: \`${entry.path}\``),
      '',
    );
  }

  lines.push(
    '## Live Acceptance Surface',
    `- Title: ${catalog.liveAcceptance.title}`,
    `- Test: \`${catalog.liveAcceptance.testPath}\``,
    `- Command: \`${catalog.liveAcceptance.command}\``,
    '- Coverage:',
    ...catalog.liveAcceptance.validates.map((entry) => `- ${entry}`),
    '- Use it when:',
    ...catalog.liveAcceptance.laterLoopUse.map((entry) => `- ${entry}`),
    '',
    '## Fast Validation Commands',
    ...catalog.validationCommands.map((command) => `- \`${command}\``),
    '',
    '## Acceptance Note Contract',
    '- Every tracked workspace writes `README.md` for stable values, validation intent, supporting files, and refresh instructions.',
    '- Every tracked workspace writes `docs/sample-guide.md` for quick-start deep-link checks.',
    '- Every canonical scenario also writes one scenario-specific acceptance note under `docs/` with the key monitor or builder checks plus the primary supporting files to inspect.',
    '- Every catalog entry lists the exact supporting files later loops should inspect instead of guessing within the workspace.',
    '',
    '## Notes',
    '- The fixture helper is the executable source of truth: `web-app/tests/helpers/sample_agentflow.ts`.',
    '- The tracked workspaces, machine-readable catalog, and this coverage note are all generated by `scripts/refresh-monitor-sample-fixtures.ts`.',
    '- The builder snapshot fixture keeps generated plans plain and local; it does not introduce any runtime persona registry or `persona_ref` contract.',
    '',
  );

  writeText(path.join(repoRootDir, '.tmp', 'web_studio_vision', 'monitor_sample_coverage.md'), `${lines.join('\n')}\n`);
}

function refreshTrackedFixture(spec: TrackedFixtureSpec, repoRootDir = defaultRepoRoot): CatalogEntry {
  const workspaceRoot = path.join(repoRootDir, spec.workspaceRelPath);
  fs.rmSync(workspaceRoot, { recursive: true, force: true });

  const fixture = createSampleAgentflowFixture({ rootDir: workspaceRoot, scenario: spec.scenario });
  writeWorkspaceDocs(spec, fixture, repoRootDir);

  return {
    scenario: fixture.scenario,
    title: spec.title,
    headline: spec.headline,
    workspacePath: repoRelativePath(fixture.workspaceRoot, repoRootDir),
    planPath: repoRelativePath(fixture.planPath, repoRootDir),
    runDir: repoRelativePath(fixture.runDir, repoRootDir),
    runId: fixture.runId,
    deepLinkChecks: spec.deepLinkChecks,
    docs: buildCatalogDocs(spec, fixture, repoRootDir),
    supportingPaths: buildSupportingPaths(fixture, repoRootDir),
    validates: fixture.acceptance.validates,
    laterLoopUse: fixture.acceptance.laterLoopUse,
    legacyAliasOf: spec.legacyAliasOf,
    draft: fixture.draft
      ? {
        draftId: fixture.draft.draftId,
        draftDir: repoRelativePath(fixture.draft.draftDir, repoRootDir),
        sourcePlanPath: repoRelativePath(fixture.draft.sourcePlanPath, repoRootDir),
        draftPlanPath: repoRelativePath(fixture.draft.draftPlanPath, repoRootDir),
        launchPlanPath: repoRelativePath(fixture.draft.launchPlanPath, repoRootDir),
      }
      : undefined,
  };
}

export function buildMonitorSampleCatalog(repoRootDir = defaultRepoRoot): MonitorSampleCatalog {
  const canonicalFixtures: CatalogEntry[] = [];
  const legacyAliases: CatalogEntry[] = [];

  for (const spec of fixtureSpecs) {
    const entry = refreshTrackedFixture(spec, repoRootDir);
    if (spec.legacyAliasOf) {
      legacyAliases.push(entry);
      continue;
    }
    canonicalFixtures.push(entry);
  }

  return {
    schemaVersion: 4,
    refreshCommand: 'npm run fixtures:refresh-monitor',
    smokePlan: {
      path: './.tmp/joke-demo-plan.json',
      model: 'gpt-5.4-mini',
      purpose: 'Lightweight manual launch smoke plan for the local studio.',
    },
    validationCommands: [
      'npm run fixtures:refresh-monitor',
      'npm test -- tests/monitor-fixtures.test.ts',
      'npm --prefix web-app run test -- --run tests/server.sample-agentflow.test.ts tests/client.monitor-sample-run.test.tsx',
      'npm --prefix web-app run test -- --run tests/server.live-command-run.test.ts',
      'npm --prefix web-app run typecheck',
    ],
    liveAcceptance: {
      title: 'Command-only live resume proof',
      testPath: './web-app/tests/server.live-command-run.test.ts',
      command: 'npm --prefix web-app run test -- --run tests/server.live-command-run.test.ts',
      validates: [
        'Real command-only start flow without provider auth.',
        'Real failure followed by resume on the same run ID.',
        'Proof that resume reruns only the blocking command before the remaining command continues.',
      ],
      laterLoopUse: [
        'Use when a change touches resume semantics, run lifecycle routes, or same-run state persistence.',
        'Pair with the fixture-backed catalog when you need one live rerun proof on top of deterministic historical monitor coverage.',
      ],
    },
    fixtures: canonicalFixtures,
    legacyAliases,
  };
}

export function writeMonitorSampleCatalog(repoRootDir = defaultRepoRoot): MonitorSampleCatalog {
  const catalog = buildMonitorSampleCatalog(repoRootDir);
  writeJson(path.join(repoRootDir, '.tmp', 'web_studio_vision', 'monitor_sample_catalog.json'), catalog);
  writeMonitorSampleCoverage(catalog, repoRootDir);
  return catalog;
}

export function main(): void {
  writeMonitorSampleCatalog();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

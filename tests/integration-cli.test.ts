import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { main } from '../src/cli.ts';
import { getSingleRunDir, installMockCodex, mkRepo, parseJsonLines, withPatchedEnv } from './helpers.ts';

test('unknown keys surface a clear user-facing CLI error', async (t) => {
  const repoRoot = mkRepo('agentflow-unknown-key-cli-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const planPath = path.resolve(repoRoot, 'unknown_key_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify(
      {
        setup: 'unknown key cli message test',
        limits: { unknown_key: 'oops' },
        flow: [{ type: 'task', id: 'a', prompt: 'b' }],
      },
      null,
      2,
    ),
    'utf8',
  );

  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]): void => {
    errors.push(args.map((v) => String(v)).join(' '));
  };
  try {
    const exitCode = await main(['--plan', planPath]);
    assert.equal(exitCode, 1);
  } finally {
    console.error = original;
  }
  assert.match(errors.join('\n'), /limits contains unknown key: "unknown_key"\./);
});

test('dry-run is CLI-flag only (plan options.dry_run does not force dry mode)', async (t) => {
  const repoRoot = mkRepo('agentflow-dry-flag-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const mockBinDir = path.resolve(repoRoot, 'mockbin');
  installMockCodex(mockBinDir);
  const mockLog = path.resolve(repoRoot, 'mock_codex.log');
  const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');
  fs.writeFileSync(
    mockBehavior,
    JSON.stringify({ default: { exitCode: 0, sleepMs: 0 } }, null, 2),
    'utf8',
  );

  const planPath = path.resolve(repoRoot, 'dry_flag_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify(
      {
        setup: 'dry flag behavior test',
        repos: { main: '.' },
        worktrees: false,
        provider: 'codex',
        model: 'gpt-5-nano',
        reasoning: 'xhigh',
        options: {
          run_root: 'tmp/test_dry_flag_runs',
          cleanup_worktrees: true,
        },
        limits: {
          worker_timeout_sec: 30,
          timeout_grace_sec: 1,
        },
        flow: [{ type: 'task', id: 'live_without_flag', prompt: 'run live unless cli dry-run flag exists' }],
      },
      null,
      2,
    ),
    'utf8',
  );

  await withPatchedEnv(
    {
      PATH: `${mockBinDir}${path.delimiter}${process.env.PATH || ''}`,
      MOCK_CODEX_LOG: mockLog,
      MOCK_CODEX_BEHAVIOR: mockBehavior,
    },
    async () => {
      const liveExit = await main(['--plan', planPath]);
      assert.equal(liveExit, 0);
      const callsAfterLive = parseJsonLines(mockLog);
      assert.equal(callsAfterLive.length, 1);

      const dryExit = await main(['--plan', planPath, '--dry-run']);
      assert.equal(dryExit, 0);
      const callsAfterDry = parseJsonLines(mockLog);
      assert.equal(callsAfterDry.length, 1);
    },
  );
});

test('--skip-git-repo-check is forwarded to codex exec', async (t) => {
  const repoRoot = mkRepo('agentflow-skip-git-repo-check-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const mockBinDir = path.resolve(repoRoot, 'mockbin');
  installMockCodex(mockBinDir);
  const mockLog = path.resolve(repoRoot, 'mock_codex.log');
  const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');
  fs.writeFileSync(
    mockBehavior,
    JSON.stringify({ default: { exitCode: 0, sleepMs: 0 } }, null, 2),
    'utf8',
  );

  const planPath = path.resolve(repoRoot, 'skip_git_check_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify(
      {
        setup: 'skip git repo check passthrough test',
        repos: { main: '.' },
        worktrees: false,
        provider: 'codex',
        model: 'gpt-5-nano',
        reasoning: 'xhigh',
        options: {
          run_root: 'tmp/test_skip_git_repo_check_runs',
          cleanup_worktrees: true,
        },
        limits: {
          worker_timeout_sec: 30,
          timeout_grace_sec: 1,
        },
        flow: [{ type: 'task', id: 'skip_git_check_task', prompt: 'run task with skip git repo check flag' }],
      },
      null,
      2,
    ),
    'utf8',
  );

  await withPatchedEnv(
    {
      PATH: `${mockBinDir}${path.delimiter}${process.env.PATH || ''}`,
      MOCK_CODEX_LOG: mockLog,
      MOCK_CODEX_BEHAVIOR: mockBehavior,
    },
    async () => {
      const exitCode = await main(['--plan', planPath, '--skip-git-repo-check']);
      assert.equal(exitCode, 0);
    },
  );

  const calls = parseJsonLines(mockLog);
  assert.equal(calls.length, 1);
  const args = (calls[0].args || []) as string[];
  assert.ok(args.includes('--skip-git-repo-check'));
  const sandboxIndex = args.indexOf('--sandbox');
  assert.ok(sandboxIndex >= 0);
  assert.equal(args[sandboxIndex + 1], 'workspace-write');
});

test('workspace-write sandbox is default when --sandbox is not provided', async (t) => {
  const repoRoot = mkRepo('agentflow-default-sandbox-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const mockBinDir = path.resolve(repoRoot, 'mockbin');
  installMockCodex(mockBinDir);
  const mockLog = path.resolve(repoRoot, 'mock_codex.log');
  const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');
  fs.writeFileSync(
    mockBehavior,
    JSON.stringify({ default: { exitCode: 0, sleepMs: 0 } }, null, 2),
    'utf8',
  );

  const planPath = path.resolve(repoRoot, 'default_sandbox_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify(
      {
        setup: 'default sandbox behavior test',
        repos: { main: '.' },
        worktrees: false,
        provider: 'codex',
        model: 'gpt-5-nano',
        reasoning: 'xhigh',
        options: {
          run_root: 'tmp/test_default_sandbox_runs',
          cleanup_worktrees: true,
        },
        limits: {
          worker_timeout_sec: 30,
          timeout_grace_sec: 1,
        },
        flow: [{ type: 'task', id: 'default_sandbox_task', prompt: 'run task without sandbox flag' }],
      },
      null,
      2,
    ),
    'utf8',
  );

  await withPatchedEnv(
    {
      PATH: `${mockBinDir}${path.delimiter}${process.env.PATH || ''}`,
      MOCK_CODEX_LOG: mockLog,
      MOCK_CODEX_BEHAVIOR: mockBehavior,
    },
    async () => {
      const exitCode = await main(['--plan', planPath]);
      assert.equal(exitCode, 0);
    },
  );

  const calls = parseJsonLines(mockLog);
  assert.equal(calls.length, 1);
  const args = (calls[0].args || []) as string[];
  const sandboxIndex = args.indexOf('--sandbox');
  assert.ok(sandboxIndex >= 0);
  assert.equal(args[sandboxIndex + 1], 'workspace-write');
});

test('--sandbox is forwarded to codex exec', async (t) => {
  const repoRoot = mkRepo('agentflow-sandbox-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const mockBinDir = path.resolve(repoRoot, 'mockbin');
  installMockCodex(mockBinDir);
  const mockLog = path.resolve(repoRoot, 'mock_codex.log');
  const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');
  fs.writeFileSync(
    mockBehavior,
    JSON.stringify({ default: { exitCode: 0, sleepMs: 0 } }, null, 2),
    'utf8',
  );

  const planPath = path.resolve(repoRoot, 'sandbox_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify(
      {
        setup: 'sandbox passthrough test',
        repos: { main: '.' },
        worktrees: false,
        provider: 'codex',
        model: 'gpt-5-nano',
        reasoning: 'xhigh',
        options: {
          run_root: 'tmp/test_sandbox_runs',
          cleanup_worktrees: true,
        },
        limits: {
          worker_timeout_sec: 30,
          timeout_grace_sec: 1,
        },
        flow: [{ type: 'task', id: 'sandbox_task', prompt: 'run task with sandbox flag' }],
      },
      null,
      2,
    ),
    'utf8',
  );

  await withPatchedEnv(
    {
      PATH: `${mockBinDir}${path.delimiter}${process.env.PATH || ''}`,
      MOCK_CODEX_LOG: mockLog,
      MOCK_CODEX_BEHAVIOR: mockBehavior,
    },
    async () => {
      const exitCode = await main(['--plan', planPath, '--sandbox', 'workspace-write']);
      assert.equal(exitCode, 0);
    },
  );

  const calls = parseJsonLines(mockLog);
  assert.equal(calls.length, 1);
  const args = (calls[0].args || []) as string[];
  const sandboxIndex = args.indexOf('--sandbox');
  assert.ok(sandboxIndex >= 0);
  assert.equal(args[sandboxIndex + 1], 'workspace-write');
});

test('supervisor-only flags require --supervise mode', async () => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]): void => {
    errors.push(args.map((v) => String(v)).join(' '));
  };
  try {
    const exitCode = await main(['--supervisor-profile', 'default']);
    assert.equal(exitCode, 2);
  } finally {
    console.error = original;
  }
  assert.match(errors.join('\n'), /Supervisor-specific flags require --supervise/);
});

test('--supervise --validate validates config without executing a cycle', async (t) => {
  const repoRoot = mkRepo('agentflow-supervisor-validate-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const stateDir = path.resolve(repoRoot, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.resolve(stateDir, 'mission_state.json'),
    JSON.stringify({ objective: 'validate supervisor config only' }, null, 2),
    'utf8',
  );
  fs.writeFileSync(path.resolve(repoRoot, 'planner_prompt.md'), 'planner template\n', 'utf8');
  fs.writeFileSync(path.resolve(repoRoot, 'plan_qa_prompt.md'), 'plan qa template\n', 'utf8');
  fs.writeFileSync(
    path.resolve(repoRoot, 'plan_qa_rubric.json'),
    JSON.stringify({ pass_threshold: 0.85 }, null, 2),
    'utf8',
  );
  fs.writeFileSync(
    path.resolve(repoRoot, 'agentflow.supervisor.json'),
    JSON.stringify(
      {
        prompts: {
          planner: 'planner_prompt.md',
          plan_qa: 'plan_qa_prompt.md',
        },
        rubrics: {
          plan_qa: 'plan_qa_rubric.json',
        },
        paths: {
          mission_state: 'state/mission_state.json',
          run_root: 'tmp/test_supervisor_validate_runs',
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  const originalCwd = process.cwd();
  process.chdir(repoRoot);
  try {
    const exitCode = await main(['--supervise', 'state/mission_state.json', '--validate']);
    assert.equal(exitCode, 0);
  } finally {
    process.chdir(originalCwd);
  }

  assert.equal(fs.existsSync(path.resolve(repoRoot, 'tmp/test_supervisor_validate_runs')), false);
});

test('supervisor mode can generate, approve, and execute a child plan', async (t) => {
  const repoRoot = mkRepo('agentflow-supervisor-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const mockBinDir = path.resolve(repoRoot, 'mockbin');
  installMockCodex(mockBinDir);
  const mockLog = path.resolve(repoRoot, 'mock_codex.log');
  const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');

  const plannerOutput = JSON.stringify({
    repos: { main: '.' },
    flow: [
      {
        type: 'command',
        id: 'child_echo',
        command: '/bin/sh',
        args: ['-c', 'echo supervisor_child_ok'],
      },
    ],
  });
  const planQaOutput = JSON.stringify({
    passed: true,
    score: 0.95,
    reasons: ['plan is acceptable'],
    hard_failures: [],
    required_fixes: [],
  });
  fs.writeFileSync(
    mockBehavior,
    JSON.stringify(
      {
        rules: [
          { match: 'SUPERVISOR_PLANNER_TEST', stdout: plannerOutput, exitCode: 0, sleepMs: 0 },
          { match: 'SUPERVISOR_PLAN_QA_TEST', stdout: planQaOutput, exitCode: 0, sleepMs: 0 },
        ],
        default: { exitCode: 0, sleepMs: 0 },
      },
      null,
      2,
    ),
    'utf8',
  );

  const stateDir = path.resolve(repoRoot, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.resolve(stateDir, 'mission_state.json'),
    JSON.stringify({
      objective: 'Test supervisor run',
      unknowns: ['none'],
      constraints: ['test-only'],
    }, null, 2),
    'utf8',
  );
  fs.writeFileSync(path.resolve(repoRoot, 'planner_prompt.md'), 'SUPERVISOR_PLANNER_TEST\n{{OUTPUT_PLAN_PATH}}\n', 'utf8');
  fs.writeFileSync(path.resolve(repoRoot, 'plan_qa_prompt.md'), 'SUPERVISOR_PLAN_QA_TEST\n{{PLAN_CANDIDATE_PATH}}\n', 'utf8');
  fs.writeFileSync(
    path.resolve(repoRoot, 'plan_qa_rubric.json'),
    JSON.stringify({ pass_threshold: 0.85 }, null, 2),
    'utf8',
  );
  fs.writeFileSync(
    path.resolve(repoRoot, 'agentflow.supervisor.json'),
    JSON.stringify(
      {
        prompts: {
          planner: 'planner_prompt.md',
          plan_qa: 'plan_qa_prompt.md',
        },
        rubrics: {
          plan_qa: 'plan_qa_rubric.json',
        },
        thresholds: {
          plan_qa_pass_score: 0.85,
          max_planner_revisions: 2,
        },
        paths: {
          mission_state: 'state/mission_state.json',
          plan_candidate: 'state/plan_candidate.generated.json',
          plan_rationale: 'state/plan_rationale.generated.md',
          plan_score: 'state/plan_score.generated.json',
          run_ledger: 'state/run_ledger.generated.jsonl',
          run_root: 'tmp/test_supervisor_runs',
        },
        execute_approved_plan: true,
      },
      null,
      2,
    ),
    'utf8',
  );

  await withPatchedEnv(
    {
      PATH: `${mockBinDir}${path.delimiter}${process.env.PATH || ''}`,
      MOCK_CODEX_LOG: mockLog,
      MOCK_CODEX_BEHAVIOR: mockBehavior,
    },
    async () => {
      const originalCwd = process.cwd();
      process.chdir(repoRoot);
      try {
        const exitCode = await main(['--supervise', 'state/mission_state.json']);
        assert.equal(exitCode, 0);
      } finally {
        process.chdir(originalCwd);
      }
    },
  );

  const generatedPlanPath = path.resolve(repoRoot, 'state/plan_candidate.generated.json');
  assert.ok(fs.existsSync(generatedPlanPath));
  const generatedPlan = JSON.parse(fs.readFileSync(generatedPlanPath, 'utf8'));
  assert.equal(generatedPlan.flow[0].id, 'child_echo');

  const planScore = JSON.parse(
    fs.readFileSync(path.resolve(repoRoot, 'state/plan_score.generated.json'), 'utf8'),
  );
  assert.equal(planScore.approved, true);
  assert.equal(planScore.score, 0.95);

  const ledgerRows = parseJsonLines(path.resolve(repoRoot, 'state/run_ledger.generated.jsonl'));
  assert.equal(ledgerRows.length, 1);
  assert.equal(ledgerRows[0].approved, true);
  assert.equal(ledgerRows[0].executed, true);
  assert.equal(ledgerRows[0].child_exit_code, 0);

  const childRunDir = getSingleRunDir(path.resolve(repoRoot, 'state/tmp/agentflow_runs'));
  const childState = JSON.parse(fs.readFileSync(path.resolve(childRunDir, 'run_state.json'), 'utf8'));
  const rows = Object.values(childState.tasks || {}) as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].taskId, 'child_echo');
  assert.equal(rows[0].status, 'DONE');
  const commandLog = fs.readFileSync(String(rows[0].logPath), 'utf8');
  assert.match(commandLog, /supervisor_child_ok/);
});

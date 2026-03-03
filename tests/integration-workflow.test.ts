import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { main } from '../src/cli.ts';
import { getSingleRunDir, installMockCodex, mkRepo, parseJsonLines, runOrThrow, withPatchedEnv } from './helpers.ts';

test('task-level provider/model overrides are applied per task', async (t) => {
  const repoRoot = mkRepo('agentflow-task-overrides-');
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

  const planPath = path.resolve(repoRoot, 'task_overrides_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify(
      {
        setup: 'task override behavior test',
        repos: { main: '.' },
        worktrees: false,
        provider: 'codex',
        model: 'gpt-5-nano',
        reasoning: 'xhigh',
        options: {
          run_root: 'tmp/test_task_overrides_runs',
          cleanup_worktrees: true,
        },
        limits: {
          worker_timeout_sec: 30,
          timeout_grace_sec: 1,
        },
        flow: [
          { type: 'task', id: 'default_model_task', prompt: 'use default model' },
          {
            type: 'task',
            id: 'override_model_task',
            prompt: 'use override model',
            provider: 'codex',
            model: 'gpt-5',
          },
        ],
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
  assert.equal(calls.length, 2);
  const byTask = new Map<string, Record<string, unknown>>();
  for (const call of calls) {
    byTask.set(String(call.taskId), call);
  }

  const defaultCall = byTask.get('default_model_task');
  const overrideCall = byTask.get('override_model_task');
  assert.ok(defaultCall);
  assert.ok(overrideCall);

  const defaultArgs = (defaultCall?.args || []) as string[];
  const overrideArgs = (overrideCall?.args || []) as string[];
  assert.ok(defaultArgs.includes('gpt-5-nano'));
  assert.ok(overrideArgs.includes('gpt-5'));
});

test('single-task happy path succeeds and persists DONE artifacts', async (t) => {
  const repoRoot = mkRepo('agentflow-happy-single-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const mockBinDir = path.resolve(repoRoot, 'mockbin');
  installMockCodex(mockBinDir);
  const mockLog = path.resolve(repoRoot, 'mock_codex.log');
  const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');
  fs.writeFileSync(
    mockBehavior,
    JSON.stringify(
      {
        default: { exitCode: 0, sleepMs: 25 },
      },
      null,
      2,
    ),
    'utf8',
  );

  const planPath = path.resolve(repoRoot, 'happy_single_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify(
      {
        setup: 'happy single test',
        repos: { main: '.' },
        worktrees: true,
        provider: 'codex',
        model: 'gpt-5-nano',
        reasoning: 'xhigh',
        options: {
          run_root: 'tmp/test_happy_single_runs',
          cleanup_worktrees: true,
        },
        limits: {
          worker_timeout_sec: 30,
          timeout_grace_sec: 1,
        },
        flow: [{ type: 'task', id: 'happy_task', prompt: 'complete successfully' }],
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
  assert.ok(args.includes('exec'));
  assert.ok(args.includes('-o'));
  assert.ok(args.includes('-m'));
  assert.ok(args.includes('gpt-5-nano'));
  assert.ok(args.includes('-c'));
  assert.ok(args.includes('model_reasoning_effort=xhigh'));

  const runBase = path.resolve(repoRoot, 'tmp/test_happy_single_runs');
  const runDir = getSingleRunDir(runBase);
  const runState = JSON.parse(fs.readFileSync(path.resolve(runDir, 'run_state.json'), 'utf8'));
  const taskRows = Object.values(runState.tasks || {}) as Array<Record<string, unknown>>;
  assert.equal(taskRows.length, 1);
  assert.equal(taskRows[0].status, 'DONE');
  assert.ok(fs.existsSync(String(taskRows[0].reportPath)));

  assert.ok(fs.existsSync(path.resolve(runDir, 'run_summary.md')));
  assert.ok(!fs.existsSync(path.resolve(runDir, 'run_events.jsonl')));
  assert.ok(!fs.existsSync(path.resolve(runDir, 'raw_thoughts.md')));
  const decisionTracePath = path.resolve(runDir, 'decision_trace.json');
  assert.ok(fs.existsSync(decisionTracePath));
  const decisionTrace = JSON.parse(fs.readFileSync(decisionTracePath, 'utf8'));
  assert.ok(Array.isArray(decisionTrace));
  const summaryText = fs.readFileSync(path.resolve(runDir, 'run_summary.md'), 'utf8');
  assert.match(summaryText, /## Latest Decisions/);

  const worktreeList = runOrThrow('git', ['worktree', 'list', '--porcelain'], repoRoot).stdout;
  const worktreeEntries = worktreeList
    .split('\n')
    .filter((line) => line.startsWith('worktree '));
  assert.equal(worktreeEntries.length, 1, worktreeList);
  const leftoverBranches = runOrThrow('git', ['branch', '--list', 'agentflow/*'], repoRoot).stdout.trim();
  assert.equal(leftoverBranches, '');
});

test('worktree_branch_template supports slash-free branch names', async (t) => {
  const repoRoot = mkRepo('agentflow-branch-template-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const mockBinDir = path.resolve(repoRoot, 'mockbin');
  installMockCodex(mockBinDir);
  const mockLog = path.resolve(repoRoot, 'mock_codex.log');
  const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');
  fs.writeFileSync(
    mockBehavior,
    JSON.stringify({ default: { exitCode: 0, sleepMs: 10 } }, null, 2),
    'utf8',
  );

  const planPath = path.resolve(repoRoot, 'branch_template_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify(
      {
        setup: 'branch template test',
        repos: { main: '.' },
        worktrees: true,
        provider: 'codex',
        model: 'gpt-5-nano',
        reasoning: 'xhigh',
        options: {
          run_root: 'tmp/test_branch_template_runs',
          cleanup_worktrees: false,
          worktree_branch_template: 'agentflow-{run_id}-r{repo}-g{group}-{kind_short}{node}-a{attempt}',
        },
        limits: {
          worker_timeout_sec: 30,
          timeout_grace_sec: 1,
        },
        flow: [{ type: 'task', id: 'happy_task', prompt: 'complete successfully' }],
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

  const slashBranches = runOrThrow('git', ['branch', '--list', 'agentflow/*'], repoRoot).stdout.trim();
  assert.equal(slashBranches, '');
  const hyphenBranches = runOrThrow('git', ['branch', '--list', 'agentflow-*'], repoRoot).stdout.trim();
  assert.match(hyphenBranches, /agentflow-/);
});

test('group(parallel=true) happy path succeeds with DONE results for all tasks', async (t) => {
  const repoRoot = mkRepo('agentflow-happy-parallel-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const mockBinDir = path.resolve(repoRoot, 'mockbin');
  installMockCodex(mockBinDir);
  const mockLog = path.resolve(repoRoot, 'mock_codex.log');
  const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');
  fs.writeFileSync(
    mockBehavior,
    JSON.stringify(
      {
        rules: [
          { match: 'Goal (fast_done)', exitCode: 0, sleepMs: 50 },
          { match: 'Goal (slow_done)', exitCode: 0, sleepMs: 250 },
        ],
        default: { exitCode: 0, sleepMs: 0 },
      },
      null,
      2,
    ),
    'utf8',
  );

  const planPath = path.resolve(repoRoot, 'happy_parallel_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify(
      {
        setup: 'happy group parallel test',
        repos: { main: '.' },
        worktrees: true,
        provider: 'codex',
        model: 'gpt-5-nano',
        reasoning: 'xhigh',
        on_failure: 'stop',
        limits: {
          max_retries: 0,
          retry_on: ['FAILED', 'TIMEOUT'],
          worker_timeout_sec: 30,
          timeout_grace_sec: 1,
        },
        options: {
          run_root: 'tmp/test_happy_parallel_runs',
          cleanup_worktrees: true,
        },
        flow: [
          {
            type: 'group',
            id: 'parallel_success_group',
            parallel: true,
            steps: [
              { type: 'task', id: 'fast_done', prompt: 'finish quickly' },
              { type: 'task', id: 'slow_done', prompt: 'finish eventually' },
            ],
          },
        ],
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
  assert.equal(calls.length, 2);

  const runBase = path.resolve(repoRoot, 'tmp/test_happy_parallel_runs');
  const runDir = getSingleRunDir(runBase);
  const runState = JSON.parse(fs.readFileSync(path.resolve(runDir, 'run_state.json'), 'utf8'));
  const taskRows = Object.values(runState.tasks || {}) as Array<Record<string, unknown>>;
  assert.equal(taskRows.length, 2);
  assert.ok(taskRows.every((row) => row.status === 'DONE'));
});

test('group(parallel=true) failure waits for sibling task completion and records both task outcomes', async (t) => {
  const repoRoot = mkRepo('agentflow-parallel-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const mockBinDir = path.resolve(repoRoot, 'mockbin');
  installMockCodex(mockBinDir);
  const mockLog = path.resolve(repoRoot, 'mock_codex.log');
  const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');
  fs.writeFileSync(
    mockBehavior,
    JSON.stringify(
      {
        rules: [
          { match: 'Goal (fast_fail)', exitCode: 1, sleepMs: 50, skipReport: true },
          { match: 'Goal (slow_done)', exitCode: 0, sleepMs: 1200 },
        ],
        default: { exitCode: 0, sleepMs: 0 },
      },
      null,
      2,
    ),
    'utf8',
  );

  const planPath = path.resolve(repoRoot, 'parallel_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify(
      {
        setup: 'group parallel test',
        repos: { main: '.' },
        worktrees: true,
        provider: 'codex',
        model: 'gpt-5-nano',
        reasoning: 'xhigh',
        on_failure: 'stop',
        limits: {
          max_retries: 0,
          retry_on: ['FAILED', 'TIMEOUT'],
          worker_timeout_sec: 30,
          timeout_grace_sec: 1,
        },
        options: {
          run_root: 'tmp/test_parallel_runs',
          cleanup_worktrees: true,
        },
        flow: [
          {
            type: 'group',
            id: 'parallel_tasks',
            parallel: true,
            steps: [
              { type: 'task', id: 'fast_fail', prompt: 'fail quickly' },
              { type: 'task', id: 'slow_done', prompt: 'finish after delay' },
            ],
          },
        ],
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
      const started = Date.now();
      const exitCode = await main(['--plan', planPath]);
      const elapsedMs = Date.now() - started;

      assert.equal(exitCode, 1);
      assert.ok(elapsedMs >= 1000, `group(parallel=true) flow exited too early: elapsed=${elapsedMs}ms`);
    },
  );

  const codexCalls = parseJsonLines(mockLog);
  assert.equal(codexCalls.length, 2);
  for (const call of codexCalls) {
    const args = (call.args || []) as string[];
    assert.ok(args.includes('exec'));
    assert.ok(args.includes('-o'));
    assert.ok(args.includes('-m'));
    assert.ok(args.includes('gpt-5-nano'));
    assert.ok(args.includes('-c'));
    assert.ok(args.includes('model_reasoning_effort=xhigh'));
  }

  const runBase = path.resolve(repoRoot, 'tmp/test_parallel_runs');
  const runDir = getSingleRunDir(runBase);
  const runState = JSON.parse(fs.readFileSync(path.resolve(runDir, 'run_state.json'), 'utf8'));
  const taskRows = Object.values(runState.tasks || {}) as Array<Record<string, unknown>>;
  assert.equal(taskRows.length, 2);
  const taskIds = taskRows.map((row) => String(row.taskId)).sort();
  assert.deepEqual(taskIds, ['fast_fail', 'slow_done']);

  const worktreeList = runOrThrow('git', ['worktree', 'list', '--porcelain'], repoRoot).stdout;
  const worktreeEntries = worktreeList
    .split('\n')
    .filter((line) => line.startsWith('worktree '));
  assert.equal(worktreeEntries.length, 1, worktreeList);

  const leftoverBranches = runOrThrow('git', ['branch', '--list', 'agentflow/*'], repoRoot).stdout.trim();
  assert.equal(leftoverBranches, '');
});

test('group(parallel=false) executes child steps sequentially in order', async (t) => {
  const repoRoot = mkRepo('agentflow-group-sequential-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const mockBinDir = path.resolve(repoRoot, 'mockbin');
  installMockCodex(mockBinDir);
  const mockLog = path.resolve(repoRoot, 'mock_codex.log');
  const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');
  fs.writeFileSync(
    mockBehavior,
    JSON.stringify(
      {
        rules: [
          { match: 'Goal (first_step)', exitCode: 0, sleepMs: 450 },
          { match: 'Goal (second_step)', exitCode: 0, sleepMs: 450 },
        ],
        default: { exitCode: 0, sleepMs: 0 },
      },
      null,
      2,
    ),
    'utf8',
  );

  const planPath = path.resolve(repoRoot, 'group_sequential_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify(
      {
        setup: 'group sequential happy path',
        repos: { main: '.' },
        worktrees: false,
        provider: 'codex',
        model: 'gpt-5-nano',
        reasoning: 'xhigh',
        options: {
          run_root: 'tmp/test_group_sequential_runs',
          cleanup_worktrees: true,
        },
        limits: {
          worker_timeout_sec: 30,
          timeout_grace_sec: 1,
        },
        flow: [
          {
            type: 'group',
            id: 'sequential_group',
            parallel: false,
            steps: [
              { type: 'task', id: 'first_step', prompt: 'execute first' },
              { type: 'task', id: 'second_step', prompt: 'execute second' },
            ],
          },
        ],
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
      const started = Date.now();
      const exitCode = await main(['--plan', planPath]);
      const elapsedMs = Date.now() - started;
      assert.equal(exitCode, 0);
      assert.ok(elapsedMs >= 800, `group(parallel=false) unexpectedly fast: elapsed=${elapsedMs}ms`);
    },
  );

  const codexCalls = parseJsonLines(mockLog);
  assert.equal(codexCalls.length, 2);
  assert.deepEqual(
    codexCalls.map((row) => String(row.taskId)),
    ['first_step', 'second_step'],
  );
});

test('worktrees=true carries forward successful sequential task changes', async (t) => {
  const repoRoot = mkRepo('agentflow-worktree-sequential-state-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const mockBinDir = path.resolve(repoRoot, 'mockbin');
  installMockCodex(mockBinDir);
  const mockLog = path.resolve(repoRoot, 'mock_codex.log');
  const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');
  fs.writeFileSync(
    mockBehavior,
    JSON.stringify(
      {
        rules: [
          { match: 'Goal (write_marker)', createFile: 'marker.txt', exitCode: 0 },
          { match: 'Goal (read_marker)', requireFile: 'marker.txt', missingExitCode: 17, exitCode: 0 },
        ],
        default: { exitCode: 0, sleepMs: 0 },
      },
      null,
      2,
    ),
    'utf8',
  );

  const planPath = path.resolve(repoRoot, 'worktree_sequential_state_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify(
      {
        setup: 'worktree sequential state carryover test',
        repos: { main: '.' },
        worktrees: true,
        provider: 'codex',
        model: 'gpt-5-nano',
        reasoning: 'xhigh',
        on_failure: 'stop',
        options: {
          run_root: 'tmp/test_worktree_sequential_state_runs',
          cleanup_worktrees: true,
        },
        limits: {
          worker_timeout_sec: 30,
          timeout_grace_sec: 1,
        },
        flow: [
          { type: 'task', id: 'write_marker', prompt: 'create marker in workspace' },
          { type: 'task', id: 'read_marker', prompt: 'verify marker from prior task' },
        ],
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

  const codexCalls = parseJsonLines(mockLog);
  assert.equal(codexCalls.length, 2);
  const firstCwd = String(codexCalls[0].cwd || '');
  const secondCwd = String(codexCalls[1].cwd || '');
  assert.notEqual(firstCwd, secondCwd, 'steps should run in distinct worktrees');

  const runBase = path.resolve(repoRoot, 'tmp/test_worktree_sequential_state_runs');
  const runDir = getSingleRunDir(runBase);
  const runState = JSON.parse(fs.readFileSync(path.resolve(runDir, 'run_state.json'), 'utf8'));
  const taskRows = Object.values(runState.tasks || {}) as Array<Record<string, unknown>>;
  assert.equal(taskRows.length, 2);
  assert.ok(taskRows.every((row) => row.status === 'DONE'));
});

test('worktrees=true uses deterministic latest base ref after parallel same-repo tasks', async (t) => {
  const repoRoot = mkRepo('agentflow-worktree-parallel-base-ref-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const mockBinDir = path.resolve(repoRoot, 'mockbin');
  installMockCodex(mockBinDir);
  const mockLog = path.resolve(repoRoot, 'mock_codex.log');
  const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');
  fs.writeFileSync(
    mockBehavior,
    JSON.stringify(
      {
        rules: [
          { match: 'Goal (slow_branch)', createFile: 'marker_slow.txt', sleepMs: 300, exitCode: 0 },
          { match: 'Goal (fast_branch)', createFile: 'marker_fast.txt', sleepMs: 10, exitCode: 0 },
          { match: 'Goal (verify_latest)', requireFile: 'marker_fast.txt', missingExitCode: 19, exitCode: 0 },
        ],
        default: { exitCode: 0, sleepMs: 0 },
      },
      null,
      2,
    ),
    'utf8',
  );

  const planPath = path.resolve(repoRoot, 'worktree_parallel_base_ref_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify(
      {
        setup: 'parallel worktree latest base-ref determinism test',
        repos: { main: '.' },
        worktrees: true,
        provider: 'codex',
        model: 'gpt-5-nano',
        reasoning: 'xhigh',
        on_failure: 'stop',
        options: {
          run_root: 'tmp/test_worktree_parallel_base_ref_runs',
          cleanup_worktrees: true,
        },
        limits: {
          worker_timeout_sec: 30,
          timeout_grace_sec: 1,
        },
        flow: [
          {
            type: 'group',
            id: 'parallel_same_repo',
            parallel: true,
            steps: [
              { type: 'task', id: 'slow_branch', prompt: 'write slow branch marker' },
              { type: 'task', id: 'fast_branch', prompt: 'write fast branch marker' },
            ],
          },
          { type: 'task', id: 'verify_latest', prompt: 'verify marker from selected latest branch' },
        ],
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

  const codexCalls = parseJsonLines(mockLog);
  assert.equal(codexCalls.length, 3);
  const byTask = new Map(codexCalls.map((row) => [String(row.taskId), row]));
  const verifyCall = byTask.get('verify_latest') as Record<string, unknown> | undefined;
  assert.ok(verifyCall);
});

test('group(parallel=true) can run without worktrees when tasks are independent', async (t) => {
  const repoRoot = mkRepo('agentflow-group-parallel-no-worktree-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const mockBinDir = path.resolve(repoRoot, 'mockbin');
  installMockCodex(mockBinDir);
  const mockLog = path.resolve(repoRoot, 'mock_codex.log');
  const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');
  fs.writeFileSync(
    mockBehavior,
    JSON.stringify(
      {
        rules: [
          { match: 'Goal (left_task)', exitCode: 0, sleepMs: 500 },
          { match: 'Goal (right_task)', exitCode: 0, sleepMs: 500 },
        ],
        default: { exitCode: 0, sleepMs: 0 },
      },
      null,
      2,
    ),
    'utf8',
  );

  const planPath = path.resolve(repoRoot, 'group_parallel_no_worktree_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify(
      {
        setup: 'group parallel no-worktree happy path',
        repos: { main: '.' },
        worktrees: false,
        provider: 'codex',
        model: 'gpt-5-nano',
        reasoning: 'xhigh',
        options: {
          run_root: 'tmp/test_group_parallel_no_worktree_runs',
          cleanup_worktrees: true,
        },
        limits: {
          worker_timeout_sec: 30,
          timeout_grace_sec: 1,
        },
        flow: [
          {
            type: 'group',
            id: 'parallel_group',
            parallel: true,
            steps: [
              { type: 'task', id: 'left_task', prompt: 'left side task' },
              { type: 'task', id: 'right_task', prompt: 'right side task' },
            ],
          },
        ],
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
      const started = Date.now();
      const exitCode = await main(['--plan', planPath]);
      const elapsedMs = Date.now() - started;
      assert.equal(exitCode, 0);
      assert.ok(elapsedMs < 900, `group(parallel=true) appears sequential: elapsed=${elapsedMs}ms`);
    },
  );

  const codexCalls = parseJsonLines(mockLog);
  assert.equal(codexCalls.length, 2);
});

test('loop with deterministic gate executes body and exits when gate passes', async (t) => {
  const repoRoot = mkRepo('agentflow-loop-det-gate-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const mockBinDir = path.resolve(repoRoot, 'mockbin');
  installMockCodex(mockBinDir);
  const mockLog = path.resolve(repoRoot, 'mock_codex.log');
  const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');
  fs.writeFileSync(
    mockBehavior,
    JSON.stringify({ default: { exitCode: 0, sleepMs: 0 } }),
    'utf8',
  );

  const gateSentinel = path.resolve(repoRoot, 'gate_sentinel');
  const gateScript = path.resolve(repoRoot, 'gate.sh');
  fs.writeFileSync(
    gateScript,
    `#!/bin/sh
if [ -f "${gateSentinel}" ]; then
  echo '{"passed":true,"score":1,"reasons":[]}'
else
  touch "${gateSentinel}"
  echo '{"passed":false,"score":0,"reasons":["not yet"]}'
fi
`,
    { mode: 0o755 },
  );

  const planPath = path.resolve(repoRoot, 'loop_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify({
      setup: 'loop deterministic gate test',
      repos: { main: '.' },
      worktrees: false,
      provider: 'codex',
      model: 'gpt-5-nano',
      reasoning: 'xhigh',
      options: { run_root: 'tmp/test_loop_runs' },
      limits: { worker_timeout_sec: 30, timeout_grace_sec: 1 },
      flow: [
        {
          type: 'loop',
          id: 'improve_loop',
          max_iterations: 3,
          gate: {
            type: 'deterministic',
            command: '/bin/sh',
            args: [gateScript],
          },
          body: [
            { type: 'task', id: 'loop_task', prompt: 'improve the code' },
          ],
        },
      ],
    }),
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

  const codexCalls = parseJsonLines(mockLog);
  assert.equal(codexCalls.length, 1, 'loop body task should have executed exactly once before gate passed');

  const runBase = path.resolve(repoRoot, 'tmp/test_loop_runs');
  const runDir = getSingleRunDir(runBase);
  const groupDirs = fs.readdirSync(runDir).filter((d) => d.startsWith('group_01')).sort();
  assert.ok(groupDirs.length > 0, 'expected first loop body group directory');
  const taskDirs = fs.readdirSync(path.resolve(runDir, groupDirs[0]));
  const loopTaskDir = taskDirs.find((d) => d.includes('loop-task'));
  assert.ok(loopTaskDir, 'expected loop_task artifact directory');
  const promptText = fs.readFileSync(path.resolve(runDir, groupDirs[0], loopTaskDir, 'prompt.md'), 'utf8');
  assert.match(promptText, /## Gate Feedback To Address/);
  assert.match(promptText, /not yet/);
});

test('multi-repo plan with two repos targets different repos per task', async (t) => {
  const repoA = mkRepo('agentflow-multirepo-api-');
  const repoB = mkRepo('agentflow-multirepo-web-');
  t.after(() => {
    fs.rmSync(repoA, { recursive: true, force: true });
    fs.rmSync(repoB, { recursive: true, force: true });
  });

  const mockBinDir = path.resolve(repoA, 'mockbin');
  installMockCodex(mockBinDir);
  const mockLog = path.resolve(repoA, 'mock_codex.log');
  const mockBehavior = path.resolve(repoA, 'mock_behavior.json');
  fs.writeFileSync(
    mockBehavior,
    JSON.stringify({ default: { exitCode: 0, sleepMs: 0 } }),
    'utf8',
  );

  const planPath = path.resolve(repoA, 'multi_repo_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify({
      setup: 'multi-repo integration test',
      repos: { api: '.', web: repoB },
      worktrees: false,
      provider: 'codex',
      model: 'gpt-5-nano',
      reasoning: 'xhigh',
      options: { run_root: 'tmp/test_multi_repo_runs' },
      limits: { worker_timeout_sec: 30, timeout_grace_sec: 1 },
      flow: [
        { type: 'task', id: 'api_task', repo: 'api', prompt: 'update API schema' },
        { type: 'task', id: 'web_task', repo: 'web', prompt: 'update web client' },
      ],
    }),
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

  const codexCalls = parseJsonLines(mockLog);
  assert.equal(codexCalls.length, 2, 'both tasks should have been invoked');
  const taskIds = codexCalls.map((c) => c.taskId).sort();
  assert.deepEqual(taskIds, ['api_task', 'web_task']);

  const apiCall = codexCalls.find((c) => c.taskId === 'api_task');
  const webCall = codexCalls.find((c) => c.taskId === 'web_task');
  assert.ok(apiCall);
  assert.ok(webCall);
  assert.equal(apiCall.cwd, fs.realpathSync(repoA), 'api task should run in repo A');
  assert.equal(webCall.cwd, fs.realpathSync(repoB), 'web task should run in repo B');

  const apiReportPath = path.resolve(String(apiCall.reportPath || ''));
  const webReportPath = path.resolve(String(webCall.reportPath || ''));
  const apiRoot = path.resolve(repoA);
  const webRoot = path.resolve(repoB);
  assert.ok(
    apiReportPath === apiRoot || apiReportPath.startsWith(apiRoot + path.sep),
    `api task report path should be inside repo A, got: ${apiReportPath}`,
  );
  assert.ok(
    webReportPath === webRoot || webReportPath.startsWith(webRoot + path.sep),
    `web task report path should be inside repo B, got: ${webReportPath}`,
  );

  const runBase = path.resolve(repoA, 'tmp/test_multi_repo_runs');
  const runDir = getSingleRunDir(runBase);
  const runState = JSON.parse(fs.readFileSync(path.resolve(runDir, 'run_state.json'), 'utf8'));
  const taskRows = Object.values(runState.tasks || {}) as Array<Record<string, unknown>>;
  assert.equal(taskRows.length, 2);
  for (const row of taskRows) {
    assert.ok(fs.existsSync(String(row.reportPath)), `missing report artifact: ${String(row.reportPath)}`);
    assert.ok(fs.existsSync(String(row.summaryPath)), `missing summary artifact: ${String(row.summaryPath)}`);
  }
});

test('loop gate repo scope resolves required artifacts and cwd against selected repo', async (t) => {
  const repoA = mkRepo('agentflow-gate-repo-api-');
  const repoB = mkRepo('agentflow-gate-repo-web-');
  t.after(() => {
    fs.rmSync(repoA, { recursive: true, force: true });
    fs.rmSync(repoB, { recursive: true, force: true });
  });

  const mockBinDir = path.resolve(repoA, 'mockbin');
  installMockCodex(mockBinDir);
  const mockLog = path.resolve(repoA, 'mock_codex.log');
  const mockBehavior = path.resolve(repoA, 'mock_behavior.json');
  fs.writeFileSync(
    mockBehavior,
    JSON.stringify({ default: { exitCode: 0, sleepMs: 0 } }),
    'utf8',
  );

  fs.writeFileSync(path.resolve(repoB, 'web_ready.txt'), 'ready', 'utf8');

  const planPath = path.resolve(repoA, 'gate_repo_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify({
      setup: 'multi-repo gate scope test',
      repos: { api: '.', web: repoB },
      worktrees: false,
      provider: 'codex',
      model: 'gpt-5-nano',
      reasoning: 'xhigh',
      options: { run_root: 'tmp/test_gate_repo_runs' },
      limits: { worker_timeout_sec: 30, timeout_grace_sec: 1 },
      flow: [
        {
          type: 'loop',
          id: 'repo_scoped_gate_loop',
          max_iterations: 1,
          gate: {
            type: 'deterministic',
            repo: 'web',
            command: '/bin/sh',
            args: ['-c', 'if [ -f web_ready.txt ]; then echo \'{"passed":true,"score":1,"reasons":[]}\' ; else echo \'{"passed":false,"score":0,"reasons":["missing web_ready.txt"]}\' ; fi'],
            required_artifacts: ['web_ready.txt'],
          },
          body: [
            { type: 'task', id: 'should_not_run', repo: 'api', prompt: 'this task should never run' },
          ],
        },
      ],
    }),
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

  const codexCalls = parseJsonLines(mockLog);
  assert.equal(codexCalls.length, 0, 'loop body task should not run because pre-body gate passed');
});

test('command node success writes command artifacts and DONE state', async (t) => {
  const repoRoot = mkRepo('agentflow-command-success-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const planPath = path.resolve(repoRoot, 'command_success_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify({
      setup: 'command success integration test',
      repos: { main: '.' },
      worktrees: false,
      on_failure: 'stop',
      options: { run_root: 'tmp/test_command_success_runs' },
      limits: { worker_timeout_sec: 30, timeout_grace_sec: 1 },
      flow: [
        {
          type: 'command',
          id: 'echo_ok',
          repo: 'main',
          command: '/bin/sh',
          args: ['-c', 'echo command_ok'],
          cwd: '.',
        },
      ],
    }),
    'utf8',
  );

  const exitCode = await main(['--plan', planPath]);
  assert.equal(exitCode, 0);

  const runBase = path.resolve(repoRoot, 'tmp/test_command_success_runs');
  const runDir = getSingleRunDir(runBase);
  const state = JSON.parse(fs.readFileSync(path.resolve(runDir, 'run_state.json'), 'utf8'));
  const taskRows = Object.values(state.tasks || {}) as Array<Record<string, unknown>>;
  assert.equal(taskRows.length, 1);
  const row = taskRows[0];
  assert.equal(row.taskId, 'echo_ok');
  assert.equal(row.status, 'DONE');
  assert.equal(row.provider, null);
  assert.ok(fs.existsSync(String(row.logPath)));
  assert.ok(fs.existsSync(String(row.reportPath)));
  assert.ok(fs.existsSync(String(row.summaryPath)));

  const taskDir = path.dirname(String(row.reportPath));
  const resultPath = path.resolve(taskDir, 'command_result.json');
  assert.ok(fs.existsSync(resultPath));
  const commandResult = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  assert.equal(commandResult.task_id, 'echo_ok');
  assert.equal(commandResult.status, 'DONE');
  assert.equal(commandResult.exit_code, 0);
  assert.equal(commandResult.timed_out, false);

  const summaryText = fs.readFileSync(String(row.summaryPath), 'utf8');
  assert.match(summaryText, /Command `echo_ok` finished with status `DONE`/);
});

test('worktrees=true runs command nodes in isolated worktrees with state carryover', async (t) => {
  const repoRoot = mkRepo('agentflow-command-worktree-carry-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const planPath = path.resolve(repoRoot, 'command_worktree_carry_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify({
      setup: 'command worktree carryover test',
      repos: { main: '.' },
      worktrees: true,
      on_failure: 'stop',
      options: { run_root: 'tmp/test_command_worktree_carry_runs', cleanup_worktrees: true },
      limits: { worker_timeout_sec: 30, timeout_grace_sec: 1 },
      flow: [
        {
          type: 'command',
          id: 'write_marker',
          repo: 'main',
          command: '/bin/sh',
          args: ['-c', 'echo marker > carry_marker.txt'],
        },
        {
          type: 'command',
          id: 'read_marker',
          repo: 'main',
          command: '/bin/sh',
          args: ['-c', 'test -f carry_marker.txt'],
        },
      ],
    }),
    'utf8',
  );

  const exitCode = await main(['--plan', planPath]);
  assert.equal(exitCode, 0);

  const runBase = path.resolve(repoRoot, 'tmp/test_command_worktree_carry_runs');
  const runDir = getSingleRunDir(runBase);
  const state = JSON.parse(fs.readFileSync(path.resolve(runDir, 'run_state.json'), 'utf8'));
  const rows = Object.values(state.tasks || {}) as Array<Record<string, unknown>>;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.status === 'DONE'));

  const byTask = new Map(rows.map((row) => [String(row.taskId), row]));
  const writeRow = byTask.get('write_marker');
  const readRow = byTask.get('read_marker');
  assert.ok(writeRow);
  assert.ok(readRow);
  assert.notEqual(String(writeRow?.cwd || ''), String(readRow?.cwd || ''), 'commands should run in distinct worktrees');
});

test('command node retries on FAILED and run succeeds on second attempt', async (t) => {
  const repoRoot = mkRepo('agentflow-command-retry-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const sentinelPath = path.resolve(repoRoot, 'retry_once_sentinel');
  const planPath = path.resolve(repoRoot, 'command_retry_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify({
      setup: 'command retry integration test',
      repos: { main: '.' },
      worktrees: false,
      on_failure: 'stop',
      options: { run_root: 'tmp/test_command_retry_runs' },
      limits: {
        worker_timeout_sec: 30,
        timeout_grace_sec: 1,
        max_retries: 1,
        retry_on: ['FAILED'],
      },
      flow: [
        {
          type: 'command',
          id: 'flaky_command',
          repo: 'main',
          command: '/bin/sh',
          args: [
            '-c',
            `if [ ! -f "${sentinelPath}" ]; then touch "${sentinelPath}"; echo first_fail; exit 2; fi; echo second_ok; exit 0`,
          ],
        },
      ],
    }),
    'utf8',
  );

  const exitCode = await main(['--plan', planPath]);
  assert.equal(exitCode, 0);

  const runBase = path.resolve(repoRoot, 'tmp/test_command_retry_runs');
  const runDir = getSingleRunDir(runBase);
  const state = JSON.parse(fs.readFileSync(path.resolve(runDir, 'run_state.json'), 'utf8'));
  const taskRows = Object.values(state.tasks || {}) as Array<Record<string, unknown>>;
  assert.equal(taskRows.length, 2);
  const statuses = taskRows.map((row) => String(row.status)).sort();
  assert.deepEqual(statuses, ['DONE', 'FAILED']);

  const decisionTrace = JSON.parse(fs.readFileSync(path.resolve(runDir, 'decision_trace.json'), 'utf8'));
  const retryEntry = (decisionTrace as Array<Record<string, unknown>>).find(
    (entry) =>
      entry.type === 'task_retry' &&
      typeof entry.detail === 'object' &&
      entry.detail !== null &&
      (entry.detail as Record<string, unknown>).taskId === 'flaky_command',
  );
  assert.ok(retryEntry, 'expected a retry decision for flaky_command');
});

test('command node timeout marks FAILED with timeout metadata', async (t) => {
  const repoRoot = mkRepo('agentflow-command-timeout-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const planPath = path.resolve(repoRoot, 'command_timeout_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify({
      setup: 'command timeout integration test',
      repos: { main: '.' },
      worktrees: false,
      on_failure: 'continue',
      options: { run_root: 'tmp/test_command_timeout_runs' },
      limits: {
        worker_timeout_sec: 1,
        timeout_grace_sec: 1,
      },
      flow: [
        {
          type: 'command',
          id: 'slow_command',
          repo: 'main',
          command: '/bin/sh',
          args: ['-c', 'sleep 3'],
        },
      ],
    }),
    'utf8',
  );

  const exitCode = await main(['--plan', planPath]);
  assert.equal(exitCode, 1);

  const runBase = path.resolve(repoRoot, 'tmp/test_command_timeout_runs');
  const runDir = getSingleRunDir(runBase);
  const state = JSON.parse(fs.readFileSync(path.resolve(runDir, 'run_state.json'), 'utf8'));
  const rows = Object.values(state.tasks || {}) as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.taskId, 'slow_command');
  assert.equal(row.status, 'FAILED');
  assert.equal(row.timedOut, true);
  assert.equal(row.failureReason, 'timed_out');
  assert.equal(row.timeoutClassification, 'timeout');

  const resultPath = path.resolve(path.dirname(String(row.reportPath)), 'command_result.json');
  const commandResult = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  assert.equal(commandResult.status, 'FAILED');
  assert.equal(commandResult.timed_out, true);
  assert.equal(commandResult.timeout_classification, 'timeout');
});

test('command summary is available to downstream task via context_from', async (t) => {
  const repoRoot = mkRepo('agentflow-command-context-from-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const mockBinDir = path.resolve(repoRoot, 'mockbin');
  installMockCodex(mockBinDir);
  const mockLog = path.resolve(repoRoot, 'mock_codex.log');
  const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');
  fs.writeFileSync(
    mockBehavior,
    JSON.stringify({ default: { exitCode: 0, sleepMs: 0 } }),
    'utf8',
  );

  const planPath = path.resolve(repoRoot, 'command_context_from_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify({
      setup: 'command context_from integration test',
      repos: { main: '.' },
      worktrees: false,
      provider: 'codex',
      model: 'gpt-5-nano',
      reasoning: 'xhigh',
      on_failure: 'stop',
      options: { run_root: 'tmp/test_command_context_runs' },
      limits: { worker_timeout_sec: 30, timeout_grace_sec: 1 },
      flow: [
        {
          type: 'command',
          id: 'collect_status',
          repo: 'main',
          command: '/bin/sh',
          args: ['-c', 'echo lint_clean'],
        },
        {
          type: 'task',
          id: 'consume_status',
          repo: 'main',
          prompt: 'Use the prior command summary and proceed.',
          context_from: ['collect_status'],
        },
      ],
    }),
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

  const codexCalls = parseJsonLines(mockLog);
  assert.equal(codexCalls.length, 1);
  assert.equal(codexCalls[0].taskId, 'consume_status');

  const runBase = path.resolve(repoRoot, 'tmp/test_command_context_runs');
  const runDir = getSingleRunDir(runBase);
  const runState = JSON.parse(fs.readFileSync(path.resolve(runDir, 'run_state.json'), 'utf8'));
  const rows = Object.values(runState.tasks || {}) as Array<Record<string, unknown>>;
  const taskRow = rows.find((row) => row.taskId === 'consume_status');
  assert.ok(taskRow);
  const promptText = fs.readFileSync(String(taskRow?.promptPath), 'utf8');
  assert.match(promptText, /collect_status/);
  assert.match(promptText, /Command `collect_status` finished with status `DONE`/);
});

test('parallel groups reject cross-branch context_from dependencies', async (t) => {
  const repoRoot = mkRepo('agentflow-context-from-parallel-invalid-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const planPath = path.resolve(repoRoot, 'context_from_parallel_invalid_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify({
      setup: 'context_from cross-branch dependency should be rejected',
      repos: { main: '.' },
      worktrees: false,
      provider: 'codex',
      model: 'gpt-5-nano',
      reasoning: 'xhigh',
      on_failure: 'stop',
      options: { run_root: 'tmp/test_context_from_parallel_invalid_runs' },
      limits: { worker_timeout_sec: 30, timeout_grace_sec: 1 },
      flow: [
        {
          type: 'group',
          id: 'parallel_stage',
          parallel: true,
          steps: [
            {
              type: 'command',
              id: 'collect_parallel_status',
              repo: 'main',
              command: '/bin/sh',
              args: ['-c', 'echo parallel_ready'],
            },
            {
              type: 'task',
              id: 'consume_parallel_status',
              repo: 'main',
              prompt: 'Use the command summary.',
              context_from: ['collect_parallel_status'],
            },
          ],
        },
      ],
    }),
    'utf8',
  );

  const validateExit = await main(['--plan', planPath, '--validate']);
  assert.equal(validateExit, 1);

  const runExit = await main(['--plan', planPath]);
  assert.equal(runExit, 1);

  const runBase = path.resolve(repoRoot, 'tmp/test_context_from_parallel_invalid_runs');
  assert.ok(!fs.existsSync(runBase), 'invalid plan should fail before creating run directories');
});

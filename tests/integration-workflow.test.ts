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
  assert.ok(!fs.existsSync(path.resolve(runDir, 'decision_trace.json')));

  const worktreeList = runOrThrow('git', ['worktree', 'list', '--porcelain'], repoRoot).stdout;
  const worktreeEntries = worktreeList
    .split('\n')
    .filter((line) => line.startsWith('worktree '));
  assert.equal(worktreeEntries.length, 1, worktreeList);
  const leftoverBranches = runOrThrow('git', ['branch', '--list', 'agentflow/*'], repoRoot).stdout.trim();
  assert.equal(leftoverBranches, '');
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
});

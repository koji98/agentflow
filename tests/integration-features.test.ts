import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { main } from '../src/cli.ts';
import { getSingleRunDir, installMockCodex, mkRepo, parseJsonLines, withPatchedEnv } from './helpers.ts';

test('--validate succeeds for valid plan and exits 0', async (t) => {
  const repoRoot = mkRepo('agentflow-validate-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const planPath = path.resolve(repoRoot, 'valid_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify({
      repo: '.',
      provider: 'codex',
      flow: [{ type: 'task', id: 'task_a', prompt: 'do something' }],
    }),
    'utf8',
  );

  const exitCode = await main(['--plan', planPath, '--validate']);
  assert.equal(exitCode, 0);

  const runBase = path.resolve(repoRoot, 'tmp/agentflow_runs');
  assert.ok(!fs.existsSync(runBase), 'validate should not create any run directories');
});

test('--validate fails for invalid plan and exits 1', async () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentflow-validate-bad-'));
  const planPath = path.resolve(repoRoot, 'bad_plan.json');
  fs.writeFileSync(planPath, JSON.stringify({ bad_key: true }), 'utf8');

  const exitCode = await main(['--plan', planPath, '--validate']);
  assert.equal(exitCode, 1);
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('--resume skips completed tasks and re-runs failed ones', async (t) => {
  const repoRoot = mkRepo('agentflow-resume-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const mockBinDir = path.resolve(repoRoot, 'mockbin');
  installMockCodex(mockBinDir);
  const mockLog = path.resolve(repoRoot, 'mock_codex.log');
  const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');

  fs.writeFileSync(
    mockBehavior,
    JSON.stringify({
      rules: [
        { match: 'Goal (task_b)', exitCode: 1, skipReport: true },
      ],
      default: { exitCode: 0 },
    }),
    'utf8',
  );

  const planPath = path.resolve(repoRoot, 'resume_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify({
      setup: 'resume test',
      repo: '.',
      worktrees: true,
      provider: 'codex',
      model: 'gpt-5-nano',
      reasoning: 'xhigh',
      on_failure: 'stop',
      options: {
        run_root: 'tmp/test_resume_runs',
      },
      limits: {
        worker_timeout_sec: 30,
        timeout_grace_sec: 1,
      },
      flow: [
        { type: 'task', id: 'task_a', prompt: 'do task A' },
        { type: 'task', id: 'task_b', prompt: 'do task B' },
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
      const exitCode1 = await main(['--plan', planPath]);
      assert.equal(exitCode1, 1, 'first run should fail because task_b fails');
    },
  );

  const runBase = path.resolve(repoRoot, 'tmp/test_resume_runs');
  const runDir = getSingleRunDir(runBase);
  const state1 = JSON.parse(fs.readFileSync(path.resolve(runDir, 'run_state.json'), 'utf8'));
  const rows1 = Object.values(state1.tasks) as Array<Record<string, unknown>>;
  const doneRows = rows1.filter((r) => r.status === 'DONE');
  const failedRows = rows1.filter((r) => r.status === 'FAILED');
  assert.equal(doneRows.length, 1, 'task_a should be DONE');
  assert.equal(failedRows.length, 1, 'task_b should be FAILED');

  fs.writeFileSync(
    mockBehavior,
    JSON.stringify({ default: { exitCode: 0 } }),
    'utf8',
  );
  if (fs.existsSync(mockLog)) fs.unlinkSync(mockLog);

  await withPatchedEnv(
    {
      PATH: `${mockBinDir}${path.delimiter}${process.env.PATH || ''}`,
      MOCK_CODEX_LOG: mockLog,
      MOCK_CODEX_BEHAVIOR: mockBehavior,
    },
    async () => {
      const exitCode2 = await main(['--plan', planPath, '--resume', runDir]);
      assert.equal(exitCode2, 0, 'resumed run should succeed');
    },
  );

  const resumeCalls = parseJsonLines(mockLog);
  assert.equal(resumeCalls.length, 1, 'only task_b should have been executed on resume');
  const resumedTaskId = (resumeCalls[0].taskId || '') as string;
  assert.equal(resumedTaskId, 'task_b', 'the re-executed task should be task_b');
});

test('progress tag appears in task execution log', async (t) => {
  const repoRoot = mkRepo('agentflow-progress-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const mockBinDir = path.resolve(repoRoot, 'mockbin');
  installMockCodex(mockBinDir);
  const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');
  fs.writeFileSync(mockBehavior, JSON.stringify({ default: { exitCode: 0 } }), 'utf8');

  const planPath = path.resolve(repoRoot, 'progress_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify({
      setup: 'progress test',
      repo: '.',
      provider: 'codex',
      model: 'gpt-5-nano',
      reasoning: 'xhigh',
      worktrees: true,
      options: { run_root: 'tmp/test_progress_runs' },
      limits: { worker_timeout_sec: 30, timeout_grace_sec: 1 },
      flow: [
        { type: 'task', id: 'p1', prompt: 'task one' },
        { type: 'task', id: 'p2', prompt: 'task two' },
      ],
    }),
    'utf8',
  );

  const logLines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    logLines.push(args.map(String).join(' '));
  };

  await withPatchedEnv(
    {
      PATH: `${mockBinDir}${path.delimiter}${process.env.PATH || ''}`,
      MOCK_CODEX_BEHAVIOR: mockBehavior,
    },
    async () => {
      const exitCode = await main(['--plan', planPath]);
      assert.equal(exitCode, 0);
    },
  );

  console.log = origLog;

  const progressLines = logLines.filter((l) => /^\[\d+\/\d+\]/.test(l));
  assert.ok(progressLines.length >= 2, `expected progress lines, got: ${JSON.stringify(progressLines)}`);
  assert.ok(progressLines.some((l) => l.startsWith('[1/2]')), 'should have [1/2] prefix');
  assert.ok(progressLines.some((l) => l.startsWith('[2/2]')), 'should have [2/2] prefix');
});

test('max_retries: 1 with on_failure: stop retries before stopping', async (t) => {
  const repoRoot = mkRepo('agentflow-retry-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const mockBinDir = path.resolve(repoRoot, 'mockbin');
  installMockCodex(mockBinDir);
  const mockLog = path.resolve(repoRoot, 'mock_codex.log');
  const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');
  const onceFile = path.resolve(repoRoot, 'fail_once_sentinel');

  fs.writeFileSync(
    mockBehavior,
    JSON.stringify({
      rules: [
        { match: 'Goal (retry_task)', exitCode: 1, skipReport: true, onceFile },
      ],
      default: { exitCode: 0 },
    }),
    'utf8',
  );

  const planPath = path.resolve(repoRoot, 'retry_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify({
      setup: 'retry test',
      repo: '.',
      worktrees: false,
      provider: 'codex',
      model: 'gpt-5-nano',
      reasoning: 'xhigh',
      on_failure: 'stop',
      options: { run_root: 'tmp/test_retry_runs' },
      limits: {
        worker_timeout_sec: 30,
        timeout_grace_sec: 1,
        max_retries: 1,
        retry_on: ['FAILED'],
      },
      flow: [
        { type: 'task', id: 'retry_task', prompt: 'do something flaky' },
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
      await main(['--plan', planPath]);
    },
  );

  const codexCalls = parseJsonLines(mockLog);
  assert.equal(codexCalls.length, 2, 'codex should have been invoked twice (fail + succeed) even with on_failure: stop');

  const runBase = path.resolve(repoRoot, 'tmp/test_retry_runs');
  const runDir = getSingleRunDir(runBase);
  const state = JSON.parse(fs.readFileSync(path.resolve(runDir, 'run_state.json'), 'utf8'));
  const taskRows = Object.values(state.tasks) as Array<Record<string, unknown>>;
  const doneRow = taskRows.find((r) => r.status === 'DONE');
  assert.ok(doneRow, 'task should have a DONE row from the successful retry attempt');
});

test('max_retries exhausted with on_failure: stop stops the run', async (t) => {
  const repoRoot = mkRepo('agentflow-retry-stop-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const mockBinDir = path.resolve(repoRoot, 'mockbin');
  installMockCodex(mockBinDir);
  const mockLog = path.resolve(repoRoot, 'mock_codex.log');
  const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');

  fs.writeFileSync(
    mockBehavior,
    JSON.stringify({
      rules: [{ match: 'Goal (always_fail)', exitCode: 1, skipReport: true }],
      default: { exitCode: 0 },
    }),
    'utf8',
  );

  const planPath = path.resolve(repoRoot, 'retry_stop_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify({
      setup: 'retry stop test',
      repo: '.',
      worktrees: false,
      provider: 'codex',
      model: 'gpt-5-nano',
      reasoning: 'xhigh',
      on_failure: 'stop',
      options: { run_root: 'tmp/test_retry_stop_runs' },
      limits: {
        worker_timeout_sec: 30,
        timeout_grace_sec: 1,
        max_retries: 1,
        retry_on: ['FAILED'],
      },
      flow: [
        { type: 'task', id: 'always_fail', prompt: 'will always fail' },
        { type: 'task', id: 'never_run', prompt: 'should never execute' },
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
      assert.equal(exitCode, 1, 'run should fail after retries exhausted');
    },
  );

  const codexCalls = parseJsonLines(mockLog);
  assert.equal(codexCalls.length, 2, 'codex invoked twice: initial attempt + 1 retry');
  const invokedTaskIds = codexCalls.map((c) => c.taskId);
  assert.ok(!invokedTaskIds.includes('never_run'), 'second task should not run after stop');
});

test('worker timeout kills task and marks it FAILED/timed_out', async (t) => {
  const repoRoot = mkRepo('agentflow-timeout-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const mockBinDir = path.resolve(repoRoot, 'mockbin');
  installMockCodex(mockBinDir);
  const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');
  fs.writeFileSync(
    mockBehavior,
    JSON.stringify({
      rules: [{ match: 'Goal (slow_task)', exitCode: 0, sleepMs: 10000 }],
      default: { exitCode: 0 },
    }),
    'utf8',
  );

  const planPath = path.resolve(repoRoot, 'timeout_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify({
      setup: 'timeout test',
      repo: '.',
      worktrees: false,
      provider: 'codex',
      model: 'gpt-5-nano',
      reasoning: 'xhigh',
      on_failure: 'continue',
      options: { run_root: 'tmp/test_timeout_runs' },
      limits: {
        worker_timeout_sec: 1,
        timeout_grace_sec: 1,
      },
      flow: [
        { type: 'task', id: 'slow_task', prompt: 'do something very slow' },
      ],
    }),
    'utf8',
  );

  await withPatchedEnv(
    {
      PATH: `${mockBinDir}${path.delimiter}${process.env.PATH || ''}`,
      MOCK_CODEX_BEHAVIOR: mockBehavior,
    },
    async () => {
      const exitCode = await main(['--plan', planPath]);
      assert.equal(exitCode, 1, 'run should fail due to timeout');
    },
  );

  const runBase = path.resolve(repoRoot, 'tmp/test_timeout_runs');
  const runDir = getSingleRunDir(runBase);
  const state = JSON.parse(fs.readFileSync(path.resolve(runDir, 'run_state.json'), 'utf8'));
  const taskRows = Object.values(state.tasks) as Array<Record<string, unknown>>;
  const timedOutRow = taskRows.find((r) => r.timedOut === true);
  assert.ok(timedOutRow, 'should have a timed-out task row');
  assert.equal(timedOutRow.status, 'FAILED');
  assert.equal(timedOutRow.failureReason, 'timed_out');
});

test('max_failures terminates run when exceeded', async (t) => {
  const repoRoot = mkRepo('agentflow-maxfail-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const mockBinDir = path.resolve(repoRoot, 'mockbin');
  installMockCodex(mockBinDir);
  const mockLog = path.resolve(repoRoot, 'mock_codex.log');
  const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');
  fs.writeFileSync(
    mockBehavior,
    JSON.stringify({
      rules: [
        { match: 'Goal (fail_a)', exitCode: 1, skipReport: true },
        { match: 'Goal (fail_b)', exitCode: 1, skipReport: true },
      ],
      default: { exitCode: 0 },
    }),
    'utf8',
  );

  const planPath = path.resolve(repoRoot, 'maxfail_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify({
      setup: 'max_failures test',
      repo: '.',
      worktrees: false,
      provider: 'codex',
      model: 'gpt-5-nano',
      reasoning: 'xhigh',
      on_failure: 'continue',
      options: { run_root: 'tmp/test_maxfail_runs' },
      limits: {
        worker_timeout_sec: 30,
        timeout_grace_sec: 1,
        max_failures: 1,
      },
      flow: [
        { type: 'task', id: 'fail_a', prompt: 'will fail a' },
        { type: 'task', id: 'fail_b', prompt: 'will fail b' },
        { type: 'task', id: 'should_not_run', prompt: 'should never run' },
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
      assert.equal(exitCode, 1, 'run should fail');
    },
  );

  const codexCalls = parseJsonLines(mockLog);
  const invokedTaskIds = codexCalls.map((c) => c.taskId);
  assert.ok(!invokedTaskIds.includes('should_not_run'), 'third task should not have been invoked');
  assert.equal(codexCalls.length, 2, 'only 2 tasks should have been invoked before abort');
});

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { main } from '../src/cli.ts';
import {
  getSingleRunDir,
  installMockAgent,
  installMockCodex,
  mkRepo,
  parseJsonLines,
  runOrThrow,
  withPatchedEnv,
  WORKSPACE_ROOT,
} from './helpers.ts';

test('cursor provider single-task happy path succeeds', async (t) => {
  const repoRoot = mkRepo('agentflow-cursor-happy-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const mockBinDir = path.resolve(repoRoot, 'mockbin');
  installMockAgent(mockBinDir);
  const mockLog = path.resolve(repoRoot, 'mock_agent.log');
  const mockBehavior = path.resolve(repoRoot, 'mock_agent_behavior.json');
  fs.writeFileSync(
    mockBehavior,
    JSON.stringify({ default: { exitCode: 0, sleepMs: 25 } }, null, 2),
    'utf8',
  );

  const planPath = path.resolve(repoRoot, 'cursor_happy_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify(
      {
        setup: 'cursor happy path test',
        repos: { main: '.' },
        worktrees: false,
        provider: 'cursor',
        model: 'claude-sonnet',
        options: {
          run_root: 'tmp/test_cursor_happy_runs',
          cleanup_worktrees: true,
        },
        limits: {
          worker_timeout_sec: 30,
          timeout_grace_sec: 1,
        },
        flow: [{ type: 'task', id: 'cursor_task', prompt: 'complete successfully' }],
      },
      null,
      2,
    ),
    'utf8',
  );

  await withPatchedEnv(
    {
      PATH: `${mockBinDir}${path.delimiter}${process.env.PATH || ''}`,
      MOCK_AGENT_LOG: mockLog,
      MOCK_AGENT_BEHAVIOR: mockBehavior,
    },
    async () => {
      const exitCode = await main(['--plan', planPath]);
      assert.equal(exitCode, 0);
    },
  );

  const calls = parseJsonLines(mockLog);
  assert.equal(calls.length, 1);
  const args = (calls[0].args || []) as string[];
  assert.ok(args.includes('-p'));
  assert.ok(args.includes('--force'));
  assert.ok(args.includes('--model'));
  assert.ok(args.includes('claude-sonnet'));
  assert.ok(args.includes('--output-format'));
  assert.ok(args.includes('text'));
  assert.ok(!args.includes('--sandbox'), 'sandbox flag omitted for workspace-write');
  assert.ok(!args.includes('exec'), 'cursor should not use exec subcommand');
  assert.ok(!args.includes('-o'), 'cursor should not use -o flag');
  assert.ok(!args.includes('-'), 'cursor should not use stdin marker');

  const runBase = path.resolve(repoRoot, 'tmp/test_cursor_happy_runs');
  const runDir = getSingleRunDir(runBase);
  const runState = JSON.parse(fs.readFileSync(path.resolve(runDir, 'run_state.json'), 'utf8'));
  const taskRows = Object.values(runState.tasks || {}) as Array<Record<string, unknown>>;
  assert.equal(taskRows.length, 1);
  assert.equal(taskRows[0].status, 'DONE');
  assert.equal(taskRows[0].provider, 'cursor');
});

test('cursor provider captures stdout to last_message_path', async (t) => {
  const repoRoot = mkRepo('agentflow-cursor-stdout-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const mockBinDir = path.resolve(repoRoot, 'mockbin');
  installMockAgent(mockBinDir);
  const mockLog = path.resolve(repoRoot, 'mock_agent.log');
  const mockBehavior = path.resolve(repoRoot, 'mock_agent_behavior.json');
  fs.writeFileSync(
    mockBehavior,
    JSON.stringify({ default: { exitCode: 0, sleepMs: 0 } }, null, 2),
    'utf8',
  );

  const planPath = path.resolve(repoRoot, 'cursor_stdout_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify(
      {
        setup: 'cursor stdout capture test',
        repos: { main: '.' },
        worktrees: false,
        provider: 'cursor',
        model: 'claude-sonnet',
        options: {
          run_root: 'tmp/test_cursor_stdout_runs',
          cleanup_worktrees: true,
        },
        limits: {
          worker_timeout_sec: 30,
          timeout_grace_sec: 1,
        },
        flow: [{ type: 'task', id: 'stdout_task', prompt: 'produce output' }],
      },
      null,
      2,
    ),
    'utf8',
  );

  await withPatchedEnv(
    {
      PATH: `${mockBinDir}${path.delimiter}${process.env.PATH || ''}`,
      MOCK_AGENT_LOG: mockLog,
      MOCK_AGENT_BEHAVIOR: mockBehavior,
    },
    async () => {
      const exitCode = await main(['--plan', planPath]);
      assert.equal(exitCode, 0);
    },
  );

  const runBase = path.resolve(repoRoot, 'tmp/test_cursor_stdout_runs');
  const runDir = getSingleRunDir(runBase);
  const runState = JSON.parse(fs.readFileSync(path.resolve(runDir, 'run_state.json'), 'utf8'));
  const taskRows = Object.values(runState.tasks || {}) as Array<Record<string, unknown>>;
  assert.equal(taskRows.length, 1);
  const lastMessagePath = String(taskRows[0].lastMessagePath);
  assert.ok(fs.existsSync(lastMessagePath), 'last_message_path should exist from stdout capture');
  const content = fs.readFileSync(lastMessagePath, 'utf8');
  assert.match(content, /Task completed/);
});

test('task fails when exit code 0 but no report written', async (t) => {
  const repoRoot = mkRepo('agentflow-no-report-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const mockBinDir = path.resolve(repoRoot, 'mockbin');
  installMockCodex(mockBinDir);
  const mockLog = path.resolve(repoRoot, 'mock_codex.log');
  const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');
  fs.writeFileSync(
    mockBehavior,
    JSON.stringify({ default: { exitCode: 0, sleepMs: 0, skipReport: true } }, null, 2),
    'utf8',
  );

  const planPath = path.resolve(repoRoot, 'no_report_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify(
      {
        setup: 'missing report test',
        repos: { main: '.' },
        worktrees: false,
        on_failure: 'continue',
        provider: 'codex',
        model: 'gpt-5-nano',
        reasoning: 'xhigh',
        options: {
          run_root: 'tmp/test_no_report_runs',
          cleanup_worktrees: true,
        },
        limits: {
          worker_timeout_sec: 30,
          timeout_grace_sec: 1,
        },
        flow: [{ type: 'task', id: 'no_report_task', prompt: 'skip the report' }],
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
      assert.equal(exitCode, 1);
    },
  );

  const runBase = path.resolve(repoRoot, 'tmp/test_no_report_runs');
  const runDir = getSingleRunDir(runBase);
  const runState = JSON.parse(fs.readFileSync(path.resolve(runDir, 'run_state.json'), 'utf8'));
  const taskRows = Object.values(runState.tasks || {}) as Array<Record<string, unknown>>;
  assert.equal(taskRows.length, 1);
  assert.equal(taskRows[0].status, 'FAILED');
  assert.equal(taskRows[0].failureReason, 'missing_report');
});

test('prior task summaries appear in prompt for second task', async (t) => {
  const repoRoot = mkRepo('agentflow-prior-context-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const mockBinDir = path.resolve(repoRoot, 'mockbin');
  installMockCodex(mockBinDir);
  const mockLog = path.resolve(repoRoot, 'mock_codex.log');
  const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');
  fs.writeFileSync(
    mockBehavior,
    JSON.stringify({ default: { exitCode: 0, sleepMs: 25 } }, null, 2),
    'utf8',
  );

  const planPath = path.resolve(repoRoot, 'prior_context_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify(
      {
        setup: 'prior context test',
        repos: { main: '.' },
        worktrees: false,
        provider: 'codex',
        model: 'gpt-5-nano',
        reasoning: 'xhigh',
        options: {
          run_root: 'tmp/test_prior_context_runs',
          cleanup_worktrees: true,
        },
        limits: {
          worker_timeout_sec: 30,
          timeout_grace_sec: 1,
        },
        flow: [
          { type: 'task', id: 'first_task', prompt: 'do the first thing' },
          { type: 'task', id: 'second_task', prompt: 'do the second thing' },
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

  const runBase = path.resolve(repoRoot, 'tmp/test_prior_context_runs');
  const runDir = getSingleRunDir(runBase);

  const group02Dir = fs.readdirSync(runDir).filter((d) => d.startsWith('group_02')).sort();
  assert.ok(group02Dir.length > 0, 'expected group_02 directory for second task');
  const secondTaskDirs = fs.readdirSync(path.resolve(runDir, group02Dir[0]));
  const secondTaskDir = secondTaskDirs.find((d) => d.includes('second'));
  assert.ok(secondTaskDir, 'expected second_task directory');
  const promptPath = path.resolve(runDir, group02Dir[0], secondTaskDir, 'prompt.md');
  const promptContent = fs.readFileSync(promptPath, 'utf8');
  assert.match(promptContent, /What's Been Done So Far/);
  assert.match(promptContent, /first_task/);
});

test('SIGINT triggers graceful finalize with FAILED status', async (t) => {
  const repoRoot = mkRepo('agentflow-signal-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const mockBinDir = path.resolve(repoRoot, 'mockbin');
  installMockCodex(mockBinDir);
  const mockLog = path.resolve(repoRoot, 'mock_codex.log');
  const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');
  fs.writeFileSync(
    mockBehavior,
    JSON.stringify(
      {
        rules: [{ match: 'Goal (long_task)', exitCode: 0, sleepMs: 5000 }],
        default: { exitCode: 0, sleepMs: 0 },
      },
      null,
      2,
    ),
    'utf8',
  );

  const planPath = path.resolve(repoRoot, 'signal_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify(
      {
        setup: 'signal test',
        repos: { main: '.' },
        worktrees: false,
        provider: 'codex',
        model: 'gpt-5-nano',
        reasoning: 'xhigh',
        options: {
          run_root: 'tmp/test_signal_runs',
          cleanup_worktrees: true,
        },
        limits: {
          worker_timeout_sec: 60,
          timeout_grace_sec: 1,
        },
        flow: [{ type: 'task', id: 'long_task', prompt: 'takes long' }],
      },
      null,
      2,
    ),
    'utf8',
  );

  const child = spawn(
    process.execPath,
    ['--import', 'tsx', path.resolve(WORKSPACE_ROOT, 'src/cli.ts'), '--plan', planPath],
    {
      cwd: WORKSPACE_ROOT,
      env: {
        ...process.env,
        PATH: `${mockBinDir}${path.delimiter}${process.env.PATH || ''}`,
        MOCK_CODEX_LOG: mockLog,
        MOCK_CODEX_BEHAVIOR: mockBehavior,
      },
    },
  );

  let output = '';
  child.stdout.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    output += String(chunk);
  });

  setTimeout(() => {
    child.kill('SIGINT');
  }, 500);

  const exited = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  assert.equal(exited.code, 130);
  assert.equal(exited.signal, null);
  assert.match(output, /received SIGINT, shutting down/i);

  const runBase = path.resolve(repoRoot, 'tmp/test_signal_runs');
  const runDir = getSingleRunDir(runBase);
  assert.ok(fs.existsSync(path.resolve(runDir, 'run_summary.md')));
  assert.ok(fs.existsSync(path.resolve(runDir, 'run_state.json')));
});

test('context_from filters prior task summaries to specified task ids', async (t) => {
  const repoRoot = mkRepo('agentflow-contextfrom-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const mockBinDir = path.resolve(repoRoot, 'mockbin');
  installMockCodex(mockBinDir);
  const mockLog = path.resolve(repoRoot, 'mock_codex.log');
  const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');
  fs.writeFileSync(
    mockBehavior,
    JSON.stringify({ default: { exitCode: 0 } }),
    'utf8',
  );

  const planPath = path.resolve(repoRoot, 'context_from_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify({
      setup: 'context_from filter test',
      repos: { main: '.' },
      worktrees: false,
      provider: 'codex',
      model: 'gpt-5-nano',
      reasoning: 'xhigh',
      options: { run_root: 'tmp/test_context_from_runs' },
      limits: { worker_timeout_sec: 30, timeout_grace_sec: 1 },
      flow: [
        { type: 'task', id: 'task_a', prompt: 'do task A' },
        { type: 'task', id: 'task_b', prompt: 'do task B' },
        { type: 'task', id: 'task_c', prompt: 'do task C', context_from: ['task_a'] },
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

  const runBase = path.resolve(repoRoot, 'tmp/test_context_from_runs');
  const runDir = getSingleRunDir(runBase);

  const groupDirs = fs.readdirSync(runDir).filter((d) => d.startsWith('group_03')).sort();
  assert.ok(groupDirs.length > 0, 'expected group directory for task_c');
  const taskCDirs = fs.readdirSync(path.resolve(runDir, groupDirs[0]));
  const taskCDir = taskCDirs.find((d) => d.includes('task-c'));
  assert.ok(taskCDir, 'expected task_c directory');
  const promptContent = fs.readFileSync(
    path.resolve(runDir, groupDirs[0], taskCDir, 'prompt.md'),
    'utf8',
  );
  assert.match(promptContent, /task_a/, 'prompt should include task_a summary');
  assert.ok(!promptContent.includes('task_b'), 'prompt should NOT include task_b summary');
});

test('context_from_artifact=report injects full prior report into downstream prompt', async (t) => {
  const repoRoot = mkRepo('agentflow-contextfrom-report-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const mockBinDir = path.resolve(repoRoot, 'mockbin');
  installMockCodex(mockBinDir);
  const mockLog = path.resolve(repoRoot, 'mock_codex.log');
  const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');
  fs.writeFileSync(
    mockBehavior,
    JSON.stringify({ default: { exitCode: 0 } }),
    'utf8',
  );

  const planPath = path.resolve(repoRoot, 'context_from_report_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify({
      setup: 'context_from report test',
      repos: { main: '.' },
      worktrees: false,
      provider: 'codex',
      model: 'gpt-5-nano',
      reasoning: 'xhigh',
      options: { run_root: 'tmp/test_context_from_report_runs' },
      limits: { worker_timeout_sec: 30, timeout_grace_sec: 1 },
      flow: [
        { type: 'task', id: 'task_a', prompt: 'do task A' },
        { type: 'task', id: 'task_b', prompt: 'do task B', context_from: ['task_a'], context_from_artifact: 'report' },
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

  const runBase = path.resolve(repoRoot, 'tmp/test_context_from_report_runs');
  const runDir = getSingleRunDir(runBase);
  const groupDirs = fs.readdirSync(runDir).filter((d) => d.startsWith('group_02')).sort();
  assert.ok(groupDirs.length > 0, 'expected group directory for task_b');
  const taskBDirs = fs.readdirSync(path.resolve(runDir, groupDirs[0]));
  const taskBDir = taskBDirs.find((d) => d.includes('task-b'));
  assert.ok(taskBDir, 'expected task_b directory');
  const promptContent = fs.readFileSync(
    path.resolve(runDir, groupDirs[0], taskBDir, 'prompt.md'),
    'utf8',
  );
  assert.match(promptContent, /### task_a \(DONE, report\)/);
  assert.match(promptContent, /# report/);
  assert.ok(!promptContent.includes('Task completed successfully. No issues found.'), 'prompt should not inject the brief summary when report context is requested');
});

test('on_failure: continue with multiple tasks runs all tasks despite failures', async (t) => {
  const repoRoot = mkRepo('agentflow-continue-multi-');
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const mockBinDir = path.resolve(repoRoot, 'mockbin');
  installMockCodex(mockBinDir);
  const mockLog = path.resolve(repoRoot, 'mock_codex.log');
  const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');
  fs.writeFileSync(
    mockBehavior,
    JSON.stringify({
      rules: [
        { match: 'Goal (failing_task)', exitCode: 1, skipReport: true },
      ],
      default: { exitCode: 0 },
    }),
    'utf8',
  );

  const planPath = path.resolve(repoRoot, 'continue_multi_plan.json');
  fs.writeFileSync(
    planPath,
    JSON.stringify({
      setup: 'on_failure continue multi test',
      repos: { main: '.' },
      worktrees: false,
      provider: 'codex',
      model: 'gpt-5-nano',
      reasoning: 'xhigh',
      on_failure: 'continue',
      options: { run_root: 'tmp/test_continue_multi_runs' },
      limits: { worker_timeout_sec: 30, timeout_grace_sec: 1 },
      flow: [
        { type: 'task', id: 'failing_task', prompt: 'this will fail' },
        { type: 'task', id: 'following_task', prompt: 'this should still run' },
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
      assert.equal(exitCode, 1, 'run should report failure');
    },
  );

  const codexCalls = parseJsonLines(mockLog);
  assert.equal(codexCalls.length, 2, 'both tasks should have been invoked');
  const invokedTaskIds = codexCalls.map((c) => c.taskId);
  assert.ok(invokedTaskIds.includes('failing_task'), 'failing_task should have been invoked');
  assert.ok(invokedTaskIds.includes('following_task'), 'following_task should also have been invoked');
});

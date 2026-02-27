import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { main } from '../src/cli.ts';
import { normalizePlan } from '../src/lib/plan.ts';

const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runOrThrow(cmd: string, args: string[], cwd: string): { stdout: string; stderr: string } {
  const out = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (out.status !== 0) {
    throw new Error(
      `Command failed: ${cmd} ${args.join(' ')}\nstatus=${out.status}\nstdout=${out.stdout}\nstderr=${out.stderr}`,
    );
  }
  return {
    stdout: String(out.stdout || ''),
    stderr: String(out.stderr || ''),
  };
}

function mkRepo(prefix: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# test repo\n', 'utf8');
  runOrThrow('git', ['init'], repoRoot);
  runOrThrow('git', ['config', 'user.email', 'test@example.com'], repoRoot);
  runOrThrow('git', ['config', 'user.name', 'Test User'], repoRoot);
  runOrThrow('git', ['add', '.'], repoRoot);
  runOrThrow('git', ['commit', '-m', 'init'], repoRoot);
  return repoRoot;
}

function installMockCodex(binDir: string): string {
  fs.mkdirSync(binDir, { recursive: true });
  const mockPath = path.resolve(binDir, 'codex');
  fs.writeFileSync(
    mockPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const outIndex = args.indexOf('-o');
const outPath = outIndex >= 0 ? args[outIndex + 1] : null;
const stdin = fs.readFileSync(0, 'utf8');
const behaviorPath = process.env.MOCK_CODEX_BEHAVIOR;
let behavior = { rules: [], default: { status: 'DONE', exitCode: 0, sleepMs: 0, skipReport: false } };
if (behaviorPath && fs.existsSync(behaviorPath)) {
  behavior = JSON.parse(fs.readFileSync(behaviorPath, 'utf8'));
}
let rule = behavior.default || { status: 'DONE', exitCode: 0, sleepMs: 0, skipReport: false };
for (const candidate of behavior.rules || []) {
  if (stdin.includes(String(candidate.match || ''))) {
    rule = { ...rule, ...candidate };
    break;
  }
}

if (Number(rule.sleepMs || 0) > 0) {
  const block = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(block, 0, 0, Number(rule.sleepMs));
}

if (outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, 'Status: ' + String(rule.status || 'DONE') + '\\n', 'utf8');
}

const reportMatch = stdin.match(/Write a concise markdown report to:\\n\\s+([^\\n]+)/);
const reportPath = reportMatch ? String(reportMatch[1]).trim() : null;
if (reportPath && !rule.skipReport) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, '# report\\nstatus=' + String(rule.status || 'DONE') + '\\n', 'utf8');
}

const logPath = process.env.MOCK_CODEX_LOG;
if (logPath) {
  fs.appendFileSync(
    logPath,
    JSON.stringify({
      args,
      cwd: process.cwd(),
      taskId: ((stdin.match(/Task ID:\\n-\\s+([^\\n]+)/) || [])[1] || null),
      status: String(rule.status || 'DONE'),
      reportPath,
    }) + '\\n',
    'utf8',
  );
}

if (rule.stdout) process.stdout.write(String(rule.stdout));
if (rule.stderr) process.stderr.write(String(rule.stderr));
process.exit(Number(rule.exitCode ?? (rule.status === 'DONE' ? 0 : 1)));
`,
    'utf8',
  );
  fs.chmodSync(mockPath, 0o755);
  return mockPath;
}

function parseJsonLines(filePath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function getSingleRunDir(runBase: string): string {
  const runDirs = fs
    .readdirSync(runBase)
    .filter((name) => fs.statSync(path.resolve(runBase, name)).isDirectory())
    .sort();
  assert.equal(runDirs.length, 1);
  return path.resolve(runBase, runDirs[0]);
}

async function withPatchedEnv(
  patch: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const keys = Object.keys(patch);
  const before: Record<string, string | undefined> = {};
  for (const key of keys) before[key] = process.env[key];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const key of keys) {
      const value = before[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('agentflow runtime behavior', async (t) => {
  await t.test('defaults cleanup_worktrees to true', async () => {
    const plan = normalizePlan({
      setup: 'x',
      target: { repo_root: '.' },
      flow: [{ type: 'task', id: 'a', prompt: 'b' }],
    });
    assert.equal(plan.runtime.cleanup_worktrees, true);

    const explicit = normalizePlan({
      setup: 'x',
      target: { repo_root: '.' },
      runtime: { cleanup_worktrees: false },
      flow: [{ type: 'task', id: 'a', prompt: 'b' }],
    });
    assert.equal(explicit.runtime.cleanup_worktrees, false);
  });

  await t.test('unknown plan keys fail schema normalization with field-specific errors', async () => {
    assert.throws(
      () =>
        normalizePlan({
          setup: 'x',
          target: { repo_root: '.' },
          flow: [{ type: 'task', id: 'a', prompt: 'b' }],
          unexpected_top_level: true,
        }),
      /plan contains unknown key: "unexpected_top_level"\./,
    );

    assert.throws(
      () =>
        normalizePlan({
          setup: 'x',
          target: { repo_root: '.', unknown_target_field: true },
          flow: [{ type: 'task', id: 'a', prompt: 'b' }],
        }),
      /target contains unknown key: "unknown_target_field"\./,
    );

    assert.throws(
      () =>
        normalizePlan({
          setup: 'x',
          target: { repo_root: '.' },
          flow: [{ type: 'task', id: 'a', prompt: 'b', extra_task_field: true }],
        }),
      /flow\[0\] contains unknown key: "extra_task_field"\./,
    );
  });

  await t.test('flow uses group nodes and requires explicit parallel boolean', async () => {
    assert.throws(
      () =>
        normalizePlan({
          setup: 'x',
          target: { repo_root: '.' },
          flow: [{ type: 'parallel', id: 'legacy', steps: [] }],
        }),
      /flow\[0\]\.type must be one of: task, group, loop\./,
    );

    assert.throws(
      () =>
        normalizePlan({
          setup: 'x',
          target: { repo_root: '.' },
          flow: [
            {
              type: 'group',
              id: 'missing_parallel',
              steps: [{ type: 'task', id: 'a', prompt: 'b' }],
            },
          ],
        }),
      /flow\[0\]\.parallel must be a boolean\./,
    );
  });

  await t.test('unknown keys surface a clear user-facing CLI error', async (t2) => {
    const repoRoot = mkRepo('agentflow-unknown-key-cli-');
    t2.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

    const planPath = path.resolve(repoRoot, 'unknown_key_plan.json');
    fs.writeFileSync(
      planPath,
      JSON.stringify(
        {
          setup: 'unknown key cli message test',
          target: { repo_root: '.', unknown_key: 'oops' },
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
    assert.match(errors.join('\n'), /target contains unknown key: "unknown_key"\./);
  });

  await t.test('dry-run is CLI-flag only (plan runtime.dry_run does not force dry mode)', async (t2) => {
    const repoRoot = mkRepo('agentflow-dry-flag-');
    t2.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

    const mockBinDir = path.resolve(repoRoot, 'mockbin');
    installMockCodex(mockBinDir);
    const mockLog = path.resolve(repoRoot, 'mock_codex.log');
    const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');
    fs.writeFileSync(
      mockBehavior,
      JSON.stringify({ default: { status: 'DONE', exitCode: 0, sleepMs: 0 } }, null, 2),
      'utf8',
    );

    const planPath = path.resolve(repoRoot, 'dry_flag_plan.json');
    fs.writeFileSync(
      planPath,
      JSON.stringify(
        {
          setup: 'dry flag behavior test',
          target: { repo_root: '.', use_worktrees: false },
          defaults: { provider: 'codex', model: 'gpt-5-nano', reasoning: 'xhigh' },
          runtime: {
            run_root: 'tmp/test_dry_flag_runs',
            dry_run: true,
            cleanup_worktrees: true,
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

  await t.test('task-level provider/model overrides are applied per task', async (t2) => {
    const repoRoot = mkRepo('agentflow-task-overrides-');
    t2.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

    const mockBinDir = path.resolve(repoRoot, 'mockbin');
    installMockCodex(mockBinDir);
    const mockLog = path.resolve(repoRoot, 'mock_codex.log');
    const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');
    fs.writeFileSync(
      mockBehavior,
      JSON.stringify({ default: { status: 'DONE', exitCode: 0, sleepMs: 0 } }, null, 2),
      'utf8',
    );

    const planPath = path.resolve(repoRoot, 'task_overrides_plan.json');
    fs.writeFileSync(
      planPath,
      JSON.stringify(
        {
          setup: 'task override behavior test',
          target: { repo_root: '.', use_worktrees: false },
          defaults: { provider: 'codex', model: 'gpt-5-nano', reasoning: 'xhigh' },
          runtime: {
            run_root: 'tmp/test_task_overrides_runs',
            dry_run: false,
            cleanup_worktrees: true,
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

  await t.test('single-task happy path succeeds and persists DONE artifacts', async (t2) => {
    const repoRoot = mkRepo('agentflow-happy-single-');
    t2.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

    const mockBinDir = path.resolve(repoRoot, 'mockbin');
    installMockCodex(mockBinDir);
    const mockLog = path.resolve(repoRoot, 'mock_codex.log');
    const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');
    fs.writeFileSync(
      mockBehavior,
      JSON.stringify(
        {
          default: { status: 'DONE', exitCode: 0, sleepMs: 25 },
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
          target: { repo_root: '.', use_worktrees: true },
          defaults: { provider: 'codex', model: 'gpt-5-nano', reasoning: 'xhigh' },
          runtime: {
            run_root: 'tmp/test_happy_single_runs',
            dry_run: false,
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
    assert.ok(fs.existsSync(String(taskRows[0].reportJsonPath)));

    const events = parseJsonLines(path.resolve(runDir, 'run_events.jsonl'));
    const completion = events.find((event) => event.type === 'run_completed');
    assert.ok(completion);
    assert.equal(completion?.status, 'DONE');

    const worktreeList = runOrThrow('git', ['worktree', 'list', '--porcelain'], repoRoot).stdout;
    const worktreeEntries = worktreeList
      .split('\n')
      .filter((line) => line.startsWith('worktree '));
    assert.equal(worktreeEntries.length, 1, worktreeList);
    const leftoverBranches = runOrThrow('git', ['branch', '--list', 'agentflow/*'], repoRoot).stdout.trim();
    assert.equal(leftoverBranches, '');
  });

  await t.test('group(parallel=true) happy path succeeds with DONE results for all tasks', async (t2) => {
    const repoRoot = mkRepo('agentflow-happy-parallel-');
    t2.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

    const mockBinDir = path.resolve(repoRoot, 'mockbin');
    installMockCodex(mockBinDir);
    const mockLog = path.resolve(repoRoot, 'mock_codex.log');
    const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');
    fs.writeFileSync(
      mockBehavior,
      JSON.stringify(
        {
          rules: [
            { match: 'Task ID:\n- fast_done', status: 'DONE', exitCode: 0, sleepMs: 50 },
            { match: 'Task ID:\n- slow_done', status: 'DONE', exitCode: 0, sleepMs: 250 },
          ],
          default: { status: 'DONE', exitCode: 0, sleepMs: 0 },
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
          target: { repo_root: '.', use_worktrees: true },
          defaults: { provider: 'codex', model: 'gpt-5-nano', reasoning: 'xhigh' },
          policy: { fail_mode: 'stop', retry: { max_retries: 0, retry_on: ['FAILED', 'TIMEOUT'] } },
          runtime: {
            run_root: 'tmp/test_happy_parallel_runs',
            dry_run: false,
            cleanup_worktrees: true,
            worker_timeout_sec: 30,
            timeout_grace_sec: 1,
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

    const events = parseJsonLines(path.resolve(runDir, 'run_events.jsonl'));
    const completion = events.find((event) => event.type === 'run_completed');
    assert.ok(completion);
    assert.equal(completion?.status, 'DONE');
  });

  await t.test('group(parallel=true) failure waits for sibling task completion and records both task outcomes', async (t2) => {
    const repoRoot = mkRepo('agentflow-parallel-');
    t2.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

    const mockBinDir = path.resolve(repoRoot, 'mockbin');
    installMockCodex(mockBinDir);
    const mockLog = path.resolve(repoRoot, 'mock_codex.log');
    const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');
    fs.writeFileSync(
      mockBehavior,
      JSON.stringify(
        {
          rules: [
            { match: 'Task ID:\n- fast_fail', status: 'FAILED', exitCode: 1, sleepMs: 50, skipReport: true },
            { match: 'Task ID:\n- slow_done', status: 'DONE', exitCode: 0, sleepMs: 1200 },
          ],
          default: { status: 'DONE', exitCode: 0, sleepMs: 0 },
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
          target: { repo_root: '.', use_worktrees: true },
          defaults: { provider: 'codex', model: 'gpt-5-nano', reasoning: 'xhigh' },
          policy: { fail_mode: 'stop', retry: { max_retries: 0, retry_on: ['FAILED', 'TIMEOUT'] } },
          runtime: {
            run_root: 'tmp/test_parallel_runs',
            dry_run: false,
            cleanup_worktrees: true,
            worker_timeout_sec: 30,
            timeout_grace_sec: 1,
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

  await t.test('group(parallel=false) executes child steps sequentially in order', async (t2) => {
    const repoRoot = mkRepo('agentflow-group-sequential-');
    t2.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

    const mockBinDir = path.resolve(repoRoot, 'mockbin');
    installMockCodex(mockBinDir);
    const mockLog = path.resolve(repoRoot, 'mock_codex.log');
    const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');
    fs.writeFileSync(
      mockBehavior,
      JSON.stringify(
        {
          rules: [
            { match: 'Task ID:\n- first_step', status: 'DONE', exitCode: 0, sleepMs: 450 },
            { match: 'Task ID:\n- second_step', status: 'DONE', exitCode: 0, sleepMs: 450 },
          ],
          default: { status: 'DONE', exitCode: 0, sleepMs: 0 },
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
          target: { repo_root: '.', use_worktrees: false },
          defaults: { provider: 'codex', model: 'gpt-5-nano', reasoning: 'xhigh' },
          runtime: {
            run_root: 'tmp/test_group_sequential_runs',
            dry_run: false,
            cleanup_worktrees: true,
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

  await t.test('group(parallel=true) can run without worktrees when tasks are independent', async (t2) => {
    const repoRoot = mkRepo('agentflow-group-parallel-no-worktree-');
    t2.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

    const mockBinDir = path.resolve(repoRoot, 'mockbin');
    installMockCodex(mockBinDir);
    const mockLog = path.resolve(repoRoot, 'mock_codex.log');
    const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');
    fs.writeFileSync(
      mockBehavior,
      JSON.stringify(
        {
          rules: [
            { match: 'Task ID:\n- left_task', status: 'DONE', exitCode: 0, sleepMs: 500 },
            { match: 'Task ID:\n- right_task', status: 'DONE', exitCode: 0, sleepMs: 500 },
          ],
          default: { status: 'DONE', exitCode: 0, sleepMs: 0 },
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
          target: { repo_root: '.', use_worktrees: false },
          defaults: { provider: 'codex', model: 'gpt-5-nano', reasoning: 'xhigh' },
          runtime: {
            run_root: 'tmp/test_group_parallel_no_worktree_runs',
            dry_run: false,
            cleanup_worktrees: true,
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

  await t.test('SIGINT triggers graceful finalize with FAILED completion event', async (t2) => {
    const repoRoot = mkRepo('agentflow-signal-');
    t2.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

    const mockBinDir = path.resolve(repoRoot, 'mockbin');
    installMockCodex(mockBinDir);
    const mockLog = path.resolve(repoRoot, 'mock_codex.log');
    const mockBehavior = path.resolve(repoRoot, 'mock_behavior.json');
    fs.writeFileSync(
      mockBehavior,
      JSON.stringify(
        {
          rules: [{ match: 'Task ID:\n- long_task', status: 'DONE', exitCode: 0, sleepMs: 5000 }],
          default: { status: 'DONE', exitCode: 0, sleepMs: 0 },
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
          target: { repo_root: '.', use_worktrees: false },
          defaults: { provider: 'codex', model: 'gpt-5-nano', reasoning: 'xhigh' },
          runtime: {
            run_root: 'tmp/test_signal_runs',
            dry_run: false,
            cleanup_worktrees: true,
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
    const events = parseJsonLines(path.resolve(runDir, 'run_events.jsonl'));
    const completion = events.find((event) => event.type === 'run_completed');
    assert.ok(completion, 'expected run_completed event');
    assert.equal(completion?.status, 'FAILED');
    assert.ok(fs.existsSync(path.resolve(runDir, 'run_summary.md')));
  });
});

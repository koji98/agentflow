import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { main } from '../src/cli.ts';
import { installMockCodex, mkRepo, parseJsonLines, withPatchedEnv } from './helpers.ts';

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

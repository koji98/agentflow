import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { main } from '../src/cli.ts';
import { parseArgs } from '../src/lib/args.ts';
import { buildAiGatePrompt } from '../src/lib/gates.ts';
import { normalizePlan } from '../src/lib/plan.ts';
import { buildPrompt } from '../src/lib/prompt.ts';
import { buildProviderCommand } from '../src/lib/providers.ts';
import type { Session } from '../src/lib/types.ts';
import { mapSandboxForCursor, normalizeProvider } from '../src/lib/utils.ts';

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

function installMockAgent(binDir: string): string {
  fs.mkdirSync(binDir, { recursive: true });
  const mockPath = path.resolve(binDir, 'agent');
  fs.writeFileSync(
    mockPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const behaviorPath = process.env.MOCK_AGENT_BEHAVIOR;
let behavior = { rules: [], default: { exitCode: 0, sleepMs: 0, skipReport: false } };
if (behaviorPath && fs.existsSync(behaviorPath)) {
  behavior = JSON.parse(fs.readFileSync(behaviorPath, 'utf8'));
}

const positionalArgs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('-')) {
    if (['--output-format', '--workspace', '--sandbox', '--model', '--mode'].includes(args[i])) {
      i++;
    }
    continue;
  }
  positionalArgs.push(args[i]);
}
const prompt = positionalArgs[positionalArgs.length - 1] || '';

let rule = behavior.default || { exitCode: 0, sleepMs: 0, skipReport: false };
for (const candidate of behavior.rules || []) {
  if (prompt.includes(String(candidate.match || ''))) {
    rule = { ...rule, ...candidate };
    break;
  }
}

if (Number(rule.sleepMs || 0) > 0) {
  const block = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(block, 0, 0, Number(rule.sleepMs));
}

process.stdout.write('Task completed successfully.\\n');

const reportMatch = prompt.match(/Write a detailed report to:\\s*([^\\n]+)/);
const reportPath = reportMatch ? String(reportMatch[1]).trim() : null;
if (reportPath && !rule.skipReport) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, '# report\\nTask completed.\\n', 'utf8');
}

const summaryMatch = prompt.match(/Write a brief summary to:\\s*([^\\n]+)/);
const summaryPath = summaryMatch ? String(summaryMatch[1]).trim() : null;
if (summaryPath && !rule.skipReport) {
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, 'Task completed successfully. No issues found.\\n', 'utf8');
}

const logPath = process.env.MOCK_AGENT_LOG;
if (logPath) {
  const workspaceIdx = args.indexOf('--workspace');
  fs.appendFileSync(
    logPath,
    JSON.stringify({
      args,
      cwd: process.cwd(),
      workspace: workspaceIdx >= 0 ? args[workspaceIdx + 1] : null,
      taskId: ((prompt.match(/Your Task[^(]*\\(([^)]+)\\)/) || [])[1] || null),
      reportPath,
    }) + '\\n',
    'utf8',
  );
}

if (rule.stdout) process.stdout.write(String(rule.stdout));
if (rule.stderr) process.stderr.write(String(rule.stderr));
process.exit(Number(rule.exitCode ?? 0));
`,
    'utf8',
  );
  fs.chmodSync(mockPath, 0o755);
  return mockPath;
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
let behavior = { rules: [], default: { exitCode: 0, sleepMs: 0, skipReport: false } };
if (behaviorPath && fs.existsSync(behaviorPath)) {
  behavior = JSON.parse(fs.readFileSync(behaviorPath, 'utf8'));
}
let rule = behavior.default || { exitCode: 0, sleepMs: 0, skipReport: false };
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
  fs.writeFileSync(outPath, 'Task completed successfully.\\n', 'utf8');
}

const reportMatch = stdin.match(/Write a detailed report to:\\s*([^\\n]+)/);
const reportPath = reportMatch ? String(reportMatch[1]).trim() : null;
if (reportPath && !rule.skipReport) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, '# report\\nTask completed.\\n', 'utf8');
}

const summaryMatch = stdin.match(/Write a brief summary to:\\s*([^\\n]+)/);
const summaryPath = summaryMatch ? String(summaryMatch[1]).trim() : null;
if (summaryPath && !rule.skipReport) {
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, 'Task completed successfully. No issues found.\\n', 'utf8');
}

const logPath = process.env.MOCK_CODEX_LOG;
if (logPath) {
  fs.appendFileSync(
    logPath,
    JSON.stringify({
      args,
      cwd: process.cwd(),
      taskId: ((stdin.match(/Your Task[^(]*\\(([^)]+)\\)/) || [])[1] || null),
      reportPath,
    }) + '\\n',
    'utf8',
  );
}

if (rule.stdout) process.stdout.write(String(rule.stdout));
if (rule.stderr) process.stderr.write(String(rule.stderr));
process.exit(Number(rule.exitCode ?? 0));
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
  await t.test('--help prints TLDR and points to plan help', async () => {
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]): void => {
      logs.push(args.map((v) => String(v)).join(' '));
    };
    try {
      const exitCode = await main(['--help']);
      assert.equal(exitCode, 0);
    } finally {
      console.log = original;
    }

    const out = logs.join('\n');
    assert.match(out, /TLDR:/);
    assert.match(out, /agentflow --plan-help/);
    assert.match(out, /Show detailed plan schema and all supported keys\./);
    assert.match(out, /--skip-git-repo-check/);
    assert.match(out, /--sandbox <mode>/);
  });

  await t.test('--plan-help prints detailed plan schema guidance', async () => {
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]): void => {
      logs.push(args.map((v) => String(v)).join(' '));
    };
    try {
      const exitCode = await main(['--plan-help']);
      assert.equal(exitCode, 0);
    } finally {
      console.log = original;
    }

    const out = logs.join('\n');
    assert.match(out, /Plan File Help/);
    assert.match(out, /Mental model:/);
    assert.match(out, /Minimal valid plan \(JSON\):/);
    assert.match(out, /Full schema skeleton \(all keys shown\):/);
    assert.match(out, /Flow nodes:/);
    assert.match(out, /unknown keys hard-fail at every object level/);
    assert.match(out, /Common mistakes \(and actual error text\):/);
    assert.match(out, /--skip-git-repo-check/);
    assert.match(out, /--sandbox <mode>/);
  });

  await t.test('defaults cleanup_worktrees to true', async () => {
    const plan = normalizePlan({
      setup: 'x',
      flow: [{ type: 'task', id: 'a', prompt: 'b' }],
    });
    assert.equal(plan.options.cleanup_worktrees, true);

    const explicit = normalizePlan({
      setup: 'x',
      options: { cleanup_worktrees: false },
      flow: [{ type: 'task', id: 'a', prompt: 'b' }],
    });
    assert.equal(explicit.options.cleanup_worktrees, false);
  });

  await t.test('unknown plan keys fail schema normalization with field-specific errors', async () => {
    assert.throws(
      () =>
        normalizePlan({
          setup: 'x',
          flow: [{ type: 'task', id: 'a', prompt: 'b' }],
          unexpected_top_level: true,
        }),
      /plan contains unknown key: "unexpected_top_level"\./,
    );

    assert.throws(
      () =>
        normalizePlan({
          setup: 'x',
          limits: { unknown_limit: true },
          flow: [{ type: 'task', id: 'a', prompt: 'b' }],
        }),
      /limits contains unknown key: "unknown_limit"\./,
    );

    assert.throws(
      () =>
        normalizePlan({
          setup: 'x',
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
          flow: [{ type: 'parallel', id: 'legacy', steps: [] }],
        }),
      /flow\[0\]\.type must be one of: task, group, loop\./,
    );

    assert.throws(
      () =>
        normalizePlan({
          setup: 'x',
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

  await t.test('dry-run is CLI-flag only (plan options.dry_run does not force dry mode)', async (t2) => {
    const repoRoot = mkRepo('agentflow-dry-flag-');
    t2.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

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
          repo: '.',
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

  await t.test('--skip-git-repo-check is forwarded to codex exec', async (t2) => {
    const repoRoot = mkRepo('agentflow-skip-git-repo-check-');
    t2.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

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
          repo: '.',
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

  await t.test('workspace-write sandbox is default when --sandbox is not provided', async (t2) => {
    const repoRoot = mkRepo('agentflow-default-sandbox-');
    t2.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

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
          repo: '.',
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

  await t.test('--sandbox is forwarded to codex exec', async (t2) => {
    const repoRoot = mkRepo('agentflow-sandbox-');
    t2.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

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
          repo: '.',
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

  await t.test('--sandbox rejects unsupported values', async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]): void => {
      errors.push(args.map((v) => String(v)).join(' '));
    };
    try {
      const exitCode = await main(['--sandbox', 'write-all', '--plan', 'example_plan.json']);
      assert.equal(exitCode, 2);
    } finally {
      console.error = original;
    }

    const out = errors.join('\n');
    assert.match(out, /--sandbox must be one of: read-only, workspace-write, danger-full-access\./);
    assert.match(out, /Usage:/);
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
      JSON.stringify({ default: { exitCode: 0, sleepMs: 0 } }, null, 2),
      'utf8',
    );

    const planPath = path.resolve(repoRoot, 'task_overrides_plan.json');
    fs.writeFileSync(
      planPath,
      JSON.stringify(
        {
          setup: 'task override behavior test',
          repo: '.',
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
          repo: '.',
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
          repo: '.',
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
          repo: '.',
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
          repo: '.',
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
          repo: '.',
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

  await t.test('SIGINT triggers graceful finalize with FAILED status', async (t2) => {
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
          repo: '.',
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

  await t.test('normalizeProvider accepts cursor', () => {
    assert.equal(normalizeProvider('cursor'), 'cursor');
    assert.equal(normalizeProvider('CURSOR'), 'cursor');
    assert.equal(normalizeProvider('codex'), 'codex');
    assert.equal(normalizeProvider(null), null);
    assert.throws(() => normalizeProvider('unsupported'), /provider must be one of/);
  });

  await t.test('mapSandboxForCursor maps 3-tier modes correctly', () => {
    assert.equal(mapSandboxForCursor('read-only'), null);
    assert.equal(mapSandboxForCursor('workspace-write'), null);
    assert.equal(mapSandboxForCursor('danger-full-access'), 'disabled');
  });

  await t.test('buildProviderCommand builds correct cursor argv', () => {
    const cmd = buildProviderCommand({
      provider: 'cursor',
      model: 'claude-sonnet',
      reasoning_effort: 'high',
      profile: 'my-profile',
      promptText: 'Do the thing.',
      workspaceCwd: '/tmp/test-workspace',
      lastMessagePath: '/tmp/out.md',
      skipGitRepoCheck: true,
      sandboxMode: 'workspace-write',
    });

    assert.equal(cmd[0], 'agent');
    assert.ok(cmd.includes('-p'));
    assert.ok(cmd.includes('--force'));
    assert.ok(cmd.includes('--output-format'));
    assert.ok(cmd.includes('text'));
    assert.ok(cmd.includes('--model'));
    assert.ok(cmd.includes('claude-sonnet'));
    assert.ok(cmd.includes('--workspace'));
    assert.ok(cmd.includes('/tmp/test-workspace'));
    assert.ok(!cmd.includes('--sandbox'), 'sandbox flag omitted for workspace-write');
    assert.ok(cmd.includes('Do the thing.'));
    assert.ok(!cmd.includes('--profile'), 'cursor should not use --profile');
    assert.ok(!cmd.includes('-c'), 'cursor should not use -c for reasoning');
    assert.ok(!cmd.includes('-o'), 'cursor should not use -o');
  });

  await t.test('buildProviderCommand builds correct codex argv', () => {
    const cmd = buildProviderCommand({
      provider: 'codex',
      model: 'gpt-5-nano',
      reasoning_effort: 'xhigh',
      profile: 'my-profile',
      promptText: 'Do the thing.',
      workspaceCwd: '/tmp/test-workspace',
      lastMessagePath: '/tmp/out.md',
      skipGitRepoCheck: false,
      sandboxMode: 'workspace-write',
    });

    assert.equal(cmd[0], 'codex');
    assert.ok(cmd.includes('exec'));
    assert.ok(cmd.includes('-o'));
    assert.ok(cmd.includes('-m'));
    assert.ok(cmd.includes('gpt-5-nano'));
    assert.ok(cmd.includes('-c'));
    assert.ok(cmd.includes('model_reasoning_effort=xhigh'));
    assert.ok(cmd.includes('--profile'));
    assert.ok(cmd.includes('my-profile'));
    assert.ok(cmd.includes('-'));
  });

  await t.test('plan normalization accepts cursor as provider', () => {
    const plan = normalizePlan({
      setup: 'cursor provider test',
      provider: 'cursor',
      model: 'claude-sonnet',
      flow: [{ type: 'task', id: 'a', prompt: 'do it' }],
    });
    assert.equal(plan.provider, 'cursor');

    const taskPlan = normalizePlan({
      setup: 'task level cursor test',
      flow: [{ type: 'task', id: 'b', prompt: 'do it', provider: 'cursor' }],
    });
    assert.equal(taskPlan.workflow[0].type, 'task');
    if (taskPlan.workflow[0].type === 'task') {
      assert.equal(taskPlan.workflow[0].provider, 'cursor');
    }
  });

  await t.test('cursor provider single-task happy path succeeds', async (t2) => {
    const repoRoot = mkRepo('agentflow-cursor-happy-');
    t2.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

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
          repo: '.',
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

  await t.test('cursor provider captures stdout to last_message_path', async (t2) => {
    const repoRoot = mkRepo('agentflow-cursor-stdout-');
    t2.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

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
          repo: '.',
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

  await t.test('task fails when exit code 0 but no report written', async (t2) => {
    const repoRoot = mkRepo('agentflow-no-report-');
    t2.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

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
          repo: '.',
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

  await t.test('prior task summaries appear in prompt for second task', async (t2) => {
    const repoRoot = mkRepo('agentflow-prior-context-');
    t2.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

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
          repo: '.',
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

  await t.test('setup is optional and prompt omits Background when empty', () => {
    const plan = normalizePlan({
      flow: [{ type: 'task', id: 'a', prompt: 'do it' }],
    });
    assert.equal(plan.setup, '');

    const prompt = buildPrompt({
      persona: null,
      objective: null,
      setup: '',
      task: { task_id: 'a', task: 'do it' },
      contextFiles: [],
      reportPath: '/tmp/report.md',
      summaryPath: '/tmp/summary.md',
      priorTaskSummaries: [],
    });
    assert.ok(!prompt.includes('## Background'), 'empty setup should not produce Background section');
    assert.match(prompt, /do it/);

    const promptWithSetup = buildPrompt({
      persona: null,
      objective: null,
      setup: 'some context',
      task: { task_id: 'b', task: 'do it' },
      contextFiles: [],
      reportPath: '/tmp/report.md',
      summaryPath: '/tmp/summary.md',
      priorTaskSummaries: [],
    });
    assert.match(promptWithSetup, /## Background\nsome context/);
  });

  await t.test('prompt includes both report and summary paths in completion instructions', () => {
    const prompt = buildPrompt({
      persona: null,
      objective: null,
      setup: 'test',
      task: { task_id: 'a', task: 'do it' },
      contextFiles: [],
      reportPath: '/tmp/report.md',
      summaryPath: '/tmp/summary.md',
      priorTaskSummaries: [],
    });
    assert.match(prompt, /Write a detailed report to: \/tmp\/report\.md/);
    assert.match(prompt, /Write a brief summary to: \/tmp\/summary\.md/);
  });

  await t.test('per-task persona overrides plan-level persona in prompt', () => {
    const prompt = buildPrompt({
      persona: 'task-level persona',
      objective: null,
      setup: '',
      task: { task_id: 'a', task: 'do it' },
      contextFiles: [],
      reportPath: '/tmp/report.md',
      summaryPath: '/tmp/summary.md',
      priorTaskSummaries: [],
    });
    assert.match(prompt, /task-level persona/);
    assert.ok(!prompt.includes('senior software engineer'));
  });

  await t.test('plan normalization accepts context_from on task nodes', () => {
    const plan = normalizePlan({
      setup: 'test',
      flow: [
        { type: 'task', id: 'a', prompt: 'do a' },
        { type: 'task', id: 'b', prompt: 'do b', context_from: ['a'] },
      ],
    });
    const taskB = plan.workflow[1];
    assert.equal(taskB.type, 'task');
    if (taskB.type === 'task') {
      assert.deepEqual(taskB.context_from, ['a']);
    }
  });

  await t.test('plan normalization accepts persona on task nodes', () => {
    const plan = normalizePlan({
      setup: 'test',
      flow: [
        { type: 'task', id: 'a', prompt: 'do a', persona: 'You are a QA engineer.' },
        { type: 'task', id: 'b', prompt: 'do b' },
      ],
    });
    const taskA = plan.workflow[0];
    const taskB = plan.workflow[1];
    assert.equal(taskA.type, 'task');
    assert.equal(taskB.type, 'task');
    if (taskA.type === 'task') {
      assert.equal(taskA.persona, 'You are a QA engineer.');
    }
    if (taskB.type === 'task') {
      assert.equal(taskB.persona, null);
    }
  });

  await t.test('buildAiGatePrompt uses section-based format', () => {
    const mockSession = {
      plan: { setup: 'test setup', objective: 'test objective' },
      state: { groups: {}, tasks: {} },
    } as Session;
    const gate = {
      type: 'ai' as const,
      id: 'test_gate',
      prompt: 'evaluate this',
      provider: null,
      model: null,
      reasoning_effort: null,
      profile: null,
      include_recent_tasks: null,
      score_threshold: null,
      timeout_sec: null,
      required_artifacts: [],
    };
    const prompt = buildAiGatePrompt(mockSession, gate, 'loop_1', 1, 'post_body');
    assert.match(prompt, /## Loop Metadata/);
    assert.match(prompt, /## Run Setup/);
    assert.match(prompt, /## Objective/);
    assert.match(prompt, /## Gate Instruction/);
    assert.match(prompt, /## Output Format Requirements/);
    assert.ok(!prompt.includes('\\n\\n'), 'should not have literal escaped newlines');
  });

  await t.test('buildAiGatePrompt omits Run Setup when setup is empty', () => {
    const mockSession = {
      plan: { setup: '', objective: null },
      state: { groups: {}, tasks: {} },
    } as Session;
    const gate = {
      type: 'ai' as const,
      id: 'test_gate',
      prompt: 'evaluate this',
      provider: null,
      model: null,
      reasoning_effort: null,
      profile: null,
      include_recent_tasks: null,
      score_threshold: null,
      timeout_sec: null,
      required_artifacts: [],
    };
    const prompt = buildAiGatePrompt(mockSession, gate, 'loop_1', 1, 'post_body');
    assert.ok(!prompt.includes('## Run Setup'), 'empty setup should not produce Run Setup section');
    assert.match(prompt, /\(not provided\)/);
  });

  await t.test('parseArgs parses --validate flag', () => {
    const args = parseArgs(['--plan', 'my_plan.json', '--validate']);
    assert.equal(args.validate, true);
    assert.equal(args.planFile, 'my_plan.json');
  });

  await t.test('parseArgs parses --resume flag with value', () => {
    const args = parseArgs(['--plan', 'my_plan.json', '--resume', 'tmp/runs/run_001']);
    assert.equal(args.resumeDir, 'tmp/runs/run_001');
    assert.equal(args.planFile, 'my_plan.json');
  });

  await t.test('parseArgs throws when --resume has no value', () => {
    assert.throws(() => parseArgs(['--plan', 'my_plan.json', '--resume']), /--resume requires a value/);
  });

  await t.test('--validate succeeds for valid plan and exits 0', async (t2) => {
    const repoRoot = mkRepo('agentflow-validate-');
    t2.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

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

  await t.test('--validate fails for invalid plan and exits 1', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentflow-validate-bad-'));
    const planPath = path.resolve(repoRoot, 'bad_plan.json');
    fs.writeFileSync(planPath, JSON.stringify({ bad_key: true }), 'utf8');

    const exitCode = await main(['--plan', planPath, '--validate']);
    assert.equal(exitCode, 1);
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  await t.test('--resume skips completed tasks and re-runs failed ones', async (t2) => {
    const repoRoot = mkRepo('agentflow-resume-');
    t2.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

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

  await t.test('progress tag appears in task execution log', async (t2) => {
    const repoRoot = mkRepo('agentflow-progress-');
    t2.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

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
});

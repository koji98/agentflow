import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function runOrThrow(cmd: string, args: string[], cwd: string): { stdout: string; stderr: string } {
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

export function mkRepo(prefix: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# test repo\n', 'utf8');
  runOrThrow('git', ['init'], repoRoot);
  runOrThrow('git', ['config', 'user.email', 'test@example.com'], repoRoot);
  runOrThrow('git', ['config', 'user.name', 'Test User'], repoRoot);
  runOrThrow('git', ['add', '.'], repoRoot);
  runOrThrow('git', ['commit', '-m', 'init'], repoRoot);
  return repoRoot;
}

export function installMockAgent(binDir: string): string {
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
    if (candidate.onceFile) {
      if (fs.existsSync(candidate.onceFile)) continue;
      fs.writeFileSync(candidate.onceFile, '1', 'utf8');
    }
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

export function installMockCodex(binDir: string): string {
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
const taskId = ((stdin.match(/Your Task[^(]*\\(([^)]+)\\)/) || [])[1] || null);
const behaviorPath = process.env.MOCK_CODEX_BEHAVIOR;
let behavior = { rules: [], default: { exitCode: 0, sleepMs: 0, skipReport: false } };
if (behaviorPath && fs.existsSync(behaviorPath)) {
  behavior = JSON.parse(fs.readFileSync(behaviorPath, 'utf8'));
}
let rule = behavior.default || { exitCode: 0, sleepMs: 0, skipReport: false };
for (const candidate of behavior.rules || []) {
  if (stdin.includes(String(candidate.match || ''))) {
    if (candidate.onceFile) {
      if (fs.existsSync(candidate.onceFile)) continue;
      fs.writeFileSync(candidate.onceFile, '1', 'utf8');
    }
    rule = { ...rule, ...candidate };
    break;
  }
}

if (rule.createFile) {
  const createPath = path.resolve(process.cwd(), String(rule.createFile));
  fs.mkdirSync(path.dirname(createPath), { recursive: true });
  fs.writeFileSync(createPath, String(rule.createFileContent || 'created by mock codex\\n'), 'utf8');
}

if (rule.requireFile) {
  const requiredPath = path.resolve(process.cwd(), String(rule.requireFile));
  if (!fs.existsSync(requiredPath)) {
    rule = {
      ...rule,
      exitCode: Number(rule.missingExitCode ?? 1),
    };
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
      taskId,
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

export function parseJsonLines(filePath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function getSingleRunDir(runBase: string): string {
  const runDirs = fs
    .readdirSync(runBase)
    .filter((name) => fs.statSync(path.resolve(runBase, name)).isDirectory())
    .sort();
  assert.equal(runDirs.length, 1);
  return path.resolve(runBase, runDirs[0]);
}

export async function withPatchedEnv(
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

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { main } from '../src/cli.ts';
import { parseArgs } from '../src/lib/args.ts';
import { buildWebUrl, runWebMode } from '../src/lib/web.ts';

function makeWebRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentflow-web-mode-'));
  fs.mkdirSync(path.join(repoRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'bin', 'agentflow.js'), '#!/usr/bin/env node\n', 'utf8');
  fs.mkdirSync(path.join(repoRoot, 'web-app', 'client', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'web-app', 'client', 'dist', 'index.html'), '<html></html>', 'utf8');
  return repoRoot;
}

test('parseArgs parses web mode flags', () => {
  const args = parseArgs(['web', '--plan', 'plans/demo.json', '--host', '0.0.0.0', '--port', '4100', '--no-open']);
  assert.equal(args.webMode, true);
  assert.equal(args.planFile, 'plans/demo.json');
  assert.equal(args.webHost, '0.0.0.0');
  assert.equal(args.webPort, 4100);
  assert.equal(args.webNoOpen, true);
});

test('parseArgs rejects invalid web port', () => {
  assert.throws(() => parseArgs(['web', '--port', '70000']), /--port must be an integer between 1 and 65535/);
});

test('agentflow web rejects non-web execution flags', async () => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]): void => {
    errors.push(args.map((value) => String(value)).join(' '));
  };
  try {
    const exitCode = await main(['web', '--resume', '/tmp/run']);
    assert.equal(exitCode, 2);
  } finally {
    console.error = original;
  }
  assert.match(errors.join('\n'), /`agentflow web` only supports --plan, --host, --port, and --no-open\./);
});

test('runWebMode reuses a healthy server and opens the plan URL', async (t) => {
  const repoRoot = makeWebRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  const planPath = path.join(repoRoot, 'plans', 'demo.json');
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(planPath, '{}', 'utf8');

  const logs: string[] = [];
  let openedUrl = '';
  let spawned = false;
  const exitCode = await runWebMode(parseArgs(['web', '--plan', 'plans/demo.json']), {
    cwd: () => repoRoot,
    existsSync: (filePath) => fs.existsSync(filePath),
    fetch: async () => ({ ok: true }),
    spawnDetached: () => {
      spawned = true;
    },
    openExternal: (url) => {
      openedUrl = url;
    },
    sleep: async () => {},
    log: (message) => {
      logs.push(message);
    },
    logError: (message) => {
      logs.push(`ERR:${message}`);
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(spawned, false);
  assert.equal(openedUrl, buildWebUrl('127.0.0.1', 3208, planPath));
  assert.match(logs.join('\n'), /web_server: reused http:\/\/127\.0\.0\.1:3208/);
});

test('runWebMode spawns the server when unhealthy and honors --no-open', async (t) => {
  const repoRoot = makeWebRepo();
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));

  let healthChecks = 0;
  let spawned = 0;
  let opened = 0;
  const exitCode = await runWebMode(parseArgs(['web', '--host', '127.0.0.1', '--port', '4001', '--no-open']), {
    cwd: () => repoRoot,
    existsSync: (filePath) => fs.existsSync(filePath),
    fetch: async () => {
      healthChecks += 1;
      return { ok: healthChecks >= 3 };
    },
    spawnDetached: () => {
      spawned += 1;
    },
    openExternal: () => {
      opened += 1;
    },
    sleep: async () => {},
  });

  assert.equal(exitCode, 0);
  assert.equal(spawned, 1);
  assert.equal(opened, 0);
});

test('runWebMode rejects non-loopback hosts unless explicitly allowed', async () => {
  const errors: string[] = [];
  const original = process.env.AGENTFLOW_WEB_ALLOW_REMOTE;
  delete process.env.AGENTFLOW_WEB_ALLOW_REMOTE;
  try {
    const exitCode = await runWebMode(parseArgs(['web', '--host', '0.0.0.0']), {
      cwd: () => process.cwd(),
      existsSync: () => true,
      fetch: async () => ({ ok: false }),
      spawnDetached: () => {
        throw new Error('should not spawn');
      },
      openExternal: () => {
        throw new Error('should not open');
      },
      sleep: async () => {},
      logError: (message) => {
        errors.push(message);
      },
    });

    assert.equal(exitCode, 2);
    assert.match(errors.join('\n'), /Refusing to bind agentflow web to a non-loopback host/);
  } finally {
    if (original === undefined) delete process.env.AGENTFLOW_WEB_ALLOW_REMOTE;
    else process.env.AGENTFLOW_WEB_ALLOW_REMOTE = original;
  }
});

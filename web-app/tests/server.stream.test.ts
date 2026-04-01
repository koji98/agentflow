import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createServer } from '../server/index.ts';
import {
  deriveLogTailUpdateKind,
  deriveSnapshotTailUpdate,
  resolveTailSource,
  type LogTailCursor,
} from '../server/routes/stream.ts';
import { createSampleAgentflowFixture } from './helpers/sample_agentflow.ts';

let app: any;
const cleanupDirs: string[] = [];

describe('stream routes', () => {
  beforeAll(async () => {
    app = await createServer();
  });

  afterEach(() => {
    delete process.env.AGENTFLOW_WEB_ALLOWED_ROOTS;
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await app?.close?.();
  });

  it('rejects event subscriptions for runs that are not open', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/stream/run/missing-run/events',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'run_not_found' });
  });

  it('blocks tail subscriptions when the log path escapes the allowlist', async () => {
    const fixture = createSampleAgentflowFixture();
    cleanupDirs.push(fixture.workspaceRoot);
    process.env.AGENTFLOW_WEB_ALLOWED_ROOTS = fixture.workspaceRoot;

    const outsideLog = path.join(path.dirname(fixture.workspaceRoot), 'outside.log');
    fs.writeFileSync(outsideLog, 'secret log', 'utf8');

    const statePath = path.join(fixture.runDir, 'run_state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as any;
    state.tasks[fixture.taskKeys.echoStatus].logPath = outsideLog;
    state.tasks[fixture.taskKeys.echoStatus].lastMessagePath = '';
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    const openRes = await app.inject({
      method: 'POST',
      url: '/api/runs/open',
      payload: { runDir: fixture.runDir },
    });
    expect(openRes.statusCode).toBe(200);
    const { runId } = openRes.json();

    const res = await app.inject({
      method: 'GET',
      url: `/api/stream/run/${encodeURIComponent(runId)}/tail?taskKey=${encodeURIComponent(fixture.taskKeys.echoStatus)}`,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'path_not_allowed' });
  });

  it('falls back to lastMessagePath when a task has no execution log path', () => {
    expect(resolveTailSource({
      taskKey: 'g0:message_only#a1',
      lastMessagePath: '/tmp/message-only.md',
    })).toEqual({
      kind: 'last_message',
      path: '/tmp/message-only.md',
      label: 'Last message / stdout',
    });
  });

  it('prefers an existing last-message file when the log path is stale', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-web-tail-source-'));
    cleanupDirs.push(rootDir);
    process.env.AGENTFLOW_WEB_ALLOWED_ROOTS = rootDir;

    const taskDir = path.join(rootDir, 'run', 'group_01', 'task_message_fallback-a1');
    fs.mkdirSync(taskDir, { recursive: true });
    const lastMessagePath = path.join(taskDir, 'worker_last_message.md');
    fs.writeFileSync(lastMessagePath, 'streamed message\n', 'utf8');

    expect(resolveTailSource({
      taskKey: 'g0:message_only#a1',
      logPath: path.join(taskDir, 'missing.log'),
      lastMessagePath,
    })).toEqual({
      kind: 'last_message',
      path: lastMessagePath,
      label: 'Last message / stdout',
    });
  });

  it('emits snapshot updates when the selected message file is rewritten in place', () => {
    expect(deriveSnapshotTailUpdate('alpha', 'beta')).toBe('beta');
    expect(deriveSnapshotTailUpdate('beta', 'beta')).toBeNull();
  });

  it('treats atomic log replacement as a snapshot even when the replacement grows', () => {
    const previous: LogTailCursor = {
      size: 18,
      mtimeMs: 10,
      fingerprint: '1:100',
    };
    const next: LogTailCursor = {
      size: 44,
      mtimeMs: 20,
      fingerprint: '1:200',
    };

    expect(deriveLogTailUpdateKind(previous, next)).toBe('snapshot');
  });

  it('treats same-size log rewrites as a snapshot instead of an append', () => {
    const previous: LogTailCursor = {
      size: 44,
      mtimeMs: 10,
      fingerprint: '1:100',
    };
    const next: LogTailCursor = {
      size: 44,
      mtimeMs: 20,
      fingerprint: '1:100',
    };

    expect(deriveLogTailUpdateKind(previous, next)).toBe('snapshot');
  });

  it('keeps append semantics for in-place log growth on the same file', () => {
    const previous: LogTailCursor = {
      size: 18,
      mtimeMs: 10,
      fingerprint: '1:100',
    };
    const next: LogTailCursor = {
      size: 44,
      mtimeMs: 20,
      fingerprint: '1:100',
    };

    expect(deriveLogTailUpdateKind(previous, next)).toBe('append');
  });
});

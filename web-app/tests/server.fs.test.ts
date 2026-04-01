import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createServer } from '../server/index.ts';

let app: any;
describe('fs router', () => {
  beforeAll(async () => { app = await createServer(); });
  afterAll(async () => { await app?.close?.(); });
  afterEach(() => {
    delete process.env.AGENTFLOW_WEB_ALLOWED_ROOTS;
  });

  it('lists cwd by default', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fs/ls' });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(Array.isArray(json.items)).toBe(true);
  });

  it('exposes roots endpoint', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/fs/roots' });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(typeof json.repoRoot).toBe('string');
    expect(Array.isArray(json.allowedRoots)).toBe(true);
  });

  it('blocks paths outside the allowlist', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'af-web-fs-'));
    const allowed = path.join(base, 'allowed');
    const blocked = path.join(base, 'blocked');
    fs.mkdirSync(allowed);
    fs.mkdirSync(blocked);
    process.env.AGENTFLOW_WEB_ALLOWED_ROOTS = allowed;

    const res = await app.inject({
      method: 'GET',
      url: `/api/fs/ls?path=${encodeURIComponent(blocked)}`,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'path_not_allowed' });
  });
});

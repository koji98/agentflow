import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../server/index.ts';

let app: any;
describe('runs resume by id', () => {
  beforeAll(async () => { app = await createServer(); });
  afterAll(async () => { await app?.close?.(); });
  it('404 when run cannot be resolved', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/runs/does-not-exist/resume' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'run_not_found', runId: 'does-not-exist' });
  });
});

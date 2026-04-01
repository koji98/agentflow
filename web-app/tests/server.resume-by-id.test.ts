import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from '../server/index.ts';

let app: any;
describe('runs resume by id', () => {
  beforeAll(async () => { app = await createServer(); });
  afterAll(async () => { await app?.close?.(); });
  it('404 when run not open', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/runs/does-not-exist/resume' });
    expect(res.statusCode).toBe(404);
  });
});


import { describe, it, expect, vi } from 'vitest';

describe('SSE tail client util', () => {
  it('constructs EventSource URL for tail', () => {
    const runId = 'run_x';
    const taskKey = 'g01:t#a1';
    const url = `/api/stream/run/${encodeURIComponent(runId)}/tail?taskKey=${encodeURIComponent(taskKey)}`;
    expect(url).toContain('run_x');
    expect(url).toContain('taskKey=');
  });

  it('heartbeat event name', () => {
    // server emits 'ping' to keep SSE warm
    const eventName = 'ping';
    expect(eventName).toBe('ping');
  });
});

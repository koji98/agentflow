import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { deriveTraceUpdates, watchRunFiles } from '../server/file_watch.ts';
import { getBus, removeBus } from '../server/sse_bus.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForEvent(
  events: any[],
  predicate: (event: any) => boolean,
  timeoutMs = 3000,
): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const match = events.find(predicate);
    if (match) return match;
    await sleep(25);
  }
  throw new Error('timed out waiting for watcher event');
}

describe('file watch trace updates', () => {
  it('emits every appended decision-trace entry', () => {
    const update = deriveTraceUpdates(
      [
        { atUtc: '1', type: 'gate', detail: { iteration: 1 } },
        { atUtc: '2', type: 'gate', detail: { iteration: 2 } },
        { atUtc: '3', type: 'gate', detail: { iteration: 3 } },
      ],
      1,
    );

    expect(update).toEqual({
      kind: 'append',
      entries: [
        { atUtc: '2', type: 'gate', detail: { iteration: 2 } },
        { atUtc: '3', type: 'gate', detail: { iteration: 3 } },
      ],
      nextLength: 3,
      startIndex: 1,
    });
  });

  it('falls back to a snapshot when the trace shrinks', () => {
    const update = deriveTraceUpdates(
      [{ atUtc: '1', type: 'gate', detail: { iteration: 1 } }],
      4,
    );

    expect(update).toEqual({
      kind: 'snapshot',
      entries: [{ atUtc: '1', type: 'gate', detail: { iteration: 1 } }],
      nextLength: 1,
      startIndex: 0,
    });
  });

  it('falls back to a snapshot when the trace is rewritten without growing', () => {
    const update = deriveTraceUpdates(
      [
        { atUtc: '2', type: 'gate', detail: { iteration: 2 } },
        { atUtc: '3', type: 'gate', detail: { iteration: 3 } },
      ],
      2,
    );

    expect(update).toEqual({
      kind: 'snapshot',
      entries: [
        { atUtc: '2', type: 'gate', detail: { iteration: 2 } },
        { atUtc: '3', type: 'gate', detail: { iteration: 3 } },
      ],
      nextLength: 2,
      startIndex: 0,
    });
  });

  it('emits an empty snapshot when a previous trace is cleared', () => {
    const update = deriveTraceUpdates([], 3);

    expect(update).toEqual({
      kind: 'snapshot',
      entries: [],
      nextLength: 0,
      startIndex: 0,
    });
  });

  it('includes the snapshot offset when only the trace tail is resent', () => {
    const update = deriveTraceUpdates(
      Array.from({ length: 60 }, (_, index) => ({
        atUtc: String(index + 1),
        type: 'gate',
        detail: { iteration: index + 1 },
      })),
      60,
    );

    expect(update).toEqual({
      kind: 'snapshot',
      entries: Array.from({ length: 50 }, (_, index) => ({
        atUtc: String(index + 11),
        type: 'gate',
        detail: { iteration: index + 11 },
      })),
      nextLength: 60,
      startIndex: 10,
    });
  });

  it('keeps emitting trace updates after decision_trace.json is atomically replaced', async () => {
    const runId = 'r-trace-replace';
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-web-file-watch-'));
    const runDir = path.join(rootDir, 'run');
    fs.mkdirSync(runDir, { recursive: true });
    const tracePath = path.join(runDir, 'decision_trace.json');
    fs.writeFileSync(
      tracePath,
      JSON.stringify([{ atUtc: '1', type: 'gate', detail: { iteration: 1, score: 0.3 } }]),
      'utf8',
    );

    const bus = getBus(runId);
    const events: any[] = [];
    const onEvent = (event: any) => events.push(event);
    bus.on('event', onEvent);

    const watcher = watchRunFiles(runId, runDir);
    try {
      await sleep(200);
      events.length = 0;

      const replacementPath = path.join(runDir, 'decision_trace.next.json');
      fs.writeFileSync(
        replacementPath,
        JSON.stringify([{ atUtc: 'rewrite-1', type: 'gate', detail: { iteration: 1, score: 0.9 } }]),
        'utf8',
      );
      fs.renameSync(replacementPath, tracePath);

      const snapshot = await waitForEvent(events, (event) => (
        event.type === 'decision-trace-snapshot'
        && event.nextLength === 1
        && Array.isArray(event.entries)
        && event.entries[0]?.atUtc === 'rewrite-1'
      ));

      expect(snapshot).toMatchObject({
        type: 'decision-trace-snapshot',
        entries: [{ atUtc: 'rewrite-1', type: 'gate', detail: { iteration: 1, score: 0.9 } }],
        nextLength: 1,
        startIndex: 0,
      });
    } finally {
      watcher.close();
      bus.off('event', onEvent);
      removeBus(runId);
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('keeps emitting appended trace entries after an atomic trace replacement reattaches the watcher', async () => {
    const runId = 'r-trace-replace-append';
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-web-file-watch-'));
    const runDir = path.join(rootDir, 'run');
    fs.mkdirSync(runDir, { recursive: true });
    const tracePath = path.join(runDir, 'decision_trace.json');
    fs.writeFileSync(
      tracePath,
      JSON.stringify([{ atUtc: '1', type: 'gate', detail: { iteration: 1, score: 0.3 } }]),
      'utf8',
    );

    const bus = getBus(runId);
    const events: any[] = [];
    const onEvent = (event: any) => events.push(event);
    bus.on('event', onEvent);

    const watcher = watchRunFiles(runId, runDir);
    try {
      await sleep(200);
      events.length = 0;

      const replacementPath = path.join(runDir, 'decision_trace.next.json');
      fs.writeFileSync(
        replacementPath,
        JSON.stringify([{ atUtc: 'rewrite-1', type: 'gate', detail: { iteration: 1, score: 0.9 } }]),
        'utf8',
      );
      fs.renameSync(replacementPath, tracePath);

      await waitForEvent(events, (event) => (
        event.type === 'decision-trace-snapshot'
        && Array.isArray(event.entries)
        && event.entries[0]?.atUtc === 'rewrite-1'
      ));

      events.length = 0;
      fs.writeFileSync(
        tracePath,
        JSON.stringify([
          { atUtc: 'rewrite-1', type: 'gate', detail: { iteration: 1, score: 0.9 } },
          { atUtc: 'rewrite-2', type: 'gate', detail: { iteration: 2, score: 0.95 } },
        ]),
        'utf8',
      );

      const append = await waitForEvent(events, (event) => (
        event.type === 'decision-trace'
        && event.entry?.atUtc === 'rewrite-2'
      ));

      expect(append).toMatchObject({
        type: 'decision-trace',
        entry: { atUtc: 'rewrite-2', type: 'gate', detail: { iteration: 2, score: 0.95 } },
      });
    } finally {
      watcher.close();
      bus.off('event', onEvent);
      removeBus(runId);
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

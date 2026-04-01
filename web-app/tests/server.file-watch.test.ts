import { describe, expect, it } from 'vitest';

import { deriveTraceUpdates } from '../server/file_watch.ts';

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
    });
  });
});

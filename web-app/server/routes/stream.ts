import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { getBus } from '../sse_bus.ts';
import { isPathAllowed } from '../fs_access.ts';
import { readJsonFileWithRetries } from '../json_files.ts';
import { resolvePreferredRawOutputSource } from '../raw_output.ts';
import { resolveHandle } from '../run_manager.ts';

export type TailSource = {
  kind: 'log' | 'last_message';
  path: string;
  label: string;
};

export type LogTailCursor = {
  size: number;
  mtimeMs: number;
  fingerprint: string | null;
};

export function resolveTailSource(row: Record<string, unknown>): TailSource | null {
  return resolvePreferredRawOutputSource(row);
}

export function deriveSnapshotTailUpdate(previousText: string, nextText: string): string | null {
  return previousText === nextText ? null : nextText;
}

function emptyLogTailCursor(): LogTailCursor {
  return {
    size: 0,
    mtimeMs: 0,
    fingerprint: null,
  };
}

function readLogTailCursor(stat: fs.Stats): LogTailCursor {
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    fingerprint: `${stat.dev}:${stat.ino}`,
  };
}

export function deriveLogTailUpdateKind(
  previous: LogTailCursor,
  next: LogTailCursor,
): 'append' | 'snapshot' | null {
  if (previous.fingerprint && next.fingerprint && previous.fingerprint !== next.fingerprint) {
    return 'snapshot';
  }
  if (next.size < previous.size) return 'snapshot';
  if (next.size > previous.size) return 'append';
  if (next.size === previous.size && next.mtimeMs !== previous.mtimeMs) {
    return 'snapshot';
  }
  return null;
}

export default async function streamRouter(app: FastifyInstance): Promise<void> {
  app.get('/run/:runId/events', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const handle = resolveHandle(runId);
    if (!handle) return reply.code(404).send({ error: 'run_not_found' });
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.flushHeaders();

    const bus = getBus(runId);
    if (handle?.recentConsole?.length) {
      reply.sse({ event: 'run-console-snapshot', data: JSON.stringify({ type: 'run-console-snapshot', entries: handle.recentConsole }) });
    }
    const onEvent = (e: any): void => {
      reply.sse({ id: undefined, event: e.type, data: JSON.stringify(e) });
    };
    bus.on('event', onEvent);
    // Heartbeat/keepalive
    const iv = setInterval(() => {
      try { reply.sse({ event: 'ping', data: JSON.stringify({ t: Date.now() }) }); } catch {}
    }, 25000);
    req.raw.on('close', () => { bus.off('event', onEvent); clearInterval(iv); });
  });

  app.get('/run/:runId/tail', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const { taskKey } = req.query as { taskKey?: string };
    if (!taskKey) return reply.code(400).send({ error: 'taskKey_required' });

    const handle = resolveHandle(runId);
    if (!handle) return reply.code(404).send({ error: 'run_not_found' });

    // resolve log path from run_state.json
    const runDir = handle.runDir || null;
    const statePath = runDir ? path.resolve(runDir, 'run_state.json') : null;
    if (!statePath || !fs.existsSync(statePath)) return reply.code(404).send({ error: 'state_not_found' });

    const state = await readJsonFileWithRetries<any>(statePath) || handle.lastKnownState || null;
    if (!state) return reply.code(503).send({ error: 'state_unavailable' });
    const row = state.tasks?.[taskKey];
    const source = row ? resolveTailSource(row) : null;
    if (!source) return reply.code(404).send({ error: 'log_not_found' });
    if (!isPathAllowed(source.path)) return reply.code(403).send({ error: 'path_not_allowed' });

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.flushHeaders();

    let lastLogCursor = emptyLogTailCursor();
    let lastText = '';
    try {
      if (source.kind === 'last_message' && fs.existsSync(source.path)) {
        lastText = fs.readFileSync(source.path, 'utf8');
      }
      if (source.kind === 'log' && fs.existsSync(source.path)) {
        lastLogCursor = readLogTailCursor(fs.statSync(source.path));
      }
    } catch {
      lastLogCursor = emptyLogTailCursor();
      lastText = '';
    }

    const watcher = fs.watch(path.dirname(source.path), (_eventType, filename) => {
      if (filename) {
        const changedPath = path.resolve(path.dirname(source.path), filename.toString());
        if (changedPath !== source.path) return;
      }
      try {
        if (source.kind === 'last_message') {
          const nextText = fs.existsSync(source.path) ? fs.readFileSync(source.path, 'utf8') : '';
          const update = deriveSnapshotTailUpdate(lastText, nextText);
          lastText = nextText;
          if (update === null) return;
          reply.sse({
            event: 'log-snapshot',
            data: JSON.stringify({ type: 'log-snapshot', taskKey, text: update, source: source.kind }),
          });
          return;
        }

        if (!fs.existsSync(source.path)) {
          if (lastLogCursor.size !== 0 || lastLogCursor.fingerprint !== null) {
            lastLogCursor = emptyLogTailCursor();
            reply.sse({
              event: 'log-snapshot',
              data: JSON.stringify({ type: 'log-snapshot', taskKey, text: '', source: source.kind }),
            });
          }
          return;
        }

        const stat = fs.statSync(source.path);
        const nextLogCursor = readLogTailCursor(stat);
        const updateKind = deriveLogTailUpdateKind(lastLogCursor, nextLogCursor);
        if (updateKind === 'snapshot') {
          lastLogCursor = nextLogCursor;
          reply.sse({
            event: 'log-snapshot',
            data: JSON.stringify({
              type: 'log-snapshot',
              taskKey,
              text: fs.readFileSync(source.path, 'utf8'),
              source: source.kind,
            }),
          });
          return;
        }
        if (updateKind === 'append') {
          const fd = fs.openSync(source.path, 'r');
          const len = stat.size - lastLogCursor.size;
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, lastLogCursor.size);
          fs.closeSync(fd);
          lastLogCursor = nextLogCursor;
          const text = buf.toString('utf8');
          for (const line of text.split(/\r?\n/)) {
            if (line) reply.sse({ event: 'log-line', data: JSON.stringify({ type: 'log-line', taskKey, text: line }) });
          }
          return;
        }
        lastLogCursor = nextLogCursor;
      } catch {}
    });

    req.raw.on('close', () => { try { watcher.close(); } catch {} });
  });
}

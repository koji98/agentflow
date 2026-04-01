import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { getBus } from '../sse_bus.ts';
import { isPathAllowed } from '../fs_access.ts';
import { getHandle } from '../run_manager.ts';

export default async function streamRouter(app: FastifyInstance): Promise<void> {
  app.get('/run/:runId/events', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const handle = getHandle(runId);
    if (!handle) return reply.code(404).send({ error: 'run_not_open' });
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

    const handle = getHandle(runId);
    if (!handle) return reply.code(404).send({ error: 'run_not_open' });

    // resolve log path from run_state.json
    const runDir = handle.runDir || null;
    const statePath = runDir ? path.resolve(runDir, 'run_state.json') : null;
    if (!statePath || !fs.existsSync(statePath)) return reply.code(404).send({ error: 'state_not_found' });

    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as any;
    const row = state.tasks?.[taskKey];
    if (!row || !row.logPath) return reply.code(404).send({ error: 'log_not_found' });
    const logPath = String(row.logPath);
    if (!isPathAllowed(logPath)) return reply.code(403).send({ error: 'path_not_allowed' });

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.flushHeaders();

    let lastSize = 0;
    try { lastSize = fs.statSync(logPath).size; } catch { lastSize = 0; }
    const watcher = fs.watch(logPath, () => {
      try {
        const stat = fs.statSync(logPath);
        if (stat.size > lastSize) {
          const fd = fs.openSync(logPath, 'r');
          const len = stat.size - lastSize;
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, lastSize);
          fs.closeSync(fd);
          lastSize = stat.size;
          const text = buf.toString('utf8');
          for (const line of text.split(/\r?\n/)) {
            if (line) reply.sse({ event: 'log-line', data: JSON.stringify({ type: 'log-line', taskKey, text: line }) });
          }
        }
      } catch {}
    });

    req.raw.on('close', () => { try { watcher.close(); } catch {} });
  });
}

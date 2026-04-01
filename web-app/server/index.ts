import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import FastifySSEPlugin from 'fastify-sse-v2';

import runsRouter from './routes/runs.ts';
import fsRouter from './routes/fs.ts';
import planRouter from './routes/plan.ts';
import streamRouter from './routes/stream.ts';

const PORT = Number(process.env.PORT || 3208);
const HOST = process.env.HOST || '127.0.0.1';

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

const __dirnameShim = path.dirname(new URL(import.meta.url).pathname);

export async function createServer() {
  const app = Fastify({ logger: false });
  // Expose getHandle for routes that need it (SSE tail)
  (app as any).getHandle = undefined;
  // fastify-sse-v2 default export is a Fastify plugin; cast guards NodeNext typing edge cases
  await app.register(FastifySSEPlugin as any);

  // Health and version
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/version', async () => {
    const webRoot = path.resolve(__dirnameShim, '..');
    const rootRoot = path.resolve(webRoot, '..');
    const rootPkgPath = path.join(rootRoot, 'package.json');
    const webPkgPath = path.join(webRoot, 'package.json');
    const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
    const webPkg = JSON.parse(fs.readFileSync(webPkgPath, 'utf8'));
    return { agentflowVersion: rootPkg.version, webAppVersion: webPkg.version };
  });

  await app.register(runsRouter, { prefix: '/api/runs' });
  await app.register(fsRouter, { prefix: '/api/fs' });
  await app.register(planRouter, { prefix: '/api/plan' });
  await app.register(streamRouter, { prefix: '/api/stream' });

  // Static assets (prod build only)
  // Serve the built client from client/dist (vite root is client/)
  const staticDir = path.resolve(__dirnameShim, '..', 'client', 'dist');
  if (fs.existsSync(staticDir)) {
    await app.register(fastifyStatic, { root: staticDir, prefix: '/' });
    // SPA fallback
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.method === 'GET' && req.raw.headers.accept?.includes('text/html')) {
        try {
          const html = fs.readFileSync(path.join(staticDir, 'index.html'), 'utf8');
          reply.header('Content-Type', 'text/html').send(html);
          return;
        } catch {}
      }
      reply.code(404).send({ error: 'not_found' });
    });
  } else {
    app.get('/', async () => ({ ok: true, message: 'Dev mode. Use Vite on :5173.' }));
  }

  return app;
}

async function main() {
  const app = await createServer();
  if (process.argv.includes('--build-check')) return;
  if (!isLoopbackHost(HOST) && process.env.AGENTFLOW_WEB_ALLOW_REMOTE !== '1') {
    throw new Error('Refusing to bind agentflow web server to a non-loopback host without AGENTFLOW_WEB_ALLOW_REMOTE=1.');
  }
  try {
    await app.listen({ host: HOST, port: PORT });
  } catch (err) {
    if ((err as any).code === 'EADDRINUSE' && process.env.VITEST) {
      // In tests, avoid hard exit when address already in use.
      return;
    }
    throw err;
  }
  // eslint-disable-next-line no-console
  console.log();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  if (!process.env.VITEST) process.exit(1);
});

import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { findRepoRoot, getAllowedRoots, isPathAllowed } from '../fs_access.ts';

function isHidden(name: string): boolean { return name.startsWith('.'); }

export default async function fsRouter(app: FastifyInstance): Promise<void> {
  app.get('/roots', async () => {
    const repoRoot = findRepoRoot();
    const cwd = process.cwd();
    const home = process.env.HOME || process.env.USERPROFILE || '';
    return { repoRoot, cwd, home, allowedRoots: getAllowedRoots() };
  });

  app.get('/ls', async (req, reply) => {
    const q = req.query as { path?: string };
    const target = q.path ? path.resolve(String(q.path)) : process.cwd();
    if (!isPathAllowed(target)) return reply.code(403).send({ error: 'path_not_allowed' });
    let entries: string[] = [];
    try { entries = fs.readdirSync(target); } catch { return reply.code(400).send({ error: 'cannot_read_dir' }); }
    const items = entries.map((name) => {
      const full = path.resolve(target, name);
      let stat: fs.Stats | null = null;
      try { stat = fs.statSync(full); } catch { return null; }
      if (!stat) return null;
      return {
        name,
        path: full,
        type: stat.isDirectory() ? 'dir' : 'file',
        size: stat.isDirectory() ? 0 : stat.size,
        mtime: new Date(stat.mtimeMs).toISOString(),
        hidden: isHidden(name),
      };
    }).filter(Boolean) as any[];
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    return { items };
  });

  app.get('/read', async (req, reply) => {
    const q = req.query as { path?: string };
    if (!q.path) return reply.code(400).send({ error: 'path_required' });
    const filePath = path.resolve(String(q.path));
    if (!isPathAllowed(filePath)) return reply.code(403).send({ error: 'path_not_allowed' });
    if (!fs.existsSync(filePath)) return reply.code(404).send({ error: 'not_found' });
    try {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) return reply.code(400).send({ error: 'is_directory' });
      const sizeCap = 1_500_000; // 1.5 MB
      if (stat.size <= sizeCap) {
        const text = fs.readFileSync(filePath, 'utf8');
        return { text, size: stat.size, mtime: new Date(stat.mtimeMs).toISOString(), binary: false };
      }
      const fd = fs.openSync(filePath, 'r');
      const headSize = Math.min(64_000, stat.size);
      const headBuf = Buffer.alloc(headSize);
      fs.readSync(fd, headBuf, 0, headSize, 0);
      const tailSize = Math.min(64_000, stat.size);
      const tailBuf = Buffer.alloc(tailSize);
      fs.readSync(fd, tailBuf, 0, tailSize, stat.size - tailSize);
      fs.closeSync(fd);
      return {
        tooLarge: true,
        size: stat.size,
        mtime: new Date(stat.mtimeMs).toISOString(),
        head: headBuf.toString('utf8'),
        tail: tailBuf.toString('utf8'),
        binary: false,
      };
    } catch {
      return reply.code(500).send({ error: 'read_failed' });
    }
  });

  // Stream a file download (attachment) for local preview/download in browser
  app.get('/download', async (req, reply) => {
    const q = req.query as { path?: string };
    if (!q.path) return reply.code(400).send({ error: 'path_required' });
    const filePath = path.resolve(String(q.path));
    if (!isPathAllowed(filePath)) return reply.code(403).send({ error: 'path_not_allowed' });
    if (!fs.existsSync(filePath)) return reply.code(404).send({ error: 'not_found' });
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) return reply.code(400).send({ error: 'is_directory' });
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
    const stream = fs.createReadStream(filePath);
    return reply.send(stream);
  });
}

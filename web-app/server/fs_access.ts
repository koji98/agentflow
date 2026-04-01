import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function uniquePaths(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const resolved = path.resolve(value);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

export function findRepoRoot(startDir = process.cwd()): string {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 6; i += 1) {
    try {
      if (fs.existsSync(path.join(dir, 'bin', 'agentflow.js'))) return dir;
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir, '..');
}

export function getAllowedRoots(): string[] {
  const explicit = (process.env.AGENTFLOW_WEB_ALLOWED_ROOTS || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (explicit.length > 0) return uniquePaths(explicit);

  const repoRoot = findRepoRoot();
  return uniquePaths([
    repoRoot,
    process.cwd(),
    path.dirname(repoRoot),
    os.tmpdir(),
  ]);
}

export function isPathAllowed(targetPath: string, allowedRoots = getAllowedRoots()): boolean {
  const resolved = path.resolve(targetPath);
  const comparable = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return allowedRoots.some((root) => {
    const normalizedRoot = path.resolve(root);
    const comparableRoot = process.platform === 'win32' ? normalizedRoot.toLowerCase() : normalizedRoot;
    return comparable === comparableRoot || comparable.startsWith(`${comparableRoot}${path.sep}`);
  });
}


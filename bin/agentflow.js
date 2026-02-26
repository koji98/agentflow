#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const thisFile = fileURLToPath(import.meta.url);
const pkgRoot = path.resolve(path.dirname(thisFile), '..');
const entry = path.resolve(pkgRoot, 'src', 'cli.ts');
const require = createRequire(import.meta.url);

let tsxImport = 'tsx';
try {
  tsxImport = require.resolve('tsx/dist/loader.mjs');
} catch {
  // Fallback for environments where tsx is available on module resolution path.
}

const result = spawnSync(
  process.execPath,
  ['--import', tsxImport, entry, ...process.argv.slice(2)],
  {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
  },
);

if (result.error) {
  // eslint-disable-next-line no-console
  console.error(String(result.error));
  process.exit(1);
}
process.exit(result.status ?? 1);

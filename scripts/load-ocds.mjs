#!/usr/bin/env node
// Retired compatibility wrapper. Procurement OCDS now comes only from the storage.eop.bg per-day
// bucket handled by scripts/load-eop.mjs.

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const legacy = new Set(['--all', '--refresh']);
const args = process.argv.slice(2).filter((arg) => !legacy.has(arg) && !arg.startsWith('--limit='));

if (process.argv.includes('--all') || process.argv.some((arg) => arg.startsWith('--limit='))) {
  process.stderr.write(
    '!! scripts/load-ocds.mjs is retired; ignoring legacy --all/--limit flags. Use --from/--to.\n',
  );
}

execFileSync('node', ['scripts/load-eop.mjs', '--ocds-only', ...args], {
  stdio: 'inherit',
  cwd: root,
});

#!/usr/bin/env node
// Sigma ETL orchestrator for storage.eop.bg open-data buckets. Initial backfill and daily catch-up
// both route through scripts/load-eop.mjs; only the date window and derive mode differ.

import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeCatchupWindow, daysInWindow } from '../packages/ingest/src/ocds.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'apps/api');
const DEFAULT_FROM = '2020-01-01';
const LARGE_GAP_DAYS = 14;
const DEFAULT_LOOKBACK_DAYS = 3;

const remote = process.argv.includes('--remote');
const reset = process.argv.includes('--reset');
const catchup = process.argv.includes('--catchup');
const planOnly = process.argv.includes('--plan-only') || process.argv.includes('--dry-run');
const loc = remote ? '--remote' : '--local';
const passthru = remote ? ['--remote'] : [];

function arg(name) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function rangeFlags(from, to) {
  return [`--from=${from}`, `--to=${to}`];
}

function explicitRangeFlags() {
  const flags = [];
  for (const name of ['from', 'to']) {
    const value = arg(name);
    if (value !== undefined && value !== true) flags.push(`--${name}=${value}`);
  }
  return flags;
}

function run(cmd, args, cwd = root) {
  console.log(`\n==> ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', cwd });
}
const execSql = (file) => run('wrangler', ['d1', 'execute', 'sigma', loc, '--file', file], apiDir);

function d1(sql) {
  const out = execFileSync(
    'wrangler',
    ['d1', 'execute', 'sigma', loc, '--json', '--command', sql],
    {
      cwd: apiDir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const start = out.indexOf('[');
  if (start === -1) return [];
  return JSON.parse(out.slice(start))[0]?.results ?? [];
}

function safeD1(sql) {
  try {
    return d1(sql);
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (/no such table|does not exist/i.test(msg)) return [];
    throw err;
  }
}

function assertFxPopulated() {
  const rows = d1(
    "SELECT COUNT(*) AS missing_fx FROM contracts WHERE currency NOT IN ('BGN','EUR') " +
      "AND amount_eur IS NULL AND value_flag <> 'value_suspect'",
  );
  const missing = Number(rows[0]?.missing_fx ?? 0);
  if (missing > 0) {
    console.error(
      `!! FX assertion failed: ${missing} foreign-currency contracts have NULL amount_eur after normalize.`,
    );
    process.exit(1);
  }
}

function latestLoadedDate() {
  const rows = safeD1(`
    SELECT
      COUNT(*) AS rows,
      MAX(CASE
        WHEN substr(source, length(source) - 9, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        THEN substr(source, length(source) - 9, 10)
      END) AS max_source_day,
      MAX(CASE
        WHEN published_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        THEN published_at
      END) AS max_published_at
    FROM raw_egov_contracts
    WHERE source LIKE 'eop:%' OR source LIKE 'ocds:%'
  `);
  const loadedRows = Number(rows[0]?.rows ?? 0);
  if (loadedRows > 0) return rows[0]?.max_source_day ?? rows[0]?.max_published_at ?? null;

  const fallback = safeD1(`
    SELECT MAX(as_of) AS max_loaded_date
    FROM data_freshness
    WHERE source IN ('eop', 'ocds')
      AND as_of GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  `);
  return fallback[0]?.max_loaded_date ?? null;
}

function resolveCatchupPlan() {
  const today = String(arg('today') || todayUtc());
  const lookbackDays = Number(arg('lookback-days') || DEFAULT_LOOKBACK_DAYS);
  const maxLoadedDate = latestLoadedDate();
  if (!maxLoadedDate) {
    const from = String(arg('from') || DEFAULT_FROM);
    const to = String(arg('to') || today);
    return { from, to, maxLoadedDate, gapDays: daysInWindow(from, to), derive: 'full' };
  }
  const window = computeCatchupWindow({ maxLoadedDate, today, lookbackDays });
  const from = String(arg('from') || window.from);
  const to = String(arg('to') || window.to);
  const gapDays = daysInWindow(from, to);
  const requestedDerive = arg('derive');
  const derive =
    requestedDerive && requestedDerive !== true
      ? String(requestedDerive)
      : gapDays > LARGE_GAP_DAYS
        ? 'full'
        : 'slice';
  return { from, to, maxLoadedDate, gapDays, derive };
}

function validateDeriveMode(mode) {
  if (!['full', 'slice'].includes(mode))
    throw new Error(`unknown --derive=${mode}; expected full|slice`);
}

function runFullDerive() {
  execSql(resolve(root, 'scripts/derive-amendments.sql'));
  run('node', ['scripts/load-fx.mjs', '--apply', ...passthru]);
  execSql(resolve(root, 'scripts/load-nuts.sql'));
  execSql(resolve(root, 'scripts/normalize-egov.sql'));
  assertFxPopulated();
  execSql(resolve(root, 'scripts/precompute.sql'));
}

function runSliceDerive() {
  execSql(resolve(root, 'scripts/derive-amendments.sql'));
  run('node', ['scripts/load-fx.mjs', '--apply', ...passthru]);
  execSql(resolve(root, 'scripts/load-nuts.sql'));
  execSql(resolve(root, 'scripts/refresh-slice.sql'));
}

if (planOnly) {
  if (!catchup) throw new Error('--plan-only is only supported with --catchup');
  const plan = resolveCatchupPlan();
  validateDeriveMode(plan.derive);
  console.log(
    `==> catchup plan maxLoadedDate=${plan.maxLoadedDate || 'none'} from=${plan.from} to=${plan.to} gapDays=${plan.gapDays} derive=${plan.derive}`,
  );
  process.exit(0);
}

if (reset) {
  if (remote) {
    console.error(
      '!! --reset is local-only (refusing to wipe remote). Drop/recreate the remote D1 manually.',
    );
    process.exit(1);
  }
  const state = resolve(apiDir, '.wrangler/state/v3/d1');
  if (existsSync(state)) {
    rmSync(state, { recursive: true, force: true });
    console.log('==> reset: removed local D1 state');
  }
}

console.log(`==> Sigma import (${remote ? 'REMOTE' : 'local'})`);
run('wrangler', ['d1', 'migrations', 'apply', 'sigma', loc], apiDir);

let deriveMode = String(arg('derive') || 'full');
let loadFlags = explicitRangeFlags();
if (catchup) {
  const plan = resolveCatchupPlan();
  deriveMode = plan.derive;
  loadFlags = rangeFlags(plan.from, plan.to);
  console.log(
    `==> catchup window ${plan.from}..${plan.to} (${plan.gapDays} days, latest=${plan.maxLoadedDate || 'none'}, derive=${deriveMode})`,
  );
}
validateDeriveMode(deriveMode);

run('node', ['scripts/load-eop.mjs', '--apply', ...loadFlags, ...passthru]);
if (deriveMode === 'slice') runSliceDerive();
else runFullDerive();

console.log('\n==> import complete.');

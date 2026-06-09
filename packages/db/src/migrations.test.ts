/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migration0 = resolve(root, 'packages/db/migrations/0000_init.sql');
const migration1 = resolve(root, 'packages/db/migrations/0001_amendments.sql');
const migration2 = resolve(root, 'packages/db/migrations/0002_parties.sql');

function sqlite(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8' });
}

function readScript(dbPath: string, path: string): void {
  execFileSync('sqlite3', ['-bail', dbPath], { input: `.read ${path}\n`, stdio: 'pipe' });
}

describe('served migrations', () => {
  it('keeps amendments out of 0000 and adds them in 0001 while dropping raw staging', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-migrations-'));
    const dbPath = resolve(dir, 'test.sqlite');
    try {
      readScript(dbPath, migration0);
      expect(
        sqlite(dbPath, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='amendments';").trim(),
      ).toBe('0');

      sqlite(dbPath, 'CREATE TABLE raw_egov_contracts (id INTEGER); CREATE TABLE raw_tr_companies (id INTEGER);');
      readScript(dbPath, migration1);

      expect(
        sqlite(dbPath, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='amendments';").trim(),
      ).toBe('1');
      expect(
        sqlite(dbPath, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name LIKE 'raw_%';").trim(),
      ).toBe('0');
      expect(
        sqlite(dbPath, "SELECT COUNT(*) FROM pragma_table_info('amendments') WHERE name='natural_key' AND \"notnull\"=1;").trim(),
      ).toBe('1');

      readScript(dbPath, migration2);
      expect(
        sqlite(dbPath, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='parties';").trim(),
      ).toBe('1');
      expect(
        sqlite(dbPath, "SELECT COUNT(*) FROM pragma_table_info('parties') WHERE name='party_key' AND pk=1;").trim(),
      ).toBe('1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

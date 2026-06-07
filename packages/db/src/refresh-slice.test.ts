/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const schemaPath = resolve(root, 'packages/db/migrations/0000_init.sql');
const refreshSlicePath = resolve(root, 'scripts/refresh-slice.sql');

function sqlite(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8' });
}

function sqliteJson<T>(dbPath: string, sql: string): T[] {
  const out = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' }).trim();
  return out ? (JSON.parse(out) as T[]) : [];
}

function readScript(dbPath: string, path: string): void {
  execFileSync('sqlite3', [dbPath], {
    input: `PRAGMA foreign_keys=ON;\n.read ${path}\n`,
    stdio: 'pipe',
  });
}

function seedEopBaseDay(dbPath: string): void {
  sqlite(
    dbPath,
    `PRAGMA foreign_keys=ON;
INSERT INTO raw_egov_tenders
  (source, dataset_year, fetched_at, unp, tender_id, procedure_type, procurement_subject,
   cpv_code, cpv_description, contract_kind, estimated_value, currency, legal_basis,
   award_criteria, authority_name, authority_eik, authority_type, main_activity, deadline,
   notice_type, lot_id, lot_name, num_lots, eu_funded, published_at)
VALUES
  ('eop:tenders:2026-06-01', 2026, '2026-06-07T00:00:00Z', 'UNP-CE-1', 'TENDER-CE-1',
   'open', 'Base tender', '45000000', 'Construction', 'works', 2000, 'BGN', 'basis',
   'lowest', 'Authority CE', '123456789', 'public', 'activity', '2026-06-10', 'notice',
   NULL, NULL, 1, 0, '2026-06-01'),
  ('eop:tenders:2026-06-01', 2026, '2026-06-07T00:00:00Z', 'UNP-CE-1', 'TENDER-CE-1',
   'open', 'Base tender', '45000000', 'Construction', 'works', 2000, 'BGN', 'basis',
   'lowest', 'Authority CE', '123456789', 'public', 'activity', '2026-06-10', 'notice',
   '1', 'Lot 1', 1, 0, '2026-06-01');

INSERT INTO raw_egov_contracts
  (source, dataset_year, dataset_variant, fetched_at, needs_enrichment, document_number,
   published_at, unp, tender_ext_id, procedure_type, procurement_subject, cpv_code,
   cpv_description, contract_kind, estimated_value, procurement_currency, legal_basis,
   award_criteria, authority_name, authority_eik, authority_type, main_activity, notice_type,
   lot_id, contract_number, contract_date, signing_value, currency, contract_subject,
   awarded_to_group, contractor_eik, contractor_name, contractor_country, winner_size,
   eu_funded, bids_received, bids_sme, bids_rejected, bids_non_eea, duration_days)
VALUES
  ('eop:contracts:2026-06-01', 2026, 'eop', '2026-06-07T00:00:00Z', 0, 'DOC-CE-1',
   '2026-06-01', 'UNP-CE-1', 'TENDER-CE-1', 'open', 'Base tender', '45000000',
   'Construction', 'works', 2000, 'BGN', 'basis', 'lowest', 'Authority CE', '123456789',
   'public', 'activity', 'notice', '1', 'CONTRACT-CE-1', '2026-06-02', 1000, 'BGN',
   'Base contract', 0, '987654321', 'Bidder CE', 'BG', 'small', 0, 3, 1, 0, 0, 30);
`,
  );
}

describe('refresh-slice EOP base derivation', () => {
  it('derives new eop base rows as c:e contracts and is idempotent', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'sigma-refresh-slice-'));
    const dbPath = resolve(dir, 'test.sqlite');
    try {
      readScript(dbPath, schemaPath);
      seedEopBaseDay(dbPath);

      readScript(dbPath, refreshSlicePath);

      const firstContracts = sqliteJson<{ id: string; amount_eur: number }>(
        dbPath,
        "SELECT id, amount_eur FROM contracts WHERE id GLOB 'c:e:*' ORDER BY id",
      );
      expect(firstContracts.length).toBeGreaterThan(0);
      expect(firstContracts[0]?.amount_eur).toBeCloseTo(1000 / 1.95583, 6);

      expect(
        sqliteJson<{ n: number }>(dbPath, 'SELECT COUNT(*) AS n FROM company_totals')[0]?.n,
      ).toBe(1);
      expect(
        sqliteJson<{ n: number }>(dbPath, 'SELECT COUNT(*) AS n FROM authority_totals')[0]?.n,
      ).toBe(1);
      expect(
        sqliteJson<{ n: number }>(
          dbPath,
          "SELECT COUNT(*) AS n FROM search_index WHERE kind = 'contract' AND ref GLOB 'c:e:*'",
        )[0]?.n,
      ).toBe(firstContracts.length);
      expect(sqlite(dbPath, 'PRAGMA foreign_key_check;').trim()).toBe('');

      readScript(dbPath, refreshSlicePath);

      const secondContracts = sqliteJson<{ id: string; amount_eur: number }>(
        dbPath,
        "SELECT id, amount_eur FROM contracts WHERE id GLOB 'c:e:*' ORDER BY id",
      );
      expect(secondContracts).toEqual(firstContracts);
      expect(sqlite(dbPath, 'PRAGMA foreign_key_check;').trim()).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

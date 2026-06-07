import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { deleteSqlForEopSources } from './load-eop.mjs';

describe('deleteSqlForEopSources', () => {
  it('keeps the existing single-day source wipe', () => {
    assert.equal(
      deleteSqlForEopSources('raw_egov_contracts', 'contracts', ['2024-01-02']),
      "DELETE FROM raw_egov_contracts WHERE source = 'eop:contracts:2024-01-02';\n",
    );
  });

  it('scopes multi-day wipes to the requested window', () => {
    const sql = deleteSqlForEopSources('raw_egov_contracts', 'contracts', [
      '2024-01-02',
      '2024-01-03',
    ]);

    assert.equal(
      sql,
      "DELETE FROM raw_egov_contracts WHERE source IN (\n  'eop:contracts:2024-01-02',\n  'eop:contracts:2024-01-03'\n);\n",
    );
    assert.equal(sql.includes("source LIKE 'eop:contracts:%'"), false);
  });
});

-- Sigma — data-quality columns on contracts, set by scripts/normalize-egov.sql.
--
-- The admin ЦАИС ЕОП register carries a small number of source data-entry errors and a
-- mix of currencies. These were investigated (May 2026) and the findings drive two columns:
--
--   * value_flag — a per-contract quality verdict. ~213 contracts (0.12 %) carry a value
--     ≥100× their estimate; raw-cell inspection (e.g. signing `6938481985,00` vs estimate
--     `69384819,85` — a dropped decimal comma) and a cross-check against the open-data portal
--     (which holds the IDENTICAL erroneous values — same ЦАИС source, 108/108 matched, 0
--     corrected) confirm these are UPSTREAM source errors, not a load artifact, and are NOT
--     recoverable from the open data. So we flag, never fabricate a "correction":
--       'value_suspect'  — the signed value itself is ≥100× the estimate (untrustworthy).
--       'annex_suspect'  — an amendment pushed current_value ≥100× signing, or negative; the
--                          signing value is sane (it matches the estimate), so we fall back to it.
--       'review'         — 10–100× the estimate (gray zone: some real frameworks, some errors).
--       'ok'             — normal.
--
--   * amount_bgn — the canonical, SAFE-TO-SUM value in BGN. Currency is kept per row on
--     `contracts.currency` (BGN pre-2026, EUR from 2026, a few foreign); amount_bgn converts
--     EUR at the fixed lev rate (1 EUR = 1.95583 BGN) and is NULL for value_suspect rows and
--     for unconvertible foreign currencies — so SUM(amount_bgn) is always a clean total, while
--     `amount` stays the faithful as-recorded value for display.

ALTER TABLE contracts ADD COLUMN amount_bgn REAL;                      -- canonical BGN; NULL = excluded (value_suspect / foreign ccy)
ALTER TABLE contracts ADD COLUMN value_flag TEXT NOT NULL DEFAULT 'ok'; -- ok | review | annex_suspect | value_suspect
CREATE INDEX IF NOT EXISTS idx_contracts_value_flag ON contracts(value_flag);

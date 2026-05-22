-- Sigma — domain v2: promote the rich admin ЦАИС ЕОП fields into the domain tables.
--
-- The domain was first built from the thin xlsx bootstrap (scripts/normalize-aop.sql),
-- which carried almost none of the procedure-level detail. The admin export
-- (raw_egov_contracts / raw_egov_tenders, loaded by scripts/load-admin.mjs) is now the
-- authoritative source for 2020–2026 and is rich per row, so scripts/normalize-egov.sql
-- rebuilds the domain from it. These additive columns are exactly the fields
-- docs/core-scope.md flagged as "data dependencies this scope needs" — without them the
-- explorer cannot show authority type, lot structure, the signing→current value history,
-- or the EU-funding / competition context. All NULL-able; no data is dropped.

-- Authority kind (Вид на възложителя): public body, utility, sectoral, etc.
ALTER TABLE authorities ADD COLUMN type TEXT;

-- Procurement-level context. cpv_description is the human-readable CPV label; contract_kind
-- is Доставки / Услуги / Строителство; num_lots is the declared lot count (lots are rows in `lots`).
ALTER TABLE tenders ADD COLUMN cpv_description TEXT;
ALTER TABLE tenders ADD COLUMN contract_kind TEXT;
ALTER TABLE tenders ADD COLUMN num_lots INTEGER;

-- Contract-level detail. `amount` stays the live (current) value for safe money sums;
-- signing_value + current_value keep the signed→current history explicit, annex_count is
-- how many amendments produced it. eu_funded / bids_received / contract_kind give the
-- explorer the funding source, competition level, and category per contract line.
ALTER TABLE contracts ADD COLUMN contract_number TEXT;
ALTER TABLE contracts ADD COLUMN signing_value REAL;
ALTER TABLE contracts ADD COLUMN current_value REAL;
ALTER TABLE contracts ADD COLUMN annex_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contracts ADD COLUMN eu_funded INTEGER;
ALTER TABLE contracts ADD COLUMN bids_received INTEGER;
ALTER TABLE contracts ADD COLUMN contract_kind TEXT;
-- "Възложена на група": this AWARD went to an обединение/консорциум. It is a per-contract
-- fact (a company can win some contracts solo and some as part of a group), so it lives on
-- the contract — not on bidders.is_consortium, which describes the entity (a JV with its own ЕИК).
ALTER TABLE contracts ADD COLUMN awarded_to_group INTEGER;
CREATE INDEX IF NOT EXISTS idx_contracts_bidder ON contracts(bidder_id);

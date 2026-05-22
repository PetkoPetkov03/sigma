-- Sigma — normalise the admin ЦАИС ЕОП staging into the domain tables
-- (authorities, tenders, lots, bidders, contracts). Run AFTER scripts/load-admin.mjs
-- (+ scripts/derive-amendments.sql for current_value/annex_count) have populated staging:
--   (cd apps/api && wrangler d1 execute sigma --local --file ../../scripts/normalize-egov.sql)
--
-- SOURCE MODEL (see docs/etl-pipeline.md): the admin export is the authoritative base for
-- 2020–2026 (raw_egov_contracts + raw_egov_tenders, source 'admin:%'). The OCDS JSON feed
-- is the go-forward delta for new 2026+ data; when those rows land (source 'ocds:%') they
-- carry their procedure fields on the contract row and are picked up here automatically —
-- a contract whose УНП has no tenders-export row gets a synthetic tender (step 2b). When
-- OCDS overlaps the admin snapshot, dedupe must happen at load time (admin wins); the admin
-- export already covers through the snapshot date, so there is no overlap to resolve today.
--
-- FULL REBUILD: clears the derived tables and re-inserts from staging, so a re-run always
-- reflects the current rules and never leaves stale rows. wrangler runs this file as one
-- atomic D1 batch (explicit BEGIN/COMMIT is rejected), so a failed run rolls back.
--
-- Cleaning policy — staging stays 100% raw; cleaning happens only here:
--   * Currency is kept per row as it appears (BGN pre-2026, EUR from 2026, a few foreign) —
--     NOT coerced to one currency. Money sums must group/convert by currency downstream.
--   * Authorities dedupe on ЕИК (Вид на възложителя kept as `type`); a canonical name is kept.
--   * Bidders dedupe on raw contractor ЕИК (kept verbatim in bulstat); is_consortium comes from
--     the admin "възложена на група" flag (awarded_to_group), not a name heuristic. Members
--     hidden behind a single consortium ЕИК need the Търговски регистър (joined on ЕИК) — a
--     later pipeline; bidder_members stays empty and contract_participants attributes the full
--     value to the consortium entity (role 'consortium_unresolved').
--   * Tenders come from the tenders-export header row (one per УНП); lots from its lot rows.
--     11k+ УНП appear only in contracts (no tenders row) → a synthetic 'неизвестна' tender so
--     every contract has a parent. bids stays empty (the data has a bid COUNT, not bids).

-- Full clear in child→parent order (D1 enforces FKs). risk_scores/bids are dependents and
-- are stale after a domain reload; risk_scores is recomputed by apps/etl after this runs.
DELETE FROM bidder_members;
DELETE FROM contracts;
DELETE FROM bids;
DELETE FROM risk_scores;
DELETE FROM lots;
DELETE FROM tenders;
DELETE FROM bidders;
DELETE FROM authorities;

-- 1) Authorities — dedupe on ЕИК across both contracts and tenders staging, keep a
--    canonical display name and the authority type (Вид на възложителя).
INSERT OR IGNORE INTO authorities (id, name, bulstat, type)
SELECT 'auth:' || authority_eik, MIN(authority_name), authority_eik, MAX(authority_type)
FROM (
  SELECT authority_eik, authority_name, authority_type FROM raw_egov_contracts WHERE authority_eik IS NOT NULL
  UNION ALL
  SELECT authority_eik, authority_name, authority_type FROM raw_egov_tenders   WHERE authority_eik IS NOT NULL
)
GROUP BY authority_eik;

-- 2a) Tenders — the header row of each procurement (lot_id IS NULL): one per УНП, carrying
--     procedure type, CPV, the procurement-level estimated value, lot count and authority.
INSERT OR IGNORE INTO tenders
  (id, source_id, title, authority_id, cpv_code, cpv_description, estimated_value, currency,
   procedure_type, contract_kind, num_lots, status, deadline_at)
SELECT
  't:' || t.unp,
  t.unp,
  COALESCE(t.procurement_subject, '(без предмет)'),
  'auth:' || t.authority_eik,
  t.cpv_code,
  t.cpv_description,
  t.estimated_value,
  COALESCE(t.currency, 'BGN'),
  COALESCE(t.procedure_type, 'неизвестна'),
  t.contract_kind,
  t.num_lots,
  CASE WHEN EXISTS (SELECT 1 FROM raw_egov_contracts c WHERE c.unp = t.unp) THEN 'awarded' ELSE 'published' END,
  t.deadline
FROM raw_egov_tenders t
WHERE t.lot_id IS NULL;

-- 2b) Synthetic tenders — УНП that appear only in contracts (no tenders-export row), so
--     every contract has a parent. Procedure type is unknown ('неизвестна'); subject/CPV/
--     estimated are taken from the contract line.
INSERT OR IGNORE INTO tenders
  (id, source_id, title, authority_id, cpv_code, estimated_value, currency,
   procedure_type, contract_kind, status)
SELECT
  't:' || c.unp,
  c.unp,
  COALESCE(MIN(c.procurement_subject), '(без предмет)'),
  'auth:' || MIN(c.authority_eik),
  MIN(c.cpv_code),
  MIN(c.estimated_value),
  COALESCE(MIN(c.currency), 'BGN'),
  'неизвестна',
  MIN(c.contract_kind),
  'awarded'
FROM raw_egov_contracts c
WHERE c.unp IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM raw_egov_tenders t WHERE t.unp = c.unp)
GROUP BY c.unp;

-- 3) Lots — the lot rows of each procurement (lot_id IS NOT NULL), linked to their tender.
INSERT OR IGNORE INTO lots (id, tender_id, title, cpv_code, estimated_value)
SELECT
  'lot:' || t.unp || ':' || t.lot_id,
  't:' || t.unp,
  COALESCE(t.lot_name, '(без предмет)'),
  t.cpv_code,
  t.estimated_value
FROM raw_egov_tenders t
WHERE t.lot_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM tenders te WHERE te.id = 't:' || t.unp);

-- 4) Bidders — winning contractors, with a robust identity key:
--      * valid ЕИК (digits-only, length 9/13)  → key by ЕИК       ('eik:<eik>')
--      * otherwise (withheld 'не се публикува', foreign id, multi-ЕИК consortium, missing) →
--        key by NORMALISED NAME ('name:<UPPER+collapsed name>')
--    Keying invalid ЕИК by name stops the collapse where ~595 distinct withheld-ЕИК contractors
--    merged onto one node. bulstat/eik_normalized stay set only for a valid ЕИК (NULL otherwise,
--    which keeps the bulstat UNIQUE happy). is_consortium describes the ENTITY (a JV), so it is
--    name-based — a semicolon member list or ДЗЗД / ОБЕДИНЕНИЕ / КОНСОРЦИУМ in the name; the
--    per-contract awarded_to_group flag lives on contracts, not here.
INSERT OR IGNORE INTO bidders (id, name, bulstat, eik_normalized, eik_valid, is_consortium, kind)
SELECT
  bidder_key,
  MIN(contractor_name),
  MIN(CASE WHEN eik_valid = 1 THEN eik_clean END),
  MIN(CASE WHEN eik_valid = 1 THEN eik_clean END),
  MAX(eik_valid),
  MAX(grp),
  CASE WHEN MAX(grp) = 1 THEN 'consortium' ELSE 'company' END
FROM (
  SELECT
    contractor_name,
    eik_clean,
    CASE WHEN eik_clean NOT GLOB '*[^0-9]*' AND LENGTH(eik_clean) IN (9, 13) THEN 1 ELSE 0 END AS eik_valid,
    CASE
      WHEN eik_clean NOT GLOB '*[^0-9]*' AND LENGTH(eik_clean) IN (9, 13) THEN 'eik:' || eik_clean
      WHEN contractor_name IS NOT NULL AND TRIM(contractor_name) <> '' THEN 'name:' || UPPER(TRIM(REPLACE(REPLACE(contractor_name, '  ', ' '), '  ', ' ')))
      ELSE NULL
    END AS bidder_key,
    CASE
      WHEN contractor_name LIKE '%;%'
        OR UPPER(contractor_name) LIKE '%ДЗЗД%'
        OR UPPER(contractor_name) LIKE '%ОБЕДИНЕНИЕ%'
        OR UPPER(contractor_name) LIKE '%КОНСОРЦИУМ%'
      THEN 1 ELSE 0
    END AS grp
  FROM (
    SELECT
      contractor_name,
      TRIM(CASE WHEN contractor_eik LIKE 'ЕИК %' THEN SUBSTR(contractor_eik, 5) ELSE contractor_eik END) AS eik_clean
    FROM raw_egov_contracts WHERE source LIKE 'admin:%'
  )
)
WHERE bidder_key IS NOT NULL
GROUP BY bidder_key;

-- 5) Contracts — awarded lines (1:1 with staging rows), linked to tender + winning bidder,
--    with the data-quality verdict (see 0007_data_quality.sql):
--      value_flag = 'value_suspect'  signed value ≥100× estimate (untrustworthy, excluded from sums)
--                 | 'annex_suspect'  amendment pushed current_value ≥100× signing, or negative →
--                                    fall back to the sane signing value (the contract still counts)
--                 | 'review'         10–100× estimate (kept, but flagged)
--                 | 'ok'
--    `amount` is the as-recorded display value (current_value when an annex legitimately raised it,
--    else signing; signing for annex_suspect). `amount_bgn` is the SAFE-TO-SUM canonical value:
--    EUR→BGN at the fixed 1.95583, NULL for value_suspect and unconvertible foreign currencies.
INSERT OR IGNORE INTO contracts
  (id, tender_id, bidder_id, amount, currency, signed_at,
   contract_number, signing_value, current_value, annex_count, eu_funded, bids_received,
   contract_kind, awarded_to_group, value_flag, amount_bgn)
SELECT
  'c:' || x.id,
  't:' || x.unp,
  x.bidder_key,
  CASE WHEN x.value_flag = 'annex_suspect' THEN x.signing_value ELSE COALESCE(x.current_value, x.signing_value) END,
  COALESCE(x.currency, 'BGN'),
  x.contract_date,
  x.contract_number,
  x.signing_value,
  x.current_value,
  COALESCE(x.annex_count, 0),
  x.eu_funded,
  x.bids_received,
  x.contract_kind,
  x.awarded_to_group,
  x.value_flag,
  CASE COALESCE(x.currency, 'BGN')
    WHEN 'BGN' THEN x.trusted_native
    WHEN 'EUR' THEN x.trusted_native * 1.95583
    ELSE NULL
  END
FROM (
  SELECT y.*,
    CASE y.value_flag
      WHEN 'value_suspect' THEN NULL
      WHEN 'annex_suspect' THEN y.signing_value
      ELSE COALESCE(y.current_value, y.signing_value)
    END AS trusted_native
  FROM (
    SELECT c.*,
      CASE
        WHEN c.estimated_value > 0 AND c.signing_value / c.estimated_value >= 100 THEN 'value_suspect'
        WHEN c.current_value IS NOT NULL AND (c.current_value < 0 OR (c.signing_value > 0 AND c.current_value / c.signing_value >= 100)) THEN 'annex_suspect'
        WHEN c.estimated_value > 0 AND COALESCE(c.current_value, c.signing_value) / c.estimated_value >= 10 THEN 'review'
        ELSE 'ok'
      END AS value_flag,
      CASE
        WHEN TRIM(CASE WHEN c.contractor_eik LIKE 'ЕИК %' THEN SUBSTR(c.contractor_eik, 5) ELSE c.contractor_eik END) NOT GLOB '*[^0-9]*'
         AND LENGTH(TRIM(CASE WHEN c.contractor_eik LIKE 'ЕИК %' THEN SUBSTR(c.contractor_eik, 5) ELSE c.contractor_eik END)) IN (9, 13)
        THEN 'eik:' || TRIM(CASE WHEN c.contractor_eik LIKE 'ЕИК %' THEN SUBSTR(c.contractor_eik, 5) ELSE c.contractor_eik END)
        WHEN c.contractor_name IS NOT NULL AND TRIM(c.contractor_name) <> '' THEN 'name:' || UPPER(TRIM(REPLACE(REPLACE(c.contractor_name, '  ', ' '), '  ', ' ')))
        ELSE NULL
      END AS bidder_key
    FROM raw_egov_contracts c WHERE c.source LIKE 'admin:%'
  ) y
) x
WHERE x.bidder_key IS NOT NULL
  AND COALESCE(x.current_value, x.signing_value) IS NOT NULL
  AND EXISTS (SELECT 1 FROM tenders te WHERE te.id = 't:' || x.unp)
  AND EXISTS (SELECT 1 FROM bidders  b  WHERE b.id  = x.bidder_key);

-- Summary (last result set printed by `wrangler d1 execute`)
SELECT
  (SELECT COUNT(*) FROM authorities)                              AS authorities,
  (SELECT COUNT(*) FROM tenders)                                  AS tenders,
  (SELECT COUNT(*) FROM lots)                                     AS lots,
  (SELECT COUNT(*) FROM bidders)                                  AS bidders,
  (SELECT COUNT(*) FROM bidders WHERE eik_valid = 0)              AS bidders_name_keyed,
  (SELECT COUNT(*) FROM bidders WHERE kind = 'consortium')        AS consortia,
  (SELECT COUNT(*) FROM contracts)                                AS contracts,
  (SELECT COUNT(*) FROM contracts WHERE value_flag = 'value_suspect') AS value_suspect,
  (SELECT COUNT(*) FROM contracts WHERE value_flag = 'annex_suspect') AS annex_suspect,
  (SELECT COUNT(*) FROM contracts WHERE value_flag = 'review')    AS review,
  (SELECT ROUND(SUM(amount_bgn) / 1e9, 2) FROM contracts)        AS clean_total_bn;

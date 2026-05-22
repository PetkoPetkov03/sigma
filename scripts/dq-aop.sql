-- Sigma — data-quality report for the raw_aop_contracts staging table.
-- Read-only and re-runnable; run it after each load to track quality over time:
--   (cd apps/api && wrangler d1 execute sigma --local --file ../../scripts/dq-aop.sql)
-- Every section returns uniform rows: (check_name, detail, n).

-- Row counts
SELECT 'rows' AS check_name, dataset AS detail, COUNT(*) AS n
FROM raw_aop_contracts GROUP BY dataset
UNION ALL SELECT 'rows', '(total)', COUNT(*) FROM raw_aop_contracts;

-- Authority hygiene — gap between raw and normalised distinct counts = phantom dupes
SELECT 'authorities' AS check_name, 'raw_distinct' AS detail,
  COUNT(DISTINCT authority_name) AS n
FROM raw_aop_contracts WHERE authority_name IS NOT NULL
UNION ALL SELECT 'authorities', 'normalised_distinct',
  COUNT(DISTINCT UPPER(TRIM(REPLACE(REPLACE(authority_name, '  ', ' '), '  ', ' '))))
FROM raw_aop_contracts WHERE authority_name IS NOT NULL;

-- ЕИК validity buckets
SELECT 'eik' AS check_name, 'valid_9_or_13_digit' AS detail, COUNT(*) AS n
  FROM raw_aop_contracts
  WHERE contractor_eik IS NOT NULL AND contractor_eik NOT GLOB '*[^0-9]*' AND LENGTH(contractor_eik) IN (9, 13)
UNION ALL SELECT 'eik', 'has_letters_or_symbols', COUNT(*)
  FROM raw_aop_contracts WHERE contractor_eik GLOB '*[^0-9]*'
UNION ALL SELECT 'eik', 'prefix_label_recoverable', COUNT(*)
  FROM raw_aop_contracts WHERE contractor_eik LIKE 'ЕИК %'
UNION ALL SELECT 'eik', 'placeholder_not_published', COUNT(*)
  FROM raw_aop_contracts WHERE contractor_eik = 'не се публикува'
UNION ALL SELECT 'eik', 'separator_in_field', COUNT(*)
  FROM raw_aop_contracts
  WHERE contractor_eik LIKE '%/%' OR contractor_eik LIKE '%;%' OR contractor_eik LIKE '%,%' OR contractor_eik LIKE '%+%';

-- Consortia / обединения (the bulk are detectable only by name markers)
SELECT 'consortium' AS check_name, 'rows_by_name_marker' AS detail, COUNT(*) AS n
  FROM raw_aop_contracts
  WHERE contractor_name LIKE '%ДЗЗД%' OR UPPER(contractor_name) LIKE '%ОБЕДИНЕНИЕ%' OR UPPER(contractor_name) LIKE '%КОНСОРЦИУМ%'
UNION ALL SELECT 'consortium', 'distinct_names', COUNT(DISTINCT contractor_name)
  FROM raw_aop_contracts
  WHERE contractor_name LIKE '%ДЗЗД%' OR UPPER(contractor_name) LIKE '%ОБЕДИНЕНИЕ%' OR UPPER(contractor_name) LIKE '%КОНСОРЦИУМ%';

-- contract_kind domain (note: kind ≠ dataset/file)
SELECT 'contract_kind' AS check_name, COALESCE(contract_kind, '(null)') AS detail, COUNT(*) AS n
FROM raw_aop_contracts GROUP BY contract_kind;

-- Value anomalies (incl. a value-growth red-flag signal)
SELECT 'values' AS check_name, 'zero_signing' AS detail, COUNT(*) AS n
  FROM raw_aop_contracts WHERE signing_value_eur = 0
UNION ALL SELECT 'values', 'negative_any', COUNT(*)
  FROM raw_aop_contracts WHERE estimated_value_eur < 0 OR signing_value_eur < 0 OR current_value_eur < 0
UNION ALL SELECT 'values', 'current_over_2x_signing', COUNT(*)
  FROM raw_aop_contracts WHERE signing_value_eur > 0 AND current_value_eur > 2 * signing_value_eur;

-- Date anomalies
SELECT 'dates' AS check_name, 'end_before_start' AS detail, COUNT(*) AS n
  FROM raw_aop_contracts WHERE contract_end_date < contract_start_date
UNION ALL SELECT 'dates', 'deadline_2027_plus', COUNT(*)
  FROM raw_aop_contracts WHERE submission_deadline >= '2027'
UNION ALL SELECT 'dates', 'deadline_pre_2019', COUNT(*)
  FROM raw_aop_contracts WHERE submission_deadline < '2019';

-- Grain integrity — reused top-level ids are fine as long as tender attrs agree
SELECT 'grain' AS check_name, 'toplevel_ids_reused' AS detail, COUNT(*) AS n FROM
  (SELECT tender_internal_id FROM raw_aop_contracts WHERE parent_tender_id IS NULL
   GROUP BY tender_internal_id HAVING COUNT(*) > 1)
UNION ALL SELECT 'grain', 'reused_ids_divergent_unp', COUNT(*) FROM
  (SELECT tender_internal_id FROM raw_aop_contracts WHERE parent_tender_id IS NULL
   GROUP BY tender_internal_id HAVING COUNT(DISTINCT unp) > 1)
UNION ALL SELECT 'grain', 'lot_rows', COUNT(*)
  FROM raw_aop_contracts WHERE parent_tender_id IS NOT NULL;

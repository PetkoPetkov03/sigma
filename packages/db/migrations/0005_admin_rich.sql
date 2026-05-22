-- Sigma — rich fields from the admin ЦАИС ЕОП export (data/Open_data_resources.zip).
--
-- That export (Contracts/Tenders/Annexes, 2020–2026) is the authoritative source: each
-- contract row already carries the procedure-level fields the public open data lacked
-- (procedure type, CPV, estimated value, lots, authority type, consortium flag). So it
-- supersedes the thin portal CSVs and the xlsx for 2020–2026, and there is no separate
-- УНП enrichment pass — load-admin.mjs writes these directly (needs_enrichment = 0).

-- Rich columns onto the existing contracts staging.
ALTER TABLE raw_egov_contracts ADD COLUMN cpv_description TEXT;     -- Описание на CPV кода
ALTER TABLE raw_egov_contracts ADD COLUMN authority_type TEXT;      -- Вид на възложителя
ALTER TABLE raw_egov_contracts ADD COLUMN awarded_to_group INTEGER; -- Възложена на група (consortium)
ALTER TABLE raw_egov_contracts ADD COLUMN lot_id TEXT;              -- Идентификатор на обособена позиция
ALTER TABLE raw_egov_contracts ADD COLUMN award_criteria TEXT;      -- Критерий за възлагане
ALTER TABLE raw_egov_contracts ADD COLUMN legal_basis TEXT;         -- Правно основание за откриване

-- Procedure-level records (lot-grained) from the admin Tenders export. Feeds the domain
-- tenders/lots tables with procedure type, CPV, estimated value and lot structure —
-- including procedures that never produced a signed contract.
CREATE TABLE IF NOT EXISTS raw_egov_tenders (
  id              INTEGER PRIMARY KEY,
  source          TEXT NOT NULL,        -- 'admin:tenders:2023'
  dataset_year    INTEGER,
  fetched_at      TEXT NOT NULL,
  unp             TEXT,                  -- Уникален номер на поръчката
  tender_id       TEXT,                  -- ID на поръчката
  procedure_type  TEXT,                  -- Вид на поръчката
  procurement_subject TEXT,              -- Предмет на поръчката
  cpv_code        TEXT,
  cpv_description TEXT,
  contract_kind   TEXT,                  -- Обект на поръчката
  estimated_value REAL,                  -- Прогнозна стойност
  currency        TEXT,
  legal_basis     TEXT,
  award_criteria  TEXT,
  authority_name  TEXT,
  authority_eik   TEXT,
  authority_type  TEXT,                  -- Вид на възложителя
  main_activity   TEXT,                  -- Основна дейност
  deadline        TEXT,                  -- Срок за получаване на оферти (raw)
  notice_type     TEXT,                  -- Вид обявление
  lot_id          TEXT,                  -- Идентификатор на обособена позиция
  lot_name        TEXT,                  -- Наименование на обособената позиция
  num_lots        INTEGER,               -- Брой обособени позиции
  eu_funded       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_egov_tenders_unp ON raw_egov_tenders(unp);
CREATE INDEX IF NOT EXISTS idx_egov_tenders_source ON raw_egov_tenders(source);

-- Served OCDS party projection. This is curated domain/reference data, not raw staging.
CREATE TABLE IF NOT EXISTS parties (
  party_key TEXT PRIMARY KEY,
  eik TEXT,
  source TEXT NOT NULL,
  ocid TEXT,
  party_id TEXT,
  name TEXT,
  street_address TEXT,
  locality TEXT,
  region_nuts TEXT,
  contact_email TEXT,
  contact_phone TEXT
);

CREATE INDEX IF NOT EXISTS idx_parties_eik ON parties(eik);

-- Promote transient/work OCDS party staging into the served parties projection.
WITH keyed AS (
  SELECT
    CASE
      WHEN NULLIF(ocid, '') IS NOT NULL AND NULLIF(party_id, '') IS NOT NULL THEN 'ocid:' || ocid || ':party:' || party_id
      WHEN NULLIF(eik, '') IS NOT NULL AND NULLIF(party_id, '') IS NOT NULL THEN 'eik:' || eik || ':party:' || party_id
      ELSE 'content:' ||
        COALESCE(ocid, '') || ':' || COALESCE(party_id, '') || ':' || COALESCE(eik, '') || ':' ||
        COALESCE(name, '') || ':' || COALESCE(street_address, '') || ':' || COALESCE(locality, '') || ':' ||
        COALESCE(region_nuts, '') || ':' || COALESCE(contact_email, '') || ':' || COALESCE(contact_phone, '')
    END AS party_key,
    eik,
    source,
    ocid,
    party_id,
    name,
    street_address,
    locality,
    region_nuts,
    contact_email,
    contact_phone
  FROM raw_ocds_parties
), ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (
      PARTITION BY party_key
      ORDER BY source DESC, COALESCE(ocid, '') DESC, COALESCE(party_id, '') DESC,
        COALESCE(name, '') DESC, COALESCE(street_address, '') DESC, COALESCE(locality, '') DESC,
        COALESCE(contact_email, '') DESC, COALESCE(contact_phone, '') DESC
    ) AS rn
  FROM keyed
)
INSERT OR REPLACE INTO parties (
  party_key, eik, source, ocid, party_id, name, street_address, locality, region_nuts,
  contact_email, contact_phone
)
SELECT
  party_key, eik, source, ocid, party_id, name, street_address, locality, region_nuts,
  contact_email, contact_phone
FROM ranked
WHERE rn = 1;

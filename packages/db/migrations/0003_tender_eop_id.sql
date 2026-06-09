-- Preserve the raw EOP numeric tenderId on the served tenders row. The procurement portal keys its
-- public documents page on this id (https://app.eop.bg/today/<eop_tender_id>) — it is NOT the УНП and
-- NOT the contract document_number (noticeId). Real tenders carry it on the header row
-- (raw_egov_tenders.tender_id); synthetic 'неизвестна' tenders, which have no header, derive it from
-- the contract feed (raw_egov_contracts.tender_ext_id). Stored verbatim as text — never derive it by
-- stripping a prefix.
ALTER TABLE tenders ADD COLUMN eop_tender_id TEXT;

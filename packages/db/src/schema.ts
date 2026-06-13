// Row types mirroring migrations/0000_init.sql. Keep in sync with the SQL.

export interface AuthorityRow {
  id: string;
  name: string;
  bulstat: string | null;
  region: string | null;
  type: string | null;
  type_group: string | null; // friendly bucket (heuristic from name + type)
  // location — filled from OCDS parties / NSI ЕКАТТЕ
  nuts: string | null;
  settlement: string | null;
  ekatte: string | null;
  municipality: string | null;
  address: string | null;
  created_at: string;
}

export interface TenderRow {
  id: string;
  source_id: string;
  title: string;
  authority_id: string;
  cpv_code: string | null;
  cpv_description: string | null;
  estimated_value: number | null;
  currency: string;
  procedure_type: string;
  contract_kind: string | null;
  num_lots: number | null;
  status: string;
  published_at: string | null;
  deadline_at: string | null;
  legal_basis: string | null;
  award_criteria: string | null;
  main_activity: string | null;
  notice_type: string | null;
  place_of_performance: string | null;
  start_date: string | null;
  end_date: string | null;
  duration: string | null;
  duration_unit: string | null;
  eu_programme: string | null;
  green: number | null;
  social: number | null;
  innovation: number | null;
  eauction: number | null;
  cancelled: number | null;
  created_at: string;
}

export interface LotRow {
  id: string;
  tender_id: string;
  title: string;
  cpv_code: string | null;
  estimated_value: number | null;
  created_at: string;
}

export interface BidderRow {
  id: string;
  name: string;
  bulstat: string | null; // raw ЕИК as it appears in the register
  eik_normalized: string | null; // digits-only ЕИК when recoverable, else null
  eik_valid: number; // 1 if eik_normalized is a valid 9/13-digit ЕИК
  is_consortium: number; // 1 if a joint venture (multi-ЕИК field or ДЗЗД/ОБЕДИНЕНИЕ/КОНСОРЦИУМ name)
  kind: 'company' | 'consortium';
  ownership_kind: 'state' | 'municipal' | 'mixed' | null;
  // company master data — filled from OCDS parties
  legal_form: string | null;
  nuts: string | null;
  settlement: string | null;
  ekatte: string | null;
  municipality: string | null;
  address: string | null;
  created_at: string;
}

export interface ContractRow {
  id: string;
  tender_id: string;
  bidder_id: string;
  amount: number;
  currency: string;
  signed_at: string | null;
  contract_number: string | null;
  signing_value: number | null;
  current_value: number | null;
  annex_count: number;
  eu_funded: number | null;
  bids_received: number | null;
  contract_kind: string | null;
  awarded_to_group: number | null;
  value_flag: string;
  date_flag: string;
  amount_eur: number | null;
  fx_converted: number;
  fx_rate: number | null;
  lot_id: string | null;
  document_number: string | null;
  published_at: string | null;
  contract_subject: string | null;
  eu_programme: string | null;
  duration_days: number | null;
  winner_size: string | null;
  contractor_country: string | null;
  bids_sme: number | null;
  bids_rejected: number | null;
  bids_non_eea: number | null;
  subcontractor_eik: string | null;
  subcontractor_name: string | null;
  subcontract_value: number | null;
  eauction: number | null;
  framework: number | null;
  accelerated: number | null;
  strategic: number | null;
  created_at: string;
}

export interface RiskScoreRow {
  tender_id: string;
  score: number;
  band: string;
  signals: string;
  computed_at: string;
}

#!/usr/bin/env node
// Load the public EOP MinIO open-data feed — the canonical historical source.
// Per-day buckets are read from EOP_OPEN_DATA_BASE_URL/open-data-YYYY-MM-DD/.
//
//   node scripts/load-eop.mjs --from=2020-11-03 --to=2020-11-05
//   node scripts/load-eop.mjs --from=2020-11-03 --to=2020-11-05 --apply
//   node scripts/load-eop.mjs --cat=contracts --concurrency=4
//
//   flags: --from=YYYY-MM-DD --to=YYYY-MM-DD, --cat=contracts|tenders|annexes,
//          --concurrency=N, --apply, --remote
//
// Format notes: records are flat objects with English camelCase keys. Object files are
// small enough to fetch and JSON.parse whole. Wipes are scoped to source 'eop:<cat>:%'.

import { execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'apps/api');
const MAX_BATCH_BYTES = 90_000;
const MAX_BATCH_ROWS = 500;
const MAX_FILE_BYTES = 256 * 1024 * 1024; // keep each SQL chunk under Node's ~512MB string cap (wrangler reads the whole file into one string)
const DEFAULT_FROM = '2020-01-01';
const DEFAULT_TO = '2025-12-31';
const DEFAULT_CONCURRENCY = 4;
const FETCH_ATTEMPTS = 6;
const FETCH_TIMEOUT_MS = 60_000;
const BASE_URL = (process.env.EOP_OPEN_DATA_BASE_URL || 'https://storage.eop.bg').replace(/\/+$/, '');
const CATEGORIES = ['contracts', 'tenders', 'annexes'];
const RESOURCE_WORDS = {
  contracts: 'договори',
  tenders: 'поръчки',
  annexes: 'анекси',
};
const RESOURCE_FILES = {
  contracts: 'contracts.json',
  tenders: 'tenders.json',
  annexes: 'annexes.json',
};

function clean(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
function toInt(v) {
  const s = clean(v);
  if (s === null) return null;
  const n = parseInt(s.replace(/\s/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}
// European numbers: comma decimal, optional dot/space thousands.
function toReal(v) {
  let s = clean(v);
  if (s === null) return null;
  s = s.replace(/\s/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
function toBool(v) {
  const s = clean(v);
  if (s === null) return null;
  const t = s.toLowerCase();
  if (['да', 'true', '1', 'yes'].includes(t)) return 1;
  if (['не', 'false', '0', 'no'].includes(t)) return 0;
  return null;
}
// DD.MM.YYYY or DD/MM/YYYY, plus ISO timestamps/dates from the EOP feed.
function toISODate(v) {
  const s = clean(v);
  if (s === null) return null;
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:T|\b)/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : s;
}
function toSecuredFinancing(v) {
  const unsecured = toBool(v);
  return unsecured === null ? null : unsecured === 1 ? 0 : 1;
}
function toVariants(v) {
  const s = clean(v);
  if (s === 'Разрешено') return 1;
  if (s === 'Забранено') return 0;
  return null;
}
function coerce(kind, v) {
  if (kind === 'int') return toInt(v);
  if (kind === 'real') return toReal(v);
  if (kind === 'bool') return toBool(v);
  if (kind === 'date') return toISODate(v);
  if (kind === 'secured_inverse') return toSecuredFinancing(v);
  if (kind === 'variants_enum') return toVariants(v);
  return clean(v);
}
function lit(kind, value) {
  if (value === null) return 'NULL';
  if (['int', 'real', 'bool', 'secured_inverse', 'variants_enum'].includes(kind)) return String(value);
  return `'${String(value)
    .replace(/[\x00-\x1F]/g, '')
    .replace(/'/g, "''")}'`;
}

const fetchedAt = new Date().toISOString().replace('.000Z', 'Z');
const CATS = {
  contracts: {
    table: 'raw_egov_contracts',
    fixed: ['source', 'dataset_year', 'dataset_variant', 'fetched_at', 'needs_enrichment'],
    fixedVals: (day) => [`'eop:contracts:${day}'`, String(yearOf(day)), `'eop'`, `'${fetchedAt}'`, '0'],
    keep: (record) => clean(record.contractNumber) !== null,
    fields: [
      ['seq_no', null, 'text'],
      ['document_number', 'noticeId', 'text'],
      ['published_at', 'publicationDate', 'date'],
      ['unp', 'uniqueProcurementNumber', 'text'],
      ['tender_ext_id', 'tenderId', 'text'],
      ['procedure_type', 'procedureType', 'text'],
      ['procurement_subject', 'tenderName', 'text'],
      ['cpv_code', 'tenderMainCpv', 'text'],
      ['cpv_description', 'tenderMainCpvDescription', 'text'],
      ['contract_kind', 'typeOfContract', 'text'],
      ['estimated_value', 'estimatedValue', 'real'],
      ['procurement_currency', 'currency', 'text'],
      ['legal_basis', 'legalBasis', 'text'],
      ['award_criteria', 'awardMethod', 'text'],
      ['joint_procurement', 'isJointProcurement', 'bool'],
      ['central_purchasing', 'isCentralPurchasingAuthority', 'bool'],
      ['authority_name', 'buyerName', 'text'],
      ['authority_eik', 'buyerRegistryNumber', 'text'],
      ['authority_type', 'buyerType', 'text'],
      ['main_activity', 'buyerMainActivity', 'text'],
      ['notice_type', 'noticeType', 'text'],
      ['lot_id', 'lotIdentifier', 'text'],
      ['contract_number', 'contractNumber', 'text'],
      ['contract_date', 'contractDate', 'date'],
      ['signing_value', 'contractValue', 'real'],
      ['currency', 'contractCurrency', 'text'],
      ['contract_subject', 'contractSubject', 'text'],
      ['awarded_to_group', 'awardedToGroup', 'bool'],
      ['contractor_eik', 'supplierRegisterNumber', 'text'],
      ['contractor_name', 'supplierName', 'text'],
      ['contractor_country', 'supplierNationality', 'text'],
      ['winner_owner_nationality', null, 'text'],
      ['winner_size', 'supplierCompanySizeCode', 'text'],
      ['has_subcontractor', 'hasSubcontractors', 'bool'],
      ['subcontractor_name', 'subcontractorName', 'text'],
      ['subcontractor_eik', 'subcontractorRegistryNumber', 'text'],
      ['subcontract_share', 'subcontractingPercent', 'text'],
      ['subcontract_value', 'subcontractingAmount', 'real'],
      ['eu_funded', 'isEuFunded', 'bool'],
      ['eu_programme', 'europeanProgram', 'text'],
      ['framework_notice', 'isFrameworkAgreement', 'bool'],
      ['framework_contract', 'frameworkAgreementContract', 'bool'],
      ['related_to', 'linkedTenders', 'text'],
      ['dps_contract', 'contractUnderQs', 'bool'],
      ['accelerated', 'isAcceleratedProcedure', 'bool'],
      ['eauction', 'hasAuctionQuotationMethod', 'bool'],
      ['strategic', 'isStrategicTender', 'bool'],
      ['outside_zop', 'isExceptionContract', 'bool'],
      ['exemption_legal_basis', 'directAwardJustification', 'text'],
      ['bids_received', 'offersCount', 'int'],
      ['bids_sme', 'smeOffersCount', 'int'],
      ['bids_rejected', 'disqualifiedOffersCount', 'int'],
      ['bids_non_eea', 'noEeaOffersCount', 'int'],
      ['duration_days', 'contractPeriod', 'int'],
      ['non_award', 'noAwarding', 'bool'],
      ['correction_number', null, 'text'],
      ['ted_link', 'linkToOjEu', 'text'],
    ],
  },
  tenders: {
    table: 'raw_egov_tenders',
    fixed: ['source', 'dataset_year', 'fetched_at'],
    fixedVals: (day) => [`'eop:tenders:${day}'`, String(yearOf(day)), `'${fetchedAt}'`],
    keep: () => true,
    fields: [
      ['seq_no', null, 'text'],
      ['document_number', 'noticeId', 'text'],
      ['published_at', 'publicationDate', 'date'],
      ['unp', 'uniqueProcurementNumber', 'text'],
      ['tender_id', 'tenderId', 'text'],
      ['procedure_type', 'procedureType', 'text'],
      ['procurement_subject', 'subject', 'text'],
      ['cpv_code', 'mainCpvCode', 'text'],
      ['cpv_description', 'mainCpvDescription', 'text'],
      ['contract_kind', 'typeOfContract', 'text'],
      ['estimated_value', 'estimatedValue', 'real'],
      ['currency', 'currency', 'text'],
      ['legal_basis', 'legalBasis', 'text'],
      ['award_criteria', 'awardMethod', 'text'],
      ['joint_procurement', 'hasJointProcurement', 'bool'],
      ['central_purchasing', 'isCentralPurchasingAuthority', 'bool'],
      ['authority_name', 'buyerName', 'text'],
      ['authority_eik', 'buyerRegistryNumber', 'text'],
      ['authority_type', 'buyerType', 'text'],
      ['main_activity', 'buyerMainActivity', 'text'],
      ['deadline', 'submissionDeadline', 'text'],
      ['notice_type', 'noticeType', 'text'],
      ['lot_id', 'lotIdentifier', 'text'],
      ['eu_funded', 'isEuFunded', 'bool'],
      ['eu_programme', 'europeanProgram', 'text'],
      ['secured_financing', 'hasUnsecuredFunding', 'secured_inverse'],
      ['framework_notice', 'isFrameworkAgreement', 'bool'],
      ['dps_notice', 'isDpsProcedure', 'bool'],
      ['accelerated', 'isAcceleratedProcedure', 'bool'],
      ['eauction', 'hasElectronicAuction', 'bool'],
      ['strategic', 'isStrategicProcurement', 'bool'],
      ['green', 'isGreenProcurement', 'bool'],
      ['social', 'isSocialProcurement', 'bool'],
      ['innovation', 'isInnovationProcurement', 'bool'],
      ['options', 'hasOptions', 'bool'],
      ['renewable', 'hasRenewal', 'bool'],
      ['reserved', 'isReservedProcurement', 'bool'],
      ['variants', 'hasVariants', 'variants_enum'],
      ['num_lots', 'lotsCount', 'int'],
      ['place_of_performance', 'executionPlaceNuts', 'text'],
      ['lot_name', 'lotTenderName', 'text'],
      ['duration', 'tenderDuration', 'text'],
      ['duration_unit', 'tenderDurationUnit', 'text'],
      ['start_date', 'tenderStartDate', 'date'],
      ['end_date', 'tenderEndDate', 'date'],
      ['einvoicing', 'electronicInvoicing', 'bool'],
      ['epayment', 'electronicPayment', 'bool'],
      ['eordering', 'electronicOrdering', 'bool'],
      ['corrections_count', 'changeNoticeCount', 'int'],
      ['cancelled', 'isCancelled', 'bool'],
      ['correction_number', null, 'text'],
      ['ted_link', 'linkToOjEu', 'text'],
    ],
  },
  annexes: {
    table: 'raw_egov_amendments',
    fixed: ['source', 'dataset_year', 'dataset_variant', 'fetched_at'],
    fixedVals: (day) => [`'eop:annexes:${day}'`, String(yearOf(day)), `'eop'`, `'${fetchedAt}'`],
    keep: (record) => clean(record.contractNumber) !== null,
    fields: [
      ['seq_no', null, 'text'],
      ['document_number', 'noticeId', 'text'],
      ['published_at', 'publicationDate', 'date'],
      ['unp', 'uniqueProcurementNumber', 'text'],
      ['tender_ext_id', 'tenderId', 'text'],
      ['procedure_type', 'procedureType', 'text'],
      ['procurement_subject', 'tenderName', 'text'],
      ['cpv_code', 'tenderMainCpv', 'text'],
      ['cpv_description', 'tenderMainCpvDescription', 'text'],
      ['contract_kind', 'typeOfContract', 'text'],
      ['authority_name', 'buyerName', 'text'],
      ['authority_eik', 'buyerRegistryNumber', 'text'],
      ['authority_type', 'buyerType', 'text'],
      ['main_activity', 'buyerMainActivity', 'text'],
      ['lot_id', 'lotIdentifier', 'text'],
      ['contract_number', 'contractNumber', 'text'],
      ['contract_date', 'contractDate', 'date'],
      ['value_before', 'lastContractValue', 'real'],
      ['value_after', 'currentContractValue', 'real'],
      ['value_delta', 'contractValueDifference', 'real'],
      ['currency', 'contractCurrency', 'text'],
      ['contract_subject', 'contractSubject', 'text'],
      ['awarded_to_group', 'awardedToGroup', 'bool'],
      ['contractor_eik', 'supplierRegisterNumber', 'text'],
      ['contractor_name', 'supplierName', 'text'],
      ['contractor_country', 'supplierNationality', 'text'],
      ['winner_owner_nationality', null, 'text'],
      ['winner_size', 'supplierCompanySizeCode', 'text'],
      ['eu_funded', 'isEuFunded', 'bool'],
      ['eu_programme', 'europeanProgram', 'text'],
      ['description', 'changeDescription', 'text'],
      ['reason', 'changeReason', 'text'],
      ['circumstances', 'changeReasonDescription', 'text'],
      ['outside_zop', 'isExceptionContract', 'bool'],
      ['exemption_legal_basis', 'directAwardJustification', 'text'],
      ['correction_number', null, 'text'],
      ['ted_link', 'linkToOjEu', 'text'],
    ],
  },
};

function arg(name) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
}
function yearOf(day) {
  return Number(day.slice(0, 4));
}
function validateDay(day, label) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`${label} must be YYYY-MM-DD`);
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day) {
    throw new Error(`${label} is not a valid date: ${day}`);
  }
}
function daysBetween(from, to) {
  validateDay(from, '--from');
  validateDay(to, '--to');
  const start = new Date(`${from}T00:00:00Z`).getTime();
  const end = new Date(`${to}T00:00:00Z`).getTime();
  if (start > end) throw new Error('--from must be before or equal to --to');
  const days = [];
  for (let t = start; t <= end; t += 86_400_000) days.push(new Date(t).toISOString().slice(0, 10));
  return days;
}
function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
async function writeChunk(stream, str) {
  if (!stream.write(str)) await once(stream, 'drain');
}

class MissingBucketError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} ${url}`);
    this.status = status;
  }
}

function cacheDir(day) {
  return resolve(root, 'data/eop', day);
}
function cachePath(day, name) {
  return resolve(cacheDir(day), name);
}
async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}
async function atomicWrite(path, text) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, path);
}
function backoffMs(attempt) {
  return Math.min(500 * 2 ** (attempt - 1), 10_000);
}
function errText(err) {
  const parts = [];
  if (err?.name) parts.push(err.name);
  if (err?.code) parts.push(err.code);
  if (err?.message) parts.push(err.message);
  if (err?.cause?.code) parts.push(err.cause.code);
  if (err?.cause?.message) parts.push(err.cause.message);
  return parts.filter(Boolean).join(' ');
}
async function retryOperation(label, fn) {
  let lastErr;
  for (let i = 1; i <= FETCH_ATTEMPTS; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fn(controller.signal);
    } catch (err) {
      if (err instanceof MissingBucketError) throw err;
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
    if (i < FETCH_ATTEMPTS) await sleep(backoffMs(i));
  }
  throw new Error(`${label} failed after ${FETCH_ATTEMPTS} attempts: ${errText(lastErr)}`, {
    cause: lastErr,
  });
}
function handleHttp(res, url) {
  if (res.status === 403 || res.status === 404) throw new MissingBucketError(res.status, url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} ${url}`);
}
function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
function parseBucketKeys(xml) {
  const keys = [];
  const re = /<Key>([\s\S]*?)<\/Key>/g;
  let m;
  while ((m = re.exec(xml)) !== null) keys.push(decodeXml(m[1]));
  return keys;
}

const bucketCache = new Map();
async function bucketKeysFor(day) {
  if (bucketCache.has(day)) return bucketCache.get(day);
  const promise = readBucketKeysFor(day);
  bucketCache.set(day, promise);
  try {
    return await promise;
  } catch (err) {
    bucketCache.delete(day);
    throw err;
  }
}
async function readBucketKeysFor(day) {
  const missingPath = cachePath(day, '_missing');
  if (await pathExists(missingPath)) {
    process.stderr.write(`!! ${day}: not published (cached) — skipping\n`);
    return null;
  }

  const keysPath = cachePath(day, '_keys.json');
  if (await pathExists(keysPath)) {
    return JSON.parse(await readFile(keysPath, 'utf8'));
  }

  const url = `${BASE_URL}/open-data-${day}/`;
  try {
    const keyMap = await retryOperation(`${day} bucket listing`, async (signal) => {
      const res = await fetch(url, { signal });
      handleHttp(res, url);
      const keys = parseBucketKeys(await res.text());
      const byCat = {};
      for (const cat of CATEGORIES) {
        const key = keyForCat(keys, cat);
        if (key) byCat[cat] = key;
      }
      return byCat;
    });
    await atomicWrite(keysPath, `${JSON.stringify(keyMap, null, 2)}\n`);
    return keyMap;
  } catch (err) {
    if (err instanceof MissingBucketError) {
      await atomicWrite(missingPath, '');
      process.stderr.write(`!! ${day}: not published (${err.status}) — skipping\n`);
      return null;
    }
    throw err;
  }
}
function keyForCat(keys, cat) {
  const word = RESOURCE_WORDS[cat];
  const matches = keys.filter((key) => key.includes(word));
  if (matches.length > 1) {
    process.stderr.write(`!! ${cat}: multiple keys matched ${word}; using first\n`);
  }
  return matches[0] || null;
}
async function fetchObjectJson(cat, day, key) {
  const bucketUrl = `${BASE_URL}/open-data-${day}/`;
  const url = `${bucketUrl}${encodeURIComponent(key)}`;
  return retryOperation(`${cat} ${day} object`, async (signal) => {
    const res = await fetch(url, { signal });
    handleHttp(res, url);
    const text = await res.text();
    const json = JSON.parse(text);
    if (!Array.isArray(json)) throw new Error(`${cat} ${day}: object JSON is not an array`);
    return { text, json };
  });
}
function parseCachedJson(cat, day, text) {
  const json = JSON.parse(text);
  if (!Array.isArray(json)) throw new Error(`${cat} ${day}: object JSON is not an array`);
  return json;
}
async function recordsForDay(cat, day, failures) {
  try {
    const keys = await bucketKeysFor(day);
    if (keys === null) return { records: [], failed: false };
    const key = keys[cat];
    if (!key) {
      process.stderr.write(`!! ${cat} ${day}: object key missing — skipping\n`);
      return { records: [], failed: false };
    }

    const jsonPath = cachePath(day, RESOURCE_FILES[cat]);
    if (await pathExists(jsonPath)) {
      process.stderr.write(`==> ${cat} ${day}: cache HIT ${jsonPath}\n`);
      return { records: parseCachedJson(cat, day, await readFile(jsonPath, 'utf8')), failed: false };
    }

    process.stderr.write(`==> ${cat} ${day}: fetching ${key}\n`);
    const { text, json } = await fetchObjectJson(cat, day, key);
    await atomicWrite(jsonPath, text);
    return { records: json, failed: false };
  } catch (err) {
    const message = errText(err);
    process.stderr.write(`!! ${cat} ${day}: FETCH FAILED after retries: ${message} — continuing\n`);
    failures.push({ day, cat, error: message });
    return { records: [], failed: true };
  }
}

function tupleForRecord(cfg, cat, day, record) {
  if (!cfg.keep(record)) return null;
  const vals = [...cfg.fixedVals(day)];
  for (const [, eopKey, kind] of cfg.fields) {
    const value = eopKey === null ? null : coerce(kind, record[eopKey]);
    vals.push(lit(kind, value));
  }
  return `(${vals.join(',')})`;
}

async function loadCategory(cat, days, concurrency, apply, remote, failures, stats) {
  const cfg = CATS[cat];
  const insertCols = [...cfg.fixed, ...cfg.fields.map((f) => f[0])];
  const wipe =
    days.length === 1
      ? `DELETE FROM ${cfg.table} WHERE source = 'eop:${cat}:${days[0]}';\n`
      : `DELETE FROM ${cfg.table} WHERE source LIKE 'eop:${cat}:%';\n`;

  // Chunk the output across multiple files so none exceeds Node's ~512MB string cap (wrangler
  // d1 execute --file reads the whole file into one string). Only the FIRST chunk carries the
  // DELETE; the rest are INSERT-only continuations, applied in order.
  const chunkFiles = [];
  let out = null;
  let bytesInChunk = 0;
  const chunkName = (i) =>
    resolve(root, `data/eop-${cat}-load${i === 0 ? '' : `.${String(i).padStart(2, '0')}`}.sql`);
  const openChunk = async () => {
    const file = chunkName(chunkFiles.length);
    out = createWriteStream(file, { encoding: 'utf8' });
    const head =
      `-- Generated by scripts/load-eop.mjs — do not edit by hand.\n` +
      (chunkFiles.length === 0 ? wipe : `-- chunk ${chunkFiles.length} (INSERT-only continuation)\n`);
    chunkFiles.push(file);
    await writeChunk(out, head);
    bytesInChunk = Buffer.byteLength(head, 'utf8');
  };
  const closeChunk = async () => {
    if (!out) return;
    out.end();
    await once(out, 'finish');
    out = null;
  };
  await openChunk();

  const header = `INSERT INTO ${cfg.table} (${insertCols.join(', ')}) VALUES\n`;
  const headerBytes = Buffer.byteLength(header, 'utf8') + 2;
  let batch = [];
  let stmtBytes = headerBytes;
  let grand = 0;
  let maxStmt = 0;

  const flush = async () => {
    if (!batch.length) return;
    const stmt = header + batch.join(',\n') + ';\n';
    const stmtSize = Buffer.byteLength(stmt, 'utf8');
    maxStmt = Math.max(maxStmt, stmtSize);
    // Roll to a new chunk file before this statement would push the current one over the cap.
    if (bytesInChunk > 0 && bytesInChunk + stmtSize > MAX_FILE_BYTES) {
      await closeChunk();
      await openChunk();
    }
    await writeChunk(out, stmt);
    bytesInChunk += stmtSize;
    batch = [];
    stmtBytes = headerBytes;
  };
  const addTuple = async (tuple) => {
    const tb = Buffer.byteLength(tuple, 'utf8') + 2;
    if (batch.length > 0 && (batch.length >= MAX_BATCH_ROWS || stmtBytes + tb > MAX_BATCH_BYTES)) {
      await flush();
    }
    batch.push(tuple);
    stmtBytes += tb;
  };

  for (let i = 0; i < days.length; i += concurrency) {
    const slice = days.slice(i, i + concurrency);
    const dayResults = await Promise.all(slice.map((day) => recordsForDay(cat, day, failures)));
    for (let j = 0; j < slice.length; j++) {
      const day = slice[j];
      const result = dayResults[j];
      if (!result.failed) stats.completedDayCats++;
      let count = 0;
      let dropped = 0;
      for (const record of result.records) {
        const tuple = tupleForRecord(cfg, cat, day, record);
        if (!tuple) {
          dropped++;
          continue;
        }
        await addTuple(tuple);
        count++;
      }
      grand += count;
      process.stderr.write(`   ${cat} ${day}: ${count.toLocaleString('en-US')} rows`);
      if (dropped) process.stderr.write(` (${dropped.toLocaleString('en-US')} dropped by keep filter)`);
      process.stderr.write('\n');
    }
  }
  await flush();
  await closeChunk();

  process.stderr.write(
    `==> ${cat}: ${grand.toLocaleString('en-US')} rows → ${chunkFiles.length} file(s) (max stmt ${maxStmt})\n`,
  );

  if (apply) {
    const scope = remote ? '--remote' : '--local';
    for (const file of chunkFiles) {
      process.stderr.write(`==> applying ${file}\n`);
      execFileSync('wrangler', ['d1', 'execute', 'sigma', scope, '--file', file], {
        stdio: 'inherit',
        cwd: apiDir,
      });
    }
  }
  return grand;
}

async function main() {
  const from = arg('from') || DEFAULT_FROM;
  const to = arg('to') || DEFAULT_TO;
  const cat = arg('cat');
  const cats = cat ? [cat] : CATEGORIES;
  for (const c of cats) {
    if (!CATS[c]) throw new Error(`unknown --cat=${c}; expected ${CATEGORIES.join('|')}`);
  }
  const rawConcurrency = Number(arg('concurrency') || DEFAULT_CONCURRENCY);
  const concurrency = Number.isFinite(rawConcurrency) && rawConcurrency > 0 ? Math.floor(rawConcurrency) : DEFAULT_CONCURRENCY;
  const apply = !!arg('apply');
  const remote = !!arg('remote');
  const days = daysBetween(from, to);

  process.stderr.write(
    `==> EOP load ${from}..${to} (${days.length} days), cats=${cats.join(',')}, concurrency=${concurrency}, base=${BASE_URL}\n`,
  );
  const totals = {};
  const failures = [];
  const stats = { completedDayCats: 0 };
  for (const c of cats) totals[c] = await loadCategory(c, days, concurrency, apply, remote, failures, stats);
  if (failures.length) {
    process.stderr.write(`\n!! EOP fetch failures (${failures.length}) — re-run these day/category slices:\n`);
    for (const f of failures) process.stderr.write(`   ${f.day} ${f.cat}: ${f.error}\n`);
    if (stats.completedDayCats === 0) process.exitCode = 1;
  }
  process.stderr.write(`\n==> done: ${JSON.stringify(totals)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

#!/usr/bin/env node
// Load the admin ЦАИС ЕОП export (data/Open_data_resources.zip) — the rich, authoritative
// source for 2020–2026. Contracts/Tenders/Annexes per year, each a CSV inside a nested zip.
// Contracts already carry procedure type / CPV / estimated value / lots / authority type /
// consortium flag, so rows land with needs_enrichment = 0 — no separate enrichment pass.
//
//   node scripts/load-admin.mjs                    # parse all → data/admin-*-load.sql
//   node scripts/load-admin.mjs --apply            # also migrate + load local D1
//   node scripts/load-admin.mjs --cat=contracts --year=2023   # one slice
//
//   flags: --cat=contracts|tenders|annexes (default all), --year=YYYY (default all),
//          --apply, --remote
//
// Format notes (differ from the portal feed): comma decimals (69999,00), dot dates
// (05.10.2021), Да/Не booleans, comma-delimited CSV with quoted fields → parsed with
// SheetJS and mapped BY HEADER NAME (indices shift due to embedded commas). Wipes are
// scoped to source 'admin:<cat>:%'.

import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiDir = resolve(root, 'apps/api');
const zipFile = resolve(root, 'data/Open_data_resources.zip');
const workDir = resolve(root, 'data/admin-export'); // gitignored scratch
const YEARS = [2020, 2021, 2022, 2023, 2024, 2025, 2026];
const MAX_BATCH_BYTES = 90_000;
const MAX_BATCH_ROWS = 500;

const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
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
// DD.MM.YYYY or DD/MM/YYYY (single digits + trailing " г."/time tolerated) → ISO.
function toISODate(v) {
  const s = clean(v);
  if (s === null) return null;
  const m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : s;
}
function coerce(kind, v) {
  if (kind === 'int') return toInt(v);
  if (kind === 'real') return toReal(v);
  if (kind === 'bool') return toBool(v);
  if (kind === 'date') return toISODate(v);
  return clean(v);
}
function lit(kind, value) {
  if (value === null) return 'NULL';
  if (kind === 'int' || kind === 'real' || kind === 'bool') return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Per category: target table, fixed columns (+ values fn), and [field, header, kind] map.
const fetchedAt = new Date().toISOString().replace('.000Z', 'Z');
const CATS = {
  contracts: {
    dir: 'Contracts',
    table: 'raw_egov_contracts',
    fixed: ['source', 'dataset_year', 'dataset_variant', 'fetched_at', 'needs_enrichment'],
    fixedVals: (y) => [`'admin:contracts:${y}'`, String(y), `'admin'`, `'${fetchedAt}'`, '0'],
    keep: (get) => get('Номер на договор') !== null, // only rows with a signed contract
    fields: [
      ['document_number', 'Номер на документ', 'text'],
      ['published_at', 'Дата на публикуване', 'date'],
      ['unp', 'Уникален номер на поръчката', 'text'],
      ['procedure_type', 'Вид на поръчката', 'text'],
      ['procurement_subject', 'Предмет на поръчката', 'text'],
      ['cpv_code', 'Основен CPV код', 'text'],
      ['cpv_description', 'Описание на CPV кода', 'text'],
      ['contract_kind', 'Обект на поръчката', 'text'],
      ['estimated_value', 'Прогнозна стойност', 'real'],
      ['legal_basis', 'Правно основание за откриване на поръчката', 'text'],
      ['award_criteria', 'Критерий за възлагане', 'text'],
      ['authority_name', 'Възложител', 'text'],
      ['authority_eik', 'ЕИК на възложителя', 'text'],
      ['authority_type', 'Вид на възложителя', 'text'],
      ['lot_id', 'Идентификатор на обособена позиция', 'text'],
      ['contract_number', 'Номер на договор', 'text'],
      ['contract_date', 'Дата на договор', 'date'],
      ['signing_value', 'Стойност при сключване', 'real'],
      ['currency', 'Валута', 'text'],
      ['contract_subject', 'Предмет на договора', 'text'],
      ['awarded_to_group', 'Възложена на група от икономически оператори', 'bool'],
      ['contractor_eik', 'ЕИК на изпълнителя', 'text'],
      ['contractor_name', 'Изпълнител', 'text'],
      ['eu_funded', 'EU финансиране', 'bool'],
      ['bids_received', 'Брой оферти', 'int'],
    ],
  },
  tenders: {
    dir: 'Tenders',
    table: 'raw_egov_tenders',
    fixed: ['source', 'dataset_year', 'fetched_at'],
    fixedVals: (y) => [`'admin:tenders:${y}'`, String(y), `'${fetchedAt}'`],
    keep: () => true,
    fields: [
      ['unp', 'Уникален номер на поръчката', 'text'],
      ['tender_id', 'ID на поръчката', 'text'],
      ['procedure_type', 'Вид на поръчката', 'text'],
      ['procurement_subject', 'Предмет на поръчката', 'text'],
      ['cpv_code', 'Основен CPV код', 'text'],
      ['cpv_description', 'Описание на CPV кода', 'text'],
      ['contract_kind', 'Обект на поръчката', 'text'],
      ['estimated_value', 'Прогнозна стойност', 'real'],
      ['currency', 'Валута на поръчката', 'text'],
      ['legal_basis', 'Правно основание за откриване на поръчката', 'text'],
      ['award_criteria', 'Критерий за възлагане', 'text'],
      ['authority_name', 'Възложител', 'text'],
      ['authority_eik', 'ЕИК на възложителя', 'text'],
      ['authority_type', 'Вид на възложителя', 'text'],
      ['main_activity', 'Основна дейност', 'text'],
      ['deadline', 'Срок за получаване на оферти', 'text'],
      ['notice_type', 'Вид обявление', 'text'],
      ['lot_id', 'Идентификатор на обособена позиция', 'text'],
      ['lot_name', 'Наименование на обособената позиция', 'text'],
      ['num_lots', 'Брой обособени позиции', 'int'],
      ['eu_funded', 'EU финансиране', 'bool'],
    ],
  },
  annexes: {
    dir: 'Annexes',
    table: 'raw_egov_amendments',
    fixed: ['source', 'dataset_year', 'dataset_variant', 'fetched_at'],
    fixedVals: (y) => [`'admin:annexes:${y}'`, String(y), `'admin'`, `'${fetchedAt}'`],
    keep: (get) => get('Номер на договор') !== null,
    fields: [
      ['document_number', 'Номер на документ', 'text'],
      ['published_at', 'Дата на публикуване', 'date'],
      ['unp', 'Уникален номер на поръчката', 'text'],
      ['authority_eik', 'ЕИК на възложителя', 'text'],
      ['authority_name', 'Възложител', 'text'],
      ['procurement_subject', 'Предмет на поръчката', 'text'],
      ['contract_kind', 'Обект на поръчката', 'text'],
      ['contract_number', 'Номер на договор', 'text'],
      ['contract_date', 'Дата на договор', 'date'],
      ['value_before', 'Стойност преди изменението', 'real'],
      ['value_after', 'Стойност след изменението', 'real'],
      ['value_delta', 'Изменение', 'real'],
      ['currency', 'Валута', 'text'],
      ['contract_subject', 'Предмет на договора', 'text'],
      ['contractor_eik', 'ЕИК на изпълнителя', 'text'],
      ['contractor_name', 'Изпълнител', 'text'],
      ['eu_funded', 'EU финансиране', 'bool'],
      ['description', 'Описание на измененията', 'text'],
      ['reason', 'Причини за изменение', 'text'],
      ['circumstances', 'Обстоятелства', 'text'],
    ],
  },
};

function extractCsv(cat, year) {
  const cfg = CATS[cat];
  const innerZip = `OpenData_${cfg.dir}_${year}.zip`;
  const tmp = resolve(workDir, `${cat}_${year}`);
  mkdirSync(tmp, { recursive: true });
  execFileSync('unzip', ['-o', '-j', zipFile, `Open_data_resources/${cfg.dir}/${innerZip}`, '-d', tmp], {
    stdio: 'ignore',
  });
  execFileSync('unzip', ['-o', '-j', resolve(tmp, innerZip), '-d', tmp], { stdio: 'ignore' });
  return { csv: resolve(tmp, `OpenData_${cfg.dir}.csv`), tmp };
}

function arg(name) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
}
async function writeChunk(stream, str) {
  if (!stream.write(str)) await once(stream, 'drain');
}

async function loadCategory(cat, years, apply, remote) {
  const cfg = CATS[cat];
  const insertCols = [...cfg.fixed, ...cfg.fields.map((f) => f[0])];
  const outFile = resolve(root, `data/admin-${cat}-load.sql`);
  const out = createWriteStream(outFile, { encoding: 'utf8' });
  await writeChunk(
    out,
    `-- Generated by scripts/load-admin.mjs — do not edit by hand.\n` +
      `DELETE FROM ${cfg.table} WHERE source LIKE 'admin:${cat}:%';\n`,
  );
  const header = `INSERT INTO ${cfg.table} (${insertCols.join(', ')}) VALUES\n`;
  const headerBytes = Buffer.byteLength(header, 'utf8') + 2;
  let grand = 0;
  let maxStmt = 0;

  for (const year of years) {
    let csvPath, tmp;
    try {
      ({ csv: csvPath, tmp } = extractCsv(cat, year));
    } catch {
      process.stderr.write(`!! ${cat} ${year}: no inner zip — skipping\n`);
      continue;
    }
    if (!existsSync(csvPath)) {
      process.stderr.write(`!! ${cat} ${year}: CSV missing after extract — skipping\n`);
      continue;
    }
    process.stderr.write(`==> ${cat} ${year}: parsing\n`);
    // Decode as UTF-8 string first — SheetJS misreads a raw buffer's Cyrillic (wrong codepage).
    const wb = XLSX.read(readFileSync(csvPath).toString('utf8'), { type: 'string', raw: true, dense: true });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {
      header: 1,
      raw: true,
      defval: null,
      blankrows: false,
    });
    rmSync(tmp, { recursive: true, force: true }); // keep disk low

    const pos = {};
    (rows[0] || []).forEach((h, i) => (pos[norm(h)] = i));
    const idxOf = (alias) => pos[norm(alias)];
    const fixedVals = cfg.fixedVals(year);

    let batch = [];
    let stmtBytes = headerBytes;
    let count = 0;
    const flush = async () => {
      if (!batch.length) return;
      const stmt = header + batch.join(',\n') + ';\n';
      maxStmt = Math.max(maxStmt, Buffer.byteLength(stmt, 'utf8'));
      await writeChunk(out, stmt);
      batch = [];
      stmtBytes = headerBytes;
    };

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const get = (alias) => {
        const i = idxOf(alias);
        return i === undefined ? null : clean(row[i]);
      };
      if (!cfg.keep(get)) continue;
      const vals = [...fixedVals];
      for (const [, headerName, kind] of cfg.fields) {
        const i = idxOf(headerName);
        vals.push(lit(kind, i === undefined ? null : coerce(kind, row[i])));
      }
      const tuple = `(${vals.join(',')})`;
      const tb = Buffer.byteLength(tuple, 'utf8') + 2;
      if (batch.length > 0 && (batch.length >= MAX_BATCH_ROWS || stmtBytes + tb > MAX_BATCH_BYTES)) await flush();
      batch.push(tuple);
      stmtBytes += tb;
      count++;
    }
    await flush();
    grand += count;
    process.stderr.write(`   ${count.toLocaleString('en-US')} rows\n`);
  }

  out.end();
  await once(out, 'finish');
  process.stderr.write(`==> ${cat}: ${grand.toLocaleString('en-US')} rows → ${outFile} (max stmt ${maxStmt})\n`);

  if (apply) {
    const scope = remote ? '--remote' : '--local';
    execFileSync('wrangler', ['d1', 'execute', 'sigma', scope, '--file', outFile], {
      stdio: 'inherit',
      cwd: apiDir,
    });
  }
  return grand;
}

async function main() {
  const cats = arg('cat') ? [arg('cat')] : ['contracts', 'tenders', 'annexes'];
  const years = arg('year') ? [Number(arg('year'))] : YEARS;
  const apply = !!arg('apply');
  const remote = !!arg('remote');
  if (!existsSync(zipFile)) throw new Error(`missing ${zipFile}`);

  if (apply) {
    const scope = remote ? '--remote' : '--local';
    execFileSync('wrangler', ['d1', 'migrations', 'apply', 'sigma', scope], { stdio: 'inherit', cwd: apiDir });
  }
  const totals = {};
  for (const cat of cats) totals[cat] = await loadCategory(cat, years, apply, remote);
  process.stderr.write(`\n==> done: ${JSON.stringify(totals)}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

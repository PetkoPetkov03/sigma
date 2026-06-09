// Run the scoped re-derive (scripts/refresh-slice.sql) inside D1. The SQL string is injected by the
// caller (the Worker imports it as a bundled text asset) so this stays a pure, testable function.

/** Split a multi-statement SQL script into individual statements. Strips `--` line comments outside
 *  single-quoted string literals, and splits on `;` only outside literals. */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inLiteral = false;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    if (!inLiteral && ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      if (i < sql.length) current += sql[i];
      continue;
    }

    if (ch === "'") {
      current += ch;
      if (inLiteral && next === "'") {
        current += next;
        i += 1;
      } else {
        inLiteral = !inLiteral;
      }
      continue;
    }

    if (!inLiteral && ch === ';') {
      const statement = current.trim();
      if (statement.length > 0) statements.push(statement);
      current = '';
      continue;
    }

    current += ch;
  }

  const statement = current.trim();
  if (statement.length > 0) statements.push(statement);
  return statements;
}

const TRANSIENT_STAGING_TABLES = [
  'raw_egov_contracts',
  'raw_egov_tenders',
  'raw_egov_amendments',
  'raw_ocds_parties',
  'raw_ocds_award_suppliers',
  'raw_ocds_lots',
] as const;

function touchesTransientStaging(statement: string): boolean {
  return TRANSIENT_STAGING_TABLES.some((table) => statement.includes(table));
}

export function transientStagingStatements(workStagingSchemaSql: string): string[] {
  return splitSqlStatements(workStagingSchemaSql).filter((statement) => touchesTransientStaging(statement));
}

export function dropTransientStagingStatements(): string[] {
  return [...TRANSIENT_STAGING_TABLES]
    .reverse()
    .map((table) => `DROP TABLE IF EXISTS ${table}`);
}

export async function createTransientStaging(
  db: D1Database,
  workStagingSchemaSql: string,
): Promise<void> {
  await db.batch(dropTransientStagingStatements().map((s) => db.prepare(s)));
  const statements = transientStagingStatements(workStagingSchemaSql);
  await db.batch(statements.map((s) => db.prepare(s)));
}

export async function dropTransientStaging(db: D1Database): Promise<void> {
  await db.batch(dropTransientStagingStatements().map((s) => db.prepare(s)));
}

/**
 * Execute the refresh-slice script as one D1 batch (transactional: all-or-nothing), then return the
 * number of refresh-derived ('c:o:%') contracts now in the domain.
 */
export async function runRefreshSlice(db: D1Database, refreshSliceSql: string): Promise<number> {
  const statements = splitSqlStatements(refreshSliceSql);
  await db.batch(statements.map((s) => db.prepare(s)));
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM contracts WHERE id LIKE 'c:o:%'")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

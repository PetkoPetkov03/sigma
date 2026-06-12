# Runbook: reseed a remote D1 (staging/prod) from a locally-rebuilt DB

Use this to make a remote environment's D1 match a clean local rebuild **without** re-running the
heavy ingest remotely.

**One procedure for both environments.** Staging and production use the *same* blue-green swap below —
only the names/ids differ (see [Environments](#environments)). Running the identical steps on staging
first makes it a faithful rehearsal of the prod run. The chunked-ship mechanics (`ship-domain` +
`precompute`) are proven on `sigma-stage` (2026-06-12); blue-green wraps those same mechanics in a
zero-downtime swap.

## Why not `import.mjs --remote`

`node scripts/import.mjs --remote` runs the in-place `runFullDerive` against the remote D1, which
executes `derive-amendments.sql` as a single `wrangler d1 execute --remote` statement. That statement
takes tens of minutes locally and **exceeds D1's ~30s per-query CPU limit** on the remote. So the
in-place remote path is not viable for a full reseed. Instead, rebuild locally and **ship the finished
domain tables** with `scripts/ship-domain.mjs` (chunked inserts, each well under the limit), then let
it run `precompute.sql` on the target.

## Prerequisites

1. A clean local rebuild: `node scripts/import.mjs --reset --from=2020-01-01 --to=<last cached day>`
   (cache-backed; **stop the `:5173` dev server first** — it shares the miniflare D1 and a concurrent
   bulk load crashes `workerd` with SIGBUS). Verify counts before shipping.
2. `wrangler` authenticated to the target account (`1a40aa4d0d78bed8ecf036dd22fbfa9f`).
3. The local served D1 sqlite path: `apps/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<largest>.sqlite`.

## Environments

Everything below is parameterized by these. The committed `wrangler.jsonc` keeps a zero-UUID dummy id;
the deploy target is chosen purely by the deploy-time env vars.

| | D1 name | current D1 id | web worker | ETL worker | workflow | deploy name vars |
|---|---|---|---|---|---|---|
| **staging** | `sigma-stage` | `d2d437a8-ab5a-4d45-a26f-0ce8e5f98742` | `sigma-stage` | `sigma-etl-stage` | `sigma-refresh-stage` | `SIGMA_WEB_NAME` / `SIGMA_ETL_NAME` / `SIGMA_WORKFLOW_NAME` / `SIGMA_D1_NAME` = the `*-stage` names |
| **production** | `sigma` | `2c60b1de-995d-41af-9cb6-672d9bcb2d60` | `sigma` | `sigma-etl` | `sigma-refresh` | name vars unset (default to `sigma…`) |

Below, `<env>` = `sigma-stage` or `sigma`; `<env>-next` = the new D1 you create for the swap.

## Procedure: blue-green swap (run identically on staging, then prod)

Build a fully-seeded **second** D1 off to the side, then atomically repoint the workers at it. The old
D1 serves correct data the whole time, so there is **no empty window and nothing bad ever gets cached**
(this is why it sidesteps the stale-homepage caveat below).

1. **Create** the new D1: `wrangler d1 create <env>-next`. Note its id (`<next-id>`).
2. **Config targeting (temporary).** `ship-domain` runs `wrangler d1 migrations apply <env>-next`, which
   resolves the target from `apps/web/wrangler.jsonc` (only defines `sigma` with a dummy id). Add a
   **temporary** `d1_databases` entry naming `<env>-next` with its real id so migrations-apply resolves;
   leave the primary `sigma` binding untouched. **Remove it before any `pnpm deploy`.**
   ```jsonc
   { "binding": "DB_NEXT", "database_name": "<env>-next",
     "database_id": "<next-id>", "migrations_dir": "../../packages/db/migrations" }
   ```
   (Plain `wrangler d1 execute <name> --remote` resolves by account name already; only `migrations apply`
   needs the config entry.)
3. **Seed `<env>-next` fully** while the old `<env>` keeps serving — no live impact, nothing points at it:
   `SIGMA_D1_NAME=<env>-next node scripts/ship-domain.mjs --work-db=<local.sqlite> --remote --yes`.
   It applies migrations, ships the domain tables in FK-dependency order into the empty schema, and runs
   `precompute.sql` (rebuilds rollups + FTS `search_index`; never ship FTS content via a sqlite dump).
   ~15-20 min.
4. **Verify `<env>-next`** against local: `contracts`, `date_flag='signed_after_publication'`,
   `amendments`, the six core tables, and crucially **`home_totals` has `id=1`** with real values (the
   homepage loader reads `home_totals WHERE id = 1`). Remove the temp binding; `git status` clean.
5. **Atomic switch.** Redeploy web + ETL pointed at `<next-id>` (per-env name vars from the table):
   `CLOUDFLARE_ACCOUNT_ID=… SIGMA_D1_ID=<next-id> [name vars] pnpm run deploy` (web) and
   `… pnpm --filter @sigma/etl run deploy` (ETL). `env.DB` repoints in one shot. Then
   `wrangler workflows trigger <env-workflow>` to advance the new D1 to the current day.
6. **Verify live** (date-flag badge, year filter, pentest fixes, homepage — fresh, no `0`s).
7. **Roll forward / back.** Keep old `<env>` as instant rollback (redeploy with the old id). **Update
   wherever `SIGMA_D1_ID` is stored** (CI secret / env) to `<next-id>` so later deploys keep targeting it.
   Delete the old D1 once confident.

## Fallback: in-place wipe (only if a second D1 can't be provisioned)

Use this *only* when blue-green isn't possible (e.g. can't create a second D1). It is **not** the default
for either env on a live site: it has a **~20-30 min degraded window**, an **unpurgeable homepage-`0`s
cache** for up to ~1h on `*.workers.dev` (a redeploy won't clear it — see the caveat below), and needs a
maintenance window away from the 6h ETL ticks (00/06/12/18 UTC). Steps (verify at each):

1. **Backup:** `wrangler d1 export <env> --remote --output=/tmp/<env>-backup.sql`.
2. **Schema parity** (if a column was added, e.g. `date_flag`): `wrangler d1 execute <env> --remote
   --command "ALTER TABLE contracts ADD COLUMN date_flag …; CREATE INDEX …"` (resolves by name; guard if
   it exists). `migrations apply` won't re-add a column folded into an already-applied `0000_init`.
3. **Config targeting:** as in blue-green step 2, but for `<env>` — only `migrations apply` needs the real
   id temporarily set; `execute` resolves by name. Revert after.
4. **Wipe `<env>`** (children-first, FKs deferred) — `wrangler d1 execute <env> --remote --file wipe.sql`:
   ```sql
   PRAGMA defer_foreign_keys=ON;
   DELETE FROM search_index; DELETE FROM flow_pairs; DELETE FROM facet_counts;
   DELETE FROM sector_totals; DELETE FROM authority_totals; DELETE FROM company_totals;
   DELETE FROM home_totals; DELETE FROM amendments; DELETE FROM risk_scores;
   DELETE FROM contracts; DELETE FROM lots; DELETE FROM tenders; DELETE FROM parties;
   DELETE FROM bidders; DELETE FROM authorities; DELETE FROM data_freshness;
   DELETE FROM fx_rates; DELETE FROM nuts_regions;
   ```
   (`ship-domain --replace` does a per-table `DELETE`+`INSERT`; without a clean wipe first, replacing one
   table while others still hold FK references fails with `FOREIGN KEY constraint failed`.)
5. **Ship:** `SIGMA_D1_NAME=<env> node scripts/ship-domain.mjs --work-db=<local.sqlite> --remote --yes
   --replace` (+ precompute). Verify (step 4 above). Revert the temp binding.
6. **Deploy** web then ETL (per-env vars), then trigger the workflow; verify live.

## Schema-only / additive change (no full reseed, no downtime)

For an additive change like `date_flag` where the data isn't emptied and `home_totals` is unchanged, the
same end state is reachable in place with no wipe/downtime/cache exposure:

```sql
ALTER TABLE contracts ADD COLUMN date_flag TEXT NOT NULL DEFAULT 'ok';
CREATE INDEX IF NOT EXISTS idx_contracts_date_flag ON contracts(date_flag);
UPDATE contracts SET date_flag='signed_after_publication'
  WHERE signed_at IS NOT NULL AND published_at IS NOT NULL
    AND signed_at > date(published_at,'+2 day');
```

Run via `wrangler d1 execute <env> --remote --file …` (resolves by name — no temp binding, no
`ship-domain`), **then** deploy web (after the column exists, so `details.ts`'s `date_flag` select is
valid) and ETL. The trade vs. a full reseed: the env keeps its own ETL-maintained rows rather than
becoming byte-identical to a local rebuild.

## Caveat: stale homepage after an in-place reseed (workers.dev)

Relevant to the **in-place fallback only** — blue-green avoids it. Pages served with
`Cache-Control: s-maxage=3600` are edge-cached by Cloudflare keyed on the **client URL** (e.g. `/`) and
served **without invoking the worker** until the TTL expires. So a page whose cache was populated during
the empty window keeps serving stale (e.g. a `0`-valued homepage) for up to ~1h. **A worker redeploy does
NOT clear it** — the worker's `DEPLOY_TAG` only busts its internal `caches.default`, which sits behind
this edge cache. On `*.workers.dev` there is **no cache-purge access**, so it self-heals at `s-maxage`
expiry (then `stale-while-revalidate` refreshes on the next request). Data/loaders are correct meanwhile
(verify via an uncached route, e.g. a `*.csv` export). On a custom domain this is purgeable via the
Cloudflare cache API.

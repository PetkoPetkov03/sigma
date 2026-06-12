# Runbook: reseed a remote D1 (staging/prod) from a locally-rebuilt DB

Use this to make a remote environment's D1 match a clean local rebuild **without** re-running the
heavy ingest remotely. Proven on `sigma-stage` (2026-06-12).

## Why not just `import.mjs --remote`

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
2. `wrangler` authenticated to the target account.
3. The local served D1 sqlite path: `apps/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<largest>.sqlite`.

## Steps

1. **Schema parity.** If the only drift is an added column (e.g. `date_flag`), `ALTER TABLE` the target
   to add it. (`ship-domain` runs `wrangler d1 migrations apply`, but already-applied `0000_init`
   won't re-add a column folded into it later — migrations are versioned.)

2. **Config targeting (temporary).** `wrangler d1 migrations apply <name>` resolves the target from
   `apps/web/wrangler.jsonc`, which only defines `sigma` (zero-UUID dummy). Add a **temporary** second
   `d1_databases` entry naming the real target so the migrations-apply step resolves — leave the
   primary `sigma` binding untouched:
   ```jsonc
   { "binding": "DB_STAGE", "database_name": "sigma-stage",
     "database_id": "<real-id>", "migrations_dir": "../../packages/db/migrations" }
   ```
   (Plain `wrangler d1 execute <name> --remote` already resolves by account name; only
   `migrations apply` needs the config entry.) **Remove this entry before any `pnpm deploy`.**

3. **Wipe the target first.** `ship-domain --replace` does a per-table `DELETE`+`INSERT`; replacing a
   single table while other tables still hold FK references **fails with `FOREIGN KEY constraint
   failed`**. Empty the target in one transaction, children before parents, FKs deferred:
   ```sql
   PRAGMA defer_foreign_keys=ON;
   DELETE FROM search_index; DELETE FROM flow_pairs; DELETE FROM facet_counts;
   DELETE FROM sector_totals; DELETE FROM authority_totals; DELETE FROM company_totals;
   DELETE FROM home_totals; DELETE FROM amendments; DELETE FROM risk_scores;
   DELETE FROM contracts; DELETE FROM lots; DELETE FROM tenders; DELETE FROM parties;
   DELETE FROM bidders; DELETE FROM authorities; DELETE FROM data_freshness;
   DELETE FROM fx_rates; DELETE FROM nuts_regions;
   ```
   `wrangler d1 execute <name> --remote --file wipe.sql`

4. **Ship.** `SIGMA_D1_NAME=<name> node scripts/ship-domain.mjs --work-db=<local.sqlite> --remote --yes --replace`
   — ships domain tables in dependency order (into the empty schema, so FKs hold) and runs
   `precompute.sql` (rebuilds rollups + FTS `search_index`; never ship FTS content via dump). ~15-20 min.

5. **Verify** against local: `contracts`, `date_flag='signed_after_publication'`, `amendments`, the six
   core tables, and crucially **`home_totals` has `id=1`** with real values (the homepage loader reads
   `home_totals WHERE id = 1`).

6. **Remove the temp binding**, then deploy the web worker:
   `CLOUDFLARE_ACCOUNT_ID=<acct> SIGMA_D1_ID=<id> SIGMA_WEB_NAME=<name> SIGMA_D1_NAME=<name> pnpm run deploy`.

## Caveat: stale homepage after a reseed (workers.dev)

Pages served with `Cache-Control: s-maxage=3600` are edge-cached by Cloudflare keyed on the **client
URL** (e.g. `/`), and served **without invoking the worker** until the TTL expires. So right after a
reseed, a page whose cache was populated during the broken/empty window keeps serving stale (e.g. a
`0`-valued homepage) for up to ~1h. **A worker redeploy does NOT clear it** — the worker's `DEPLOY_TAG`
only busts its internal `caches.default` key, which sits behind this edge cache. On `*.workers.dev`
there is **no cache-purge access**, so it self-heals at `s-maxage` expiry (then `stale-while-revalidate`
refreshes on the next request). The data and loaders are correct meanwhile (verify via an uncached
route, e.g. a `*.csv` export, which streams live rows). On a custom domain this is purgeable via the
Cloudflare cache API.

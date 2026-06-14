# Runbook: reseed a remote D1 (staging/prod) from a locally-rebuilt DB

Use this to make a remote environment's D1 match a clean local rebuild **without** re-running the
heavy ingest remotely.

## Principle: the secret is the source of truth, the name is decorative

The deployed worker binds D1 by **`database_id`** — the `SIGMA_D1_ID` value `scripts/wrangler-render.mjs`
substitutes into `wrangler.deploy.*` — and **never by name**. So "which database is live" is defined
entirely by `SIGMA_D1_ID`; the D1's *name* is just a label.

Do **not** try to keep a single canonical name like `sigma-stage`. D1 names are **unique per account and
cannot be renamed** (no `wrangler d1 rename`, no API rename), and a zero-downtime swap needs the old DB
alive while the new one seeds — which forces a second name anyway. Instead, run **two permanent slots**
and flip the secret between them.

## Blue/green slots (the standard for both environments)

Each environment has **two long-lived D1 databases** ("slots"). The live one is whichever `SIGMA_D1_ID`
points at; the other is idle and doubles as the instant rollback. A reseed ships into the idle slot and
flips the pointer — **never** create/rename/delete on the hot path (after the one-time slot creation).

| env | slots | live pointer | worker / etl / workflow (unchanged across reseeds) |
|---|---|---|---|
| **staging** | `sigma-stage-blue` · `sigma-stage-green` | `SIGMA_D1_ID` (staging env secret) | `sigma-stage` / `sigma-etl-stage` / `sigma-refresh-stage` |
| **production** | `sigma-blue` · `sigma-green` | `SIGMA_D1_ID` (production env secret) | `sigma` / `sigma-etl` / `sigma-refresh` |

Define **both** slots permanently in the migrate config (`apps/web/wrangler.jsonc`, or a dedicated
`wrangler.migrate.jsonc`) so `wrangler d1 migrations apply <slot>` always resolves — **no per-reseed temp
binding** (the old runbook's hand-edited `DB_NEXT` step is gone). Only the D1 *id* behind the binding
moves on a swap; worker/ETL/workflow names never change.

> **Why slots instead of `<name>-next`:** the name stops mattering. Two stable labels + a pointer
> (`SIGMA_D1_ID`) is the standard blue-green shape; it removes the rename problem entirely (D1 can't be
> renamed) and the create/delete churn.

> **Production byte-identity nuance.** `docs/deploy.md` keeps the prod render byte-identical when name
> vars are unset. `SIGMA_D1_NAME` only sets the cosmetic `database_name` (binding is by id), and the
> guard against overwriting the wrong *worker* comes from `SIGMA_WEB_NAME`/etc., not the DB name — so
> pointing prod at `sigma-green` just means setting `SIGMA_D1_NAME=sigma-green`. Keep one prod slot named
> `sigma` (the current DB) so the default-unset render stays byte-identical until prod's first slotted
> reseed; the partner slot is `sigma-green`.

> **Current state (2026-06-13):** staging live = `sigma-stage-next` (`f4e0880c…`); prod = `sigma`
> (`2c60b1de…`) — single DBs, not yet on the slot pair above.

### Adopting the slots & retiring old DBs

- **Create the slots lazily, on each environment's _next_ deploy.** If an env's two slots don't exist
  yet, the next deploy that touches that env creates them first (procedure step 1), then ships + flips —
  there is no separate migration pass.
- **Per environment, independently.** Staging and production adopt slots on **their own** next deploy. A
  staging-only deploy creates/uses **only** the `sigma-stage-*` slots and must **not** create or touch the
  production `sigma-*` slots (and vice versa). Adopt both only when you are deliberately deploying both.
- **Retire the old DB only after a confirmed, healthy deploy — and only with explicit user confirmation.**
  Once the new slot is live and verified, the superseded **legacy / pre-slot** DB (e.g. `sigma-stage-next`,
  or production's original `sigma`) is deleted to avoid clutter and cost — but **never automatically**.
  Always ask the user to confirm before `wrangler d1 delete`, and re-check that the name resolves to the
  *legacy* id (not a live slot, and not the other environment's DB) before deleting.
- **Steady state keeps both slots.** After adoption the two slots are permanent: the idle one is the
  one-reseed-deep rollback and is *overwritten* (wiped + reshipped) on the next reseed, **not** deleted.
  So "delete the old DB" is the one-time legacy retirement above — rolling reseeds delete nothing.

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
   bulk load crashes `workerd` with SIGBUS). Verify counts before shipping. (Shipping *from* the sqlite
   only reads it — the explorer is read-only — so the dev server can stay up during the ship itself.)
2. `wrangler` authenticated to the target account (`1a40aa4d0d78bed8ecf036dd22fbfa9f`). The deploy/seed
   token needs Workers Scripts + D1 + Workers R2 Storage + Account Settings (all **Edit**, Account Read).
3. The local served D1 sqlite path: `apps/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/<largest>.sqlite`.

## Procedure: blue/green reseed (identical for staging and prod)

Ship into the **idle** slot while the live slot keeps serving — no empty window, nothing bad gets cached.

1. **Create slots if absent (first adoption of THIS env only).** If `<env>-blue`/`<env>-green` don't yet
   exist, `wrangler d1 create` both and add them as permanent `d1_databases` entries in the migrate config
   — for **this environment only** (a staging-only deploy never creates the prod slots). See
   [Adopting the slots & retiring old DBs](#adopting-the-slots--retiring-old-dbs). Thereafter skip this step.
2. **Identify the idle slot.** `SIGMA_D1_ID` (the env secret) names the live slot; the other is idle.
   `wrangler d1 list` for ids.
3. **Empty the idle slot** (children-first, FKs deferred) — safe, nothing points at it, zero live impact.
   `wrangler d1 execute <idle-slot> --remote --file wipe.sql` (the wipe.sql below). This avoids the
   `--replace` FK-ordering hazard and means you ship into a clean schema.
4. **Ship into the idle slot:**
   `SIGMA_D1_NAME=<idle-slot> node scripts/ship-domain.mjs --work-db=<local.sqlite> --remote --yes`.
   It applies migrations (resolves because the slot is in the config), ships the domain tables in
   FK-dependency order, and runs `precompute.sql` (rebuilds rollups + FTS `search_index` — never ship FTS
   content via a sqlite dump). ~15-20 min. `ship-domain` verifies every table's row count against source.
5. **Verify the idle slot** against local: `contracts`, `date_flag='signed_after_publication'`,
   `amendments`, the six core tables, and crucially **`home_totals` has `id=1`** with real values (the
   homepage loader reads `home_totals WHERE id = 1`).
6. **Flip the pointer.** Set `SIGMA_D1_ID` → idle slot's id and `SIGMA_D1_NAME` → its name (CI env secret/
   var, or local env for a manual deploy). Redeploy web + ETL, then
   `wrangler workflows trigger <env-workflow>` to advance the new slot to the current day.
7. **Verify live** (homepage totals fresh, date-flag badge, year filter, pentest fixes). On a custom
   domain, **purge the edge cache** after the flip (see caveat); on `*.workers.dev` it self-heals at TTL.
8. **Rollback window.** The previous slot stays intact as instant rollback — flip `SIGMA_D1_ID` back and
   redeploy. It is **overwritten by the next reseed**, so the rollback is one-reseed deep. Never delete a
   slot on the hot path.
9. **Retire the legacy DB (adoption only).** After the new deploy is confirmed healthy, delete the
   superseded pre-slot DB (e.g. `sigma-stage-next`) to avoid clutter/cost — **only with explicit user
   confirmation**, and only after verifying the name resolves to that legacy id (never a live slot, never
   the other environment). Steady-state reseeds delete nothing — the previous slot is the rollback.

### wipe.sql (empty a slot, children-first)

```sql
PRAGMA defer_foreign_keys=ON;
DELETE FROM search_index; DELETE FROM flow_pairs; DELETE FROM facet_counts;
DELETE FROM sector_totals; DELETE FROM authority_totals; DELETE FROM company_totals;
DELETE FROM home_totals; DELETE FROM amendments; DELETE FROM risk_scores;
DELETE FROM contracts; DELETE FROM lots; DELETE FROM tenders; DELETE FROM parties;
DELETE FROM bidders; DELETE FROM authorities; DELETE FROM data_freshness;
DELETE FROM fx_rates; DELETE FROM nuts_regions;
```

> **`ship-domain` migration nit.** It runs `wrangler d1 migrations apply <name>`, which needs the slot in
> the config (hence permanent slot bindings). Alternatively it could apply the single `0000_init` via
> `wrangler d1 execute <name> --remote --file …`, which resolves by name and needs no binding — a possible
> simplification that would drop the config requirement entirely.

## Fallback: in-place reseed (only to keep one fixed name, accepts downtime)

Use this *only* when you deliberately want a single permanent name on a throwaway env (staging) and
accept the cost — it is **not** the default. It has a **~20-30 min degraded window**, an **unpurgeable
homepage-`0`s cache** for up to ~1h on `*.workers.dev`, and needs a maintenance window away from the 6h
ETL ticks (00/06/12/18 UTC). Prefer blue/green slots. Steps (verify at each):

1. **Backup:** `wrangler d1 export <env> --remote --output=/tmp/<env>-backup.sql`.
2. **Schema parity** (if a column was added): `wrangler d1 execute <env> --remote --command "ALTER TABLE
   …; CREATE INDEX …"` (resolves by name; guard if it exists).
3. **Wipe `<env>`** with the wipe.sql above (`wrangler d1 execute <env> --remote --file wipe.sql`).
4. **Ship:** `SIGMA_D1_NAME=<env> node scripts/ship-domain.mjs --work-db=<local.sqlite> --remote --yes
   --replace` (+ precompute). Verify.
5. **Deploy** web then ETL, then trigger the workflow; verify live.

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

Run via `wrangler d1 execute <env> --remote --file …` (resolves by name — no binding, no `ship-domain`),
**then** deploy web (after the column exists, so `details.ts`'s `date_flag` select is valid) and ETL. The
trade vs. a full reseed: the env keeps its own ETL-maintained rows rather than becoming byte-identical to
a local rebuild.

## Caveat: stale homepage and edge-cache purge

Pages served with `Cache-Control: s-maxage=3600` are edge-cached by Cloudflare keyed on the **client URL**
(e.g. `/`) and served **without invoking the worker** until the TTL expires. Blue/green avoids ever
caching a bad page (the old slot serves correct data throughout). After an **in-place** reseed a page
cached during the empty window can serve stale (e.g. `0`s) for up to ~1h.

**A worker redeploy does NOT clear it** — the worker's `DEPLOY_TAG` only busts its internal
`caches.default`, which sits *behind* this edge cache.

- **On `*.workers.dev`:** there is **no cache-purge access** (it isn't a zone you control), so it
  self-heals at `s-maxage` expiry, then `stale-while-revalidate` refreshes on the next request. Data is
  correct meanwhile — verify via an uncached route (e.g. a `*.csv` export).
- **On a custom domain** (e.g. `sigma-stage.midt.bg` — the `midt.bg` zone exists in the account): the
  cache **is** purgeable on demand via the dashboard (Caching → Purge) or
  `POST /zones/{zone_id}/purge_cache` (`purge_everything` or by URL). Recommended for staging so a reseed
  is instantly visible.

# Deploying Sigma to Cloudflare

Sigma's deploy set is two Workers sharing one D1 **per environment**: **`sigma`** (the SSR
explorer — `apps/web`) and **`sigma-etl`** (the cron-triggered refresh Workflow — `apps/etl`).
`apps/api`, `apps/admin`, `apps/assistant` are out of v1 scope and need not be deployed.

The explorer reads D1 directly; the ETL writes to the **same** D1. Locally they share one miniflare
D1 (vite `persistState`); in the cloud they share it by binding the **same `database_id`**. The
committed `wrangler.*` files hold zero-UUID dummies (so local dev / miniflare works unchanged), and
the real ids **and** resource names come from **env vars at deploy time** — so the same source tree
deploys to any number of targets (production, staging, a second account) with no file edits.

## Environments

| | Production | Staging | Production-v2 (future) |
|---|---|---|---|
| Web worker | `sigma` → sigma.obecto.workers.dev | `sigma-stage` → sigma-stage.obecto.workers.dev | new name, 3rd URL |
| ETL worker | `sigma-etl` (cron) | `sigma-etl-stage` (cron) | — |
| Workflow (account-global) | `sigma-refresh` | `sigma-refresh-stage` | — |
| D1 database | `sigma` | `sigma-stage` (**separate** DB) | own DB |
| CF account | obecto | obecto (shared, for now) | **separate** account |
| GitHub Environment | `production` | `staging` | `production` (repointed) |

`workers.dev` hostnames follow the worker name automatically — naming the worker `sigma-stage` is
all it takes to serve `sigma-stage.obecto.workers.dev`; no routes or custom domains to configure.

Each environment has its **own D1 database** (*same account ≠ same database*). Within an environment
web + etl share one D1 so the explorer reads what the ETL writes; across environments they never
touch.

## How it works — env-var rendering

A deploy never edits the committed `wrangler.*`. Each package's `deploy` script runs
`build → render → deploy`: [scripts/wrangler-render.mjs](../scripts/wrangler-render.mjs) reads env
vars and writes a throwaway, gitignored `wrangler.deploy.*` that `wrangler deploy --config` ships.

```
react-router build                                              # name:"sigma", id: 0000…0000
node scripts/wrangler-render.mjs build/server/wrangler.json     # read env vars → wrangler.deploy.json
wrangler deploy --config build/server/wrangler.deploy.json      # ship the rendered file
```

The only difference between a staging deploy and a production deploy is **which env-var values are
in scope**:

| env var | production | staging | consumed by |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | prod token | staging token | wrangler (auth) |
| `CLOUDFLARE_ACCOUNT_ID` | obecto | obecto (same, for now) | wrangler (auth) |
| `SIGMA_D1_ID` | prod D1 id | **staging D1 id** | render → `database_id` |
| `SIGMA_WEB_NAME` | *(unset → `sigma`)* | `sigma-stage` | render → web worker `name` |
| `SIGMA_ETL_NAME` | *(unset → `sigma-etl`)* | `sigma-etl-stage` | render → etl worker `name` |
| `SIGMA_WORKFLOW_NAME` | *(unset → `sigma-refresh`)* | `sigma-refresh-stage` | render → `[[workflows]] name` |
| `SIGMA_D1_NAME` | *(unset → `sigma`)* | `sigma-stage` | render → `database_name` **+** provisioning/seed scripts |

Every name var defaults to its committed value, so with all of them unset the render is
**byte-identical to today** (only `database_id` substituted) — the production-safety invariant.

> Render implementation: a fast path writes the sentinel-substituted string unchanged when no name
> var is set (preserving byte-identity and `.jsonc` comments). When a name var IS set, the web
> config (`.json`/`.jsonc`) is parsed → mutated → stringified, and the ETL config (`.toml`) is
> rewritten in place per field — `name`←`SIGMA_ETL_NAME`, `[[workflows]] name`←`SIGMA_WORKFLOW_NAME`,
> `database_name`←`SIGMA_D1_NAME`; `database_id` continues from the `SIGMA_D1_ID` sentinel.
> `class_name`/`binding` are never touched.

### Why explicit names (decision record)

Each resource gets its own env var rather than deriving names from one `-stage`-style suffix:

- **One source of truth for the D1 name.** `SIGMA_D1_NAME` is the *same* variable the
  provisioning/seed scripts ([bootstrap.mjs](../scripts/bootstrap.mjs),
  [import.mjs](../scripts/import.mjs), and the `load-*.mjs` loaders) use to target the D1 — and it
  also drives the rendered `database_name`. The deployed config therefore can't drift from the
  database you actually created/seeded.
- **Self-documenting and unconstrained.** A GitHub Environment lists exactly what it ships
  (`SIGMA_WEB_NAME=sigma-stage`, …) with no suffix arithmetic, and a future second-account
  production is free to use any names, not a forced `sigma-` base.

This is clean because the render script is **field-aware** — there is no ambiguity between the
worker `name` "sigma" and the `database_name` "sigma".

### Why GitHub Environments

The deploy job's `environment:` field selects which Environment's secrets/variables resolve, so the
*same* workflow ships to staging or production purely on which credentials + names are in scope.
Environments are also the natural home for the future separate-account production (just fill its
secrets) and for an optional manual approval gate on production.

## 0. Prerequisites (one-time)

- A Cloudflare account on the **Workers Paid** plan (needed for Workflows and a ~1.4 GB D1).
- A credential:
  - **CI (recommended):** an API token stored as a GitHub **Environment secret**
    (`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`); the deploy runs from
    [.github/workflows/deploy.yml](../.github/workflows/deploy.yml). No long-lived credential on any
    developer machine (per AGENTS.md).
  - **Local (provisioning/seeding + optional manual deploy):** prefer `pnpm exec wrangler login`
    (an OAuth session — nothing to delete afterward) over a pasted token.

> **What CI does vs. what's one-time manual.** CI only **deploys** (`wrangler deploy`). It cannot run
> steps 1–2 below: provisioning produces the `database_id` that CI needs as a secret (chicken-and-egg),
> and the initial data load needs the gitignored `data/` corpus. Do steps 1–2 once, locally, per
> environment; thereafter CI deploys and the `sigma-etl` cron keeps the data fresh.

### Minimal API-token scopes

A custom token needs only these **Account**-level permissions (it cannot be scoped to a single
Worker — see *Notes → Access scoping*): Workers Scripts **Edit**, D1 **Edit**, Workflows **Edit**,
Account Settings **Read**. The same scopes cover both provisioning and deploy.

## 1. Provision the D1 (per environment, local)

Each environment gets its **own** database. `SIGMA_D1_NAME` selects the name (default `sigma`):

```bash
# production (default name)
pnpm bootstrap:apply                                          # → wrangler d1 create sigma

# staging
SIGMA_D1_NAME=sigma-stage node scripts/bootstrap.mjs --apply # → wrangler d1 create sigma-stage
```

Capture the printed **D1 `database_id`** and store it as that environment's `SIGMA_D1_ID`
secret — **not** in the committed `wrangler.*` files (which keep the zero-UUID dummy for local dev).

> `bootstrap.mjs` acts on whichever account `wrangler` is currently authenticated to, and only
> *creates* + prints the id (it doesn't wire it anywhere). If the database already exists the create
> fails-soft; read the id back with `wrangler d1 info <name>`.

## 2. Seed the data (per environment, local)

```bash
# production
node scripts/import.mjs --remote

# staging
SIGMA_D1_NAME=sigma-stage node scripts/import.mjs --remote
```

This migrates the schema, loads the EOP staging data (from the open `storage.eop.bg` feed —
overridable via `EOP_OPEN_DATA_BASE_URL`), derives amendments, loads FX rates + NUTS, normalizes to
the domain tables, and precomputes rollups + FTS.

> **`SIGMA_D1_NAME` keeps a seed off production.** `import.mjs` and **every** `load-*.mjs` loader
> target the database by name via `SIGMA_D1_NAME`; without it they default to `sigma`. Always set it
> when seeding a non-prod environment.

> **Bulk-load caveat.** Each step runs via `wrangler d1 execute --remote --file`, the only bulk path
> in wrangler 4.x (there is no `wrangler d1 import`). Slow but feasible over the API for the ~190k-row
> staging + domain tables — figure ~20 min for a fresh remote load. The full DB is ~1.4 GB incl.
> staging (within the 10 GB Paid limit). After the first load the cron Workflow keeps it fresh
> incrementally (it never reloads the base).

> **Two gotchas if you load from a sqlite `.dump`:** D1 rejects `PRAGMA foreign_keys = OFF;`, `BEGIN
> TRANSACTION;`, `COMMIT;`, and `PRAGMA writable_schema = ON;` (the last is what `.dump` emits to
> recreate FTS5 virtual tables). Strip those lines, and rebuild `search_index` with the normal
> `INSERT INTO search_index ... SELECT ... FROM contracts` recipe from
> [scripts/precompute.sql](../scripts/precompute.sql) — don't ship FTS content via dump.

> Schema changes after the first load are applied out-of-band, per environment:
> `SIGMA_D1_NAME=sigma-stage wrangler d1 migrations apply sigma-stage --remote`. Deploys do not
> migrate or reload data.

## 3. Configure GitHub Environments

Create two Environments (repo Settings → Environments):

**`production`** (mirror of today's repo secrets, so prod behaviour is unchanged):
- secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SIGMA_D1_ID` (prod)
- variables: *(none required — every name var defaults to its committed prod value)*

**`staging`**:
- secrets `CLOUDFLARE_API_TOKEN` (same account token is fine for now), `CLOUDFLARE_ACCOUNT_ID`
  (= obecto), `SIGMA_D1_ID` (the new `sigma-stage` D1)
- variables `SIGMA_WEB_NAME` = `sigma-stage`, `SIGMA_ETL_NAME` = `sigma-etl-stage`,
  `SIGMA_WORKFLOW_NAME` = `sigma-refresh-stage`, `SIGMA_D1_NAME` = `sigma-stage`

> The `production` Environment is **non-blocking** to create: even with `environment: production`
> set on the job, GitHub still exposes repository-level secrets, so production keeps deploying with
> today's repo secrets until you choose to move them into the Environment.

> Optional hardening: give `production` **required reviewers** so a prod deploy waits for a manual
> "Review deployments" click.

## 4. Deploy

The single workflow [.github/workflows/deploy.yml](../.github/workflows/deploy.yml) maps the git
event → an environment and deploys both Workers:

- **Production** — push a version tag (cut a release):
  ```bash
  git tag v1.0.0 && git push origin v1.0.0          # → production
  ```
- **Staging** — run it by hand:
  ```bash
  gh workflow run deploy.yml -f environment=staging  # → staging  (or Actions tab → Run workflow)
  ```

The `deploy` job sets `environment: <target>`, so `${{ secrets.* }}` / `${{ vars.* }}` resolve from
the matching Environment, then it guards on the credentials, type-checks, and runs
`pnpm --filter @sigma/web run deploy` + `pnpm --filter @sigma/etl run deploy`. A per-environment
`concurrency` group keeps a staging build from blocking a production release.

> **Manual (one-off, optional):** with the right env vars sourced locally you can run the same
> `pnpm --filter @sigma/web run deploy` / `pnpm --filter @sigma/etl run deploy` from a machine — but
> CI is the intended path so credentials stay off laptops.

Deploying `apps/web` overwrites whatever currently serves that worker name (for production, the
static v1 mock at `sigma.obecto.workers.dev`) with the live SSR explorer. The ETL is necessarily a
separate worker — it carries the cron trigger and the `RefreshWorkflow` class.

## 5. Verify

- Open the worker URL (e.g. `https://sigma.obecto.workers.dev/` or
  `https://sigma-stage.obecto.workers.dev/`) — real totals (~190k contracts · ~50.8 bn €).
- Dashboard → **Workflows** → the env's refresh Workflow (`sigma-refresh` / `sigma-refresh-stage`)
  is listed. There is no public HTTP trigger; manual/backfill runs go through the Dashboard or
  `wrangler workflows trigger <name>`. The cron (`0 */6 * * *`) then refreshes unattended.
- Confirm production is **untouched** when you deploy staging (different worker + D1 + lane).

## Isolation guarantees — why staging can't touch production

Three independent walls; any one is sufficient:

1. **Different worker names.** A staging render produces `sigma-stage` / `sigma-etl-stage`;
   `wrangler deploy` only overwrites the worker named in its config — it cannot write to `sigma`.
2. **Different D1.** Staging binds the `sigma-stage` id; prod's `sigma` DB is never named in a
   staging render. The seed/provision scripts (`import.mjs` + every `load-*.mjs`) target the DB by
   name via `SIGMA_D1_NAME` — without it they default to `sigma`, so that variable is the guard that
   keeps a seed off production.
3. **Different credentials / lane.** Staging uses the `staging` Environment's secrets and the
   `deploy-staging` concurrency group. When production-v2 moves to its own account, the account
   boundary becomes a fourth wall: a staging token has no access to the prod account at all.

## Data & the ETL cron caveat

There are **two** ETL sources with opposite reachability:

- **Historical bulk** ([scripts/load-eop.mjs](../scripts/load-eop.mjs)) → `https://storage.eop.bg`
  (overridable via `EOP_OPEN_DATA_BASE_URL`). **Open** → the seed in step 2 just works.
- **Go-forward 2026+ delta** ([scripts/load-ocds.mjs](../scripts/load-ocds.mjs) and the on-platform
  ingest in [packages/ingest](../packages/ingest)) → `https://data.egov.bg/api`. **IP-restricted**
  (403 from non-BG egress).

The deployed cron `RefreshWorkflow` ([apps/etl/src/index.ts](../apps/etl/src/index.ts)) pulls the
**OCDS / `data.egov.bg`** delta — *not* storage.eop.bg. So the cron (prod **and** staging) will
**idle on errors** from Cloudflare egress until either the planned **BG egress proxy** for
`data.egov.bg` lands, or the Worker's ingester is repointed at the open `storage.eop.bg` feed (a
separate ETL change). The seeded through-2025 data is unaffected meanwhile. Consider staggering the
staging schedule (e.g. `30 */6 * * *`) so it doesn't hit the source at the same minute as prod.

## Notes

- **Runtime secrets.** The explorer needs none (read-only public data; OCDS reads need no key). The
  **ETL** has no runtime secret and no public HTTP surface — it runs cron-only and cannot be
  triggered over the internet. The `.dev.vars` secrets remain for the parked `assistant`/`admin`
  apps — `admin` fails closed without `ADMIN_BASIC_AUTH_PASS` (set `ADMIN_ALLOW_UNAUTH=true` only for
  local dev).
- **Access scoping.** Cloudflare API tokens scope by permission + account, **not** down to one Worker
  script (`Workers Scripts: Edit` is account-wide). For true "only-Sigma" isolation, put the Sigma
  workers in their own Cloudflare account and scope the token to it (this is the production-v2 plan).
  Otherwise use the minimal scopes above and keep the token in CI rather than on a laptop.
- **Page caching** is done via `Cache-Control` headers + the per-colo Cache API
  ([apps/web/app/lib/cache.ts](../apps/web/app/lib/cache.ts)) — no KV namespace needed. D1 is the
  only Cloudflare resource Sigma provisions.

## Production-v2 (future, separate account)

No code change: create the `production` Environment with the new account's
`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `SIGMA_D1_ID`, set its name vars (leave unset to
keep `sigma`/`sigma-etl`/…, or set explicit names for a distinct identity), provision + seed its D1
the same way, and deploy. The env-var rendering already supports N targets.

## Open items

- **Staging trigger** is manual `workflow_dispatch`; flip to push-to-`main` (uncomment the
  `push: { branches: [main] }` trigger) if continuous staging is wanted.
- **Cron freshness** depends on the `data.egov.bg` egress fix (BG proxy or EOP-repoint) — tracked
  separately from this deploy work.
- Whether to add a **required-reviewers** gate on the `production` Environment.

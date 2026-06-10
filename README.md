# СИГМА

**СИГМА — Платформа за прозрачност на обществените поръчки** — a transparency and exploration layer for Bulgarian public procurement. Today СИГМА centralizes the public procurement record from the ЦАИС ЕОП open-data feed, connects institutions → companies → contracts, and makes every aggregate traceable down to the individual source contract. Risk scoring, anomaly detection, and cartel analysis are planned analysis-layer work; scaffolding exists in `packages/analysis`, but it is not wired into the live product yet.

Built as an analysis/transparency layer over the national procurement data (АОП / ЦАИС ЕОП), with open data for citizens, journalists, and NGOs.

The design is captured in [`docs/`](docs/) — start there:

- **Платформа за СИГМА** — concept overview, key functionality, roadmap.
- **Обща рамка, концепция, roadmap, законови промени** — architecture, the analysis/monitoring module, phased roadmap, and the legislative changes the platform assumes.
- **UX - СИГМА** — user journeys for the three personas: contracting authority (възложител), citizen (гражданин), and bidder (фирма-участник).

> These are early drafts. A consolidated `docs/specification.md` (mirroring the kolkostruva spec structure) will follow as scope firms up.

## Quick start

This repo is set up to be developed inside a Devcontainer — host machine needs Docker (or compatible: OrbStack, Rancher Desktop) and an editor with Devcontainer support (VS Code, JetBrains, etc.).

```bash
# Open the folder in your editor and "Reopen in Container"
# (or run `devcontainer up --workspace-folder .` from the CLI)

pnpm setup    # one-time per fresh checkout: install + local D1 + seed
pnpm dev      # daily: starts every Worker + frontend in parallel
```

> **Status:** prototype. The container, agent conventions, and design docs are in place; the TypeScript monorepo scaffold (`apps/`, `packages/`, workspace + lockfile) is still being established, so the `pnpm` commands below describe the intended flow rather than what runs today.

## Layout

СИГМА reuses the kolkostruva tech stack — a single TypeScript monorepo on Cloudflare's edge platform (pnpm + turbo; React Router v7 SSR on Workers; D1 + Durable Objects + Vectorize + Workers AI + Queues + KV + R2, fronted by AI Gateway). The intended top-level layout:

| Top-level dir        | Contents                                                                                                                                                                                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/`              | Cloudflare Workers — `web` (React Router SSR explorer; citizen / authority / bidder portals; reads D1 directly via `@sigma/db`) and `etl` (ingestion + analysis pipeline)                                                                                               |
| `packages/`          | Shared libraries — `api-contract`, `db`, `analysis` (planned risk scoring, anomaly + cartel analysis scaffolding), `config`, `shared`                                                                                                                                  |
| `scripts/`           | Bootstrap, deploy, setup-local, teardown; **ЦАИС ЕОП ingestion** (`load-eop.mjs`, `normalize-egov.sql`, `import.mjs`)                                                                                                                                                 |
| `data/`              | Cached `storage.eop.bg` EOP open-data feed under `data/eop`, ~192k contracts covering 2020–2026; gitignored. Ingested into D1 by the `scripts/` pipeline — see [`docs/data-ingestion.md`](docs/data-ingestion.md)                                                     |
| `docs/`              | Specification and design docs                                                                                                                                                                                                                                         |
| `.devcontainer/`     | Container-based dev environment                                                                                                                                                                                                                                       |
| `.github/workflows/` | CI: deploy on push, scheduled ingestion, tests on PR                                                                                                                                                                                                                  |

The planned analysis layer covers risk scoring 0–100, спец-checker AI, ценови аномалии, and cartel detection. It is roadmap work, with pure-function scaffolding in `packages/analysis`; see the architecture doc in `docs/`.

## Common commands

| Command                | Purpose                                                         |
| ---------------------- | --------------------------------------------------------------- |
| `pnpm setup`           | First-time setup on a fresh checkout                            |
| `pnpm dev`             | Start every Worker + frontend locally (miniflare)               |
| `pnpm typecheck`       | Type-check the workspace                                        |
| `pnpm test`            | Run all tests                                                   |
| `pnpm bootstrap`       | Dry-run Cloudflare resource creation (one-time per CF account)  |
| `pnpm bootstrap:apply` | Actually create the resources                                   |
| `pnpm deploy`          | Run by CI on push to `main`; idempotent migrate + seed + deploy |

## ETL

The historical ЦАИС ЕОП base is loaded from the public EOP MinIO open-data feed by `scripts/load-eop.mjs`; `scripts/import.mjs` applies the local D1 migrations, loads the feed, and rebuilds derived tables. The feed base defaults to `https://storage.eop.bg` and can be overridden with `EOP_OPEN_DATA_BASE_URL`.

## Operational security

Production deploys originate only from GitHub Actions; the dev machine never holds a long-lived production credential. Procurement data is public by design, but integrations with national registries (НАП, Търговски регистър) carry access constraints — treat any credentials for those as production secrets.

## License

TBD before public release.

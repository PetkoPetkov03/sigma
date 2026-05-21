# ADR-0001 — Front-end rendering strategy & security posture

- **Status:** Accepted
- **Date:** 2026-05-21
- **Scope:** Iteration 1 — the public, read-only АОП procurement explorer (`docs/design/KICKOFF.md`).
  Notes the forward path to the broader platform (`docs/design/BRIEF.md`).

> **Update (2026-05-21):** The framework decision below changed from SvelteKit to **React Router v7
> on Cloudflare Workers** after weighing ecosystem, hiring/contributors, accessibility primitives, and
> the viz/AI ecosystem. The rendering (§2) and security (§3) decisions are framework-agnostic and
> unchanged; only their framework-specific mechanics were updated.

## Context

Iteration 1 is a **public, read-only** reporting & visualization layer over ~129k АОП contract rows
in Cloudflare D1, for citizens / journalists / NGOs, with a Bulgarian UI. The web app was first
scaffolded on **SvelteKit**; this ADR revisits that. The server runtime is **Cloudflare Workers**
reading D1. The data arrives as **periodic bulk loads**
(`scripts/load-aop.mjs`), not a live feed; there is **no public write path and no authentication**
in this iteration.

Three questions drove this decision:

1. Should the front end move from Svelte to React?
2. Should pages be server-rendered (SSR), pre-rendered (static), or a classic client-rendered SPA
   against the API?
3. Do SSR / "hydration" attacks change the answer?

## Decision

### 1. Use React with React Router v7 (framework mode) on Cloudflare Workers

Chosen over the initial SvelteKit scaffold after weighing the durable factors:

- **Ecosystem & reuse** — the largest component/library ecosystem, and the deepest options for the
  exact surfaces Sigma leans on: network/relationship graphs (`@xyflow/react`), big data tables
  (TanStack Table / AG Grid), charts (visx / Recharts), and — for the later assistant — the AI SDK
  (`@ai-sdk/react`) and mature assistant UIs.
- **Hiring & open-source contributors** — much larger talent pool; relevant for a likely-OSS civic
  platform ("License TBD before public release").
- **Accessibility primitives** — React Aria / Radix are best-in-class for the explicit **WCAG 2.2 AA**
  target.
- **Longevity** — the most defensible long-term choice for a long-lived public-good platform.

**React Router v7 (framework mode), not Next.js** — it runs cleanly on **Cloudflare Workers** (via
`@cloudflare/vite-plugin`) and preserves the SSR-on-edge model and the hybrid rendering in §2.
Trade-offs accepted vs SvelteKit: a larger client runtime (mitigated by SSR + caching) and no
first-party CF *Pages* adapter — RR7 deploys as a Worker instead, which also unifies `web` with the
other `apps/*`.

### 2. Rendering: hybrid, chosen per surface

Default to **SSR + edge caching**; pre-render only the genuinely static pages; client-render only
interactive islands. **Not** a pure SPA for public content (SEO/shareability + first-paint cost);
**not** build-time prerendering of the whole corpus (tens of thousands of company/authority pages,
and search can't be prerendered).

| Surface | Strategy | Why |
| --- | --- | --- |
| Landing, About, **methodology / "how the red-flags work"**, open-data docs | Pre-render (static) | Rarely change → bulletproof + free |
| Company profile (per ЕИК), authority page, tender/lot detail | **SSR + edge cache** (`s-maxage` + `stale-while-revalidate`), purge on dataset reload | Large set, changes only on bulk reload → static-like speed + DDoS resilience, fresh after reload |
| Explorer: search / filter / rankings ("biggest beneficiaries") | SSR, short cache, varies by query | Infinite URL space; SQL-driven |
| Interactive viz (network/flow graph, Bulgaria map, sortable tables) | Client-rendered **island** hydrated over an SSR'd page + initial data | Needs client interactivity; SSR the shell for SEO/first paint |

Because the dataset is a periodic snapshot (not live), cache TTLs can be long and a reload simply
**purges** the cache — nearly all of static's benefits without enumerating the corpus at build.

### 3. Security posture

Priorities for a public transparency site: **integrity ≈ availability ≫ confidentiality** — the
data is public by design; its *trustworthiness* and *uptime* are the product.

**Iteration 1 controls:**

- **Keep the read path read-only.** Ingestion is offline (`load-aop.mjs`); there is no public write
  endpoint. Preserve this — no public mutation, no admin in iteration 1.
- **Edge model + caching as DDoS absorption.** Cloudflare absorbs L3/4; cached HTML means attack /
  scrape traffic hits cache, not D1.
- **WAF + rate limiting** on the SQL-driven explorer/search and any open-data export; cap
  `limit` / pagination / export size so no single request scans the whole table.
- **Strict CSP + security headers** — generate a per-request nonce in `entry.server.tsx`, pass it to
  React Router's `<Scripts nonce>` / `<ScrollRestoration nonce>` and the `Content-Security-Policy`
  header (so framework hydration scripts are allowed without `unsafe-inline`). Add HSTS,
  `X-Content-Type-Options`, `Referrer-Policy`.
- **D1 prepared statements with bound params only**; never string-concatenate SQL.

**On the "hydration attack" question** — the real classes and how this design handles them:

- **Cross-user leakage via cached personalized SSR** — N/A in iteration 1 (no auth; every page
  anonymous and identical → safe to cache). Stays prevented later by caching *only* anonymous public
  pages and never authenticated ones.
- **Secret over-serialization into the hydration payload** — mitigated by the typed response DTOs in
  `packages/api-contract` (ship `TenderSummary`/`TenderDetail`, never raw rows) and by keeping
  credential-bearing code out of the web/read path. Keep DTOs free of internal-only fields.
- **XSS via serialized state / rendered data** — rely on React/JSX auto-escaping; **never
  `dangerouslySetInnerHTML`** on АОП text (authority / company / subject are externally sourced);
  strict CSP as the backstop.

**Deferred to later phases** (the broader BRIEF surfaces):

- **Authority/bidder workflows + admin** → Cloudflare Access (SSO + MFA) for admin; strict
  public/personalized cache split; write-path isolation in a dedicated worker.
- **AI Procurement Assistant** → route via **AI Gateway** (rate/spend caps, caching, logging);
  read-only, parameterized tools; ground every claim in computed data (defamation risk); never
  cache; render output as text.

## Consequences / scaffold follow-ups

- Configure prerendering in `react-router.config.ts` (`prerender` paths) for the static info routes.
- Set `Cache-Control` (`s-maxage` + `stale-while-revalidate`) via route `headers` exports on the SSR
  data routes; trigger a cache purge (by URL/tag) at the end of the АОП load script.
- Set CSP + security headers in `entry.server.tsx` (or a Worker middleware) with a per-request nonce
  on `<Scripts>`.
- Add a Cloudflare rate-limit rule + WAF managed ruleset for the explorer/export endpoints
  (infra config, tracked separately).
- Remove or auth-gate the scaffold's open `POST /etl/run` in `apps/etl` before any deploy.

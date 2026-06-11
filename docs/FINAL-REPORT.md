# Security Assessment — СИГМА (sigma-stage.cf-midt.workers.dev)

**Date:** 2026-06-10 · **Type:** Grey-box (black-box live + white-box source) · **Operator:** Claude (clearwing methodology)
**Authorization:** Repo owner, staging environment.
**Scope:** `https://sigma-stage.cf-midt.workers.dev` + source at `.sigma-source/` (local copy of `todorkolev/sigma-prototype`).
**Rules of engagement:** Non-destructive only — GET/HEAD + benign markers, read-only SELECT-logic injection probes, no DoS/load testing, no data mutation.

---

## Bottom line

**No high- or medium-severity vulnerabilities were found.** The application is well-architected
for security: parameterized data access with whitelists, React's auto-escaping with no unsafe HTML
sinks, sanitized full-text search, neutralized CSV exports, a strict CSP, and a non-public admin/ETL
surface. The realistic attack surface (a read-only, no-auth, no-mutation public data app) is small and
is handled correctly. Only minor configuration-hygiene observations remain (all LOW/INFO).

This conclusion is backed by two independent passes (manual review + a second auditor agent) plus live
probing of every input.

---

## What was tested

**Live (black-box):** route/endpoint enumeration via React Router manifest (24 routes), robots/sitemap,
HTTP method matrix, error/stack-trace leakage probes, cache-behavior/poisoning headers, and read-only
injection sweeps against every user input.

**Source (white-box):** the entire data-query layer (`packages/db/src/queries/*`), the worker entry
(`apps/web/workers/app.ts`), all route loaders (`apps/web/app/routes/*.tsx`), security/cache/filter
libs (`apps/web/app/lib/*`), SSR entry/root, and the ETL worker (`apps/etl`).

### Inputs probed and verdicts

| Input / vector | Verdict | Evidence |
|---|---|---|
| `sort` → `ORDER BY` | **Safe** | Mapped through fixed `SORTS` dict (unknown→default); exprs are constants; keyset also allowlists + regex-guards the column (`keyset.ts` `IDENTIFIER`, `assertSortDir`). Live: quotes/keywords inert, fall back to default. |
| `cursor` (keyset pagination) | **Safe** | Decoded value/id are **bound params**; a `sortToken` hash binds each cursor to its exact sort (tampered/foreign cursors → ignored); malformed → `null`. Live: type-confusion/SQLi/oversize payloads all handled. |
| `sector` (CPV filter) | **Safe** | Whitelisted against `KNOWN_SECTORS` (`filters.ts:14-19`). Live: all injection payloads inert. |
| `year`/`procedure`/`value`/`eu` filters | **Safe** | `buildFilters` fully parameterized (`?` + `params.push`); procedure/value/eu mapped through whitelists/enums (`contracts.ts:80-120`). |
| `q` (search) | **Safe** | Tokenized to `[\p{L}\p{N}]+` only (strips all FTS5 metacharacters), length/token-capped, then bound as `?` for FTS `MATCH` (`search.ts:74-78,121-139`). |
| Composite-key path params (`/contracts/:id`, `/companies/:eik`) | **Safe** | `identity.ts` is pure mapping; decoded ids flow into detail loaders as bound params; invalid → 404. |
| Reflected XSS (search highlight, error pages) | **Safe** | No `dangerouslySetInnerHTML` anywhere; highlight builds `<mark>` as JSX nodes; React auto-escaping intact. |
| CSV formula/injection | **Safe** | `csvCell` neutralizes `=^+\-@`/tab/CR cells with a `'` prefix and RFC-4180 quoting (`csv.ts`). |
| Open redirect / SSRF | **Safe** | Only path-based canonical redirect in `root.tsx`; server-side fetches target a hardcoded host (`storage.eop.bg`); no user-controlled URL/host. |
| HTTP methods | **Safe** | POST/PUT/DELETE/PATCH/OPTIONS/TRACE → 405; no write/mutation actions exist in the app. |
| Error / stack-trace disclosure | **Safe** | 404/400 return styled pages or plain CF errors; stack traces gated to `import.meta.env.DEV` (`root.tsx` ErrorBoundary). `Error`/`Env` substrings seen were `hasErrorBoundary`/`viteEnvironmentApi` in the embedded manifest — not a leak. |
| Cache poisoning (per-colo edge cache) | **Safe** | Cache key = full URL + per-deploy `DEPLOY_TAG`; only `response.ok && anonymous && s-maxage` responses cached; no unkeyed request input influences a cached entry. |
| Transport / headers | **Strong** | HSTS preload, strict CSP (per-request nonce for SSR + SHA-256 hashes for cached HTML), `frame-ancestors 'none'`, `object-src 'none'`, X-Frame-Options DENY, nosniff, tight Referrer/Permissions policies. |
| Admin / ETL surface | **Not exposed** | `apps/etl` is cron-only (`workers_dev=false`, no route/domain/HTTP trigger). `ADMIN_BASIC_AUTH_*` in `.dev.vars` is referenced **nowhere** in code → dead config. |

---

## Findings

### No High / Medium findings.

### LOW / INFO observations (hygiene, not exploitable)

- **INFO-1 — Dead admin credentials in `.dev.vars`.** `ADMIN_BASIC_AUTH_USER`/`ADMIN_BASIC_AUTH_PASS`
  are defined but used nowhere in the codebase. The file is correctly git-ignored (not committed, not a
  leak), but unused secrets are noise that can later be wired up insecurely or copied into a committed
  file by mistake. **Recommend:** remove if the admin feature was dropped; otherwise document where it's
  consumed. (Same file holds real registry API tokens — confirm `.dev.vars` is never committed in CI.)

- **INFO-2 — Unauthenticated streaming CSV exports.** `/contracts.csv` (etc.) stream the full filtered
  set (up to ~190k rows) with no auth and no edge cache (streaming responses bypass the cache). The code
  is correct and memory-safe (keyset-walked in 1k chunks, never buffered), so this is **not** a code bug,
  but a repeatedly-pulled full export is a potential bandwidth/CPU amplification lever. *Not load-tested
  (out of non-destructive scope).* **Recommend:** consider Cloudflare rate-limiting / WAF on `*.csv` if
  not already present at the edge, and/or a short cache on unfiltered exports.

- **INFO-3 — `robots.txt` `Disallow: /search, /*.csv` is advisory only.** Both remain fully reachable
  (expected/by-design for robots); noted only so it isn't mistaken for an access control.

### Retracted
- **OBS-2 (slow contract page / DoS) — RETRACTED.** An initial 25s read-timeout on a large-consortium
  contract URL did **not** reproduce on careful measurement (0.11s cold, 0.03s cached). It was a
  transient cold-start/network blip, not a slow query.

---

## Positive security notes (worth keeping)
- Defense-in-depth on SQL: parameterization **and** whitelists **and** regex-guarded identifiers — even
  the keyset column names (which are developer-supplied, not user input) are validated.
- Cursor integrity via `sortToken` prevents cross-sort cursor reuse — a nice touch beyond typical keyset.
- Search input is constrained to word characters before hitting FTS5 — closes both injection and FTS
  syntax-error/DoS classes in one move.
- CSP is genuinely strict and is recomputed (hash-based) for cached HTML so caching doesn't weaken it.

---

## Limitations / not covered
- **No load/DoS testing** (out of scope) — INFO-2 is from code review, not measured.
- **No authenticated surface exists** to test (public, no login).
- **`clearwing sourcehunt` was not run** against the source: it is tuned for native/memory-safety
  (ASan/UBSan crash ground-truth) and is a poor fit for a TypeScript web app; the manual + agentic audit
  above is the appropriate equivalent. Can be run on request if you want the tool's own pass.
- Third-party dependency CVEs (`pnpm-lock.yaml`) were **not** audited — recommend a routine `pnpm audit` /
  Dependabot pass as a separate workstream.

## Suggested next steps
1. (Optional) `pnpm audit` / SCA on the lockfile for dependency CVEs.
2. Edge rate-limiting on `*.csv` (INFO-2).
3. Remove dead `ADMIN_BASIC_AUTH_*` config (INFO-1).
4. Keep the current parameterization+whitelist pattern as the standard for any new filter/sort param.

---

*Artifacts:* recon harness `recon/probe.py`, injection sweep `recon/inject.py` (+ `inject-results.jsonl`),
mirrored bundles `assets/`, full log `reports/engagement-log.md`.

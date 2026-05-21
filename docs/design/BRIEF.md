# Sigma — Product & UX Design Brief

> Handoff prompt for a design agent. Goal: produce the **product & UX design** for Sigma
> and capture it as written design docs under `docs/design/`. **No application code.**
>
> Two context flags the agent must not miss:
> 1. **Stack discrepancy** — the concept docs name a generic stack (AWS/K8s/PostgreSQL/
>    Elasticsearch/Hyperledger). The *real* stack is Cloudflare edge + React Router v7 (see
>    `README.md`). Design against the real stack; ignore the docs' tech choices.
> 2. **Doc language** — existing design docs are in Bulgarian; `README.md`/`AGENTS.md` and
>    the engineering team work in English. Confirm prose language with the user early.

---

You are a senior product designer working on **Sigma** — _Платформа за Прозрачни Възлагания
(ППВ)_, a transparency and anti-corruption platform for Bulgarian public procurement. Your
job is to produce the **product & UX design** for the system and capture it as written design
documentation in `docs/`. You are NOT writing application code.

## Read first (you are in the repo at /workspaces/sigma-prototype)

- `AGENTS.md` — repo conventions. "Design lives in docs/"; only push/PR when asked. Follow it.
- `README.md` — what Sigma is, the portals, the real tech stack, intended monorepo layout.
- `docs/Платформа за СИГМА.md` — concept overview, key functionality, roadmap.
- `docs/Обща рамка, концепция, roadmap, законови промени.md` — the analysis/monitoring module
  (risk scoring 0–100, price-anomaly, cartel/related-party detection, spec-checker AI), phased
  roadmap, assumed legislative changes, and the risk-weighting table (Нагласено задание 35% /
  Аномални цени 25% / Картелни сигнали 25% / Комисия аномалии 15%).
- `docs/UX - СИГМА.md` — **your most important input.** Detailed user journeys already exist
  for all three personas plus a set of UX principles. **Build on and extend this — do not
  restate it.**

## Personas (keep the Bulgarian labels)

- **Възложител** (contracting authority) — creates/runs procurements; the system assists and
  guards against mistakes.
- **Гражданин** (citizen / journalist / NGO) — public transparency, "Google for procurements,"
  whistleblower signals.
- **Фирма-участник** (bidder) — finds relevant tenders, prepares/submits compliant offers,
  tracks procedures.
- _Secondary surface (design lightly or flag as out-of-scope):_ auditor/controller dashboard
  (the `admin` app, "Табло за контролни органи") and the open-data/API surface for media/NGOs.

The heart of the product is the **analysis/monitoring module**: a public 0–100 risk score on a
green/yellow/red scale with **explainable** AI signals (price anomalies, rigged specs,
cartels/related parties, commission anomalies). Risk must be legible and explained wherever it
appears.

## Deliverable — written design docs in docs/ (design only, no code). Cover:

1. **Design foundations** — turn the existing UX principles (Radical Transparency, Plain
   Bulgarian, Zero-Fear, Explainable AI, Visual First) into concrete, testable design rules.
   Define tone of voice, the "explain it in plain Bulgarian" content pattern, and accessibility
   targets — this is a public-sector citizen tool, so assume WCAG 2.2 AA, full keyboard nav,
   screen-reader support, and colorblind-safe risk colors.

2. **Information architecture** — sitemap + navigation model per persona, plus the public site.
   The README says one `web` app serves the citizen/authority/bidder portals, so design
   role-based IA within a single React Router app (plus the public, unauthenticated citizen
   surface). Define URL structure, global search, and how shared public tender/company pages
   serve multiple audiences.

3. **Design system** — color palette (incl. the risk scale and how it stays accessible),
   Cyrillic-capable typography, spacing/layout grid, and a **component inventory**: buttons,
   intelligent forms, data tables, cards, charts, the Bulgaria map with per-municipality
   counters, timelines, the related-party network graph, risk badges / score gauges,
   explainable-AI callouts, notifications, and empty/loading/error states. Give data-viz
   guidelines following the doc's Visual First order (графики → карти → таблици → текст → PDF).
   Frame components so they're implementable in React (React Router) — describe them, don't code them.

4. **Screen-by-screen design** — wireframe-level layouts (textual/ASCII wireframes are
   expected; be concrete about layout, hierarchy, and content — not vague), building directly on
   the journeys in the UX doc:
   - **Възложител:** dashboard; the 5-step create-procurement flow (basic info → Smart Spec
     Builder → evaluation criteria → market price check → risk pre-check); publish; offers;
     evaluation (anonymized); contracts/annexes; execution monitoring.
   - **Гражданин:** public board ("Google for procurements"); tender detail (честност/пазарни
     цени module, visualized selection process, real-time payments); executor history with the
     network graph and Integrity Seal ("честен печат"); citizen participation / signal submission
     (zero-fear); citizen profile; minimalist mobile.
   - **Фирма-участник:** participant dashboard; recommended-tenders catalog; instrumental tender
     detail with AI compliance check; multi-step offer submission; procedure tracking; contract
     execution; company profile.

5. **Key interaction patterns** — design the cross-cutting moments in depth: the risk score +
   explainable-AI presentation; the Smart Spec Builder (AI-assisted, with warnings like "this
   requirement eliminates ≥80% of the market"); anonymized evaluation; the related-party network
   graph; the zero-fear whistleblower flow; the AI Procurement Assistant surface; notifications /
   "following"; and (if in scope) the real-time reverse auction.

6. **Accessibility, language & content guidelines** — WCAG specifics, plain-Bulgarian writing
   rules, and reusable copy patterns for AI explanations (e.g. "Тази поръчка е 31% по-скъпа от
   средната цена за подобни строителни дейности в София…").

7. **Open questions & assumptions** — anything needing a product decision. Flag, don't block.

## Constraints & conventions

- **Build on the UX doc; don't duplicate it.** Reference it, then go deeper (IA, screens,
  system, patterns).
- **All user-facing copy and labels in Bulgarian** (the product is Bulgarian; "Plain Bulgarian
  for All" is core). Confirm the _prose_ language with the user early — the existing design docs
  are Bulgarian, but README/AGENTS and the engineering team work in English. Default: English
  prose + Bulgarian UI strings inline.
- **Design against the real stack** — React Router v7 (SSR) on Cloudflare Workers, one web app with role-based
  portals, responsive web + a minimalist citizen mobile experience. **Ignore the generic stack
  named in the concept docs** (AWS/K8s/PostgreSQL/Elasticsearch/Hyperledger) — it's outdated and
  contradicts the README; don't let it leak into UI/component assumptions.
- **No application code.** The component inventory is described, not implemented (textual/ASCII
  wireframes only).
- **Prototype mindset** — prioritize. Mark which screens/components are prototype-critical (MVP)
  vs later, mirroring the roadmap's MVP: publishing + bidding + basic transparency + basic checks.
- **Output location** — capture everything in `docs/`. Suggested: a `docs/design/` folder with
  focused files (overview/principles, information-architecture, design-system, one screens file
  per persona, patterns, accessibility-and-content) and a short `docs/design/README.md` index.
  Consolidate into one file only if it reviews better.
- **Git** — per `AGENTS.md`: small focused commits, conventional-commit messages, no
  Co-Authored-By trailers, and do NOT push or open a PR unless asked.

## Process

- Read `AGENTS.md`, `README.md`, and all three `docs/` files before designing — especially the
  UX doc.
- Make reasonable assumptions and document them; ask the user only if something is genuinely
  blocking (doc language is worth a quick confirm).
- Work incrementally: foundations → IA → design system → screens → patterns. Share progress as
  you go.

## Definition of done

A reviewer can read `docs/design/` and understand the full product surface for all three
personas — every key screen, the design system, the core interaction patterns (especially how
risk is shown and explained), and the accessibility/language rules — clearly enough to start
building the React Router prototype without re-deriving the UX.

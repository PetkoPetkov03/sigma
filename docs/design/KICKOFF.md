# Sigma — Initial Scope Kickoff: Procurement Data Explorer

You're the product & UX designer for **Sigma** (_Платформа за Прозрачни Възлагания_). For this
first iteration the scope is deliberately narrow: a **read-only reporting & visualization layer**
over the public-procurement data we already have — not the full procurement workflow. (The broader
product vision lives in `docs/design/BRIEF.md`; that's context, not the current target.)

**The data.** ~129,000 contract/lot rows from the АОП register (Агенция за обществени поръчки),
already loaded into a local **Cloudflare D1** database as a single table `raw_aop_contracts` (see
`packages/db/migrations/0001_raw_aop.sql`, `data/aop-load.sql`, `scripts/load-aop.mjs`). It covers
two sectors — **строителство** (construction, ~104k rows) and **храни** (foods, ~25k rows). Each
row has: the contracting authority / department (`authority_name`), the winning company
(`contractor_name` + `contractor_eik`), values in EUR (`estimated_value_eur`, `signing_value_eur`,
`current_value_eur`), CPV code, procedure type, EU-funded flag, bids received, dates, and lot
structure (`parent_tender_id`, `lot_number`). Read the migration and a sample of the load file
before designing.

**What to design (reports / visualizations):**

- **Biggest beneficiaries** — top companies by total public money won and by number of contracts;
  their authority and sector mix.
- **By government department** — how much each authority spends, on what, and to whom; concentration
  of spend within an authority.
- **Money flows "from where to where"** — authority → company flows (amounts + counts), as a
  network / flow visualization.
- **Company profile** — per company (keyed by `contractor_eik`): total won, number of contracts,
  which authorities, CPV mix, average bids, procedure types, EU-funded share.
- **Biggest potential corruption deals** — surface _and explain_ the red-flag signals derivable from
  this data: single-bid / no-competition contracts, non-competitive procedures (Пряко договаряне,
  Договаряне без предварително обявление), one company winning a large share of an authority's
  spend, value growth from estimated → signing → current, frequent annexes.

**Important data reality-check.** The owner / beneficial-owner reporting you described — _who
actually owns each company, which companies share owners, and how money flows to the real owners
rather than the companies_ — is **not** backed by the current data. `raw_aop_contracts` has the
company ID (`contractor_eik`) but no ownership information. That layer needs an additional source
(Търговски регистър, joined via EIK). Design the surface for it and note it as a data dependency /
next phase, but don't assume the data exists yet.

**Constraints.**

- Design docs only in `docs/design/` — **no application code**.
- Design against the real stack: React Router v7 (SSR) on Cloudflare Workers, reading from D1.
- All user-facing copy in **Bulgarian**.
- This is a public, **read-only** transparency/analytics explorer for now (citizen / journalist /
  NGO audience) — no authority or bidder workflow yet.

**Start by** reading the schema and a data sample plus `AGENTS.md`, then propose how you'd structure
the reports and screens so we can refine scope and details together before you go deep.

=======

# Sigma — Initial Scope Kickoff: Procurement Data Explorer

> Self-contained brief — you don't need any repository or file access. Everything required is
> below. Deliver your design back as markdown.

## What Sigma is

Sigma (_Платформа за Прозрачни Възлагания_) is a transparency / anti-corruption platform for
Bulgarian public procurement. This first iteration is deliberately narrow: a **read-only reporting
& visualization layer** over a dataset of historical procurement contracts — not a procurement
workflow. Audience: citizens, journalists, NGOs. There's a broader long-term product vision, but
it's out of scope here. **UI language is Bulgarian.**

## The data you're designing for

~129,000 contract/lot rows from the Bulgarian public-procurement register (АОП), loaded into a
relational database (SQLite/Cloudflare D1) as one denormalized table, `raw_aop_contracts`. Two
sectors only:

- **строителство** (construction) — ~104,000 rows
- **храни** (foods) — ~25,000 rows

Each row is a tender (or one of its lots) and, when awarded, the resulting contract. Fields:

| Field                              | Meaning                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| `dataset`                          | sector: `строителство` (construction) or `храни` (foods)                         |
| `tender_internal_id`               | internal id of the tender/lot                                                    |
| `parent_tender_id`                 | if set, this row is a **lot** under that parent tender                            |
| `lot_number`                       | lot number within the tender                                                     |
| `unp`                              | official procurement number, e.g. `00097-2020-0001`                              |
| `subject`                          | free-text subject of the tender                                                  |
| `authority_name`                   | the **contracting authority** (ministry, municipality, agency, school…) — the buyer |
| `procedure_type`                   | how it was procured (see below)                                                  |
| `contract_kind`                    | `Доставки` (supplies) / `Услуги` (services) / `Строителство` (works)             |
| `cpv_code`                         | EU Common Procurement Vocabulary code (what's being bought)                      |
| `estimated_value_eur`              | the authority's estimated value                                                  |
| `eu_funded`                        | 1 = financed with EU funds, 0 = national                                         |
| `published_ojeu`                   | 1 = published in the EU Official Journal                                          |
| `bids_received`                    | number of bids submitted (0/1 ≈ no real competition → red flag)                  |
| `annex`                            | annex / amendment indicator                                                      |
| `contract_number`, `contract_subject` | the resulting contract                                                       |
| `contract_start_date`, `contract_end_date` | contract period                                                         |
| `signing_value_eur`                | value at signing                                                                 |
| `current_value_eur`                | current value after annexes (growth vs signing → red flag)                       |
| `contractor_name`                  | the **winning company**                                                          |
| `contractor_eik`                   | the company's unique national ID (ЕИК) — stable join key                         |

It is **raw** data: contractor fields are NULL on non-awarded / parent rows, and there can be
near-duplicate rows per lot (e.g. annex variants), so aggregations need de-duplication. Values are
in EUR.

`procedure_type` values, roughly competitive → not:

- `Открита процедура` (open), `Публично състезание` (public contest), `Събиране на оферти с обява`
  (collection of offers) — competitive
- `Пряко договаряне`, `Договаряне без предварително обявление` (direct / negotiated without prior
  notice) — **low/no competition → red flag**

Two real example rows (illustrative):

- Competitive: authority `ОБЩИНА БЛАГОЕВГРАД`, food-supply subject, `Открита процедура`, 4 bids,
  signing 705,661 EUR, contractor `ЕВРО МИЙТ ЕНД МИЛК ЕООД` (ЕИК 101658372).
- Red-flag-ish: authority `МИНИСТЕРСТВО НА МЛАДЕЖТА И СПОРТА`, `Пряко договаряне` (direct
  negotiation), 76,693 EUR, contractor `БАЛКАН КОМФОРТ Д.М.С. ООД` (ЕИК 130490358).

## What to design (reports / visualizations)

- **Biggest beneficiaries** — top companies by total public money won and by number of contracts;
  their authority and sector mix.
- **By government department** — how much each authority spends, on what, and to whom; spend
  concentration within an authority.
- **Money flows "from where to where"** — authority → company flows (amounts + counts) as a network
  / flow visualization.
- **Company profile** — per company (keyed by ЕИК): total won, number of contracts, which
  authorities, CPV mix, average bids, procedure types, EU-funded share.
- **Biggest potential corruption deals** — surface _and explain_ the red-flag signals computable
  from the fields above: single-bid / no-competition, non-competitive procedures, one company
  dominating an authority's spend, value growth estimated → signing → current, frequent annexes.

## Data reality-check (important)

The owner / **beneficial-owner** reporting — _who actually owns each company, which companies share
owners, and how money reaches the real owners rather than the companies_ — is **not** backed by this
data. There's the company ID (ЕИК) but no ownership information. That layer needs a second source
(the Bulgarian Commercial Register, _Търговски регистър_, joined via ЕИК). Design the surface and
mark it as a next-phase data dependency — don't assume the data exists yet.

## Constraints

- **Design documents only** — no application code. Deliver as markdown (one or more documents); the
  user will bring them into the project.
- Target stack (for feasibility): a React Router v7 (SSR) web app on Cloudflare reading from a D1/SQLite
  relational database — reports are SQL-driven and rendered in-browser (charts, maps, network
  graphs).
- **All user-facing copy in Bulgarian.** Write the design prose in English unless the user prefers
  otherwise.
- Public, **read-only** explorer for now (citizen / journalist / NGO) — no authority or bidder
  workflow yet.

## Start

Propose how you'd structure the reports and screens (and the information architecture tying them
together) so we can refine scope and details together before you go deep.


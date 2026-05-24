# Core explorer — scope & data mapping (v1)

> The build target for the first iteration. It carves a deliberately narrow subset of the
> full design ([IA](../mocks/docs/design/01-information-architecture.md),
> [screens](../mocks/docs/design/02-screens.md)): show **the deals, who receives the money,
> and the structures that order it** — and nothing else yet. The owner layer and the
> red-flag signals layer are explicitly out (see [Parked](#parked)). The pipeline that
> feeds this is [etl-pipeline.md](etl-pipeline.md).
>
> Design prose in English; all user-facing copy in **Bulgarian**.

**Decided 2026-05-22.** Atomic record = the awarded contract (bids surface as a count, not
per-bidder offers — those aren't in the data). Money flows are **in** the core. Owners and
red-flag signals are **parked**.

## Scope in one line

Three entities — **Институция** (authority / buyer), **Компания** (recipient, keyed by ЕИК)
and **Договор** (contract) — plus the **authority→company money flows** and the **global
search** that connect them into one navigable graph. Read-only. Money is stored in each
contract's **native currency** (BGN through 2025, EUR from 2026; the lev is fixed at
1 EUR = 1.95583 BGN), so any cross-year sum converts to a single display unit — shown in лева
per IA editorial principle #1.

## In scope

| Surface | Route | What it answers |
| --- | --- | --- |
| Home | `/` | Headline totals + entry points (top buyers, top recipients) |
| Authorities | `/институции` | Every buyer, rankable and filterable |
| Authority profile | `/институции/[slug]` | One buyer: how much, on what, to whom |
| Companies | `/компании` | Recipients; defaults to top beneficiaries |
| Company profile | `/компании/[eik]` | One recipient: total won, from whom, what |
| Contracts | `/договори` | Filtered contract list |
| Contract detail | `/договори/[id]` | One deal, full provenance |
| Flows | `/потоци` | Authority→company money flows (amounts + counts) |
| Search | `/търсене` | Across names, subjects and identifiers |

The atomic record is the **awarded contract** (договор), at lot granularity per the IA: lot
rows roll up to their parent tender for display but stay addressable. "Bidding" surfaces
only as the **count of offers received** (`bids_received`) plus the procedure type —
**per-bidder offer amounts are not in the АОП data**, so there is no per-offer view.

## Parked

Out of this iteration by decision. The schema **hooks stay** so nothing has to be
re-migrated when these resume — they just have no UI or scoring in the core.

- **Owner / `Лице` layer** — beneficial owners, shared-owner patterns, the `/лица` surface.
  Needs the Търговски регистър joined on ЕИК — a separate ingest (see
  [KICKOFF](design/KICKOFF.md)). The `bidder_members` table, the `contract_participants`
  view and the `eik_normalized` join key all remain in the schema, unused by the core UI.
  Money is attributed with **lens #1 only**: `SUM(contracts.amount_eur)` grouped by `bidder_id`
  (a consortium is credited as the single awarded entity). The member-level lens #2 — splitting each
  contract across consortium members — activates with this layer via the `contract_participants` view
  (see [0000_init.sql](../packages/db/migrations/0000_init.sql)).
- **Red-flag / signals layer** — the [signal catalog](../mocks/docs/design/03-red-flag-catalog.md),
  composite scoring and the `/червени-флагове` leaderboard. The `risk_scores` table stays (empty); the
  price-benchmark view was dropped with the retired xlsx and will be rebuilt on the domain data when
  signals resume.

## Surfaces & data mapping

Source tables are the domain tables in [0000_init.sql](../packages/db/migrations/0000_init.sql).
Fields once marked **†** were "not in the domain yet" under the xlsx bootstrap; **normalize now
propagates almost all of them** from the admin export — see [Data dependencies](#data-dependencies-this-scope-needs)
for the few that remain (sector + a couple of minor contract fields).

### Authority profile (`/институции/[slug]`)

| Shows | Source / aggregation |
| --- | --- |
| Име | `authorities.name` |
| Общо похарчено | `SUM(contracts.amount_eur)` over contracts whose `tenders.authority_id` = this id |
| Брой договори | `COUNT(contracts)` via `tenders.authority_id` |
| Какво купува (CPV mix) | `GROUP BY tenders.cpv_code` (readable CPV names need a dictionary †) |
| Към кого (топ изпълнители) | `GROUP BY contracts.bidder_id`, `SUM(amount_eur)` desc → `bidders.name` |
| Процедури (mix) | `GROUP BY tenders.procedure_type` |
| ЕС финансиране (дял) | share of `eu_funded` † |
| Сектор | `sector` † |
| Тип (министерство / община / агенция …) | `authorities.type` † (classification pass) |

### Company profile (`/компании/[eik]`)

| Shows | Source / aggregation |
| --- | --- |
| Име / ЕИК | `bidders.name` (display-only) / `bidders.bulstat` + `eik_normalized` (key) |
| Общо спечелено | `SUM(contracts.amount_eur)` grouped by `bidder_id` (lens #1) |
| Брой договори | `COUNT(contracts)` |
| От кои институции | `GROUP BY tenders.authority_id` → `authorities.name` |
| Какво продава (CPV mix) | `GROUP BY tenders.cpv_code` |
| Процедури (mix) | `GROUP BY tenders.procedure_type` |
| Среден брой оферти | `AVG(bids_received)` † |
| ЕС финансиране (дял) | share of `eu_funded` † |
| Сектор | `sector` † |
| Обединение / консорциум | `bidders.kind` / `is_consortium` — shown as a neutral label, not a signal |

### Contract detail (`/договори/[id]`)

| Shows | Source |
| --- | --- |
| Възложител | `authorities.name` via `tenders.authority_id` |
| Изпълнител | `bidders.name` + ЕИК |
| Стойности: прогнозна → при сключване → текуща | `tenders.estimated_value` → `contracts.signing_value` → `current_value`; `amount` is the headline (= current, or signing when an annex is flagged `annex_suspect`) |
| Процедура | `tenders.procedure_type` |
| Брой оферти | `bids_received` † |
| Обект (вид: доставки / услуги / строителство) | `contract_kind` † |
| CPV | `tenders.cpv_code` / `lots.cpv_code` |
| ЕС финансиране | `eu_funded` † |
| Дати: сключване / край / краен срок | `contracts.signed_at` / `contract_end_date` † / `tenders.deadline_at` |
| Номер и предмет на договор | `contract_number` † / `contract_subject` † |
| УНП | `tenders.source_id` |
| Обособени позиции | `lots` under the parent tender |
| Сектор | `sector` † |

### Lists & browser

- **Authorities** / **Companies** lists — ranked tables; companies default to top
  beneficiaries by `SUM(contracts.amount_eur)`. Both rankable and filterable.
- **Contracts browser** — filtered list; filters are URL-encoded per the IA so any view is
  shareable: year (`signed_at`), sector †, CPV, procedure type, authority, company, value
  range, EU-funded †. Every aggregate elsewhere decomposes to a filtered view of this list.

### Flows (`/потоци`)

Authority→company edges: `GROUP BY tenders.authority_id, contracts.bidder_id` →
`SUM(amount_eur)`, `COUNT(*)`; nodes drawn from `authorities` and `bidders`; top-N by amount,
with the same sector/year/value filters carried through. **No owner column** (that toggle is
part of the parked layer).

### Search (`/търсене`)

Prefix / fuzzy match against `authorities.name`, `bidders.name`, `tenders.title` (subject),
the УНП (`tenders.source_id`) and `contract_number` †.

## Data dependencies this scope needs

**Mostly done.** normalize v2 (the admin export → domain rebuild, [etl-pipeline.md](etl-pipeline.md))
propagates these directly — the admin export carries them per row, from `raw_egov_contracts` /
`raw_egov_tenders` via [normalize-egov.sql](../scripts/normalize-egov.sql).

| Field | Domain home | Status |
| --- | --- | --- |
| Bidder count | `contracts.bids_received` | **done** |
| EU-funded flag | `contracts.eu_funded` | **done** |
| Contract kind (доставки / услуги / строителство) | `contracts.contract_kind` + `tenders.contract_kind` | **done** |
| Signing & current value (separate) | `contracts.signing_value` / `current_value`; `amount` headline + `amount_eur` canonical | **done** |
| Annex count | `contracts.annex_count` | **done** |
| Contract number | `contracts.contract_number` | **done** |
| Authority type | `authorities.type` | **done** — 4,867 / 4,868 typed (from Вид на възложителя) |
| CPV labels | `tenders.cpv_description` | **done** — the export ships the label; no external dictionary needed |
| Awarded-to-group flag | `contracts.awarded_to_group` | **done** — per-contract (distinct from the entity-level `bidders.is_consortium`) |
| **Sector** | [`@sigma/config`](../packages/config/src/index.ts) `sectorForCpv()` | **done** — all 45 CPV divisions classified deterministically from `tenders.cpv_code`; facet + filter wired into the API |
| **Contract subject / end date** | `contracts.contract_subject` / tender `start_date`,`end_date`,`duration_days` | **done** — admin full-capture |

So the core is buildable now — and the previously-pending **sector** + minor contract fields are now
**done** (the admin full-capture + the CPV-division sector config). The pipeline has since grown into a
multi-source model (admin full-capture, OCDS parties → location, Trade Register → owners [postponed],
NUTS region, scheduled ETL); see [etl-pipeline.md → Multi-source expansion](etl-pipeline.md#multi-source-expansion-may-2026)
and the as-built [mock-coverage.md](mock-coverage.md).

**Money & data quality.** Sum the canonical **`contracts.amount_eur`** (every currency already in EUR:
BGN at the fixed ÷1.95583 peg, foreign at the ECB signing-date rate with `fx_converted = 1`; `NULL`
only for the 172 value-error contracts, so it is always safe to `SUM`) — not the raw native-currency
`amount`, which is for display (лева = `amount_eur × 1.95583`). Each contract also carries
**`value_flag`** (`ok` / `review` / `annex_suspect` / `value_suspect`): the explorer should surface
`value_suspect`/`annex_suspect` contracts as "anomalous value — under review" rather than hide them
(they are prime scrutiny targets). Recipients with no valid ЕИК are keyed by name. See
[etl-pipeline.md → Data quality](etl-pipeline.md#data-quality).

## What is not in v1

Carried over from the [IA](../mocks/docs/design/01-information-architecture.md#7-what-is-not-in-v1):
no login or saved state, no editorial/story layer, no map, no compare mode, no CPV browser
screen, no write side, no public API (bulk CSV export per filtered view is in scope).

## Cross-references

- Full design (the superset this carves from): [IA](../mocks/docs/design/01-information-architecture.md),
  [screens](../mocks/docs/design/02-screens.md).
- Pipeline feeding the domain tables: [etl-pipeline.md](etl-pipeline.md).
- Schema (domain + staging + parked owner hooks + `contract_participants`, one file):
  [0000_init.sql](../packages/db/migrations/0000_init.sql).

# DealRoute Pipeline — Architecture

The crawl / LLM-extraction / evidence / monitoring service that turns web sources into
evidence-backed **candidate deal records** a human approves before publish. **LLM proposes,
humans approve — nothing auto-publishes in v1.**

## Layers (clean architecture; dependencies point inward)

```
┌─────────────────────────────────────────────────────────────────────┐
│ adapters/  (infrastructure: vendors behind ports)                    │
│   fetcher · llm · evidence-store · db · queue · http · cli · seeds    │
│        ▲ implements                         ▲ wired by                │
│        │                                    │                         │
│ application/  (use-cases + PORTS)           │   composition/          │
│   extract · crawl-source · review ·         │   container.ts          │
│   monitor-source · ports/*                  │   (the ONE root)        │
│        ▲ depends on                                                   │
│        │                                                              │
│ domain/  (entities, value objects, PURE rules — no vendor imports)    │
│   deal-record · rules (true-cost, dedupe, vocab, validate, confidence)│
└─────────────────────────────────────────────────────────────────────┘
```

- **`src/domain/`** — the deal record (zod schema), value objects, and **pure, unit-tested
  rules**: `true-cost`, `dedupe-key`, `vocab-mapping`, `validate-record` (sanity + grounding),
  `confidence`. Imports no framework and no vendor SDK. This is the trust-critical core.
- **`src/application/`** — use-cases orchestrating the domain over **ports** (interfaces):
  `ExtractUseCase` (the LLM core), `CrawlSourceUseCase` (Lane A), `ReviewUseCase`,
  `MonitorSourceUseCase`. Ports live in `application/ports/`.
- **`src/adapters/`** — concrete implementations of the ports (Playwright, Firecrawl,
  Anthropic, OpenAI, Stub, local-FS, S3 [stub], Postgres/drizzle, in-memory DB, pg-boss,
  in-memory queue, HTTP review API, CLI, seed parser).
- **`src/composition/container.ts`** — the **single composition root**. The only place that
  reads config and does `new SomeAdapter()`. Everything else receives dependencies (DI).

## Ports & adapters (DIP)

| Port (`application/ports`) | Default adapter | Alternatives |
|---|---|---|
| `Fetcher` | `PlaywrightFetcher` | `FirecrawlFetcher` (`FETCHER=firecrawl`) |
| `Llm` | `AnthropicLlm` | `OpenAiLlm`, `StubLlm` (`LLM_PROVIDER=…`) |
| `EvidenceStore` | `LocalFsEvidenceStore` | S3/R2 (extension point) |
| `Database` | `PostgresDb` | `InMemoryDb` (no Postgres; dry-run/tests) |
| `Queue` | `PgBossQueue` | `InMemoryQueue` |
| `BrowserAgent` | `NoopBrowserAgent` (Phase A) | real agent in Phase B/C |
| `Clock`, `Logger` | `SystemClock`, `ConsoleLogger` | fakes in tests |

Every adapter is substitutable behind its port (LSP) and verified by a **shared contract
suite** (`test/contracts/*`): `EvidenceStore` and `Database` each have one. The Postgres
contract runs only when `DATABASE_URL_TEST` is set.

## The two lanes → one pipeline

- **Lane A — deterministic (Tiers 1–2):** scheduler picks due sources → `Fetcher` returns
  text + screenshot + HTML → evidence captured **before** any candidate → `ExtractUseCase`
  (LLM = extraction only) → validate + dedupe → candidate queue.
- **Lane B — site discovery (Tiers 3–4):** `DiscoverSiteUseCase` (`discover <url>`) does a
  **bounded same-site crawl** — fetch the start page, follow links **within the start domain
  and already-approved domains**, extract candidates from each via the same path as Lane A.
  Links to **novel domains** are NOT followed; they are recorded as `pending_approval`,
  tier-4 `discovered` sources that a human approves before any crawl (the source-promotion
  loop / new-domain guardrail). Runs are CAPPED by pages **and** € **and** wall-clock and stop
  at the first cap; login/captcha/anti-bot pages route to manual capture; the frontier is
  ordered by a domain-agnostic "likely-offer-page" score so a small budget reaches deal pages
  before navigation chrome. A `NoopBrowserAgent` still backs the `BrowserAgent` port for the
  fully-agentic Phase C lane (search-driven discovery), droppable in without editing callers.
- **Lane B — community ingestion (Tier 3):** `IngestCommunityUseCase` (`ingest --source <id>`)
  reads a community source's **RSS/Atom feed** (the `FeedReader` port) as a stream of *leads*,
  applies a cheap catalog-keyword pre-filter, runs a per-item **LLM triage** (relevant
  subscription deal? — output validated at the boundary by `parseTriageResult`), and only then
  fetches + extracts the relevant leads via the Lane-A path. Merchant domains are proposed for
  approval. Same caps (items/€/time) and guardrails as discovery; the shared `LaneBSupport`
  holds the common edge logic (evidence, manual-capture routing, novel-domain proposal) so the
  two Lane-B entrypoints can't drift on a guardrail.
- **Shared path:** validate → dedupe/canonicalize → capture evidence → **candidate queue** →
  human approve/reject (review API/CLI, logged to the append-only `reviews` audit table) →
  publish → monitor/diff → re-queue or auto-expire. Lane A and Lane B share one persist
  implementation (`CandidateSink`) so the dedupe / content-change / proposal rules live in
  exactly one place.

## Trust invariants (enforced in code, covered by tests)

1. **Nothing auto-publishes.** Only `ReviewUseCase.approve` (with an approver) sets
   `published`. Tested: anonymous publish rejected; terminal deals can't be re-decided.
2. **Evidence required before a candidate.** `CrawlSourceUseCase` captures evidence and links
   `evidence_id` before inserting a candidate.
3. **Public pages only.** The `Fetcher` never logs in; `page-classifier` routes
   login/captcha/anti-bot pages to the **manual-capture queue**.
4. **LLM never invents columns.** Unknown conditions → `conditions[]` with `key:"other"` +
   a `field_proposals` entry; ingestion is never blocked (governed promotion loop).
5. **Never trust raw LLM/scraped data.** `parseLlmDeals` validates LLM output through the
   schema at the boundary; `validate-record` checks sanity + that every grounding quote is a
   real substring of the page (the hallucination guard); failures downgrade confidence and
   force review.
6. **Misleading cost can't rank silently.** `validate-record` forces must-review when a deal is
   `promo` or carries an `intro_period` condition, so a "0 € for 6 months" headline can't
   surface as permanently free without a human confirming the steady-state cost.
7. **Monitoring never silently retracts a verified deal.** A login/captcha/anti-bot wall routes
   to manual capture (not expiry); auto-expiry fires only after N **consecutive** unreachable
   checks, so a single transient failure can't expire a published deal.

## Review API trust boundary

The HTTP review API (`serve`) is the durable contract for the future admin panel. State-changing
endpoints (approve/reject) are gated by `REVIEW_API_TOKEN` (bearer) when set; the recorded
`approver` is still client-supplied, so the **production admin panel terminates real
authentication and supplies the authenticated principal**. With no token set the API is open and
**must** be bound to a trusted network (localhost/private). Read endpoints are never gated.
Domain errors map to precise client status codes (404/409/400/413); internal errors return a
generic 500 with no leaked detail; request bodies are size-bounded.

## How to add things (no editing of existing logic)

- **A new source** → add a row to the `sources` registry (via `seed-import` or the
  `add-source` skill): `url`, `type`, `tier`, `cadence_days`. No code change. If it needs a
  different fetch strategy, that's a new `Fetcher` adapter behind the port.
- **A new model / vendor** → add an adapter implementing `Llm` (or `Fetcher`, etc.) + its
  contract test, then select it via env in the composition root. No business-logic change.
- **A new condition** → add a `condition_vocabulary` entry (data). Recurring unknown
  conditions surface as `field_proposals` and are promoted via the `promote-field-proposal`
  skill, bumping `schema_version`. Never a new column without promotion.

## Data model (Postgres, `src/adapters/db/postgres/schema.ts`)

`subscription_catalog`, `sources`, `crawl_runs`, `deals` (typed core columns **plus** JSONB for
`conditions`/`attributes`/grounding/proposals), `evidence`, `changes`, `manual_capture_tasks`,
`condition_vocabulary`, `field_proposals`. Migrations live in `./drizzle` (generated by
drizzle-kit).

## Resilience

Every external call is timeout-bounded and retried with backoff (`adapters/shared/retry.ts`).
A failed source/run is logged with context and never crashes the batch. Per-run LLM cost is
estimated and logged (guardrails). Jobs are idempotent.

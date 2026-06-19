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
- **Lane B — agentic (Tiers 3–4):** behind the `BrowserAgent` port; a `NoopBrowserAgent`
  ships in Phase A so the wiring exists. Phase B/C drop in a bounded agent **without editing
  callers** (OCP).
- **Shared path:** validate → dedupe/canonicalize → capture evidence → **candidate queue** →
  human approve/reject (review API/CLI) → publish → monitor/diff → re-queue or auto-expire.

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

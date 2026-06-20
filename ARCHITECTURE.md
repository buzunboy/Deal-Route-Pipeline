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
| `Fetcher` | `PlaywrightFetcher` | `BrowserRenderFetcher` (`FETCHER=browser`, C-2 JS-render), `FirecrawlFetcher` (`FETCHER=firecrawl`), `HostedBrowserFetcher` (`FETCHER=hosted-browser`, C-2 scaffold) |
| `Llm` | `AnthropicLlm` | `OpenAiLlm`, `StubLlm` (`LLM_PROVIDER=…`) |
| `EvidenceStore` | `LocalFsEvidenceStore` | S3/R2 (extension point) |
| `Database` | `PostgresDb` | `InMemoryDb` (no Postgres; dry-run/tests) |
| `Queue` | `PgBossQueue` | `InMemoryQueue` |
| `BrowserAgent` | `NoopBrowserAgent` (off-switch) | `SearchBrowserAgent` (`AGENT=search`, C-1; also drives the C-2 render Fetcher); a future interactive multi-step agent (Option B) |
| `SearchProvider` | `StubSearchProvider` (off-switch) | `BraveSearchProvider` (`SEARCH_PROVIDER=api`), `FirecrawlSearchProvider` (`SEARCH_PROVIDER=firecrawl`) |
| `Clock`, `Logger` | `SystemClock`, `ConsoleLogger` | fakes in tests |

Every adapter is substitutable behind its port (LSP) and verified by a **shared contract
suite** (`test/contracts/*`): `EvidenceStore`, `Database`, `SearchProvider`, and `BrowserAgent`
each have one. The Postgres contract runs only when `DATABASE_URL_TEST` is set.

## The two lanes → one pipeline

- **Lane A — deterministic (Tiers 1–2):** scheduler picks due sources → `Fetcher` returns
  text + screenshot + HTML → evidence captured **before** any candidate → `ExtractUseCase`
  (LLM = extraction only) → validate + dedupe → candidate queue.
- **Lane B — site discovery (Tiers 3–4):** `DiscoverSiteUseCase` (`discover <url>`) does a
  **bounded same-site crawl** — fetch the start page, follow links **within the start domain
  and already-approved domains**, extract candidates from each via the same path as Lane A.
  Links to **novel domains** are NOT followed; they are recorded as `pending_approval`,
  tier-4 `discovered` sources that a human approves before any crawl (the **source-promotion
  loop**: `SourceReviewUseCase` + `review sources|approve-source|reject-source` + the
  `/api/sources/*` endpoints; approve→`active`, reject→`rejected` which is never re-proposed;
  decisions logged to `source_reviews`). Runs are CAPPED by pages **and** € **and** wall-clock and stop
  at the first cap; login/captcha/anti-bot pages route to manual capture; the frontier is
  ordered by a domain-agnostic "likely-offer-page" score so a small budget reaches deal pages
  before navigation chrome.
- **Lane C — broad discovery (Tier 4, Phase C / C-1):** `DiscoverBroadUseCase`
  (`discover --broad`) builds a bounded query set (catalog services × registered provider/
  bundler domains, or one explicit query) and runs the `BrowserAgent` per query within a
  shared `AgentBudget`. The C-1 agent (`SearchBrowserAgent`, `AGENT=search`) is **thin**:
  it searches via the `SearchProvider` port and fetches the top public results through the
  same polite `Fetcher` (robots + rate-limit), returning page **material** — it does NOT
  extract. Extraction stays in `ExtractUseCase` + `CandidateSink` (the same boundary as every
  lane), so the LLM does extraction only and the same trust gate applies. Novel domains →
  `pending_approval` (the same source-promotion loop); a domain **deny-list** drops social/
  aggregator noise before fetching/proposing; login/blocked pages → manual capture. Capped by
  steps/queries/€/time **and** the aggregate daily €-guard; nothing auto-publishes, no
  discovered domain is auto-crawled. The default `AGENT=noop`/`SEARCH_PROVIDER=stub` keep the
  lane dark until explicitly enabled. **C-2 (JS-heavy pages)** is delivered as a render-capable
  `Fetcher` behind the existing port — `BrowserRenderFetcher` (`FETCHER=browser`, local
  Playwright: networkidle + scroll) and a `HostedBrowserFetcher` scaffold — so the same
  `SearchBrowserAgent` drives it and `PoliteFetcher` keeps wrapping it (robots/rate-limit/size
  caps preserved); no agent change. A future interactive multi-step `BrowserAgent` (form-fill /
  click-through in one session) is recorded as a follow-up (see `docs/KNOWN_ISSUES.md`).
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
   checks, so a single transient failure can't expire a published deal. Monitor matches a
   source's deals (for expiry + the diff baseline) on the source's resolved (post-redirect) URL —
   `source.resolved_url ?? source.url`, where `resolved_url` is pinned on the first successful
   crawl/monitor pass (= `fetched.finalUrl`, the URL deals are keyed by). So a source whose
   configured URL redirects still expires its OWN deals correctly — and only those (Step 4).

## HTTP surface: two routers, one port

`serve` mounts two independent raw-`node:http` handler classes on one port, dispatched by path
prefix. Dispatch is **total**: a `/v1/*` request is always handled by `PublicApi` (which 404s its
own unknown paths), so a public path can never fall through to an admin/state-changing route.

### Review API trust boundary (`/api/*` — gated admin)

The HTTP review API (`ReviewApi`) is the durable contract for the future admin panel. State-changing
endpoints (approve/reject) are gated by `REVIEW_API_TOKEN` (bearer) when set; the recorded
`approver` is still client-supplied, so the **production admin panel terminates real
authentication and supplies the authenticated principal**. With no token set the API is open and
**must** be bound to a trusted network (localhost/private). Read endpoints are never gated.
Domain errors map to precise client status codes (404/409/400/413); internal errors return a
generic 500 with no leaked detail; request bodies are size-bounded.

### Public read surface (`/v1/*` — unauthenticated, read-only)

`PublicApi` is the public counterpart: an unauthenticated, **read-only** feed over `published`
deals only (`GET /v1/deals`, `GET /v1/deals/:id`, `GET /v1/health`). It is the first public surface,
so it carries the load-bearing trust contract:

- **Published-only.** `listPublished`/`countPublished` enforce `status='published'` inside the repo
  method (a caller can never widen it); `GET /v1/deals/:id` 404s a missing OR non-published deal
  with the same response (never leaks a candidate/in_review/expired/rejected record).
- **Curated projection, never raw data.** Responses are built by `toPublicDeal` — a deliberate
  allow-list, NOT a delete-the-bad-keys filter, so a new internal field is excluded by default.
  No `status`/`confidence`/`grounding`/`attributes`/`raw_conditions_text`/`field_proposals`/
  `evidence_id`/`verified_by`/condition `source_quote` ever appears (a contract test feeds a
  fully-populated record and asserts none leak). The only trust signal exposed is a **coarse
  freshness `trust` badge** derived from `verified_at` — never the raw reliability/confidence score.
- **Reliability-blended ordering, order-only (Step 3).** The feed sort blends a source's
  `reliability_score` as a **tiebreaker**: the primary key (`cost_asc` true-cost / `verified_desc`
  freshness) decides order, ties break by reliability DESC then `id`. The deal→source join keys on
  the **registrable domain**: each deal carries a PINNED `source_registrable_domain` (Step 6,
  below) and the index is built from active sources' pinned `registrable_domain` — so the comparator
  reads a frozen string (neutral `0.5` when no active source matches, a real `0` preserved), never
  resolves a URL. The raw score **never** reaches the DTO — it lives only inside the comparator
  (`reliability_score`/`reliability` are also in `FORBIDDEN_VALUE_KEYS` as defence-in-depth). One
  pure ranker (`domain/deal-record/published-ranking.ts`) is shared by **both** DB adapters, so the
  order is LSP-identical by construction: SQL does only `status`+filters+a deterministic
  primary-ordered bounded fetch (`LIMIT PUBLISHED_FETCH_CAP`), then the shared ranker applies the
  tiebreak + paginates. `countPublished` is order-invariant. No public-API schema change.
- **Evidence as CDN URLs.** `evidence_screenshot_url` is derived purely from `evidence_id` + the
  deterministic evidence layout (`${S3_CDN_BASE_URL}/<evidence_id>/screenshot.png`); null when no
  CDN base is configured (no broken/relative URL). No screenshot-streaming route.
  **Deployment contract (load-bearing):** a bundle stores `screenshot.png` + `page.html` +
  `terms.txt` + `evidence.json` under the SAME `<id>/` prefix. The public CDN must expose ONLY
  `*/screenshot.png` — the raw HTML snapshot and the **verbatim (copyrighted) terms text** must
  stay private (editing the screenshot URL to `…/terms.txt` must NOT resolve). Scope the
  CDN/bucket policy to `screenshot.png` objects, or serve screenshots from a separate public
  prefix. See `docs/KNOWN_ISSUES.md`.
- **Condition `value` is sanitized.** A condition's `value` is an open object from LLM/source
  output; `toPublicCondition` strips any reserved/internal key name out of it, so the no-leak
  contract holds even for nested data the pipeline doesn't control.
- **Boundary-validated params.** Query filters/sort/pagination are zod-parsed into typed values;
  malformed → 400 (not a silent default). Page size is hard-capped (`PUBLISHED_MAX_LIMIT`).
- **CORS.** Every `/v1/` response carries `Access-Control-Allow-Origin` (`PUBLIC_CORS_ORIGIN`,
  default `*` — the feed is fully public, no credentials) + an `OPTIONS` preflight, since the
  landing page consuming it lives in a separate repo (cross-origin).
- **No in-process rate-limit.** Front `/v1/` with a CDN/reverse-proxy at deploy for rate-limiting +
  caching (the published feed is highly cacheable). See `docs/KNOWN_ISSUES.md`.

## Registrable domains + multi-country (Step 6)

"The same website" — the discriminator for the split-by-source dedupe key, the reliability join,
and the Lane-B same-site boundary — is a URL's **registrable domain** (eTLD+1). It is resolved by a
real **Public Suffix List**, not a `lastTwoLabels` approximation (which is wrong for multi-label
suffixes like `bbc.co.uk`). The PSL sits behind a pure domain TYPE `SuffixOracle`
(`domain/discovery/suffix-oracle.ts`, zero imports); the only vendor (`tldts`, pinned exactly) lives
in `adapters/suffix/tldts-suffix-oracle.ts`, injected from the one composition root — so the domain
layer stays vendor-free and the resolver is swappable in one file.

The registrable domain is **pinned at write time**, never recomputed in a hot path: extract pins
`deal.source_registrable_domain` (from the fetched URL), and source-create / seed-import pin
`source.registrable_domain` (from `source.url`). The trust-critical SYNC rules — `dedupeKey` and the
`Array.sort` ranking comparator — read those frozen fields, so the PSL is never called inside a
comparator (it can't regress to async) and the dedupe key is stable. `.de` (a single-label suffix)
resolves byte-identically to the old rule, so the swap caused no dedupe churn (golden-gated by
`test/golden/suffix-equivalence.golden.test.ts`); existing rows are nullable and self-heal on
re-crawl (migration 0012 is additive, no backfill).

In-scope countries + their currencies live in one **market registry**
(`domain/markets/markets.ts`, DE→{EUR} in v1). The `Country`/`Currency` schema enums are DERIVED
from it but stay CLOSED allow-lists (an out-of-scope country is rejected at the boundary), and the
currency-sanity trust rule reads it (`isCurrencyAllowedForCountry`; a wrong currency → must-review).

## How to add things (no editing of existing logic)

- **A new source** → add a row to the `sources` registry (via `seed-import` or the
  `add-source` skill): `url`, `type`, `tier`, `cadence_days`. No code change. If it needs a
  different fetch strategy, that's a new `Fetcher` adapter behind the port.
- **A new country (market)** → add one row to `MARKETS` (`domain/markets/markets.ts`): the country
  code → its allowed currencies. The `Country`/`Currency` enums, the currency trust rule, and the
  public-API country filter all widen automatically. Then add that country's seed sources, catalog
  vocab, deny-list, and Tier-4 intent queries (data). No pipeline-logic edit. See `docs/KNOWN_ISSUES.md`.
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

## Cost & run metrics (Pre-C-3)

Every lane logs a `crawl_runs` row — Lane A inline, the bounded Lane-B lanes
(`discover`/`ingest`) via the shared `RunRecorder` (start→finish/fail; a ledger-write
failure is logged but never crashes the lane it measures; dry-run writes nothing). A
Lane-B run has no `sources` row, so `crawl_runs.source_id` is nullable and such runs
fold under a shared `SOURCELESS_RUN_BUCKET` sentinel in the per-source cost breakdown
(the in-memory and Postgres adapters bucket/round identically — LSP). `run_kind`,
`proposals_produced`, and `stopped_reason` make each run queryable. `MetricsUseCase`
surfaces `costSummary` (total / per UTC day / per source) and `recentRuns`; the `stats`
CLI renders both (`--runs`). Beyond the per-run `AgentBudget` cap, a `DailyBudgetGuard`
(pure rules in `domain/metrics/daily-budget`) enforces an aggregate €/UTC-day ceiling
(`DAILY_BUDGET_EUR`, 0 = off) across a discovery batch: it reads spend-so-far-today
from the run ledger and stops before a run would push past the ceiling, clamping the
per-run cap to the remaining headroom so one run can't overshoot either.

## Alerting (Step 5 — observability)

The two silent failure signals — a source's reliability falling below the flag threshold,
and the daily €-budget guard reaching its ceiling — emit a proactive alert in addition to
the `logger.warn`. An `Alerting` port (`application/ports/alerting.ts`) consumes a pure,
vendor-neutral `AlertEvent` (`domain/alerting/`); adapters map it to a wire format. The
DEFAULT is `NoopAlerter` (dark — logs at debug, delivers nowhere); `WebhookAlerter` POSTs JSON
to `ALERT_WEBHOOK_URL` (a Slack incoming webhook renders the top-level `text`; a generic
collector gets the structured event). The contract is **best-effort**: `alert()` resolves even
on delivery failure (timeout/non-2xx/network error are caught + logged), so alerting can never
crash or stall the lane it observes — the warn points `await` it with no try/catch. Config-
selected (`ALERT_KIND`), built at the one composition root, injected into the crawl/monitor
use-cases + the budget guard. No schema/trust impact (OCP — a new backend is a new adapter).
Native Datadog/CloudWatch metrics-push adapters are deferred (recipe: `docs/DealRoute_Observability.md`).

## Scheduling / unattended running (Step 4 — external cron)

The pipeline is a **CLI, not a self-running daemon**. The `Queue` (pg-boss) port exists but is
**intentionally unwired** from the composition root; v1 runs each lane as a scheduled invocation
of the published container image (the entrypoint applies idempotent migrations, then runs the
given CLI command). `deploy/` holds the templates: `deploy/k8s/cronjobs.yaml` (one CronJob per
lane — `crawl --due` / `monitor --due` / `ingest --community-due` / `discover --broad`, with
Tier-4 discover `suspend: true` by default) and a guarded opt-in `.github/workflows/scheduled.yml`;
`deploy/README.md` documents the cadence, env/secrets, and trust posture. Scheduling changes
**no** invariant: nothing auto-publishes, every lane is bounded, defaults keep the agentic lanes
dark, and `concurrencyPolicy: Forbid` keeps a lane from overlapping itself (a source-level
advisory lock + a bounded pg-boss pool are the prerequisites recorded in `docs/KNOWN_ISSUES.md`
for the day pg-boss is wired). Under any scheduler `EVIDENCE_STORE=s3` is required (a CronJob
pod's filesystem is ephemeral; `local` would discard evidence).

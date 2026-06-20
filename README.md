# DealRoute — Data Pipeline

Crawl / LLM-extraction / evidence-capture / monitoring service for **DealRoute** (a verified
search engine for subscription bundles, Germany v1). It turns web sources into evidence-backed
**candidate deal records** that a human approves before publish. **LLM proposes, humans
approve — nothing auto-publishes in v1.**

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the design, and `docs/` for the pipeline plan and
seed list.

## Requirements

- **Node 20.6+** (uses the built-in `.env` loader)
- For full persistence: **PostgreSQL 14+** (local via Docker is fine)
- An **LLM API key** (Anthropic or OpenAI) for real extraction — or use the offline `stub`
  provider for demos/CI

## Setup

```bash
npm install
npx playwright install chromium     # for the default Playwright fetcher
cp .env.example .env                 # then fill in keys (see below)
```

## Configuration (`.env`)

All config + secrets come from the environment; nothing is hard-coded. Key vars (full list in
[`.env.example`](.env.example)):

| Var | Purpose |
|---|---|
| `LLM_PROVIDER` | `anthropic` \| `openai` \| `stub` |
| `LLM_EXTRACTION_MODEL` / `LLM_DISCOVERY_MODEL` | cheap extractor + stronger discovery model |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | whichever provider you chose |
| `FETCHER` | `playwright` (default) \| `browser` (local Playwright JS-render for JS-heavy SPAs, C-2) \| `firecrawl` \| `hosted-browser` (C-2 hosted-vendor scaffold) |
| `BROWSER_API_KEY` | hosted-browser vendor key (only when `FETCHER=hosted-browser`) |
| `AGENT` | Tier-4 broad-discovery agent: `noop` (default off-switch) \| `search` |
| `SEARCH_PROVIDER` | `stub` (default off-switch) \| `api` (Brave) \| `firecrawl`; defaults to `api` when `SEARCH_API_KEY` is set |
| `SEARCH_API_KEY` | Brave Search API key (only when `SEARCH_PROVIDER=api`) |
| `DISCOVERY_DENY_DOMAINS` | extra deny-list domains for broad discovery (comma/space-separated) on top of the defaults |
| `DAILY_BUDGET_EUR` | aggregate €/UTC-day ceiling across all agentic runs (default 10.00; 0 disables) |
| `EVIDENCE_STORE` | `local` (default) \| `s3` |
| `S3_CDN_BASE_URL` | public CDN/base URL for evidence (only `s3`); the public API turns it into `$S3_CDN_BASE_URL/<evidence_id>/screenshot.png`. Unset ⇒ no public evidence URL exposed. **Expose ONLY `*/screenshot.png` publicly** — `page.html`/`terms.txt` live under the same `<id>/` prefix and must stay private (see ARCHITECTURE.md) |
| `DATABASE_URL` | Postgres connection string (persisted runs only; dry-run/tests need none) |
| `DEFAULT_RECRAWL_DAYS` | re-crawl cadence (default 3) |
| `REVIEW_API_TOKEN` | optional bearer token gating approve/reject on `/api/`; unset ⇒ open (bind to a trusted network) |
| `PUBLIC_CORS_ORIGIN` | `Access-Control-Allow-Origin` for the public `/v1/` read API (default `*`; set to the landing-page origin to tighten) |

## What you must supply

1. **An LLM key** (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`) — or run with `LLM_PROVIDER=stub`.
2. **A Postgres database** for persisted runs (`DATABASE_URL`), and `npm run db:migrate`.
   Dry-run and tests need neither — they use the in-memory adapters.
3. **`npx playwright install chromium`** for the default fetcher.

## Quick start (no API key, no database)

The offline path runs the full extraction pipeline against a saved page using the `stub`
provider:

```bash
LLM_PROVIDER=stub \
STUB_LLM_RESPONSE_FILE=test/fixtures/golden/telekom-magenta-disney/llm-response.json \
npm run cli -- dry-run-extract test/fixtures/golden/telekom-magenta-disney/page.html
```

You'll see the candidate deal record with fields, vocab-mapped conditions, grounding,
confidence, and the must-review decision — **with no writes**.

## Run it for real (2–3 seed sources)

```bash
# 1. start Postgres (example)
docker run -d --name dealroute-pg -e POSTGRES_USER=dealroute \
  -e POSTGRES_PASSWORD=dealroute -e POSTGRES_DB=dealroute -p 5432:5432 postgres:16

# 2. apply migrations and import seeds
npm run db:migrate
npm run cli -- seed-import                 # 25 catalog services + tiered sources

# 3. dry-run a real seed URL (needs an LLM key in .env)
npm run cli -- dry-run-extract https://www.telekom.de/magenta-tv

# 4. crawl due sources → candidates land in the queue
npm run cli -- crawl --due

# 5. review: list, then approve/reject (the durable admin contract)
npm run cli -- review list
npm run cli -- review approve <deal-id> your-name
npm run cli -- serve                       # web review page + JSON API on :3000

# 6. cost stats: aggregate logged crawl-run cost (total + per UTC day + per source)
npm run cli -- stats [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--runs]
```

## CLI

```
dry-run-extract <url|file>   Fetch + extract one source, print candidates, NO writes
seed-import [path]           Import sources from the seed-list markdown
crawl --source <id> | --subscription <name> | --due [--dry-run]
monitor --source <id> | --due           Re-verify: diff → re-queue; blocked → manual capture;
                                        gone → auto-expire (after N consecutive failures)
review list | approve <id> <who> | reject <id> <who> | proposals | manual
review sources | approve-source <id> <who> | reject-source <id> <who> [reason]
                             Promote/reject proposed (pending) sources — the source-promotion loop
stats [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--runs]
                             Aggregate logged crawl-run cost (total + per UTC day + per source);
                             every lane (crawl/discover/ingest) logs a run, so the agentic lane is
                             covered too. Half-open window: since inclusive, until exclusive.
                             --runs also lists recent runs (kind/candidates/proposals/cost/stop-reason).
serve                        Review API + thin test page
discover <url> [--max-pages N] [--dry-run]
                             Lane B: bounded same-site discovery → candidates + proposed
                             novel domains (capped by pages/€/time; nothing auto-publishes)
discover --broad [query] [--max-steps N] [--max-queries N] [--dry-run]
                             Tier 4 (Phase C, C-1): agentic broad discovery — search → fetch
                             public results → extract → propose novel domains. Catalog-driven
                             or one explicit query. Needs AGENT=search + a search backend
                             (SEARCH_API_KEY for Brave, or SEARCH_PROVIDER=firecrawl); default
                             AGENT=noop runs nothing. Capped by steps/queries/€/time + the
                             daily budget; nothing auto-publishes / auto-crawls.
ingest --source <id> | --community-due [--max-items N] [--dry-run]
                             Lane B (Tier 3): community RSS feed → triage → extract relevant
                             leads → candidates + proposed merchant sources
```

## Review API (durable contract for the future admin panel)

```
GET  /api/candidates                    list candidates + evidence
POST /api/candidates/:id/approve        { approver }          → publish
POST /api/candidates/:id/reject         { approver, reason? } → archive
GET  /api/candidates/:id/reviews        decision audit history (who/what/when/why)
GET  /api/field-proposals               recurring unknown conditions
GET  /api/manual-capture-tasks          login-gated / blocked offers
GET  /api/sources/pending               proposed sources awaiting approval
POST /api/sources/:id/approve           { approver }          → active (crawlable)
POST /api/sources/:id/reject            { approver, reason? } → rejected
GET  /api/sources/:id/reviews           source-promotion audit history
GET  /api/health
```

State-changing POSTs require `Authorization: Bearer $REVIEW_API_TOKEN` when that var is set
(unset ⇒ open; bind to a trusted network). Unknown deal → `404`; an already-decided deal →
`409`; missing approver / malformed JSON → `400`; oversized body → `413`. Internal errors return
a generic `500` (no internal detail leaked). Read endpoints are never gated.

## Public read API (`/v1/*` — unauthenticated, read-only)

`serve` also exposes a public, **read-only** feed over `published` deals on the same port. It never
writes, never changes status, and never exposes a non-published deal or any internal field.

```
GET  /v1/deals?service=&country=&route_type=&price_max=&sort=&limit=&offset=
                                        published deals; { deals, total, limit, offset }
                                        sort = cost_asc (default) | verified_desc
GET  /v1/deals/:id                      one published deal (404 if missing OR not published)
GET  /v1/health
```

Each deal is a **curated projection**: typed core (service/provider/headline/price/true_cost_monthly/
country/route_type/eligibility/validity/included_items/source_url/verified_at) + condition
`{ key, label, value }` (the verbatim `source_quote` is dropped) + a coarse freshness `trust` badge
(`recent`/`verified`/`stale`, from `verified_at` — never a raw confidence/reliability score) +
`evidence_screenshot_url` (`$S3_CDN_BASE_URL/<evidence_id>/screenshot.png`, or `null` when no CDN
base is set). Internal/audit fields never appear (a contract test proves it). Query params are
zod-validated (malformed → `400`); page size is hard-capped. CORS is set on every `/v1/` response
(`PUBLIC_CORS_ORIGIN`, default `*`) with an `OPTIONS` preflight. Put a CDN/proxy in front in
production for rate-limiting + caching.

## Commands

```bash
npm test            # unit + contract + golden + HTTP integration tests
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm run check       # lint + typecheck + test (CI gate)
npm run build       # compile to dist/
npm run db:generate # regenerate SQL migrations from the schema
npm run db:migrate  # apply migrations
```

## Deployment

Deployment-agnostic (no Vercel assumption). Build the image and run it as **scheduled jobs**
(the 3-day cadence + monitoring) plus an **on-demand trigger** (the CLI or `serve`). See
[`Dockerfile`](Dockerfile). Bring your own Postgres, evidence store (local volume or S3/R2),
and LLM key.

The container entrypoint ([`docker-entrypoint.sh`](docker-entrypoint.sh)) applies pending
DB migrations on start (idempotent — drizzle tracks them), then runs the CLI with the passed
command, so a fresh deploy never hits missing tables. Set `RUN_MIGRATIONS=false` when a separate
migration job owns the schema. The Postgres adapter tunes its connection pool and per-statement
timeout and retries transient errors with backoff (all configurable — see `.env.example`
`DB_POOL_*` / `DB_STATEMENT_TIMEOUT_MS` / `DB_RETRIES`) so an unattended run can't exhaust the DB
or wedge on a single query.

## Tests

Three tiers (see `.github/workflows/` for how CI runs them):

- **`npm test`** — fast, hermetic **unit/component** tests (no network, no DB): pure-rule unit
  tests, adapter **contract** suites (EvidenceStore, Database), **golden-file** extraction
  (saved HTML → expected record, asserting grounding + no hallucination), the deterministic
  offline **dry-run**, and the review **HTTP** integration. Runs on every PR.
- **`npm run test:integration`** — **hermetic integration** tests: the real composition root +
  **real Postgres**, with deterministic doubles for the network/LLM/feeds. Exercises Phase A
  (crawl → evidence → candidate → approve → monitor) and Phase B (feed → triage → ingest)
  end-to-end through real wiring. Needs `DATABASE_URL_TEST` (CI provides a Postgres service
  container); self-skips without it. The Postgres adapter contract also runs here.
- **`npm run test:live`** — **live smoke** tests that hit real sites (Playwright) + the real LLM
  (Anthropic) to catch "the live world changed" (site markup / feed / model drift). Run on a
  nightly schedule and on a `live-test` PR label — **never** the normal PR gate. Self-skip
  unless `RUN_LIVE_TESTS=1` and a provider key is set.

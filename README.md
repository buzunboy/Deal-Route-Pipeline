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
| `FETCHER` | `playwright` (default) \| `firecrawl` |
| `EVIDENCE_STORE` | `local` (default) \| `s3` |
| `DATABASE_URL` | Postgres connection string (persisted runs only; dry-run/tests need none) |
| `DEFAULT_RECRAWL_DAYS` | re-crawl cadence (default 3) |
| `REVIEW_API_TOKEN` | optional bearer token gating approve/reject; unset ⇒ open (bind to a trusted network) |

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
serve                        Review API + thin test page
discover <url> [--max-pages N] [--dry-run]
                             Lane B: bounded same-site discovery → candidates + proposed
                             novel domains (capped by pages/€/time; nothing auto-publishes)
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

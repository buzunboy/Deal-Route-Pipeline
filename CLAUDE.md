# DealRoute — Data Pipeline Service

The crawl / LLM-extraction / verification / monitoring service for **DealRoute** (a verified search engine for subscription bundles, Germany v1). It turns web sources into evidence-backed **deal records** that a human approves before publish. Standalone repo — the landing page and the production admin panel live in separate repos.

> Full design: `docs/DealRoute_Crawl_Pipeline_Plan.md` · Seed sources: `docs/DealRoute_Seed_List_DE.md` (read on demand).
> Phase C plan + roadmap + remaining audit gaps + recommended build sequence: `docs/DealRoute_Phase_C_and_Roadmap.md` (read before Phase C / unattended-run work).
> Phase C **build plan (C-1, search-API-first)** — standalone fresh-session prompt: `docs/DealRoute_Phase_C_Plan.md` (resolved decisions + slice-by-slice build order + guardrail checklist).
> Next-steps brief for a fresh session (Pre-C-2 → Pre-C-3 → Phase C, with the env/workflow gotchas): `docs/NEXT_SESSION_HANDOFF.md`.
> Detailed standards auto-load from `.claude/rules/` — `architecture.md`, `code-style.md`, `extraction-and-schema.md`, `testing.md`.

## Non-negotiable invariants (always)
- **LLM proposes, humans approve.** Extraction produces *candidates* with a confidence score + grounding snippets. **Nothing auto-publishes** in v1.
- **Evidence required.** Every candidate stores screenshot + HTML + terms text + source URL + timestamp before review.
- **Public pages only (v1).** Never automate logins; route login-gated/blocked offers to the manual-capture queue.
- **Extensible schema, never invented columns.** Typed core + `conditions[]` / `attributes` / `raw_conditions_text`; unknown conditions become `field_proposals` (see `.claude/rules/extraction-and-schema.md`).
- **Never trust raw LLM or scraped data.** Validate at the boundary into typed domain objects.

## Architecture (see `.claude/rules/architecture.md`)
Clean, layered: **domain** → **application** (use-cases) → **adapters/infrastructure**. Dependencies point inward; the domain imports no vendor SDK. Program to **ports**; inject concrete adapters from **one composition root**; every Fetcher / BrowserAgent / LLM / EvidenceStore / DB / Queue is swappable via config. Models are configurable via env (cheap extractor + stronger discovery model) — no hard-coded vendor clients in business logic.

## Commands
Stack: **TypeScript (Node 20+, strict)** · zod · Playwright/Firecrawl · Anthropic/OpenAI/stub · Postgres+drizzle · pg-boss · Vitest.
- Install: `npm install && npx playwright install chromium`
- Build: `npm run build`
- Test: `npm test` (fast hermetic unit/contract/golden/HTTP). Integration (real Postgres): `npm run test:integration` (needs `DATABASE_URL_TEST`). Live smoke (real sites+LLM, scheduled): `npm run test:live` (needs `RUN_LIVE_TESTS=1` + key)
- Lint + typecheck: `npm run lint && npm run typecheck` (or `npm run check` for both + tests)
- Dry-run extract a URL: `npm run cli -- dry-run-extract <url|file>` (no writes; `LLM_PROVIDER=stub` for offline)
- Run a crawl: `npm run cli -- crawl --source <id> | --subscription <name> | --due [--dry-run]`
- Discover a site (Lane B): `npm run cli -- discover <url> [--max-pages N] [--dry-run]` (bounded same-site crawl → candidates + proposed novel domains)
- Ingest a community feed (Lane B / Tier 3): `npm run cli -- ingest --source <id> | --community-due [--max-items N] [--dry-run]` (RSS → triage → extract relevant leads)
- Monitor / Review / Serve: `npm run cli -- monitor --due` · `review list|approve|reject|proposals|manual|sources|approve-source|reject-source` · `serve`
- Cost stats: `npm run cli -- stats [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--runs]` (aggregate logged `crawl_runs.cost_eur` — total + per UTC day + per source; half-open window: since inclusive, until exclusive; `--runs` also lists recent runs: kind/candidates/proposals/cost/stop-reason). All lanes (crawl + discover + ingest) log a `crawl_runs` row, so cost/metrics cover the agentic lane. A daily €-budget guard caps total agentic spend per UTC day via `DAILY_BUDGET_EUR` (default 10.00; 0 disables).
- Seed import: `npm run cli -- seed-import` · DB: `npm run db:migrate`

## Repo layout
- `src/domain/` — deal-record schema (zod) + pure rules: `rules/{true-cost,dedupe-key,vocab-mapping,validate-record,confidence}`, entities (source, evidence, crawl [CrawlRun: nullable source_id + `run_kind` crawl|discover|ingest + proposals_produced + stopped_reason], proposals, monitoring, review/{review-record,source-review-record}, catalog/subscription, metrics/{cost-summary [CostSummary schema + `roundEur` half-up-to-cents + `SOURCELESS_RUN_BUCKET` sentinel], daily-budget [pure €/UTC-day guard rules]}), `discovery/{links,community-keywords,triage-result}` (pure link/keyword rules + frontier scoring + triage boundary), typed errors, `parse-llm-output` (LLM boundary)
- `src/application/` — use-cases (`extract`, `crawl/crawl-source`, `crawl/candidate-sink` (shared persist), `crawl/run-recorder` (shared crawl_runs start/finish/fail for the bounded lanes), `review`, `review/source-review` (source-promotion loop), `monitor/monitor-source` (re-verify; reliability/back-off via the shared `crawl/source-policy.applyCrawlOutcome` — same policy as Lane A), `metrics/metrics` (cost aggregation + recent-runs over `crawl_runs`), `metrics/daily-budget-guard` (aggregate €/UTC-day ceiling across a batch), `discover/discover-site` (Lane B; writes a run, mid-loop cost guard, bounded frontier), `discover/lane-b-support` (shared Lane-B edge logic), `ingest/ingest-community` (Lane B Tier 3; writes a run) + `ingest/triage-prompt`, `discover/noop-browser-agent`) + `ports/` (Fetcher, FeedReader, Llm, EvidenceStore, repositories+Database [`CrawlRunRepository` costSummary/spentSince/recentRuns], Queue, Clock, BrowserAgent, Logger)
- `src/adapters/` — `fetcher/` (playwright, firecrawl, page-classifier) · `feed/` (rss-feed-reader) · `llm/` (anthropic, openai, stub, pricing, json-recovery) · `evidence-store/` (local-fs; atomic temp-then-rename write + structural-completeness verify on read) · `db/` (in-memory, postgres+drizzle [tuned pool + statement_timeout + `pool.on('error')`], `postgres/db-resilience` [transient-error classification + bounded retry], migrate) · `queue/` (in-memory, pg-boss) · `http/` (review-api, test-page) · `cli/` · `seeds/` · `logger/` · `shared/retry`
- `src/composition/container.ts` — the single composition root · `src/config/` — env→typed config (zod) · `docker-entrypoint.sh` — applies migrations on container start, then runs the CLI
- `test/` — `contracts/` (port suites), `fixtures/golden/`, `golden/`, `fakes/`, `factories/`, `integration/` (real Container+Postgres, hermetic), `live/` (real sites+LLM, scheduled) · `drizzle/` — generated migrations · CI: `.github/workflows/{ci,live}.yml`
- `docs/` — design + seed list · `ARCHITECTURE.md` — layers + how to add a source/model/condition

## Working habits
- Small, reviewable commits; tests for all pure logic before wiring I/O.
- **Every new/changed feature gets unit AND integration tests** (and a live smoke test for new external edges). The three tiers + exactly what each feature must add are in `.claude/rules/testing.md` — follow it.
- After scaffolding, **update Commands + Repo layout above**.
- **Ask before** changing the deal-record schema, the verification rules, or anything affecting trust.
- Build **Phase A** (deterministic core) first and keep it working; B/C slot in.
- Helpers: skills in `.claude/skills/` (`add-source`, `dry-run-extract`, `promote-field-proposal`); review agents in `.claude/agents/` (`code-reviewer`, `extraction-evaluator`).

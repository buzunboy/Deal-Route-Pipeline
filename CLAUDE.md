# DealRoute — Data Pipeline Service

The crawl / LLM-extraction / verification / monitoring service for **DealRoute** (a verified search engine for subscription bundles, Germany v1). It turns web sources into evidence-backed **deal records** that a human approves before publish. Standalone repo — the landing page and the production admin panel live in separate repos.

> Full design: `docs/DealRoute_Crawl_Pipeline_Plan.md` · Seed sources: `docs/DealRoute_Seed_List_DE.md` (read on demand).
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
- Test: `npm test` (unit + contract + golden + HTTP integration)
- Lint + typecheck: `npm run lint && npm run typecheck` (or `npm run check` for both + tests)
- Dry-run extract a URL: `npm run cli -- dry-run-extract <url|file>` (no writes; `LLM_PROVIDER=stub` for offline)
- Run a crawl: `npm run cli -- crawl --source <id> | --subscription <name> | --due [--dry-run]`
- Monitor / Review / Serve: `npm run cli -- monitor --due` · `review list|approve|reject|proposals|manual` · `serve`
- Seed import: `npm run cli -- seed-import` · DB: `npm run db:migrate`

## Repo layout
- `src/domain/` — deal-record schema (zod) + pure rules: `rules/{true-cost,dedupe-key,vocab-mapping,validate-record,confidence}`, entities (source, evidence, crawl, proposals, monitoring), typed errors, `parse-llm-output` (LLM boundary)
- `src/application/` — use-cases (`extract`, `crawl/crawl-source`, `review`, `monitor/monitor-source`, `discover/noop-browser-agent`) + `ports/` (Fetcher, Llm, EvidenceStore, repositories+Database, Queue, Clock, BrowserAgent, Logger)
- `src/adapters/` — `fetcher/` (playwright, firecrawl, page-classifier) · `llm/` (anthropic, openai, stub, pricing) · `evidence-store/` (local-fs) · `db/` (in-memory, postgres+drizzle, migrate) · `queue/` (in-memory, pg-boss) · `http/` (review-api, test-page) · `cli/` · `seeds/` · `logger/` · `shared/retry`
- `src/composition/container.ts` — the single composition root · `src/config/` — env→typed config (zod)
- `test/` — `contracts/` (port suites), `fixtures/golden/`, `golden/`, `fakes/`, `factories/` · `drizzle/` — generated migrations
- `docs/` — design + seed list · `ARCHITECTURE.md` — layers + how to add a source/model/condition

## Working habits
- Small, reviewable commits; tests for all pure logic before wiring I/O.
- After scaffolding, **update Commands + Repo layout above**.
- **Ask before** changing the deal-record schema, the verification rules, or anything affecting trust.
- Build **Phase A** (deterministic core) first and keep it working; B/C slot in.
- Helpers: skills in `.claude/skills/` (`add-source`, `dry-run-extract`, `promote-field-proposal`); review agents in `.claude/agents/` (`code-reviewer`, `extraction-evaluator`).

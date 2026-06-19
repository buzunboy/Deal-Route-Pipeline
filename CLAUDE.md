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
<!-- Fill these in once the stack is scaffolded, and keep them current. -->
- Install: `TODO`
- Build: `TODO`
- Test: `TODO`
- Lint + typecheck: `TODO`
- Dry-run extract a URL: `TODO`
- Run a crawl (by source / subscription): `TODO`

## Repo layout
<!-- Update after scaffolding. Indicative: -->
- `src/domain/` — entities, value objects, pure rules (true-cost, dedupe, vocab mapping, validation)
- `src/application/` — use-cases (crawl, extract, validate, dedupe, capture-evidence, monitor, review) + ports
- `src/adapters/` — fetcher, browser-agent, llm, db, evidence-store, queue, http/cli
- `src/composition/` — wiring / composition root
- `docs/` — design + seed list · `ARCHITECTURE.md` — layers + how to add a source/model/condition

## Working habits
- Small, reviewable commits; tests for all pure logic before wiring I/O.
- After scaffolding, **update Commands + Repo layout above**.
- **Ask before** changing the deal-record schema, the verification rules, or anything affecting trust.
- Build **Phase A** (deterministic core) first and keep it working; B/C slot in.
- Helpers: skills in `.claude/skills/` (`add-source`, `dry-run-extract`, `promote-field-proposal`); review agents in `.claude/agents/` (`code-reviewer`, `extraction-evaluator`).

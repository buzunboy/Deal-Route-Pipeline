# Testing (always applies)

## The three test tiers (every feature is covered by the relevant ones)

The suite is split into three tiers, each with its own runner and CI home. **When you add or change a feature, cover it at the tiers that apply — at minimum unit + integration.** Don't ship a use-case or adapter with only one tier.

1. **Unit / component — `npm test`** (fast, hermetic; runs on every PR). Pure domain rules and use-cases wired to **fakes** (`test/fakes/`). No network, no DB, no real LLM. This is the default suite and must stay fast and deterministic.
2. **Integration — `npm run test:integration`** (`vitest.integration.config.ts`; runs on every PR via a Postgres service container). Exercises the **real composition root (`Container`) + real Postgres**, with deterministic doubles only at the genuinely-external edges (network fetch, LLM, RSS feed) injected via `ContainerOptions.overrides`. Self-skips when `DATABASE_URL_TEST` is unset (local-without-Docker stays green). The Postgres adapter contract runs in this tier.
3. **Live smoke — `npm run test:live`** (`vitest.live.config.ts`; **scheduled / `live-test` label only — never the PR gate**). Hits real sites (Playwright) + the real LLM (Anthropic) to catch "the live world changed" (site markup / feed / model drift). Self-skips unless `RUN_LIVE_TESTS=1` + a provider key. Failures notify; they do **not** gate merges.

> **Manual live-test results** (an interactive real-sites+real-LLM run requested by a human, distinct from the automated live tier above) are recorded with the canonical template **`docs/testing/LIVE_TEST_TEMPLATE.md`** — copy to `docs/testing/results/LIVE_TEST_<date>.md`, fill every section (all tiers, per-deal score-reasoning + evidence, the trust-invariant checklist). **Extend that template whenever a new feature adds a recordable field**, and add a changelog entry there. Render it as an HTML artifact when a visual is wanted; the Markdown copy stays the source of truth. See `CLAUDE.md` → Working habits → "Live testing".

## What every new feature must add

- **A use-case (new or changed)** → unit tests against fakes (happy path + the trust-critical failure paths) **and** an integration test that drives it through the real `Container` + Postgres end-to-end (persisted rows, status transitions, audit/evidence side-effects actually written). Covers the wiring a fake can't.
- **A new adapter** → a shared **port contract suite** that both it and the in-memory/fake implementation pass (substitutability/LSP), plus its own unit tests. If it talks to Postgres, it runs in the integration tier.
- **A new external edge worth smoke-testing** (a site we extract from, a feed format we parse, the LLM prompt/shape) → a **live** test asserting the contract still holds against the real world, behind the `RUN_LIVE_TESTS` gate.
- **A boundary that parses external/LLM/scraped data** → adversarial unit tests: malformed JSON, missing/wrong-typed fields, prose-wrapped output, injection. Never trust raw data; prove the parser rejects it.
- **A new DB table/column** → a drizzle migration **and** integration coverage of the round-trip (write → read-back through the repo + schema parse).

## Specific kinds (always)

- **Pure logic = unit tested.** Extraction mapping, validation, dedupe key, true-cost, vocabulary mapping, confidence, triage, link/keyword rules — table-driven tests.
- **Adapter contract tests.** Each adapter must pass a shared contract suite for its port, so any implementation is substitutable.
- **Golden-file extraction tests.** Saved HTML fixtures → expected deal records; assert fields, grounding presence, and **no hallucinated values**. Add a fixture whenever a real page breaks extraction.
- **Deterministic dry-run.** A no-write path that fetches + extracts + prints the candidate record; used in tests and by the `dry-run-extract` skill.

## Discipline

- **Coverage philosophy:** cover the domain and the trust-critical paths, not a vanity %. The worst-case bug is one that lets a *wrong* deal publish — test explicitly against it.
- **Determinism:** unit + integration tests must be deterministic (no real network/clock/LLM — inject doubles via fakes or `Container.overrides`; use the `FixedClock`). Anything non-deterministic belongs in the live tier behind its gate.
- **Run `code-reviewer` before merging**; it checks for missing trust-path coverage.
- **CI:** lint + type-check + format + unit + integration must pass before merge. Live runs on a schedule.

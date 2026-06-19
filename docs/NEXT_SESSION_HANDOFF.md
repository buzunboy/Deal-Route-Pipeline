# Next-session handoff — continue the roadmap (Pre-C-2 → Pre-C-3 → Phase C)

_Paste this (or point the session at this file) to continue in a fresh Claude Code chat._
_Master is at the Pre-C-1 commit; this is the next-steps brief. Authoritative plan:
`docs/DealRoute_Phase_C_and_Roadmap.md`._

You're picking up an in-progress, trust-critical crawl/LLM-extraction service (DealRoute — a
verified search engine for subscription bundles, Germany v1). **Phase A (deterministic
Tiers 1–2), Phase B (Tier-3 community ingestion), and Pre-C-1 (the source-promotion loop)
are built, tested, and merged.** Your job is the next roadmap steps.

## First, orient yourself (before writing any code)

1. Read `CLAUDE.md` and the auto-loaded `.claude/rules/` (`architecture.md`, `code-style.md`,
   `extraction-and-schema.md`, `testing.md`). These are **binding**.
2. Read **`docs/DealRoute_Phase_C_and_Roadmap.md`** in full — the master plan (current state §1,
   sequence §2, remaining audit gaps §3, Phase C design §4, post-C §5, open decisions §6). This
   handoff summarizes it but the doc is authoritative.
3. Skim `docs/DealRoute_Crawl_Pipeline_Plan.md` (§7 monitoring, §9 guardrails, §10 scheduling)
   and `docs/DealRoute_Seed_List_DE.md` (§E Tier-4).
4. Current baseline: branch `master` at the Pre-C-1 commit; clean tree; latest migration
   `drizzle/0005_plain_stingray.sql`; ~213 vitest tests pass. Verify with
   `npm run check && npm run build`.

## Hard rules (non-negotiable — from CLAUDE.md / .claude/rules)

- **Nothing auto-publishes.** LLM proposes; a human approves. Evidence required before any
  candidate. Never trust raw LLM/scraped data — validate at the boundary (zod).
- **Clean layered architecture**: domain → application → adapters; dependencies point inward;
  **domain imports no vendor SDK**; **no `new VendorClient()` outside the one composition root**
  (`src/composition/container.ts`). Program to ports; inject adapters.
- **Resilience**: every external call timeout-bounded + retried with backoff + idempotent; one
  failed source never crashes a batch; typed/domain errors, no silent catches.
- **Testing rule (`.claude/rules/testing.md`) — MANDATORY**: every new/changed feature gets
  **unit AND integration tests** (and a live smoke test for a new external edge). Three tiers:
  - `npm test` — fast hermetic unit/component (fakes, no I/O). PR gate.
  - `npm run test:integration` — real `Container` + real Postgres, externals doubled via
    `ContainerOptions.overrides`; self-skips without `DATABASE_URL_TEST` (CI provides a postgres
    service container). Add cases here for anything touching DB/wiring.
  - `npm run test:live` — real sites + real LLM; scheduled / `live-test`-label only; behind
    `RUN_LIVE_TESTS=1`. Never the PR gate.
- **Determinism**: inject doubles (fakes or `Container.overrides` + `FixedClock`); no real
  network/clock/LLM in unit/integration tests.
- After any feature: **run the `code-reviewer` subagent before merging** and address its
  findings. Update `CLAUDE.md` (Commands + Repo layout), `README.md`, `ARCHITECTURE.md`, and the
  roadmap doc to match.
- Commit style: small, conventional messages; **no `Co-Authored-By` trailer** (global user
  preference). Husky pre-commit runs prettier + eslint + typecheck.

## Workflow / environment facts (these bit us before — don't rediscover)

- You're likely in a git **worktree** on your own branch. The runtime `.env` (gitignored, holds
  the real `ANTHROPIC_API_KEY`, `LLM_PROVIDER=anthropic`) lives ONLY in the **main repo root**
  (`<repo>/.env`). To run real LLM/fetch commands from a worktree, copy it in temporarily (it's
  gitignored) and delete after — or run from the main worktree.
- **Run gates from your own worktree.** A shell `cd` that resets to the main repo will silently
  run stale code. Confirm `git rev-parse --abbrev-ref HEAD` before testing.
- Merge to `master` via **fast-forward only**. `master` may be checked out in the main worktree;
  if it has uncommitted WIP, stash → ff → pop (don't clobber). A stale third worktree may exist —
  ignore it.
- **No Docker/Postgres locally** — integration tests self-skip; CI is their first real execution.
  After writing integration tests you can't run, statically verify them (spawn a general-purpose
  agent to trace assertions against the real code) before relying on CI.
- Migrations: edit `src/adapters/db/postgres/schema.ts`, then `npm run db:generate`; commit the
  generated `drizzle/*.sql` + `drizzle/meta/*`. Generated drizzle files and `test/fixtures/` are
  in `.prettierignore` — don't reformat them.
- Stack: TypeScript (Node 20+, strict), zod, drizzle+Postgres, Playwright/Firecrawl/stub,
  Anthropic/OpenAI/stub LLM, vitest.

## What to build, in order

### Step 1 — Pre-C-2: Persistence/ops hardening for unattended running (DO THIS FIRST)

Phase C and the cron deployment run autonomously, so close these resilience/scale gaps. All are
real audit findings (medium). Each needs unit + integration coverage per the testing rule.

1. **Postgres pool + DB-op resilience** (`src/adapters/db/postgres/postgres-db.ts`):
   `PostgresDb.connect` builds `new pg.Pool({ connectionString })` with **no**
   `max`/`idleTimeoutMillis`/`connectionTimeoutMillis`/`statement_timeout` and no
   `pool.on('error', …)`; DB ops have **no retry**. The `withRetry`/backoff helper exists in
   `src/adapters/shared/retry.ts` (used for fetch/LLM, not DB). Add pool tuning + statement
   timeout + an error handler (log, don't crash), and wrap repo ops in retry for transient errors
   (connection reset, serialization failures), keeping writes idempotent (the
   `(dedupe_key, evidence_id)` unique index + `onConflictDoNothing` already make deal inserts
   safe). Make pool params configurable via env/config.
2. **Dockerfile runs migrations** (`Dockerfile`): it never runs `db:migrate`, so a first deploy
   hits missing tables. Add a migrate step (an entrypoint wrapper that migrates then runs the
   CLI, or document a compose `command`). Keep the CLI entrypoint model. Don't bake secrets.
3. **Atomic evidence-bundle write** (`src/adapters/evidence-store/local-fs-evidence-store.ts`):
   the write is non-atomic — a crash/disk-full mid-write leaves a partial bundle `get()` would
   surface. Write to a temp path then `rename` (atomic); verify the content hash/structure on read.
4. **`field_proposals.upsertAndCount` race** (`src/adapters/db/postgres/postgres-db.ts`): it
   reads-then-writes `count` and loses `first_seen_at` under concurrency. Replace with a single
   SQL upsert (`ON CONFLICT … DO UPDATE SET count = field_proposals.count + 1`, preserving
   `first_seen_at`, bumping `last_seen_at`). Keep the in-memory adapter behaviorally identical;
   assert parity via the DB contract suite.
5. **Reliability-driven cadence** (`src/application/crawl/source-policy.ts` already has
   `reliabilityAfter`, `isReliabilityLow`, `RELIABILITY_FLAG_THRESHOLD`): wire reliability into
   scheduling — a low-reliability source should back off (longer `next_due`) and/or get flagged,
   per plan §7 ("reliability score decides cadence and trust"). Currently `next_due` is a flat
   `cadence_days`. Decide the back-off curve; keep it pure + unit-tested in `source-policy.ts`.

Optional (judgment call, fold in if cheap): a source-level advisory lock to avoid duplicate
*work* when concurrent crawls hit the same source (the unique index already prevents duplicate
*rows*; this avoids wasted work once a scheduler exists).

### Step 2 — Pre-C-3: Cost & observability spine

Phase C is the expensive agentic lane; build this before turning it on.

1. **Surface/aggregate per-run cost**: `crawl_runs.cost_eur` is already logged per run. Add a
   query/CLI to aggregate cost (per day / per source / total) — e.g. a `metrics`/`stats` CLI
   command and/or a repo method.
2. **Aggregate €/day (or per-batch) budget guard**: caps today are per-run (`AgentBudget`). Add a
   budget guard across a discovery/crawl batch so a runaway day can't blow cost. Configurable ceiling.
3. **Structured run metrics queryable**: candidates produced, sources proposed, cost, stop-reason
   — per run, queryable. Extend `crawl_runs` or add a small metrics surface. Also fold in the
   cheap Lane-B polish gaps: `discover` cost cap is checked only at loop top (overshoots by one
   extraction — mirror the `ingest` mid-loop guard); `discover` frontier grows with total
   in-domain links not `maxPages` — bound it.

### Step 3 — Phase C: agentic broad discovery (Tier 4)

Only after Pre-C-1/2/3. Full design in roadmap §4. Summary:

- Implement the existing **`BrowserAgent` port** (`src/application/ports/browser-agent.ts`;
  `NoopBrowserAgent` is the current default/off-switch) with a real adapter. **Staging (decision
  pending — see below): C-1 = search-API-first** (search → fetch top results via the existing
  polite `Fetcher` → extract → propose; cheap, no heavy vendor); **C-2 = a real browser agent**
  (Browser Use / Stagehand + hosted browser) behind the same port for JS-heavy pages.
- A `DiscoverBroadUseCase` (application): build queries from `subscription_catalog` × intent
  terms ("[service] im Bundle / inklusive / gratis / Aktion / perk", "[provider] Vorteil/Partner")
  → bounded agent run → candidates via the **existing `ExtractUseCase` + `CandidateSink`** →
  novel domains via the **existing `LaneBSupport.persistProposedSources`** (which now feeds the
  Pre-C-1 approval loop). CLI `discover --broad [query] …` + a `discover` job for cron.
- **Guardrails (all have homes already)**: bounded by `AgentBudget` (steps/seconds/€) + the
  Pre-C-3 daily guard; novel domains → `pending_approval` only (never auto-crawled); add an
  explicit domain **deny-list**; public-only (route agent fetches through `PoliteFetcher`;
  login/captcha/blocked → manual capture); LLM = extraction/navigation only, nothing
  auto-publishes; cost logged per run; **prompt-injection hardening** (neutralize/frame untrusted
  page text in the prompt — matters most here, since Tier-4 ingests arbitrary open-web content).

### Other remaining audit gaps (roadmap §3 — address opportunistically within the steps above)

- **Fetcher live-edges**: Firecrawl response body + screenshot download unbounded/not size-capped;
  `page.content()` not `withTimeout`-wrapped; robots.txt fetch follows redirects / no size cap /
  ignores 4xx/5xx nuance; no charset guard for non-HTML/non-UTF8.
- **Extraction/LLM**: a truncated LLM reply (hit `max_tokens`) is a silent zero-candidate outcome
  — detect `stop_reason==='max_tokens'` and flag/retry; the JSON inner-quote repair heuristic
  (`src/adapters/llm/json-recovery.ts`) is fragile — consider stricter parsing / repair-retry.
- **CI**: the integration job should run `db:migrate` as an explicit gate; order it relative to
  the unit `check` job.

## Open decisions to confirm with the user BEFORE building (don't guess)

1. **Phase-C agent vendor**: search-API-first (C-1) then Browser Use/Stagehand (C-2), or straight
   to a hosted browser? (Recommendation: C-1 first.)
2. **Scheduler model**: stay on external cron (current decision — the `Queue` pg-boss port exists
   but is intentionally unwired) or build an in-process pg-boss worker now? Only matters once
   autonomy/concurrency grows.
3. **Dedupe-key provenance** (trust-relevant): the dedupe key is
   `service + provider + route_type + country` (omits source/origin). Two sources reporting the
   same route can churn duplicate `in_review` candidates. Collapse to one canonical deal, or split
   by source? **Ask before changing — affects the trust model and the schema.**
4. **Numbers**: the Pre-C-2 reliability back-off curve, and the Pre-C-3 daily €/budget ceiling.

## How to proceed

- Confirm the orientation reads + run `npm run check && npm run build` to verify the baseline.
- Ask the open-decision questions above that block the step you're starting (use `AskUserQuestion`).
- Do **Pre-C-2 first** (smallest, trust/ops-critical, unblocks safe unattended running), then
  Pre-C-3, then Phase C — one coherent, reviewed, merged batch at a time. For substantial steps, an
  `ultracode`/Workflow multi-agent pass (implement → adversarially verify → fix) is appropriate;
  the user has used that pattern throughout. Keep `master` green after each merge, and update the
  roadmap doc as each step lands.

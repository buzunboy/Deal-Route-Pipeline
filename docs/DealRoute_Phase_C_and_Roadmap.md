# DealRoute — Phase C plan & roadmap to the product goal

> **📍 SOURCE OF TRUTH: the product roadmap (LIVING — keep §5 current).** The
> sequencing here is the long-range plan to the "verified search engine for
> subscription bundles" goal. **§5 (post-C steps) is the authoritative step list** —
> update it whenever a step ships. Phase C itself (C-1 + C-2) is DONE; for the
> immediate next-steps brief read `docs/DealRoute_PostP3_Handoff.md`. (The older body
> below — written at the Phase A+B audit — is kept for its sequencing rationale; trust
> §5 + the active handoff for current status, not any inline "master @ …" snapshot.)_

> **The goal (recap).** A trust-first pipeline that turns web sources into
> evidence-backed _candidate_ deal records a human approves before publish.
> Phase A (deterministic Tiers 1–2) and Phase B (Tier-3 community ingestion) are
> built, merged, and audited. Phase C is **Tier-4 agentic broad discovery** + the
> full source-promotion loop.

---

## 1. Where we are (built & working)

- **Lane A — deterministic crawl** (`crawl --source|--subscription|--due`): seed →
  fetch (Playwright/Firecrawl behind `Fetcher`) → evidence → LLM extract →
  validate/dedupe → candidate queue. Golden + unit + integration tested.
- **Lane B(i) — site discovery** (`discover <url>`): bounded same-domain crawl →
  candidates + novel-domain proposals (`pending_approval`).
- **Lane B(ii) — community ingestion** (`ingest --source|--community-due`): RSS
  feed → keyword pre-filter → LLM triage → extract relevant leads → candidates +
  proposed merchant domains.
- **Review** (CLI + HTTP API, the durable admin contract): approve→published /
  reject→rejected, append-only `reviews` audit log, field-proposals + manual-
  capture queues.
- **Source-promotion loop** (Pre-C-1): list/approve/reject proposed
  `pending_approval` sources (CLI + API + test-page tab), approve→`active`,
  reject→`rejected`, append-only `source_reviews` audit log. Closes the
  discovery/ingest proposal loop.
- **Monitoring** (`monitor --source|--due`): diff price/terms via evidence hash →
  re-queue on change; debounced auto-expiry on disappearance; blocked→manual
  capture; cadence advanced each pass.
- **Shared core**: typed/boundary-validated deal-record schema, controlled
  condition vocabulary + field-proposal promotion loop, true-cost + promo-review
  guard, `CandidateSink` (one persist path for all lanes), `LaneBSupport` (shared
  Lane-B edge logic), three-tier tests (unit / integration / live), CI.
- **`BrowserAgent` port + `NoopBrowserAgent`** already scaffold Phase C; `JobNames`
  already lists `Discover`.

**Deployment model (decided):** external cron invokes the CLI (`crawl --due`,
`monitor --due`, `ingest --community-due`). The `Queue` port + pg-boss/in-memory
adapters remain in the tree for a future in-process worker but are **not** wired
into the composition root (removed as a required-dead dependency in `3e8aecb`).

---

## 2. Recommended sequence (the short answer)

Build in this order. **Phase C should NOT be first** — a few prerequisites make
it safe and actually useful, and some are trust-critical regardless of Phase C.

1. **Pre-C-1 — Source-promotion loop. ✅ DONE.** Discovery/ingest propose
   `pending_approval` tier-4 sources, and a human can now promote/reject them:
   `SourceReviewUseCase` + CLI (`review sources` / `review approve-source <id>
   <who>` / `review reject-source <id> <who> [reason]`) + HTTP API
   (`GET /api/sources/pending`, `POST /api/sources/:id/approve|reject`,
   `GET /api/sources/:id/reviews`) + a "Pending sources" tab on the test page.
   Approve → `status='active'`, tier kept, `next_due=null` (crawled on the next
   `crawl --due`). Reject → new `status='rejected'` (never crawled, never
   re-proposed — `LaneBSupport.knownDomains()` includes it). Decisions are written
   to an append-only `source_reviews` audit log (log-before-act). Unit + contract +
   integration tested. (Migration `0005`.)
2. **Pre-C-2 — Persistence/ops hardening for unattended running. ✅ DONE.** Closed
   the resilience/scale gaps for autonomous running: Postgres pool tuning (`max`/
   idle/connection timeouts) + `statement_timeout` + `pool.on('error')` (log, don't
   crash) + bounded transient-error retry on every DB op (`postgres/db-resilience.ts`
   classifies connection/serialization/deadlock SQLSTATEs; non-idempotent inserts
   treat a retry-time unique violation as "already committed"); the container
   entrypoint (`docker-entrypoint.sh`) applies migrations before the app runs;
   evidence bundles are written atomically (sibling staging dir → `rename`) and the
   stored terms text is hash-verified on read; and reliability now drives cadence —
   a flaky source backs off (linear inverse-reliability multiplier, capped 5×) and
   a sub-threshold source logs a warning. Unit + contract + integration tested.
   _(The field-proposal upsert was already a single atomic SQL statement from
   `f995bef`; the dedupe race + SCAN_LIMIT cliff + monitor next_due were fixed in
   the audit pass.)_ **Follow-up (post-audit):** the reliability/back-off policy
   now also drives the MONITOR loop — extracted into a shared `applyCrawlOutcome`
   (`crawl/source-policy.ts`) so crawl + monitor can't diverge: a monitor pass that
   is unreachable/errors lowers reliability + backs off + flags; a `blocked` wall
   stays neutral (manual-capture route, not a failure — §9); a content-changed
   re-crawl owns the schedule (the monitor no longer clobbers its back-off next_due).
   Unit + integration tested. (Originally the monitor used flat cadence and never
   touched reliability — the §7 "repeated failures lower reliability + flag" signal
   was Lane-A-only.)
3. **Pre-C-3 — Cost & observability spine. ✅ DONE.** Phase C is the expensive,
   agentic lane; before turning it on we built: per-run cost surfaced/aggregated
   (`stats`); every lane logging a `crawl_runs` row (the agentic lane was invisible
   before); a daily/€-budget guard across a discovery batch (`DAILY_BUDGET_EUR`,
   default €10/day, distinct from the per-run cap); structured run metrics
   (kind/candidates/proposals/cost/stop-reason) queryable via `stats --runs`.
   - ✅ **Cost-aggregation CLI (part 1) DONE.** `CostSummary` domain type +
     `roundEur` (half-up to cents) + `CrawlRunRepository.costSummary({since,until})`
     (half-open window, UTC day buckets) implemented on BOTH adapters and pinned by
     the shared contract suite (in-memory unit tier + Postgres integration tier);
     `crawl_runs(started_at)` btree index (migration `0006`); `MetricsUseCase` wired
     in the Container; `stats [--since] [--until]` CLI. The in-memory and Postgres
     adapters produce bit-for-bit identical summaries (same rounding, sort, bucketing).
   - ✅ **Structured run-metrics surface (part 2) DONE.** EVERY lane now logs a
     `crawl_runs` row — Lane A inline, the bounded Lane-B lanes (`discover`/`ingest`)
     via a shared `RunRecorder` — closing the gap where the agentic lane's cost was
     invisible to `stats`. `crawl_runs` gained `run_kind` (crawl|discover|ingest),
     `proposals_produced`, `stopped_reason`; `source_id` is now nullable (Lane-B runs
     have no source row) and folds under a shared `SOURCELESS_RUN_BUCKET` sentinel in
     the per-source breakdown (migration `0007`, backfill-safe). `CrawlRunRepository`
     gained `spentSince` + `recentRuns` (both adapters, contract-pinned); `stats
     --runs` lists recent runs (kind/candidates/proposals/cost/stop-reason).
   - ✅ **Daily/€-budget guard (part 3) DONE.** A `DailyBudgetGuard` enforces an
     aggregate €/UTC-day ceiling (`DAILY_BUDGET_EUR`, default **€10/day**; 0 disables)
     across a discovery/ingest batch — distinct from the per-run `AgentBudget` cap. It
     reads spend-so-far-today from the run ledger and stops before a run would push past
     the ceiling (recording `stopped_reason='daily_budget_cap'`-style stop in the CLI),
     and clamps each run's per-run €-cap to the remaining headroom so one run can't
     overshoot either. Pure rules in `domain/metrics/daily-budget`. Also folded in the
     parked Lane-B polish: `discover`'s mid-loop cost/time re-check (was loop-top only,
     overshooting by one extraction) and a bounded discovery frontier (`FRONTIER_HEADROOM`).
   - **Pre-C-3 is now COMPLETE** — the cost & observability spine is in place; Phase C
     can run on a schedule against the open web with cost bounded per-run AND per-day.
4. **Phase C — agentic broad discovery (Tier 4). ✅ C-1 DONE.** Search-API-first
   lane shipped: `SearchProvider` port (stub/Brave/Firecrawl), a thin
   `SearchBrowserAgent` behind the `BrowserAgent` port, `DiscoverBroadUseCase`
   (`discover --broad`), a domain deny-list, and the `discover_broad` run-kind —
   all bounded by `AgentBudget` + the daily €-guard, nothing auto-publishes, no
   discovered domain auto-crawled. Defaults (`AGENT=noop`/`SEARCH_PROVIDER=stub`)
   keep it dark until enabled. **C-2 (a real-browser agent for JS-heavy pages,
   behind the same port) is the next stage.** See §4.
5. **Post-C — product-completeness toward the goal.** See §5.

**Pre-C-1/2/3, Phase C C-1, the leftover-hardening batch, AND Phase C C-2 are now
done + merged.** C-2 shipped as a render-capable `Fetcher` (Option A): a
`BrowserRenderFetcher` (`FETCHER=browser`, local Playwright JS-render — networkidle
+ scroll) for JS-heavy SPAs, plus a `HostedBrowserFetcher` vendor scaffold behind
the same port — the existing `SearchBrowserAgent` drives it and `PoliteFetcher`
keeps wrapping it (no guardrail bypass). CI/CD also landed: fixed CI trigger +
migrate gate, a GHCR release-image workflow, and a scaffolded deploy workflow.
**Next:** the post-C product-completeness track (§5). **P3 — the public `/v1/`
published-deals read API — is DONE** (read-only feed over published deals: a
curated DTO that leaks no internal field + a coarse freshness trust badge,
CDN-resolved evidence URLs, CORS, page-cap; nothing auto-publishes, admin stays
gated). Remaining in §5: GDPR/affiliate disclosure at publish (a launch gate for
the public PAGE — see `docs/KNOWN_ISSUES.md`), reliability-driven ranking,
scheduler/ops, observability, multi-country. The interactive multi-step
`BrowserAgent` ("Option B") is a recorded future extension (`docs/KNOWN_ISSUES.md`),
to pick up only when a site needs it.

---

## 3. Remaining gaps from the live-audit (medium/low — not yet fixed)

Sequenced into the buckets above. None are critical (nothing auto-publishes;
the high-severity trust/scale issues were fixed in `3e8aecb`).

**Resilience / ops (→ Pre-C-2): ✅ DONE (except the advisory lock, deferred).**
- ✅ DB pool tuning (`max`/idle/connection timeouts) + `statement_timeout` +
  `pool.on('error')` + bounded transient-error retry on every DB op
  (`postgres/db-resilience.ts`). Configurable via `DB_POOL_*` / `DB_STATEMENT_TIMEOUT_MS`
  / `DB_RETRIES`.
- ✅ Container entrypoint (`docker-entrypoint.sh`) runs migrations before the app.
- ✅ Evidence-bundle write is atomic (staging dir → `rename`); terms text is
  hash-verified on read.
- ✅ `field_proposals.upsertAndCount` was already a single SQL upsert with
  `count = count + 1` (first_seen_at set only on insert); the contract now pins the
  first_seen_at-preserved / last_seen_at-advanced invariant.
- ⏳ Concurrent crawl/monitor on one source: the dedupe unique index prevents
  duplicate rows; a source-level advisory lock to avoid wasted duplicate *work* is
  deferred to when the scheduler lands.
- ⏳ The pg-boss queue adapter opens its own pool against the same DB and is NOT
  yet pool-bounded like `PostgresDb`. It's intentionally unwired (not in the
  composition root) in v1's external-cron model, so it's a no-op today — but when
  the in-process worker lands, apply the same `max`/`statement_timeout` bounds so
  the two pools' connection caps sum to a known ceiling.

**Fetcher live-edges (→ Pre-C-2, or fold into the Phase-C BrowserAgent work):**
- Firecrawl response body + screenshot download are unbounded / not size-capped.
- `page.content()` itself isn't `withTimeout`-wrapped (setDefaultTimeout covers
  actionability, not content serialization on a wedged render).
- robots.txt fetch follows redirects, has no size cap, ignores 4xx/5xx nuance.
- No charset/encoding guard for non-HTML/non-UTF8 responses.

**Extraction / LLM (→ Pre-C-3 + Phase-C prompt hygiene):**
- Truncated LLM reply (hit `max_tokens`) is a silent zero-candidate outcome with
  no signal — detect `stop_reason==='max_tokens'` and flag/retry.
- Scraped page text is interpolated raw into the extraction/triage prompt — add
  delimiter neutralization / explicit "the following is untrusted page content"
  framing to harden against prompt injection (more important once Tier-4 pulls
  arbitrary open-web pages).
- The JSON inner-quote repair heuristic is fragile on adversarial German text;
  consider a stricter parser or a repair-retry.

**Lane-B polish (→ with Phase C, since C shares the lane):**
- ✅ `discover` cost cap was checked only at loop top (overshot by one extraction);
  now mirrors the `ingest` mid-loop guard (re-checks €/time right before extracting).
- ✅ `discover` frontier (queue + visited sets) grew with total in-domain links;
  now bounded at `maxPages * FRONTIER_HEADROOM` for very large sites.
- Monitor batch has no aggregate cost budget across many changed sources. (Monitor
  makes no LLM call of its own — its diff is a hash compare and any re-crawl is a
  separate Lane-A run with its own cost row — so it's intentionally NOT a
  `crawl_runs` kind; its per-pass outcome lives, richer, in the `changes` table. The
  daily-budget guard does cover the re-crawl cost via that Lane-A row.)
- Dedupe key omits source/origin — two sources reporting the same route can churn
  duplicate `in_review` candidates. Decide: is that intended canonicalization
  (one offer regardless of who reports it) or should provenance split them?
  **Trust-relevant — confirm with the schema owner before changing.**

**CI/tests (low):**
- The integration CI job should run `db:migrate` as an explicit gate; the unit
  `check` job and integration job aren't dependency-ordered.

---

## 4. Phase C — agentic broad discovery (Tier 4)

**What it is (plan §6, seed-list §E):** scheduled, _bounded_ agentic search over
the open web on intent queries (e.g. _"[service] im Bundle / inklusive / gratis /
Aktion / perk"_, _"[provider] Vorteil/Partner"_). The agent searches, browses
candidate pages, judges relevance, extracts candidate offers, and — most
valuably — **proposes novel source domains** that a human approves before they
enter the deterministic crawl. Over time this converges expensive agentic
browsing into cheap Lane-A crawling.

**It slots into existing scaffolding (OCP — no rewrites):**
- Implement the `BrowserAgent` port (`run(query, budget): AgentRunResult`) with a
  real adapter (Browser Use / Stagehand + a hosted browser, or a search-API +
  the existing `Fetcher` for a lighter first cut). Keep it swappable via env, like
  the LLM/fetcher adapters; the `NoopBrowserAgent` stays as the default/off switch.
- A `DiscoverBroadUseCase` (application) orchestrates: query set (from
  `subscription_catalog` × intent terms) → agent run (capped) → candidates via
  the **existing `ExtractUseCase` + `CandidateSink`** → novel domains via the
  **existing `LaneBSupport.persistProposedSources`**. Reuse, don't reinvent.
- CLI `discover --broad [query] [--max-steps N] [--dry-run]` + a `discover` job for
  the cron/worker.

**Guardrails (plan §9 — all already have homes in the codebase):**
- **Bounded**: max steps / seconds / € via the existing `AgentBudget`; stop at the
  first cap and report it (mirror discover/ingest). Add the aggregate €/day guard
  from Pre-C-3.
- **Domain allow/deny + new-domain approval**: novel domains are `pending_approval`
  only, never auto-crawled — depends on **Pre-C-1** (the promotion loop) to be
  actionable. Add an explicit deny-list for known-bad/irrelevant domains.
- **Public-only**: login/captcha/anti-bot → manual capture; respect robots
  (route agent fetches through the `PoliteFetcher`); rate-limit per domain.
- **LLM = extraction/navigation only; nothing auto-publishes**; grounding +
  validation gate the queue exactly as today.
- **Cost logged per run** on `crawl_runs`; per-domain concurrency limits.
- **Prompt-injection hardening** (the Pre-C-3 item) matters most here, since
  Tier-4 ingests arbitrary open-web content into the agent's context.

**Suggested staging within C:**
- **C-1**: a search-driven (not full-browser) first cut — search API → fetch top
  results via the existing polite `Fetcher` → extract → propose. Cheaper, no new
  heavy vendor, proves the loop end-to-end.
- **C-2**: a real `BrowserAgent` (Browser Use/Stagehand) for JS-heavy/interactive
  pages the deterministic fetch can't handle, behind the same port.

**Tests (per `.claude/rules/testing.md`):** unit (query building, budget caps,
result mapping) + integration (real Container + Postgres, agent overridden by a
scripted fake → candidates + proposed sources persisted) + a gated live smoke
(one real query, assert grounded candidates, behind `RUN_LIVE_TESTS`).

---

## 5. Post-Phase-C — completeness toward the product goal

- **Publish handoff / durable API surface. — DONE (P3).** The public published-deals
  read API now exists: `GET /v1/deals` (filter/sort/paginate) + `GET /v1/deals/:id` +
  `/v1/health`, served read-only alongside the gated admin `/api/*` on one port. It
  exposes a curated DTO (typed core + mapped conditions + a coarse freshness trust
  badge), CDN-resolved evidence screenshot URLs, and per-source provenance via
  `source_url` (split-by-source dedupe, P1). No internal/audit field leaks
  (contract-tested); published-only; unauthenticated read, no writes.
  See `docs/DealRoute_P3_PublicAPI_Handoff.md`. (`/v1/` is the version prefix.)
- **GDPR + affiliate disclosure at publish — DONE (Step 2, 2026-06-20).** Added
  `affiliate_disclosure` (bool, default true = over-disclose) + `published_at` to the
  deal record (schema v3, migration 0010), set by the reviewer at approve-time (CLI
  `--no-affiliate-disclosure` / `/api` approve body; defaults true + warns when omitted),
  exposed in the public `/v1/` DTO. No PII stored; own-screenshot evidence (not republished
  T&C) confirmed. Legal-confirmed field set. Trust-verified (nothing auto-publishes; every
  published deal carries a disclosure decision; DTO leaks nothing new).
- **Reliability-driven trust** maturation — **DONE (Step 3, 2026-06-20).** `reliability_score`
  now blends into the public-feed ranking as a read-time **tiebreaker** (equal cost/freshness
  → more-reliable source first → id), resolved by the P1 registrable-domain deal→source join
  (neutral 0.5 when no source matches). The raw score is **never exposed** (order-only; the
  freshness `trust` badge stays the sole public trust signal). No schema change / no migration;
  one pure ranker (`src/domain/deal-record/published-ranking.ts`) shared by both DB adapters
  (LSP). Reliability was already wired into **cadence** (`source-policy.ts applyCrawlOutcome`,
  crawl + monitor); `last_verified` is surfaced as the P3 freshness badge. code-reviewer +
  adversarial-verify clean.
- **Multi-country** (plan "Later"): the `Country`/`Currency` enums and
  `registrableDomain` eTLD+1 approximation are .de-v1 scoped — generalize (a real
  Public Suffix List, per-country vocab/currency) when expanding.
- **Credentialed / login-gated capture** (plan "Later"): the manual-capture queue
  is the v1 answer; revisit automated credentialed access only if value justifies.
- **Auto-publish for high-confidence Tier-1** (plan "Later"): only after the trust
  track record + metrics justify relaxing human-in-the-loop for the safest tier.
- **Ops dashboards / alerting**: run metrics, cost, queue depth, source-reliability
  flags, failed-source alerts.

---

## 6. Open decisions to confirm before building

1. **Phase-C agent vendor**: search-API-first (C-1) then Browser Use/Stagehand
   (C-2), or go straight to a hosted browser? (Recommendation: C-1 first.)
2. **Scheduler**: stay on external cron (current decision) or build the in-process
   pg-boss worker when autonomy/concurrency grows? The `Queue` port is ready.
3. **Dedupe-key provenance** (audit medium): should two sources reporting the same
   route collapse to one canonical deal, or stay split by source? Affects the
   trust model — schema-owner call.
4. **Daily/€ budget ceiling** for the agentic lane — what number?

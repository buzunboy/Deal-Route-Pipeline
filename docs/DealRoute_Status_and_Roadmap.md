# DealRoute — Status & Roadmap (consolidated)

> **📍 THE ONE LIVING source-of-truth for "what's built / what's next."** This doc merges
> the former `DealRoute_PostP3_Handoff.md` (the next-steps brief) and
> `DealRoute_Phase_C_and_Roadmap.md` (the product roadmap) into a single living record —
> both originals are now **SUPERSEDED** (banner-marked, kept for design-rationale history).
>
> **Bottom line (2026-06-22):** the pipeline is **post-C FEATURE-COMPLETE for DE v1 and
> LIVE in the cloud.** Every numbered roadmap step (1–6) is DONE + merged, the admin
> `/api/*` surface is extended and contract-aligned with the panel, and the always-on API
> is deployed to Fly.io (`https://dealroute-api.fly.dev`). **No roadmap step remains.**
> Everything still outstanding is tracked in **`docs/KNOWN_ISSUES.md`** — that register
> (not this doc) is the to-do list now.

`master` @ **`5d2c781`** (2026-06-22). Deal-record `schema_version` = **5**
(`CURRENT_SCHEMA_VERSION`); latest migration = **`drizzle/0015`**. Baseline verified
2026-06-22: `npm run check` green — **755 unit/contract tests pass, 1 skipped**, lint +
typecheck clean.

**Binding rules still govern** (auto-loaded): `CLAUDE.md` + `.claude/rules/`
(`architecture.md`, `code-style.md`, `extraction-and-schema.md`, `testing.md`,
`api-and-openapi.md`). **Evergreen design reference:** `docs/DealRoute_Crawl_Pipeline_Plan.md`
(the founding design), `docs/DealRoute_Seed_List_DE.md`, `docs/Firecrawl_Integration_Reference.md`,
`docs/DealRoute_Observability.md`. **Delivered build records** (banner-marked ✅, NOT pending
work): `DealRoute_P3_PublicAPI_Handoff.md`, `DealRoute_Phase_C_Plan.md`,
`DealRoute_Hardening_Plan.md`, `DealRoute_PostC_Handoff.md`, and the two docs this one
supersedes.

---

## 1. Non-negotiable trust invariants (audited; do NOT regress)

Adversarially re-verified across all lanes (crawl, discover, ingest, broad-discovery,
monitor, review, public API). **All hold.**

- **Nothing auto-publishes.** Only `review.ts` (`approve()`) writes `status='published'`,
  after `assertApprover()` + the audit row. No lane, use-case, or the public API can flip status.
- **Evidence required before any candidate.** Both EvidenceStores call `assertCaptureComplete()`
  before any write; every lane captures before persist.
- **Best-effort read any page** (2026-06-21 owner reversal of the former "public pages only"
  invariant). `RESPECT_ROBOTS_TXT` defaults **off** (the robots gate stays, opt-in `=true`);
  login-wall / soft-block pages read best-effort (`page-classifier` → `ok` + `fetchSignal`,
  candidate stays must-review); a `captcha` page still → manual-capture; soft-404 / maintenance /
  expired still skip (`error`); the per-domain rate-limit ALWAYS applies; **no login automation
  anywhere** (no credential system yet — deferred, see KNOWN_ISSUES). Canonical statement +
  the EU/DE legal-exposure note: `CLAUDE.md` → "Best-effort read any page".
- **No raw external data trusted without zod at the boundary.** RSS items (B1 fix), LLM output,
  scraped data, and API requests all parse through a schema into typed objects before use.
- **LLM never invents columns.** Unknown conditions → `conditions[]` with `key:"other"` +
  `unmapped_conditions:true` + a `field_proposals` entry; pipeline-owned fields are stripped
  from LLM output.

**Defaults keep the agentic lane dark/safe:** `AGENT=noop`, `SEARCH_PROVIDER=stub`,
`FETCHER=playwright`, `EVIDENCE_STORE=local`. **Do not change these defaults.**

---

## 2. What is built (the complete picture — all DONE + merged)

### Core pipeline (Phases A / B / C)
- **Lane A — deterministic crawl** (`crawl --source|--subscription|--due`): seed → fetch
  (Playwright/Firecrawl behind `Fetcher`) → evidence → LLM extract → validate/dedupe →
  candidate queue. Golden + unit + integration tested.
- **Lane B(i) — site discovery** (`discover <url>`): bounded same-domain crawl → candidates +
  novel-domain proposals (`pending_approval`).
- **Lane B(ii) — community ingestion** (`ingest --source|--community-due`): RSS → keyword
  pre-filter → LLM triage → extract relevant leads → candidates + proposed merchant domains.
- **Tier-4 broad discovery** (`discover --broad`, Phase C **C-1**): search-API-first agentic lane
  (`SearchProvider` stub/Brave/Firecrawl; thin `SearchBrowserAgent` behind the `BrowserAgent`
  port; `DiscoverBroadUseCase`; domain deny-list; `discover_broad` run-kind). Bounded by
  `AgentBudget` + the daily €-guard; nothing auto-publishes; no discovered domain auto-crawled.
- **Render-capable fetch** (Phase C **C-2**, Option A): `BrowserRenderFetcher` (`FETCHER=browser`,
  local Playwright networkidle + scroll) for JS-heavy SPAs + a `HostedBrowserFetcher` vendor
  scaffold, both behind the `Fetcher` port and wrapped by `PoliteFetcher`. (Interactive multi-step
  "Option B" agent is a recorded future extension — KNOWN_ISSUES.)
- **Monitoring** (`monitor --source|--due`): diff price/terms via evidence hash → re-queue on
  change; debounced auto-expiry on disappearance; blocked → manual capture; reliability/back-off
  via the shared `applyCrawlOutcome` (same policy as Lane A).
- **Review** (CLI + gated `/api/*`): approve→published / reject→rejected, append-only `reviews`
  audit; field-proposals + manual-capture queues; **plus** reviewer edit, proposal→vocabulary
  promotion, manual-capture completion, and candidate-list filters (the review-API extension).
- **Source-promotion loop** (Pre-C-1): list/approve/reject `pending_approval` sources (CLI + API +
  test-page tab); append-only `source_reviews` audit.

### Ops / resilience spine (Pre-C-2 / Pre-C-3)
- DB pool tuning + `statement_timeout` + `pool.on('error')` + bounded transient-error retry
  (`postgres/db-resilience.ts`); container entrypoint applies migrations before the app.
- Atomic evidence-bundle writes; terms text hash-verified on read; hollow-capture guard.
- Reliability-driven cadence: a flaky source backs off (capped 5×) + flags (crawl AND monitor).
- Cost spine: every lane logs a `crawl_runs` row (incl. the agentic lane); `stats [--since]
  [--until] [--runs]` aggregation; per-run `AgentBudget` cap + a daily €-budget guard
  (`DAILY_BUDGET_EUR`, default €10/day).

### Post-C roadmap steps — ALL DONE
- **Step 1 — Public read API (P3).** `GET /v1/deals` (filter/sort/paginate) + `GET /v1/deals/:id`
  + `/v1/health`. Unauthenticated, read-only, `published` only; curated DTO leaks no internal
  field (contract-tested) + a coarse freshness `trust` badge; CDN-resolved screenshot URLs; CORS;
  page-cap. `/v1/*` dispatch is total.
- **Step 2 — GDPR + affiliate disclosure at publish.** `affiliate_disclosure` (bool, default true)
  + `published_at`, reviewer-set at approve, in the public DTO. Schema **v3**, migration **0010**.
  Legal-confirmed; the launch gate for the public PAGE.
- **Step 3 — Reliability-driven ranking.** A source's `reliability_score` is a read-time
  **tiebreaker** in the public-feed sort (equal cost/freshness → more-reliable source → id),
  resolved by the registrable-domain deal→source join (neutral 0.5 on no match). Raw score NEVER
  exposed (order-only). One pure ranker (`published-ranking.ts`) shared by both DB adapters (LSP).
  No schema change.
- **Step 4 — Scheduler / unattended-run harness.** External-cron model: `deploy/k8s/cronjobs.yaml`
  (4 CronJobs — crawl 6h / monitor 3h / ingest hourly / discover daily-but-suspended) + a guarded
  scheduled Action + `deploy/README.md`. pg-boss stays unwired. Shipped with **Prereq A**: a Source
  `resolved_url` set on first successful crawl/monitor pass so monitor matches expiry/baseline on
  `resolved_url ?? url` → a redirecting source's published deals now auto-expire. Migration **0011**.
- **Step 5 — Observability / alerting.** A new `Alerting` port + `NoopAlerter` (default off) +
  `WebhookAlerter` (generic webhook + Slack), wired at the source-reliability-low (crawl + monitor)
  and daily-budget-reached warn points. Best-effort (never crashes a lane); dark by default; no
  schema/trust impact. Datadog/CloudWatch metrics-push adapters deferred (KNOWN_ISSUES; recipe in
  `docs/DealRoute_Observability.md`).
- **Step 6 — Multi-country FOUNDATION (DE stays the only ENABLED country).** Real Public Suffix List
  (`tldts` behind a pure `SuffixOracle`, injected) replaces the naive last-two-labels approximation;
  `registrable_domain` PINNED on deal + source so dedupe + the reliability join read a frozen field
  (schema **v4**, migration **0012**; DE byte-identical). Config-driven `MARKETS` registry → closed
  `Country`/`Currency` enums + a per-country currency trust rule. "Add a country" = data/config, no
  logic edit.

### Post-roadmap milestones (admin surface + deployment)
- **Review-API extension** (`e22635d`, 2026-06-21). Four gated `/api/*` actions: `PATCH
  /api/candidates/:id` reviewer edit (allowlist `applyCandidatePatch`; `human_edited` tagging;
  identity/provenance/status not editable), `POST /api/field-proposals/:key/promote`,
  `POST /api/manual-capture-tasks/:id/complete` (evidence required by reference), `GET
  /api/candidates` filters/pagination. New ports: `ConditionVocabularyRepository`,
  `FieldProposalRepository.getByKey/markPromoted`, `ManualCaptureRepository.getById/markDone`,
  `DealRepository.listCandidates(filter)`. Schema **v5**, migration **0013** (`human_edited`).
- **Admin-panel contract fixes** (`d09ade0`, 2026-06-22). **ACR-13** resolved
  `evidence_screenshot_url`/`evidence_html_url` on `GET /api/candidates` (new `admin-evidence-dto`;
  shared `resolveEvidenceUrl`); **ACR-14** OpenAPI `EditCandidateBody.patch` enumerates the exact
  `PATCHABLE_FIELDS`; **ACR-15** Source `proposal_reason` (additive/nullable, migration **0015**)
  surfaced on `GET /api/sources/pending`; **ACR-3** proposal-status enum reconciled to
  `[open, promoted, rejected]`. OpenAPI + Postman regenerated.
- **Cloud deploy — the API is LIVE** (head `5d2c781`, 2026-06-22). Always-on `serve` deployed to
  Fly.io (`https://dealroute-api.fly.dev`, region `fra`): managed Postgres attached, S3 evidence
  bucket + scoped IAM, GHCR image, `REVIEW_API_TOKEN`/`S3_*` Fly secrets; health/CORS/auth verified.
  Shipped with it: idempotent `sources.upsert` on `url` (migration **0014**), 2 GB lane machines
  (512 MB OOMs Chromium), a Playwright base-image pin, and one-click/manual Fly deploy workflows.
  Artifacts: `deploy/fly/` (fly.toml + setup README), the committed AWS IAM policy + S3 setup script.

**Architecture health (audited):** clean layering — zero vendor imports in `domain`, strict DIP
(no `new Vendor()` outside `src/composition/container.ts`), every adapter behind a port with a
shared contract suite enforcing LSP. The implementation is sound.

---

## 3. What's left (all tracked in `docs/KNOWN_ISSUES.md` — that register is the to-do list)

No roadmap step remains. The concrete forward work, highest-value first:

1. **Admin-panel new endpoints — mostly DONE (2026-06-22); a metrics layer is what's left.**
   BUILT (both-adapter parity + contract + unit + integration + OpenAPI): **ACR-5** candidate counts,
   **ACR-7** audit feed (approve/reject/edit), **ACR-10** admin published + sources registry,
   **ACR-12** ad-hoc capture, **ACR-11 + ACR-10-Team** team/profile (pipeline is now the reviewer-
   identity system of record; `team_members`, migration 0016), **ACR-8** persisted alerts +
   ack/resolve (`alert_events`, migration 0017, read-time auto-resolve). STILL deferred (need a
   metrics/aggregation layer that doesn't exist yet): **ACR-6** throughput, **ACR-9** queue-freshness,
   **ACR-10 Metrics** (KPIs/cost/confidence) and **ACR-10 Settings** (needs an owner call on
   pipeline-owned vs env config). Plus the ACR-7 follow-up: persist `promote`/`extract` as audit rows.
   Details + fix-when in `docs/KNOWN_ISSUES.md`. The panel renders placeholders for the deferred set.
2. **Post-deploy hardening** [medium] — the API is live + working, but parked: **rotate** the
   chat-exposed AWS key + GitHub PAT (before going past dev/staging), make the GHCR image private,
   **pin** `:edge` → `:sha-…`, set **`ADMIN_CORS_ORIGIN`** when the panel deploys. Plus the deploy-time
   **CDN scoping gate** [high — config, not code]: expose ONLY `screenshot.png`, never the whole
   evidence bundle, before pointing `S3_CDN_BASE_URL` at a public bucket.
3. **The rest of the deferred-findings register** — e.g. the **dormant Postgres contract-suite CI
   gap** [medium], the **manual-capture upload channel** [medium], no `/v1/` rate-limiting [medium,
   CDN-fronted at deploy], the per-request active-source scan, the raw-IDN suffix normalisation, the
   non-UUID `:id` → 500, the pg-boss pool bound (if/when wired). Pick by the listed fix-when triggers.
4. **Enable a real 2nd country** [low — feature-enablement, owner scope call] — Step 6 built the
   foundation; launching e.g. AT/CH is data/config (a `MARKETS` row + that country's
   seeds/vocab/deny-list/Tier-4 queries), NO logic change.
5. **Operate / curate** — real seed-list curation + live tests (per-source fetcher selection, the
   dead mydealz RSS feed, JS-heavy provider homepages yielding 0 deals).

**Open owner decisions that gate the above (not defaultable):**
- **CDN exposure scope** (the deployment gate): same S3 prefix as the bundle, or a separate public
  prefix? *Rec: separate public prefix; never make the bundle prefix listable.* (Item 2 above.)
- **ACR-11 reviewer identity**: move profile/team into the pipeline, or keep it the panel's allow-list?
  (Confirm before building ACR-11.)
- The Step 2 / 3 / 4 / 5 decisions are all **DECIDED + DONE** (recorded in the SUPERSEDED handoff §7
  and roadmap §6 for the rationale trail).

---

## 4. Workflow / environment facts (these bit earlier sessions — don't rediscover)

- You're in a git **worktree** on your own branch. The runtime `.env` (real keys) lives only in the
  main repo root. To run real LLM/fetch/S3 from a worktree, copy `.env` in temporarily (gitignored)
  and delete after — or run from the main worktree. Dry-run/tests need no keys.
- **Run gates from your own worktree** (`git rev-parse --abbrev-ref HEAD` first; a stray `cd` to the
  main repo runs stale code).
- **No local Docker/Postgres** → integration tests self-skip; CI is their first real run. After
  writing integration tests you can't run, **statically verify** (trace assertions against the real
  adapter) before relying on CI.
- **Merge to `master` via fast-forward only.** `master` is checked out in the MAIN worktree, so
  `git branch -f master` from your worktree fails — push the branch commit straight to origin with
  `git push origin HEAD:master` (a clean ff when origin hasn't advanced). A push can be rejected if
  origin advanced mid-flight — `git fetch`, `git rebase origin/master`, re-run `npm run check`, then
  push. The main worktree's local `master` then needs a `git pull`.
- **Migrations:** edit `schema.ts` → `npm run db:generate` → commit the generated `drizzle/*.sql` +
  `drizzle/meta/*` (in `.prettierignore` — don't reformat). Latest is **`0017`** (0016 team_members,
  0017 alert_events).
- **Touch the HTTP API → update `docs/api/openapi.yaml` in the same change** (`npm run api:lint` +
  `npm run api:postman`, commit both). The public DTO stays an allow-list — no internal field leaks.
- **No `Co-Authored-By` trailer** on commits (global user rule). Husky pre-commit runs
  prettier + eslint + typecheck on staged files.
- **Deploy:** the API is live on Fly (`deploy/fly/`). GHCR image path is lowercase
  `ghcr.io/buzunboy/deal-route-pipeline` even though the repo is mixed-case. Local counterpart:
  `docs/LOCAL_DEV.md`.

---

## 5. First moves for a fresh session

1. Confirm orientation reads (`CLAUDE.md` + `.claude/rules/`) + green baseline
   (`npm install && npm run check && npm run build` — expect ~755 tests, 1 skipped; lint + typecheck
   clean). **All post-C steps (1–6) are DONE, the admin surface is extended + contract-aligned, and
   the API is live on Fly.** No roadmap step is pending; no foundation repair pending.
2. **There is no next roadmap step.** Pick forward work from §3 (which mirrors `docs/KNOWN_ISSUES.md`)
   — ACR endpoints cheapest-first → the audit feed → post-deploy hardening → the rest of the register
   → (when the business calls for it) a 2nd country.
3. Every change: unit + integration tests (live for new external edges); `code-reviewer` + an
   adversarial-verify pass on anything trust/publish/schema; docs updated (this doc's §2/§3, CLAUDE.md
   Commands + Repo layout, README, ARCHITECTURE; the OpenAPI spec on any API change; and
   `docs/testing/LIVE_TEST_TEMPLATE.md` when a feature adds a recordable field). Nothing auto-publishes;
   the public feed serves only `published` deals via the deliberate DTO; defaults unchanged.

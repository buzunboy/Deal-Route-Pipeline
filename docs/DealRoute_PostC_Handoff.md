# DealRoute — Post-Phase-C handoff & next-steps plan

> **⚠️ SUPERSEDED — for current status + next steps, read `docs/DealRoute_Status_and_Roadmap.md`.**
> This doc's entire post-C track (Steps 1–6) is now DONE + merged — the pipeline is post-C
> feature-complete for DE v1 and live in the cloud. Kept only for the historical 2026-06-20
> post-C audit context; do NOT treat its "next steps" as current.

_Authoritative next-steps brief for a fresh session, written after a full audit on
2026-06-20. Supersedes `docs/NEXT_SESSION_HANDOFF.md` (which predates Phase C).
Everything through **Phase C (C-1 + C-2) + the leftover-hardening batch + CI/CD** is
built, tested, merged to `master`, and pushed (master at `190270e`). This document
covers the **post-C product-completeness track** (roadmap §5) — what's next, in what
order, what's already audited, which decisions need a human first, and which slices
are workflow-shaped._

> Read alongside the binding `CLAUDE.md` + `.claude/rules/`, the roadmap
> (`docs/DealRoute_Phase_C_and_Roadmap.md` §5), and the deferred-findings register
> (`docs/KNOWN_ISSUES.md`).

---

## 0. Where we are (verified by audit, not assumed)

**Built + merged:** Phase A (Tiers 1–2 deterministic), Phase B (Tier-3 community
ingestion), Pre-C-1/2/3, Phase C C-1 (search-API broad discovery) + C-2 (render-capable
Fetcher: `BrowserRenderFetcher` + hosted-browser scaffold behind the `Fetcher` port),
the leftover-hardening batch (monitor budget guard, LLM-truncation flag, fetcher size
caps, robots hardening), and CI/CD (fixed CI trigger + migrate gate, GHCR release image,
scaffolded SSH deploy). **467 unit tests green; lint + typecheck clean.** Defaults keep
the agentic lane dark: `AGENT=noop`, `SEARCH_PROVIDER=stub`, `FETCHER=playwright`.

**The non-negotiable invariants still hold** (audited): LLM proposes / humans approve /
**nothing auto-publishes**; evidence required before any candidate; ~~public-only via
PoliteFetcher~~ (the "public pages only" invariant was **reversed 2026-06-21** → best-effort
read any page; see `CLAUDE.md`); every boundary zod-validated. Do not regress these in any post-C work.

---

## 1. The headline finding

The pipeline is **data-ready but surface-blind**. It produces trustworthy, evidence-backed
published deal records — but there is **no way for the consuming repos (the public landing
page + the admin panel) to read them**. The HTTP surface today is entirely review/admin-centric
(candidates, approve/reject, sources, proposals); there is **no published-deals read API, no
evidence HTTP exposure, and no API versioning**. That is the critical-path gap: until it exists,
the product can't ship a page to users even though the data is correct.

Everything else in §5 (GDPR/affiliate, reliability ranking, multi-country, scheduler,
observability) is real but secondary to "let consumers read published deals."

---

## 2. Recommended sequence (highest-leverage first)

Each step lists: **what**, **why now**, **the human decision it needs (if any)**, the
**concrete code surface**, **tests required** (per `.claude/rules/testing.md`), and whether
it's **workflow-shaped** (see §4).

### Step 1 — Published-deals read API + evidence exposure (CRITICAL PATH)
**What:** A versioned public read API the landing page consumes: list/filter/paginate
published deals, fetch one by id, and resolve evidence (screenshot) URLs. Today there is
`listByStatus(status, limit)` only — no filter/sort/paginate, no published feed, no `/v1/`.

**Why now:** It's the one gap that blocks shipping anything user-facing; all the data exists.

**Decisions needed FIRST (ask the user — do not assume):**
- D1. **API shape / hosting**: extend the existing `serve` review-API process with a
  `/v1/` public surface, or a separate read-only service/process? (Recommendation: same
  process, new `/v1/` router, read-only + unauthenticated for the published feed; keep
  `/api/` admin behind `REVIEW_API_TOKEN`.)
- D2. **Public response shape**: the internal `DealRecord` carries `grounding`, `attributes`,
  `confidence` — internal audit data that should NOT leak to the public feed. Define a
  **public DTO** (a deliberate projection) vs returning the raw record. Confirm which fields
  are public (recommend: service, provider, headline, price, true_cost_monthly, country,
  validity, included_items, eligibility flags, source_url, evidence screenshot URL,
  verified_at, id). Exclude grounding + raw attributes + confidence.
- D3. **Ranking/sort default**: by `true_cost_monthly` asc? by `verified_at` desc
  (freshness)? a blended score? (See Step 3 — reliability ranking; the default sort can ship
  simple now and get the reliability blend later.)
- D4. **Evidence serving**: serve screenshots from the API (a `GET /v1/evidence/:id/screenshot`
  route streaming from the EvidenceStore), or upload to object storage (S3/R2 — the port
  exists, the adapter is a documented extension point) and return CDN URLs? (Recommendation:
  start with an API route streaming from the EvidenceStore; S3/R2 + CDN when traffic justifies.)

**Code surface:**
- New repo method: `DealRepository.listPublished({ service?, country?, routeType?, priceMax?,
  sort, limit, offset })` + `countPublished(filters)` — in `src/application/ports/repositories.ts`,
  the in-memory adapter, AND the Postgres adapter (`src/adapters/db/postgres/postgres-db.ts`)
  with a real `ORDER BY` + `LIMIT/OFFSET` and an index on `(status, country, service)`.
- New use-case (thin read use-case) or a query service that maps `DealRecord` → the public DTO.
- New HTTP routes in `src/adapters/http/` (a new `public-api.ts` router, mounted under `/v1/`,
  wired in `serve`): `GET /v1/deals`, `GET /v1/deals/:id`, `GET /v1/evidence/:id/screenshot`.
- A migration if an index is added (drizzle: edit `schema.ts` → `npm run db:generate` → commit).

**Tests:** unit (DTO projection drops grounding/attributes/confidence; filter/sort/paginate
pure logic) + a Postgres-tier integration test (real `listPublished` round-trip: filters,
ordering, pagination, only `published` returned) + the existing HTTP-test pattern for the new
routes. A contract: the public DTO NEVER contains `grounding`/internal `attributes`.

**Workflow-shaped?** Partly — after D1–D4 are decided, the per-endpoint + repo-method +
DTO + migration slices fan out cleanly (see §4 Workflow A).

---

### Step 2 — GDPR + affiliate disclosure at publish (TRUST/LEGAL, schema change)
**What:** Add EU-Omnibus affiliate disclosure to published records and confirm the no-PII /
own-screenshot-not-republished-T&C posture at the publish boundary.

**Why now:** It's a publish-surface concern and a legal gate for a public page; cheap to add
WITH Step 1 (same schema/DTO touch) and expensive to retrofit after the page ships.

**Decisions needed FIRST:** This is **schema-owner + legal** territory — ASK before changing
the deal-record schema (CLAUDE.md invariant). Specifically:
- Which fields: `affiliate_disclosure: boolean` (or a disclosure text/enum)? a `published_at`
  timestamp distinct from `verified_at`? a GDPR `legal_basis`? (Recommend the minimum legally
  required for a price-comparison page; confirm with whoever owns legal.)
- Whether disclosure is set at publish (reviewer action) or derived from the source/affiliate
  relationship.

**Code surface:** `src/domain/deal-record/deal-record.ts` (new fields, additive), a drizzle
migration, the approve path (`src/application/review/review.ts` — set the field at publish),
the public DTO (Step 1). Keep `schema_version` bumped so promoted fields are re-parseable.

**Tests:** schema round-trip integration test; a unit test that the publish path sets the new
field; the public DTO includes disclosure. **Adversarial:** a published deal without the
required disclosure field is rejected/flagged (never served).

**Workflow-shaped?** No — it's a small, decision-gated, trust-critical change; do it inline
after the human decision, ideally folded into Step 1's schema/DTO touch.

---

### Step 3 — Reliability-driven ranking + surface `last_verified` (TRUST MATURATION)
**What:** Feed `reliability_score` (and freshness) into the published-deals sort, and surface
`last_verified`/`verified_at` prominently (the product's core trust signal).

**Audit finding:** reliability_score is **fully wired for cadence/back-off** (the shared
`applyCrawlOutcome` in `source-policy.ts`) but is **NOT used in any ranking** and is **not
exposed in any API response**. The data is ready; the surface is blind.

**Why after Steps 1–2:** ranking is a refinement of the read API's sort; ship Step 1 with a
simple sort, then blend in reliability here.

**Decision needed:** the ranking formula (e.g. sort by `true_cost` but de-rank low-reliability
sources / boost recently-verified). A schema-owner call on whether to precompute a `rank_score`
column (write-time) or sort dynamically (read-time). Recommend read-time first (no new column).

**Code surface:** the `listPublished` sort (Step 1's repo method), the public DTO (expose
`verified_at` + maybe a coarse trust indicator — NOT the raw reliability_score, which is an
internal signal). NB: a deal's reliability comes from its SOURCE; joining deal→source requires
the source lineage that the dedupe-key issue (§3 below) complicates — confirm the join path.

**Tests:** pure ranking-function unit tests (table-driven); integration that the sort order
reflects reliability + freshness.

**Workflow-shaped?** No — small, formula-driven, depends on Step 1.

---

### Step 4 — Scheduler / unattended-run harness (OPS, HIGH operational risk)
**What:** Make the lanes actually RUN on a schedule. Today it's **pure external-cron**: the
container entrypoint runs migrations then the CLI; the `Queue` (pg-boss) port exists but is
**intentionally unwired** (composition root does not instantiate it). There is **no scheduler
config in the repo** — no crontab, no K8s CronJob, no scheduled GitHub Action.

**Why it matters:** the pipeline is a library, not a self-running app. If external cron is
misconfigured or down, it silently stops. This is the highest *operational* risk for going live.

**Decision needed:** external-cron (the current intended model — provide deployment templates:
K8s CronJob / ECS scheduled task / a scheduled workflow) OR wire the in-process pg-boss worker
now? (Roadmap's standing decision is external-cron for v1; recommend shipping **deployment
templates + a documented cron schedule** rather than building the worker, unless concurrency
needs have grown.)

**Code surface (external-cron path):** deployment manifests / cron templates (K8s CronJob or
a `schedule`-triggered GitHub Action invoking the GHCR image with `crawl --due` / `monitor
--due` / `ingest --community-due` / `discover --broad`); docs. The `deploy.yml` scaffold from
the CI/CD batch is the hook. If pg-boss instead: wire it in the composition root + bound its
pool (see KNOWN_ISSUES "pg-boss queue pool not bounded").

**Tests:** for templates, mostly review + a dry-run; if pg-boss, unit + integration for the worker.

**Workflow-shaped?** No — it's config/ops + one decision.

---

### Step 5 — Observability: alerting + metrics push (OPS)
**What:** Move from pull-only `stats` to proactive signals: alert on failed sources,
reliability-low flags, cost-spike / daily-budget-threshold breaches, and (if pg-boss lands)
queue depth.

**Audit finding:** metrics are **pull-only** (`stats` CLI over `crawl_runs`); reliability-low
emits a single `logger.warn`; **no alerting, no metrics push, no dashboards**. At scale this is
a severe blind spot — silent failures until someone notices a deal didn't publish.

**Decision needed:** the ops stack (Datadog/CloudWatch/Grafana/etc.) — drives the adapter.

**Code surface:** a small alerting/notification port + adapter (e.g. webhook/Slack), thresholds
in config, hooks at the existing warn points (`crawl-source.ts` reliability-low, the
daily-budget guard). Keep it behind a port (OCP) so the backend is swappable.

**Workflow-shaped?** Partly — discrete signal types could fan out, but it's small; likely inline.

---

### Step 6 — Multi-country generalization (LATER — only when expanding)
**Audit finding:** hard-coded to DE/EUR: `Country = z.enum(['DE'])`, `Currency = z.enum(['EUR'])`
(`src/domain/deal-record/enums.ts`), and `registrableDomain` is an eTLD+1 approximation
(last two labels) that **breaks on multi-label TLDs** (`.co.uk`, `.com.au`) — a real PSL is
needed. German-only vocab/deny-list/queries are data (parameterizable), not code.

**Why later:** v1 is DE-only by design; do this when a second country is actually on the roadmap.
Flagged here so it's not a landmine.

**Workflow-shaped?** No.

---

## 3. Cross-cutting trust risk to resolve before the public feed: dedupe-key provenance

`dedupeKey = service + provider + route_type + country` (omits source). Two sources reporting
the same route collapse to one canonical deal. For a **public feed** this matters: (a) which
source's evidence/`source_url` is shown? (b) a rogue Tier-4 source could influence a published
route. The evidence chain exists but there's no easy "which sources reported this route?"
query. **This is a schema-owner decision** (collapse vs split-by-source) recorded in
`docs/KNOWN_ISSUES.md` ("Dedupe-key omits source/origin"). **Resolve it before Step 1's
public feed ships**, because the public DTO's `source_url` + evidence link depend on the answer.

---

## 4. What's workflow-shaped (and what isn't)

A **Workflow** (multi-agent orchestration) makes sense for breadth/parallelism AFTER the
design decisions are made. It does NOT make sense for the decisions themselves (API shape,
GDPR fields, ranking formula, scheduler model) — those need a human and are sequential.

**Workflow A — "Public read API" build-out (after D1–D4 in Step 1 are decided).**
Once the public DTO + endpoint list + filter set are fixed, pipeline over the endpoints/repo
methods: implement → unit-test → integration-test each, with a final adversarial verify that
the public DTO never leaks internal fields (grounding/attributes/confidence) and that only
`published` deals are served. Shape: `pipeline(endpoints, implement, test)` + a barrier
"no-internal-field-leak" verify across all DTOs.

**Workflow B — Audit/verify passes (any time).** The "review → adversarially verify" pattern
already used in this project: fan out skeptics over the trust invariants of whatever was just
built (never-publish, no-PII-leak, evidence-required, public-DTO-projection). Good as the gate
before merging Step 1/2.

**Not workflow-shaped (do inline, decision-gated):** Step 2 (GDPR fields), Step 3 (ranking
formula), Step 4 (scheduler), Step 6 (multi-country). Each is small and hinges on one decision.

---

## 5. Housekeeping found during the audit (cheap, do opportunistically)

- **Stale KNOWN_ISSUES entry**: "CI jobs not dependency-ordered" is now FIXED (CI-1 added
  `needs: check`) — remove that entry from `docs/KNOWN_ISSUES.md`.
- **Stale handoff**: `docs/NEXT_SESSION_HANDOFF.md` predates Phase C — this doc supersedes it;
  delete or mark it superseded.
- The other open KNOWN_ISSUES (charset guard, JSON-recovery fragility, robots cross-origin
  redirect, monitor cost-clamp, pg-boss pool, advisory lock, screenshot height-detection,
  Option-B agent) remain valid deferrals — none block the post-C work.

## 6. Definition of done for the post-C track (per step)

- `npm run check && npm run build` green; integration tests added + (no local Postgres) statically
  verified or relied on CI Postgres. `code-reviewer` + an adversarial-verify pass on any
  trust/publish/schema change. Docs updated (CLAUDE.md Commands + Repo layout, README, ARCHITECTURE,
  roadmap §5). **Nothing auto-publishes; the public feed serves only `published` deals via the
  deliberate public DTO.** Defaults unchanged.

## 7. First moves for the next session

1. Confirm baseline green from your own worktree (`npm run check && npm run build`).
2. Put the **Step-1 decisions (D1–D4) + the dedupe-key provenance call (§3)** to the user via
   `AskUserQuestion` — they gate everything user-facing.
3. With those answered, build Step 1 (the public read API + evidence exposure), folding in
   Step 2's GDPR/affiliate fields in the same schema/DTO touch. Use Workflow A for the
   endpoint fan-out, Workflow B to verify the trust invariants before merge.
4. Then Step 3 (reliability ranking), then Step 4 (scheduler/ops) + Step 5 (observability).

# DealRoute — Post-P3 audit & next-steps handoff

_Self-contained next-steps brief for a FRESH Claude Code session. Originally written
after a full audit on **2026-06-20**; **kept current** as work merged. `master` is at
**`<set-on-merge>`** (Step 4). **Post-C Steps 1 (P3 public API), 2 (GDPR/affiliate
disclosure), 3 (reliability-blended ranking) AND 4 (scheduler / unattended-run harness)
are DONE + merged; the next step is Step 5 (observability: alerting + metrics push).**
This supersedes
`docs/DealRoute_PostC_Handoff.md` (kept, banner-marked). (`NEXT_SESSION_HANDOFF.md` was deleted.)_

> **What shipped since the original audit** (all merged to `master`, in order):
> B1 RSS-boundary fix · the live-dry-run hardening batch (raised `LLM_MAX_OUTPUT_TOKENS`
> default + a `.min` floor; a bounded LLM re-ask on parse/schema failure; **prepaid**
> billing + `prepaid_months` amortisation, schema v2) · an extraction input-size cap
> (giant pages trimmed, not crashed) · **Firecrawl v2** refactor + opt-in Tier-4
> **inline scrape** (gated by `PoliteFetcher.checkAccess`, `AGENT_INLINE_SCRAPE`) ·
> the **live-test template** `docs/testing/LIVE_TEST_TEMPLATE.md` (+ a recorded run in
> `docs/testing/results/`) · the Firecrawl reference `docs/Firecrawl_Integration_Reference.md`
> · **Step 2** (`affiliate_disclosure` default-true + `published_at`, set at approve,
> in the public DTO; schema **v3**, migration **0010**) · **Step 3** (reliability-blended
> ranking: a source's `reliability_score` is a read-time TIEBREAKER in the public feed
> sort — equal cost/freshness → more-reliable-source first → id; resolved by the P1
> registrable-domain deal→source join, neutral 0.5 when no source matches; raw score
> NEVER exposed, order-only; **no schema change / no migration**) · **Step 4** (scheduler /
> unattended-run harness: external-cron templates — K8s CronJobs + a guarded scheduled
> Action + `deploy/README.md` — pg-boss stays unwired; **Prereq A**: a nullable Source
> `resolved_url` set on first successful crawl/monitor pass so monitor matches expiry/
> baseline on `resolved_url ?? url` → a **redirecting source's published deals now
> auto-expire**, migration **0011**). Deal-record `schema_version` is still **3**; latest
> migration is now **`drizzle/0011`** (the Source `resolved_url` column).

> Binding rules still govern: `CLAUDE.md` + `.claude/rules/`
> (`architecture.md`, `code-style.md`, `extraction-and-schema.md`, `testing.md`).
> Companions: `docs/DealRoute_Crawl_Pipeline_Plan.md` (master design),
> `docs/DealRoute_Phase_C_and_Roadmap.md` §5 (the roadmap), `docs/KNOWN_ISSUES.md`
> (deferred-findings register). The P3 build record is `docs/DealRoute_P3_PublicAPI_Handoff.md`.

---

## 0. Orient first (before any code)

1. Read `CLAUDE.md` + the auto-loaded `.claude/rules/` — **binding**.
2. Green baseline from YOUR OWN worktree: `git rev-parse --abbrev-ref HEAD`, then
   **`npm install && npm run check && npm run build`**. Expect ~572 unit tests +
   lint + typecheck green. (A fresh worktree has no `node_modules` — `npm install`
   first; `@aws-sdk/client-s3` is a declared dep, its absence means install didn't run.)
   The Postgres integration tier self-skips without `DATABASE_URL_TEST` (CI runs it).
3. Re-read the **workflow/environment gotchas** in §8 — they bit earlier sessions
   (worktree `.env`, ff-only merge, no local Postgres → statically verify integration
   tests, drizzle migration flow, mid-flight push collisions).

## Non-negotiable invariants (audited 2026-06-20 — do NOT regress)

These were adversarially re-verified across **all** lanes (crawl, discover, ingest,
broad-discovery, monitor, review, public API). **4 of 5 hold; 1 has a contained crack — B1 below.**

- **Nothing auto-publishes.** ✅ HOLDS. Only `review.ts` (`approve()`) writes
  `status='published'`, after `assertApprover()` and the audit row. No lane, no
  use-case, and not the public API can flip status.
- **Evidence required before any candidate.** ✅ HOLDS. Both EvidenceStores call
  `assertCaptureComplete()` before any write; every lane captures before persist.
- **Public pages only.** ✅ HOLDS. `PoliteFetcher` (robots + per-domain rate-limit +
  size caps) decorates *every* inner fetcher at the composition root; the agentic
  `SearchBrowserAgent` uses the same polite-wrapped port. No login automation anywhere.
- **No raw external data trusted without zod at the boundary.** ✅ HOLDS (B1 fixed
  2026-06-20). The audit found the RSS feed reader returned regex-built `FeedItem`s with
  no zod parse; `parseFeed` now validates each item through `FeedItemSchema` (http/https
  `link`) and drops failures. See §3 (kept as a record of the fix).
- **LLM never invents columns.** ✅ HOLDS. Unknown conditions → `conditions[]` with
  `key:"other"` + `unmapped_conditions:true` + a `field_proposals` entry; pipeline-owned
  fields are stripped from LLM output. 8 adversarial attempts found no escape.

---

## 1. Where we are (verified by audit, not assumed)

**Built + merged + pushed (master `4f4f077`):** Phase A (Tiers 1–2 deterministic
crawl → extract → evidence → candidate → review → monitor/diff), Phase B (Tier-3
community ingestion), Pre-C-1/2/3 (DB pool/retry, atomic evidence, reliability
back-off, daily €-budget guard, all-lanes run-metrics), Phase C **C-1** (Tier-4
search-API broad discovery, `AGENT=search`) + **C-2** (render-capable `Fetcher`:
`BrowserRenderFetcher` `FETCHER=browser` + a hosted-browser scaffold), the
leftover-hardening batch, CI/CD (GHCR release image + scaffolded deploy), **P1**
dedupe split-by-source, **P2** S3/R2 EvidenceStore, **P3** the public `/v1/`
read API (= roadmap Step 1), the **post-audit hardening** (B1 RSS boundary, the
live-dry-run batch: token cap + bounded re-ask + prepaid billing, the extraction
input-size cap), the **Firecrawl v2 + Tier-4 inline-scrape** refactor, the
**live-test template**, and **Step 2** (GDPR/affiliate disclosure at publish).
~572 unit tests green; lint + typecheck clean. Deal-record `schema_version` is **3**.

**Architecture health (audited):** clean layering — zero vendor imports in `domain`,
strict DIP (no `new Vendor()` outside `src/composition/container.ts`), every adapter
behind a port with a shared contract suite enforcing LSP. The four committed trust
invariants hold. **The implementation is sound; the foundation is strong.**

**Defaults keep the agentic lane dark/safe:** `AGENT=noop`, `SEARCH_PROVIDER=stub`,
`FETCHER=playwright`, `EVIDENCE_STORE=local`. Do not change these defaults.

**Roadmap position:** post-C **Steps 1 (public read API = P3), 2 (GDPR/affiliate
disclosure), 3 (reliability-blended ranking) AND 4 (scheduler/ops) are DONE + merged.**
Remaining: **Step 5 (observability) ← NEXT**, Step 6 (multi-country). See §4 for each.

---

## 2. The headline: the launch-critical gates are CLOSED; remaining steps are refinements

The original audit's two launch-critical items are both **done + merged**: B1 (the RSS
boundary, §3) and **Step 2** (GDPR/affiliate disclosure, §4). So the public `/v1/` API +
the disclosure fields the landing page legally needs are in place. What remains (Steps 3–6)
is real but **not launch-blocking** — each is a small, mostly decision-gated refinement.

**Recommended next step: Step 5 (observability: alerting + metrics push)** — the
lowest-risk remaining step: a new `Alerting` port + a webhook/Slack adapter, thresholds
in config, hooking the existing warn points (reliability-low, daily-budget). No
schema/trust impact (§4). Step 4 (scheduler/ops) is DONE (§4). Then Step 6 (multi-country,
gated on a PSL adapter).

---

## 3. B1 — RSS feed boundary zod-validation (FIXED 2026-06-20)

_Recorded for the audit trail; no action needed. This was the one broken invariant the
audit found; it was fixed in the same session and is in `KNOWN_ISSUES.md` → Resolved._

### B1. RSS feed items bypassed zod validation at the boundary — FIXED
- **Severity (was):** high (a non-negotiable invariant was cracked; contained blast radius).
- **Location:** `src/adapters/feed/rss-feed-reader.ts:44-63` (`parseFeed`); the port
  `FeedItem` is a plain interface (`src/application/ports/feed-reader.ts`); consumed in
  `src/application/ingest/ingest-community.ts` (triage prompt `:178`, `processLead(item.link)` `:199`, `recordProposal(item.link)` `:213`).
- **What:** `parseFeed` builds `FeedItem[]` (`title`, `link`, `summary`, `publishedAt`)
  from regex-extracted XML with **no `zod.parse()`**. Raw external data flows onward:
  `item.link` → `this.fetcher.fetch(link)` (URL/scheme not validated at the boundary),
  and `item.title`/`item.summary` → the LLM triage prompt.
- **Severity calibration (verified, not assumed):** the LLM-injection path is *already
  mitigated* — `triage-prompt.ts` wraps the item in `frameUntrusted(...)` (the
  prompt-injection fence), and the `link` *does* eventually pass through PoliteFetcher.
  So this is **not** an exploitable injection or robots-bypass today. BUT the stated
  invariant ("never trust raw external data; parse at the boundary") is genuinely
  violated, and `link`'s scheme/format is unvalidated before `fetch()` (a
  `javascript:`/`file:`/non-URL string isn't rejected at the boundary). Fix it — it's
  trust-critical and contained, exactly the "fix-now" case in CLAUDE.md.
- **Fix (done):** `FeedItemSchema` (zod) added in `rss-feed-reader.ts` — `link` validated
  as an http/https URL (via a throw-safe `isHttpUrl` refine), `title`/`summary` strings,
  `publishedAt` ISO-or-null. `parseFeed` `safeParse`s each item and DROPS failures (keeps
  the "bad feed → []"/skip-bad-item resilience). 5 adversarial unit tests added (non-URL
  link, `javascript:`/`file:`/`data:`/`ftp:` schemes dropped, a valid item surviving
  alongside a dropped one, injection strings in title/summary preserved verbatim on a valid
  item — they're framed untrusted downstream by `frameUntrusted`, not parseFeed's job to strip).
- **Verified:** `npm run check` green (537 unit tests); the existing feed-reader contract
  still passes; the boundary invariant now holds.

---

## 4. The remaining roadmap steps (post-C Steps 2–6) — sequence + prerequisites

Each lists **what**, **why-now**, **the decision it needs first (if any)**, the
**code surface**, and **tests required**. **Steps 2, 3 AND 4 are DONE (below, kept for the
record).** Remaining order: **Step 5 (NEXT) → Step 6.** Step 6 (multi-country) is furthest
out (gated on a PSL adapter).

### Step 2 — GDPR + affiliate disclosure at publish — ✅ DONE (merged `4f4f077`, 2026-06-20)
_Shipped as designed: `affiliate_disclosure` (bool, default **true** = over-disclose) +
`published_at` on the deal record (schema **v3**, migration **0010**), set by the reviewer
at the approve path (CLI `--no-affiliate-disclosure` / `/api` approve body; defaults true +
warns when omitted), exposed in the public `/v1/` DTO. Legal-confirmed. Trust-verified
(nothing auto-publishes; every published deal carries a disclosure; DTO leaks nothing new).
Original plan below, retained for context:_
- **What:** add the legally-required disclosure fields to a published deal and surface
  them in the public DTO. EU-Omnibus affiliate disclosure; confirm no-PII /
  own-screenshot-not-republished-T&C posture at the publish boundary.
- **Why now:** the `/v1/` API is live but the **public landing page cannot legally go
  live** off it without these (logged in `docs/KNOWN_ISSUES.md`). It's owner+legal-gated,
  so it has the **longest lead time** — surface it first to unblock the critical path.
- **Decision needed FIRST (owner + legal — do NOT assume; CLAUDE.md: ask before any
  schema/trust change):**
  - *Which fields are mandatory* for a DE price-comparison page — affiliate disclosure
    (bool or text/enum), EU-Omnibus prior-price, a data-processing notice? a
    `published_at` distinct from `verified_at`? a GDPR `legal_basis`?
  - *Who supplies them* — set by the reviewer at approve-time (auditable, never
    LLM-proposed — **recommended**), or derived from the source/affiliate relationship?
  - **Recommendation:** get legal to enumerate the minimum set; model them as typed-core
    fields set at approve-time; add to the public DTO allow-list. Bump `schema_version`.
- **Code surface:** `src/domain/deal-record/deal-record.ts` (additive fields) + a drizzle
  migration (`0009`); the approve path `src/application/review/review.ts` (set at publish);
  the public projection `src/adapters/http/public-dto.ts` (expose them). Keep
  `schema_version` bumped so promoted fields re-parse.
- **Tests:** schema round-trip integration; a unit test that approve sets the field; the
  DTO includes disclosure; **adversarial — a published deal missing a required disclosure
  field is flagged/never served** (the worst case is a non-compliant deal going public).
- **Workflow-shaped?** No — small, decision-gated, trust-critical; do it inline after the
  human decision. `code-reviewer` + an adversarial-verify pass before merge.

### Step 3 — Reliability-driven ranking — ✅ DONE (merged `0c98be8`, 2026-06-20)
_Shipped as an owner-decided **read-time tiebreaker** (no new column, no migration). A
source's `reliability_score` breaks ties on the primary sort key: `cost_asc` (equal
`true_cost_monthly` → reliability DESC → id) and `verified_desc` (equal `verified_at` NULLS
LAST → reliability DESC → id). Resolved by the P1 **registrable-domain** deal→source join
(`deal.source_url` ↔ `source.url`); a deal with no matching active source → **neutral 0.5**
(a real source score of `0` is preserved, not coerced). The raw score is **never exposed** —
order-only; the freshness `trust` badge stays the sole public trust signal (added to the
DTO's `FORBIDDEN_VALUE_KEYS` as defence-in-depth + an adversarial canary test). LSP-by-
construction: one pure ranker (`src/domain/deal-record/published-ranking.ts`) + one
`registrableDomain` used by **both** DB adapters; SQL does only `status`+filters+a
deterministic primary-ordered bounded fetch (`LIMIT PUBLISHED_FETCH_CAP = MAX_OFFSET +
MAX_LIMIT = 10100`), then the shared ranker does the reliability tiebreak + paginate.
`countPublished` unchanged (reliability is order-only, never set membership). code-reviewer
APPROVED + a 4-angle adversarial-verify pass returned SAFE-TO-MERGE (no leak / LSP parity /
pagination-bound / neutral-and-zero all HOLD). 598 unit tests green. Original plan below,
retained for context:_
- **What:** blend `reliability_score` + freshness into the `listPublished` sort; surface
  `verified_at`/a coarse trust signal (already done as the `trust` badge in P3).
- **Audit finding:** `reliability_score` is **fully wired for cadence/back-off**
  (`source-policy.ts applyCrawlOutcome`, applied on BOTH crawl and monitor) but is **NOT
  used in any ranking** and **not exposed** anywhere. Data ready; surface blind.
- **Decision needed:** the ranking formula + whether reliability may *silently* influence
  public order. The raw score must **never** be exposed (the public DTO forbids it; P3's
  trust badge is freshness-only by design). _Owner decisions made: freshness/cost-primary,
  reliability as a TIEBREAKER (both sorts); read-time registrable-domain join; neutral 0.5
  on no-match; raw score never exposed (order-only)._
- **Caveat (from the audit):** a deal's reliability lives on its **source**; the public DTO
  has `source_url` but no source join. P1 split-by-source means each deal already carries
  a clean `source_url`, so the deal→source join is now well-defined — but confirm the join
  path when implementing (it touches the `listPublished` query). _Resolved: matched by
  `registrableDomain` (the P1 dedupe fold), so `finalUrl` ≠ canonical `url` still joins._
- **Code surface:** the `listPublished` sort (`PublishedSort` in
  `src/domain/deal-record/published-query.ts` + both DB adapters); the public DTO badge.
  _As built: new pure `src/domain/deal-record/published-ranking.ts` (the formula + the
  join); both `listPublished` adapters call it; both deal repos now reach the source repo._
- **Tests:** pure ranking-function unit tests (table-driven); integration that sort order
  reflects reliability + freshness; LSP parity across both adapters (the new sort must
  match in-memory ↔ Postgres, per the existing contract pattern). _As built: 21 pure unit
  tests; 4 reliability cases in the shared `database-contract` (both tiers); a reliability-
  ordering integration test; a reliability no-leak canary in the DTO contract test._
- **Workflow-shaped?** No — small, formula-driven, depends on P3's sort (done).
- **Follow-up logged** (`docs/KNOWN_ISSUES.md`, low): `listPublished` rebuilds the
  reliability index from a full active-source scan per public request — fine at DE-v1 scale,
  cache/fold-into-SQL when source count or `/v1/` traffic grows.

### Step 4 — Scheduler / unattended-run harness — ✅ DONE (merged `<set-on-merge>`, 2026-06-20)
_Shipped as the owner-decided **external-cron** model (pg-boss stays unwired). Two
workstreams: **(A) Prereq A trust fix** + **(B) scheduler templates**._
- **(A) Prereq A — resolved-URL tracking (the trust-critical part).** A nullable
  `resolved_url` on the Source (schema + migration **0011**, additive/backfill-safe) is set
  on the **first successful crawl/monitor pass** (= `fetched.finalUrl`, via the shared pure
  `applyCrawlOutcome`, success-only + never overwritten with undefined). Monitor now matches
  its source-scoped expiry + diff-baseline on `resolved_url ?? url` (the `dealMatchUrl`
  helper) — so a **redirecting source's published deals now auto-expire** (deals are keyed by
  `finalUrl`; before, monitor keyed off the configured `url` and never matched). Existing
  rows are `NULL` → fall back to `url`, self-healing on the next crawl. Unit (crawl sets it /
  failed pass preserves it / all `applyCrawlOutcome` permutations / monitor expires a
  redirecting source) + integration (real Container+Postgres end-to-end: redirecting source →
  published deal **does** expire) + contract round-trip. **Prereq B (pg-boss pool bound +
  source advisory lock) is N/A** — pg-boss stays unwired in the external-cron model; it stays
  deferred in `docs/KNOWN_ISSUES.md` against the day pg-boss is wired.
- **(B) Scheduler templates (config/docs, no composition change).** `deploy/k8s/cronjobs.yaml`
  (ConfigMap + Secret + 4 CronJobs: `crawl --due` 6h / `monitor --due` 3h / `ingest
  --community-due` hourly / `discover --broad` daily, **discover `suspend: true`**), a guarded
  opt-in `.github/workflows/scheduled.yml` (cron commented + `SCHEDULED_LANES_ENABLED` var +
  `production` Environment), and `deploy/README.md` (cadence rationale, env/secrets, trust
  posture). Safe-by-default: Tier-4 off, agentic lanes dark, `EVIDENCE_STORE=s3` required
  under cron (ephemeral pod FS), `concurrencyPolicy: Forbid`. code-reviewer APPROVED +
  adversarial-verify clean. 607 unit tests green. Original plan below, retained for context:_
- **What:** make the lanes actually RUN on a schedule. Today it's **pure external-cron**:
  the Docker entrypoint runs migrations then the CLI; the `Queue` (pg-boss) port exists
  but is **intentionally unwired** (`container.ts` does not instantiate it). No crontab /
  K8s CronJob / scheduled Action in the repo.
- **Why it matters:** the pipeline is a library, not a self-running app — if external cron
  is misconfigured or down, it silently stops. Highest *operational* risk for going live.
- **Decision needed:** external-cron (the standing decision) vs wire the in-process pg-boss
  worker now? **Recommendation:** ship **deployment templates + a documented cron schedule**
  (K8s CronJob / ECS scheduled task / a `schedule`-triggered Action invoking the GHCR image
  with `crawl --due` / `monitor --due` / `ingest --community-due` / `discover --broad`) for
  v1; build pg-boss only when concurrency/autonomy justify it.
- **⚠️ TWO PREREQUISITES that become BLOCKING when unattended scheduling lands** (both in
  `docs/KNOWN_ISSUES.md` today, deferred — promote them when starting Step 4):
  1. **Monitor source-scoped lookups key off `source.url`, not the resolved `finalUrl`**
     (`src/application/monitor/monitor-source.ts:251,273-274`). For a source whose URL
     redirects, every monitor pass looks like first-observation and
     `expirePublishedBySourceUrl(source.url, …)` never matches → **published deals from a
     redirecting source never auto-expire**. Fine while a human runs monitor occasionally;
     a real trust gap under unattended scheduling. Fix: track the resolved URL on the
     source (set on first successful crawl) and have monitor match on it.
  2. **If pg-boss is wired:** bound its pool (KNOWN_ISSUES "pg-boss queue pool not bounded")
     so the DB pool + queue pool caps sum to a known ceiling, and add the source-level
     advisory lock (concurrency becomes real — two workers must not crawl one source at once).
- **Code surface:** deployment manifests/templates + docs (the `deploy.yml` scaffold is the
  hook); OR the composition root + pool bound + advisory lock if pg-boss.
- **Tests:** templates → review + dry-run; pg-boss → unit + integration for the worker.
- **Workflow-shaped?** No — config/ops + one decision.

### Step 5 — Observability: alerting + metrics push (OPS)
- **What:** move from pull-only `stats` to proactive signals — alert on failed sources,
  reliability-low flags, cost-spike / daily-budget breaches, (if pg-boss) queue depth.
- **Audit finding:** metrics are pull-only (`stats` CLI over `crawl_runs`); reliability-low
  emits a single `logger.warn`; no alerting/push/dashboards. A silent-failure blind spot at scale.
- **Decision needed:** the ops backend (Datadog/CloudWatch/Grafana/Slack-webhook) — drives
  the adapter. **Recommendation:** a small `Alerting` port + a webhook/Slack adapter;
  thresholds in config; hook the existing warn points (crawl-source reliability-low, the
  daily-budget guard). Lowest-risk step — pure adapter work behind a new port (OCP), no
  schema/trust impact.
- **Tests:** port contract suite + unit; thresholds are pure logic → table-driven.
- **Workflow-shaped?** Partly (discrete signal types could fan out) but small; likely inline.

### Step 6 — Multi-country generalization (LATER — only when expanding)
- **Audit finding (HIGH, but .de-v1-scoped):** hard-coded DE/EUR —
  `Country = z.enum(['DE'])`, `Currency = z.enum(['EUR'])`
  (`src/domain/deal-record/enums.ts:27,31`); and `registrableDomain`
  (`src/domain/discovery/links.ts:81-86`) is an eTLD+1 approximation (last two labels)
  that **breaks on multi-label TLDs** (`www.bbc.co.uk` → `co.uk`), which would corrupt the
  split-by-source dedupe key the moment a `.co.uk`/`.com.au` source appears.
- **Why later:** v1 is DE-only by design; not a v1 bug. Flagged so it isn't a landmine.
- **Hard prerequisite:** a real **Public Suffix List adapter** (behind a small port) before
  any second country — dedupe correctness depends on it. Then de-hardcode the
  `Country`/`Currency` enums + per-country vocab/deny-list/queries (those are data, already
  parameterizable).
- **Workflow-shaped?** No.

---

## 5. Other findings worth knowing (deduped; full detail in `docs/KNOWN_ISSUES.md`)

**HIGH — deployment-config gate (not code):**
- **CDN must expose ONLY `screenshot.png`, not the whole evidence bundle.** A bundle stores
  `screenshot.png` + `page.html` + `terms.txt` + `evidence.json` under one `<id>/` prefix
  (`s3-evidence-store.ts`, names from `src/domain/evidence/evidence-layout.ts`). The public
  DTO only emits the screenshot URL, but if `S3_CDN_BASE_URL` fronts the prefix publicly, a
  consumer can edit `…/<id>/screenshot.png` → `…/<id>/terms.txt` and fetch the verbatim
  copyrighted terms text the DTO deliberately drops. **Before pointing `S3_CDN_BASE_URL` at a
  public bucket:** scope the bucket/CDN policy to `*/screenshot.png`, or copy only the
  screenshot to a separate public prefix/bucket. Already logged in KNOWN_ISSUES + documented
  next to the env var.

**MEDIUM — promote when their trigger nears (currently deferred):**
- **Postgres `Database` contract suite never runs in CI + not isolated** (`postgres-db.test.ts`,
  `vitest.integration.config.ts`). The LSP gate the testing rules *claim* runs server-side is in
  fact dormant. Fix before relying on the contract as an LSP gate — relevant the moment a new
  DB adapter or a schema change lands (Step 2's migration is one). Fix: a `resetBetweenTests`
  truncate hook + wire `postgres-db.test.ts` into the integration config.
- **Ingest-community cost-on-failure not credited** — a bounded budget undershoot; harmless now.

**LOW — safely deferrable (valid fix-when triggers in KNOWN_ISSUES):** screenshot
height-detection fallback, JSON-recovery heuristic, charset guard, robots cross-origin
redirect, monitor re-crawl headroom clamp, two EvidenceStore error-class names, the
interactive multi-step BrowserAgent ("Option B").

## 6. Doc / hygiene — ✅ DONE (2026-06-20 doc audit)
- `docs/NEXT_SESSION_HANDOFF.md` — **deleted** (fully redundant; its env facts live in §8 here).
- `docs/DealRoute_PostC_Handoff.md` + the delivered build plans (P3 handoff, Phase_C_Plan,
  Hardening) — **banner-marked** (SUPERSEDED / ✅ DELIVERED). "CI jobs not dependency-ordered"
  confirmed fixed + not lingering. CLAUDE.md carries a full **Docs map** (purpose + status +
  source-of-truth + the doc-hygiene rule) — keep it accurate when adding/retiring a doc.

## 7. Open decisions needing the OWNER (gate the next steps — not defaultable)
1. **GDPR/affiliate disclosure (Step 2 — blocks the public page):** ✅ DECIDED + DONE.
   `affiliate_disclosure` (bool, default true) + `published_at`, reviewer-set at approve, DTO allow-list.
2. **CDN exposure scope (the deployment gate):** same S3 prefix as the bundle, or a separate
   public prefix? *Rec: separate public prefix; never make the bundle prefix listable.* (Still open — deploy gate.)
3. **Reliability ranking exposure (Step 3):** ✅ DECIDED + DONE. Reliability may silently
   influence public order as a TIEBREAKER (freshness/cost-primary); raw score never exposed (order-only).
4. **Scheduler model (Step 4):** ✅ DECIDED + DONE. External-cron templates (K8s CronJobs +
   a guarded scheduled Action + docs); pg-boss stays unwired (its pool-bound + advisory-lock
   prereqs stay deferred in KNOWN_ISSUES against the day it's wired). Prereq A (monitor
   resolved_url) fixed.
5. **Observability backend (Step 5 — NEXT):** Datadog/CloudWatch/Grafana/Slack-webhook?
   *Rec: a small `Alerting` port + a webhook/Slack adapter; thresholds in config; hook the
   existing reliability-low + daily-budget warn points.*

## 8. Workflow / environment facts (these bit earlier sessions — don't rediscover)
- You're in a git **worktree** on your own branch. The runtime `.env` (real keys) lives only
  in the main repo root. To run real LLM/fetch/S3 from a worktree, copy `.env` in temporarily
  (gitignored) and delete after — or run from the main worktree. Dry-run/tests need no keys.
- **Run gates from your own worktree** (`git rev-parse --abbrev-ref HEAD` first; a stray `cd`
  to the main repo runs stale code).
- **No local Docker/Postgres** → integration tests self-skip; CI is their first real run.
  After writing integration tests you can't run, **statically verify** (trace assertions
  against the real adapter) before relying on CI.
- **Merge to `master` via fast-forward only.** `master` is checked out in the MAIN worktree, so
  `git branch -f master` from your worktree fails — push the branch commit straight to origin
  with `git push origin HEAD:master` (a clean ff when origin hasn't advanced). A push can be
  rejected if origin advanced mid-flight — `git fetch`, `git rebase origin/master`, re-run
  `npm run check`, then push. The main worktree's local `master` then needs a `git pull`.
- **Migrations:** edit `schema.ts` → `npm run db:generate` → commit the generated
  `drizzle/*.sql` + `drizzle/meta/*` (in `.prettierignore` — don't reformat). Latest is `0010`.
- **No `Co-Authored-By` trailer** on commits (global user rule). Husky pre-commit runs
  prettier + eslint + typecheck on staged files.
- **ultracode pattern:** drive each trust-critical change as a Workflow (implement →
  independent adversarial verifiers on the invariants), then `code-reviewer` as the merge
  gate, fix findings, merge. B1 and Step 2 are exactly what to adversarially verify.

## 9. First moves for the fresh session
1. Confirm orientation reads + green baseline (`npm install && npm run check && npm run build`).
   Steps 1 + 2 + 3 + 4 are DONE — no foundation repair pending; you're starting Step 5.
2. **Build Step 5 — observability: alerting + metrics push** (§4). The decision it needs first
   (put to the owner via `AskUserQuestion`): the ops backend (Datadog/CloudWatch/Grafana/
   Slack-webhook), which drives the adapter. Recommend a small `Alerting` port + a webhook/
   Slack adapter, thresholds in config, hooking the existing warn points — crawl-source
   reliability-low (`source-policy.isReliabilityLow`) and the daily-budget guard. It's the
   lowest-risk step: pure adapter work behind a new port (OCP), no schema/trust impact.
   Tests: port contract suite + unit; thresholds are pure logic → table-driven.
3. Then Step 6 (multi-country, gated on a real PSL adapter — `registrableDomain` eTLD+1
   breaks on multi-label TLDs like `.co.uk`; de-hardcode the `Country`/`Currency` enums).
4. Every change: unit + integration tests (live for new external edges); `code-reviewer` +
   an adversarial-verify pass on anything trust/publish/schema; docs updated (CLAUDE.md
   Commands + Repo layout, README, ARCHITECTURE, roadmap §5; **and `docs/testing/LIVE_TEST_TEMPLATE.md`
   when a feature adds a recordable field**). Nothing auto-publishes; the public feed serves only
   `published` deals via the deliberate DTO; defaults unchanged.

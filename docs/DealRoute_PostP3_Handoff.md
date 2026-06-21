# DealRoute — Post-P3 audit & next-steps handoff

_Self-contained next-steps brief for a FRESH Claude Code session. Originally written
after a full audit on **2026-06-20**; **kept current** as work merged. `master` is at
**`e22635d`** (review-API edit/promote/manual-capture/filters + schema v5, 2026-06-21;
was `849caee` at the best-effort-read policy merge). **ALL post-C Steps 1–6 are DONE + merged
(1 public API, 2 GDPR/affiliate disclosure, 3 reliability ranking, 4 scheduler, 5 observability,
6 multi-country foundation). The pipeline is post-C FEATURE-COMPLETE for DE v1** — no
roadmap step remains; what's left is the deferred-findings register (`docs/KNOWN_ISSUES.md`)
+ (only when expanding) actually enabling a 2nd country (data/config behind the now-extensible
seams). This supersedes
`docs/DealRoute_PostC_Handoff.md` (kept, banner-marked). (`NEXT_SESSION_HANDOFF.md` was deleted.)_

> **⚠️ POLICY CHANGE since the audit (`849caee`, 2026-06-21):** the **"public pages only"
> non-negotiable invariant was REVERSED** to **best-effort read any page** (owner decision).
> `RESPECT_ROBOTS_TXT` now defaults **off**; login-wall / soft-block pages are read best-effort
> (must-review); a `captcha` page still → manual-capture; soft-404/maintenance/expired still
> skip; monitor still neutral on walls; the per-domain rate-limit still always applies; no login
> automation yet (deferred — see KNOWN_ISSUES). See `CLAUDE.md` → "Best-effort read any page" for
> the canonical statement + the EU/DE legal-exposure note (revisit at launch/legal review).

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
> auto-expire**, migration **0011**) · **Step 5** (observability: a new `Alerting` port +
> `NoopAlerter`/`WebhookAlerter` — webhook+Slack — wired at the source-reliability-low + daily-
> budget-reached warn points; best-effort, dark by default `ALERT_KIND=noop`; Datadog/CloudWatch
> deferred per `docs/DealRoute_Observability.md`; NO schema change) · **Step 6** (multi-country
> FOUNDATION, DE stays the only enabled country: a real Public Suffix List via `tldts` behind a pure
> `SuffixOracle` — the naive last-two-labels `registrableDomain` is gone; `source_registrable_domain`/
> `registrable_domain` PINNED at extract/source-create/seed-import so dedupe + the reliability join read
> a frozen field, schema **v4**, migration **0012**; config-driven `MARKETS` registry → closed
> `Country`/`Currency` enums + a per-country currency trust rule; DE byte-identical, no dedupe churn)
> · **Review-API extension** (merge **`e22635d`**, 2026-06-21 — NOT a numbered roadmap step; an admin
> capability add): four new gated `/api/*` review actions (CLI + HTTP, Bearer-gated writes, audited,
> none auto-publish) — `PATCH /api/candidates/:id` reviewer edit (pure `applyCandidatePatch` allowlist;
> identity/provenance/status not editable; re-validates; tags every changed field in `human_edited` so a
> corrected value is never read as model-grounded; model grounding kept-but-flagged; status stays
> `candidate`; a later approve publishes the edited record), `POST /api/field-proposals/:key/promote`
> (→ a `condition_vocabulary` row + proposal resolved; `target:"field"` → 400, deferred),
> `POST /api/manual-capture-tasks/:id/complete` (evidence REQUIRED by **reference** — screenshot/html/terms
> refs + inline terms text; source_url pinned from evidence; mints a `candidate`, never publishes),
> `GET /api/candidates` filters + pagination. New ports: `ConditionVocabularyRepository` (first typed port
> for the existing table), `FieldProposalRepository.getByKey/markPromoted`, `ManualCaptureRepository.getById/
> markDone`, `DealRepository.listCandidates(filter)` — LSP-identical in both adapters + contract-parity-tested.
> Deal-record schema **v5**, migration **`0013`**: additive `human_edited: string[]` (default `[]`, never
> LLM-proposed, surfaced in the public DTO). 3 deferred items logged in `KNOWN_ISSUES.md` (manual-capture
> upload channel, `target:"field"` promotion, the keep-grounding stale-quote residual risk).
> Deal-record `schema_version` is now **5**; latest migration is now **`drizzle/0013`**.

> Binding rules still govern: `CLAUDE.md` + `.claude/rules/`
> (`architecture.md`, `code-style.md`, `extraction-and-schema.md`, `testing.md`).
> Companions: `docs/DealRoute_Crawl_Pipeline_Plan.md` (master design),
> `docs/DealRoute_Phase_C_and_Roadmap.md` §5 (the roadmap), `docs/KNOWN_ISSUES.md`
> (deferred-findings register). The P3 build record is `docs/DealRoute_P3_PublicAPI_Handoff.md`.

---

## 0. Orient first (before any code)

1. Read `CLAUDE.md` + the auto-loaded `.claude/rules/` — **binding**.
2. Green baseline from YOUR OWN worktree: `git rev-parse --abbrev-ref HEAD`, then
   **`npm install && npm run check && npm run build`**. Expect ~733 unit/contract tests +
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
- **Best-effort read any page** (2026-06-21; ⚠️ REVERSES the former "Public pages only"
  invariant — owner decision). `RESPECT_ROBOTS_TXT` now defaults **off** (the robots gate
  in `PoliteFetcher` stays, opt-in via `=true`); login-wall / soft-block pages are read
  best-effort (`page-classifier` → `ok` + `fetchSignal`, candidate stays must-review). Still
  holds: `PoliteFetcher` (per-domain rate-limit + size caps) decorates *every* inner fetcher;
  a `captcha` page still → manual-capture; soft-404/maintenance/expired still skip (`error`);
  **no login automation anywhere** (no credential system yet — deferred). See `CLAUDE.md` →
  "Best-effort read any page" for the canonical statement + the legal-exposure note.
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
disclosure), 3 (reliability-blended ranking), 4 (scheduler/ops), 5 (observability) AND 6
(multi-country foundation) are ALL DONE + merged.** No roadmap step remains — the pipeline
is **post-C feature-complete for DE v1**. See §4 (all six marked ✅).

---

## 2. The headline: the launch-critical gates are CLOSED; remaining steps are refinements

The original audit's two launch-critical items are both **done + merged**: B1 (the RSS
boundary, §3) and **Step 2** (GDPR/affiliate disclosure, §4). So the public `/v1/` API +
the disclosure fields the landing page legally needs are in place. What remains (Steps 3–6)
is real but **not launch-blocking** — each is a small, mostly decision-gated refinement.

**No recommended next step — all post-C roadmap steps (1–6) are DONE.** The pipeline is
post-C feature-complete for DE v1. The only forward work is **enabling a real 2nd country**
when the business decides to expand (data/config behind the Step-6 seams: a MARKETS row +
per-country seeds/vocab/deny-list/queries; see the KNOWN_ISSUES "multi-country enablement"
entry), plus working down the deferred-findings register (`docs/KNOWN_ISSUES.md`).

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
**code surface**, and **tests required**. **ALL of Steps 2–6 are DONE (below, kept for the
record).** No roadmap step remains; the pipeline is post-C feature-complete for DE v1.

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

### Step 4 — Scheduler / unattended-run harness — ✅ DONE (merged `6822a45`, 2026-06-20)
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

### Step 5 — Observability: alerting + metrics push — ✅ DONE (merged `79bada3`, 2026-06-21)
_Shipped the alerting spine as an owner-decided **generic webhook + Slack** first cut (OCP — more
backends slot in later). A new `Alerting` port (`alert(event): Promise<void>`, **best-effort: never
throws, so it can't crash a lane** — pinned by a shared contract suite); a pure vendor-neutral
`AlertEvent` + builders (`src/domain/alerting/`); a `NoopAlerter` (DEFAULT off-switch — logs at
debug, delivers nowhere) + a `WebhookAlerter` (POSTs JSON; Slack-renders the top-level `text`, plus
the structured event for a generic collector; timeout-bounded, failures swallowed). Config-selected
(`ALERT_KIND` `noop|webhook`, `ALERT_WEBHOOK_URL`, `ALERT_TIMEOUT_MS`; dark by default), injected
from the one composition root into the two wired warn points: **source reliability-low** (crawl +
monitor) and **daily-budget reached** (the guard). No schema/trust impact. The **Datadog/CloudWatch
metrics-push adapters are DEFERRED** (owner: too heavy for v1; the recipe to build them via the
same port is in `docs/DealRoute_Observability.md` + KNOWN_ISSUES). 630 unit tests + a config + an
integration test (stub alerter fires through the real Container). code-reviewer + verify clean.
Original plan below, retained for context:_
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

### Step 6 — Multi-country FOUNDATION — ✅ DONE (merged `49a228e`, 2026-06-21)
_Shipped the multi-country PREREQUISITES (DE stays the only ENABLED country — no real 2nd
country wired, per the owner decision). Three parts:_
- **(1) Real Public Suffix List.** The naive last-two-labels `registrableDomain` (wrong on
  multi-label TLDs like `.co.uk`) is GONE; resolution now goes through a pure domain type
  `SuffixOracle` (`src/domain/discovery/suffix-oracle.ts`, zero imports) backed by the `tldts`
  package (pinned exact `7.4.3`) in `src/adapters/suffix/tldts-suffix-oracle.ts`, injected from the
  one composition root. **DE byte-identical** (golden gate `test/golden/suffix-equivalence.golden.test.ts`
  proves old==new for every single-label-suffix host → no dedupe churn; multi-label cases now
  correct). One documented IDN divergence (raw umlaut → Unicode vs punycode; no DE host today) in
  KNOWN_ISSUES.
- **(2) Pinned registrable domain (schema v4, migration 0012, additive nullable).**
  `deal.source_registrable_domain` + `source.registrable_domain` are resolved ONCE via the PSL at
  extract / source-create / **seed-import** and PINNED, so the trust-critical sync rules
  (`dedupeKey`, the `comparePublished` sort comparator, `buildReliabilityIndex`/`resolveReliability`)
  read a frozen field — no PSL call inside `Array.sort`, structurally. No data backfill (existing
  rows self-heal on re-crawl; null → unknown-source dedupe / neutral reliability).
- **(3) Config-driven markets.** `src/domain/markets/markets.ts` (MARKETS, DE→{EUR}); the
  `Country`/`Currency` enums are DERIVED from it but STILL closed `z.enum`s (out-of-scope rejected at
  the boundary); the DE⇒EUR currency trust rule generalized to `isCurrencyAllowedForCountry`
  (mismatch → must-review, unchanged strictness). "Add a country" = one MARKETS data row + per-country
  seed/vocab/deny-list/query DATA (a follow-up, logged in KNOWN_ISSUES) — NO logic edit.
- code-reviewer caught + I FIXED a blocker (seed-import was leaving registrable_domain null →
  seeds would fold to neutral reliability) + a 4-angle adversarial-verify pass. ~662 unit tests green.
  **Step 6 was the LAST post-C step — the pipeline is now post-C feature-complete for DE v1.**
  Original plan below, retained for context:_
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

**Deploying the admin API (`serve`) for the production admin panel:**
- The admin panel consumes the gated `/api/*` router; `serve` (`src/adapters/cli/commands/serve.ts`)
  is ONE long-running process mounting `/api/*` (Bearer-gated writes) + `/v1/*` (public feed) +
  the test page on `REVIEW_API_PORT`. This is a **persistent service**, not a cron lane — give it a
  stable HTTPS URL behind a reverse proxy/ingress (`serve` speaks plain HTTP, binds `0.0.0.0`).
- **Browser-panel CORS on `/api/*` (added 2026-06-21).** The admin router now emits CORS headers +
  answers the `OPTIONS` preflight when `ADMIN_CORS_ORIGIN` is set (the panel's exact origin; NOT
  `*` — the surface is credentialed). Unset ⇒ no CORS headers (same-origin / server-to-server
  default). Preflight is not auth-gated (it carries no bearer); CORS headers ride every response
  incl. 401/404 so the browser can read the real status. Mirrors the public router's
  `PUBLIC_CORS_ORIGIN`. Without this a cross-origin browser panel could not call `/api/*` at all.
- **Runtime env the API needs:** `REVIEW_API_TOKEN` (mandatory once publicly reachable — the panel
  sends `Authorization: Bearer <token>`; unset = open writes), `ADMIN_CORS_ORIGIN`, `DATABASE_URL`
  (same prod PG), and `EVIDENCE_STORE=s3` + `S3_*` (+ `S3_CDN_BASE_URL` for screenshot URLs) so the
  panel's evidence views + manual-capture resolve refs. Per-user/SSO auth is still deferred (no
  credential system); v1 is the shared static bearer.

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
5. **Observability backend (Step 5):** ✅ DECIDED + DONE. Generic webhook + Slack
   (`WebhookAlerter`) behind a new `Alerting` port; reliability-low + daily-budget wired;
   Datadog/CloudWatch deferred (recipe in `docs/DealRoute_Observability.md`).

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
   **ALL post-C steps (1–6) are DONE — the pipeline is post-C feature-complete for DE v1.** No
   roadmap step is pending; no foundation repair pending.
2. **There is no next roadmap step.** Forward work, when the business calls for it:
   - **Enable a real 2nd country** (Step 6 built the foundation): add a `MARKETS` row
     (`src/domain/markets/markets.ts`) + the country's seed sources, catalog vocab, deny-list, and
     Tier-4 intent queries (all data, behind the now-extensible seams). NO logic change. See the
     KNOWN_ISSUES "multi-country enablement" entry. Ask the owner before enabling (it's a scope call).
   - **Work down `docs/KNOWN_ISSUES.md`** — the deferred-findings register (e.g. the Postgres
     contract-suite CI gap, the per-request active-source scan, the raw-IDN suffix normalisation,
     the pg-boss pool bound if/when pg-boss is wired). Pick by the listed fix-when triggers.
   - **Operate / curate**: real seed-list curation + live tests (the per-source fetcher-selection
     findings), the deploy-time CDN scoping gate, etc.
4. Every change: unit + integration tests (live for new external edges); `code-reviewer` +
   an adversarial-verify pass on anything trust/publish/schema; docs updated (CLAUDE.md
   Commands + Repo layout, README, ARCHITECTURE, roadmap §5; **and `docs/testing/LIVE_TEST_TEMPLATE.md`
   when a feature adds a recordable field**). Nothing auto-publishes; the public feed serves only
   `published` deals via the deliberate DTO; defaults unchanged.

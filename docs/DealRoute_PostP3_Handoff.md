# DealRoute — Post-P3 audit & next-steps handoff

_Self-contained next-steps brief for a FRESH Claude Code session. Originally written
after a full audit on **2026-06-20**; **kept current** as work merged. `master` is at
**`4f4f077`**. **Post-C Steps 1 (P3 public API) AND 2 (GDPR/affiliate disclosure) are
DONE + merged; the next step is Step 3 (reliability ranking).** This supersedes
`docs/DealRoute_PostC_Handoff.md` and `docs/NEXT_SESSION_HANDOFF.md` (both pre-this-track, stale)._

> **What shipped since the original audit** (all merged to `master`, in order):
> B1 RSS-boundary fix · the live-dry-run hardening batch (raised `LLM_MAX_OUTPUT_TOKENS`
> default + a `.min` floor; a bounded LLM re-ask on parse/schema failure; **prepaid**
> billing + `prepaid_months` amortisation, schema v2) · an extraction input-size cap
> (giant pages trimmed, not crashed) · **Firecrawl v2** refactor + opt-in Tier-4
> **inline scrape** (gated by `PoliteFetcher.checkAccess`, `AGENT_INLINE_SCRAPE`) ·
> the **live-test template** `docs/testing/LIVE_TEST_TEMPLATE.md` (+ a recorded run in
> `docs/testing/results/`) · the Firecrawl reference `docs/Firecrawl_Integration_Reference.md`
> · **Step 2** (`affiliate_disclosure` default-true + `published_at`, set at approve,
> in the public DTO; schema **v3**, migration **0010**). Deal-record `schema_version`
> is now **3**; latest migration is **`drizzle/0010`**.

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

**Roadmap position:** post-C **Step 1 (public read API = P3) and Step 2 (GDPR/affiliate
disclosure) are DONE + merged.** Remaining: **Step 3 (reliability ranking) ← NEXT**, Step 4
(scheduler/ops), Step 5 (observability), Step 6 (multi-country). See §4 for each.

---

## 2. The headline: the launch-critical gates are CLOSED; remaining steps are refinements

The original audit's two launch-critical items are both **done + merged**: B1 (the RSS
boundary, §3) and **Step 2** (GDPR/affiliate disclosure, §4). So the public `/v1/` API +
the disclosure fields the landing page legally needs are in place. What remains (Steps 3–6)
is real but **not launch-blocking** — each is a small, mostly decision-gated refinement.

**Recommended next step: Step 3 (reliability-blended ranking)** — a pure feature step with
no external dependency (see §4). Then Step 4 (scheduler/ops, + its two prerequisites),
Step 5 (observability), Step 6 (multi-country, gated on a PSL adapter).

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
**code surface**, and **tests required**. **Step 2 is DONE (below, kept for the record).**
Remaining order: **Step 3 (NEXT) → Step 4 (+ its two prerequisites) → Step 5 → Step 6.**
Steps 3–5 are independent and can reorder; Step 6 is furthest out.

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

### Step 3 — Reliability-driven ranking + surface `last_verified` (TRUST MATURATION)
- **What:** blend `reliability_score` + freshness into the `listPublished` sort; surface
  `verified_at`/a coarse trust signal (already done as the `trust` badge in P3).
- **Audit finding:** `reliability_score` is **fully wired for cadence/back-off**
  (`source-policy.ts applyCrawlOutcome`, applied on BOTH crawl and monitor) but is **NOT
  used in any ranking** and **not exposed** anywhere. Data ready; surface blind.
- **Decision needed:** the ranking formula + whether reliability may *silently* influence
  public order. The raw score must **never** be exposed (the public DTO forbids it; P3's
  trust badge is freshness-only by design).
  - **Recommendation:** read-time sort (no new column); freshness-primary with reliability
    as a hidden down-weight/tiebreaker. Confirm the owner is comfortable with reliability
    silently influencing public order.
- **Caveat (from the audit):** a deal's reliability lives on its **source**; the public DTO
  has `source_url` but no source join. P1 split-by-source means each deal already carries
  a clean `source_url`, so the deal→source join is now well-defined — but confirm the join
  path when implementing (it touches the `listPublished` query).
- **Code surface:** the `listPublished` sort (`PublishedSort` in
  `src/domain/deal-record/published-query.ts` + both DB adapters); the public DTO badge.
- **Tests:** pure ranking-function unit tests (table-driven); integration that sort order
  reflects reliability + freshness; LSP parity across both adapters (the new sort must
  match in-memory ↔ Postgres, per the existing contract pattern).
- **Workflow-shaped?** No — small, formula-driven, depends on P3's sort (done).

### Step 4 — Scheduler / unattended-run harness (OPS; highest operational risk)
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

## 6. Doc / hygiene to clean up (cheap, do opportunistically)
- **Delete `docs/NEXT_SESSION_HANDOFF.md`** — pre-Phase-C, superseded. It is still
  referenced from `CLAUDE.md:8` — remove/repoint that line to this doc.
- **`docs/DealRoute_PostC_Handoff.md`** — its Step 1 is done (P3); add a one-line banner that
  this doc supersedes it for the post-P3 track (or fold it in).
- "CI jobs not dependency-ordered" is **fixed** (`.github/workflows/ci.yml:37` has
  `needs: check`) — confirm it's not lingering as an open KNOWN_ISSUES entry.

## 7. Open decisions needing the OWNER (gate the next steps — not defaultable)
1. **GDPR/affiliate disclosure (Step 2 — blocks the public page):** which fields are
   legally mandatory on a published DE deal, and who supplies them (reviewer at approve-time
   vs derived)? *Rec: legal enumerates the minimum; reviewer-set typed fields; DTO allow-list.*
2. **CDN exposure scope (the deployment gate):** same S3 prefix as the bundle, or a separate
   public prefix? *Rec: separate public prefix; never make the bundle prefix listable.*
3. **Reliability ranking exposure (Step 3):** may reliability silently influence public order
   (raw score never exposed)? *Rec: yes — freshness-primary, reliability as hidden down-weight.*
4. **Scheduler model (Step 4):** external cron (current) or in-process pg-boss? *Rec: external
   cron for v1; pg-boss only when concurrency justifies (then bound the pool + advisory lock).*

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
   Steps 1 + 2 are DONE — no foundation repair pending; you're starting Step 3.
2. **Build Step 3 — reliability-blended ranking** (§4). The one decision it needs first
   (put to the owner via `AskUserQuestion`): the ranking formula + whether reliability may
   *silently* influence public order — the raw `reliability_score` must **never** be exposed
   (the public DTO's `trust` badge is freshness-only by design). Recommend read-time sort
   (no new column), freshness-primary with reliability as a hidden down-weight. NB the
   deal→source join is now well-defined (P1 split-by-source gives each deal a clean `source_url`).
3. Then Step 4 (scheduler + its two prerequisites: monitor-finalUrl + Postgres-contract-isolation)
   → Step 5 (observability) → Step 6 (multi-country, gated on the PSL adapter).
4. Every change: unit + integration tests (live for new external edges); `code-reviewer` +
   an adversarial-verify pass on anything trust/publish/schema; docs updated (CLAUDE.md
   Commands + Repo layout, README, ARCHITECTURE, roadmap §5; **and `docs/testing/LIVE_TEST_TEMPLATE.md`
   when a feature adds a recordable field**). Nothing auto-publishes; the public feed serves only
   `published` deals via the deliberate DTO; defaults unchanged.

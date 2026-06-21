# DealRoute — LLM Crawling & Extraction Pipeline (Design Plan)

> **📍 SOURCE OF TRUTH: the founding design (EVERGREEN).** The principles, the
> four-tier source model, the two-lane architecture, the deal-record shape, and the
> trust invariants here still govern and are reflected in the code. This is the
> "why it's built this way" reference — not a build queue. For what's built vs. next,
> see `docs/DealRoute_PostP3_Handoff.md` (current) + `docs/DealRoute_Phase_C_and_Roadmap.md` §5.

*Plan only — no code. This feeds a later Claude Code prompt. Scope: Germany v1, ~top 25 subscriptions. Output = the structured "deal record." The LLM proposes; a human approves (review stays a separate manual step).*

## 1. Principles
- **Verification-first.** The pipeline exists to produce trustworthy, evidence-backed deal records cheaply. Optimise for *minutes-to-verified* and *cost-to-keep-fresh*.
- **LLM proposes, humans approve.** The LLM never publishes. It outputs *candidates* + a confidence score + grounding evidence.
- **Deterministic where we can, agentic only where we must** (for cost and reliability).
- **Everything leaves an evidence trail.**

## 2. What the pipeline produces
- **`deal record`** (primary) — the structured route object from the stack plan: service, route_type, provider, price/billing/currency, true_cost, country, eligibility{new_customer, residency_kyc, plan_tier, min_spend, stackable}, validity, source_url, evidence_id, **confidence**, **grounding snippets**, status.
- Supporting tables: **`sources`** (seed + discovered URLs), **`candidates`** (pre-review), **`crawl_runs`**, **`evidence`**, **`changes`** (diffs), **`subscription_catalog`** (the 25), **`condition_vocabulary`** (canonical condition keys), **`field_proposals`** (LLM-suggested new keys).
- **Extensible by design:** a small **typed core** (the fields we rank/filter on) + open-ended **`conditions[]`** for eligibility & validity (mapped to a controlled vocabulary) + an **`attributes`** JSONB + verbatim **`raw_conditions_text`**. The LLM never invents columns — unknown conditions become **`field_proposals`** that are promoted to canonical fields once they recur. `schema_version` allows later re-parsing.

## 3. What to crawl — four source tiers (all in scope, staged)

| Tier | Sources | Crawl method | Noise | Role |
|---|---|---|---|---|
| **1 · Provider pages** | The service's own site (standard/annual/student/with-ads) | Deterministic | Low | Baseline "standard routes" + reference prices |
| **2 · Bundler pages** | Telco/bank/fintech/retail offers (Telekom, O2, Vodafone, Revolut, N26, loyalty) | Deterministic (some JS) | Medium | The differentiator — hidden bundle routes |
| **3 · Deal communities** | mydealz, Reddit, deal blogs/Telegram | Feeds + agentic triage | High | Time-limited / undocumented offers (treat as leads) |
| **4 · Broad web discovery** | Open web via search | Agentic + search | Highest | Find brand-new offers/sources you don't know about |

Noise rises with tier → so does the verification weight and the share of offers that must hit human review.

## 4. The hybrid architecture (how the LLM is involved)

Two lanes feed one shared pipeline:

```
        LANE A — DETERMINISTIC (Tiers 1–2, known T3 feeds)
 seed URL (due) ─▶ fetch (Firecrawl/Crawl4AI/Playwright) ─▶ screenshot+HTML+text
                                                              │
        LANE B — AGENTIC DISCOVERY (Tiers 3–4)               │  LLM = EXTRACTION ONLY
 search/query ─▶ agent browses (Browser Use/Stagehand)       ▼
   judges relevance ─▶ extracts candidate ─┐         ┌──────────────────┐
   + proposes NEW source URLs ─────────────┴────────▶│  EXTRACT → JSON  │
        LLM = navigation + reasoning                  │  deal record(s)  │
                                                      │  + confidence    │
                                                      └────────┬─────────┘
                                                               ▼
   validate/dedupe ─▶ capture evidence ─▶ CANDIDATE QUEUE ─▶ [human review] ─▶ PUBLISH ─▶ MONITOR/diff
                                                               (separate, manual)              │
                                                               ▲────────── change → re-queue ──┘
```

- **Lane A (deterministic):** a scheduler pulls seed URLs that are due, a headless fetch returns clean text + screenshot + HTML, and the LLM does **extraction only** (page → strict-JSON deal record(s) + confidence). Cheap model, no navigation decisions. Handles Tiers 1–2 and any stable Tier-3 feed.
- **Lane B (agentic):** a **bounded** agent runs targeted searches and browses candidate pages for Tiers 3–4. It judges relevance, extracts candidate offers, and — most valuably — **proposes new source URLs** to add to the registry. Over time this *converges expensive agentic browsing into cheap deterministic crawling* (good new domains get "promoted" into Lane A).
- Both lanes converge into the **same** path: validate → dedupe → capture evidence → candidate queue → human review → publish → monitor.

## 5. The extraction step (the LLM core)
- **Input:** cleaned page text (markdown) + a key screenshot + the URL + the target-subscription context (if known) + the deal-record JSON schema.
- **Output:** zero-or-more deal records per page (a page can hold several offers), each with:
  - canonical **service match** to your catalog (flag unknown/new services),
  - provider/route, route_type, price/billing/currency, a true-cost note,
  - **eligibility parsed into structured flags** (country, new-customer, residency/KYC, plan tier, min spend, stackable) — when a condition is unclear, set *"conditions apply"* rather than guess,
  - validity window + recheck cadence,
  - **confidence** + extraction notes,
  - **grounding snippets**: the exact source sentence supporting each key field (makes human review seconds-fast and catches hallucination).
- **Extensible schema + new-field detection:** a typed core for the fields we rank on, plus open `conditions[]` (mapped to a controlled vocabulary) for the long tail, an `attributes` JSONB, and verbatim `raw_conditions_text`. When the LLM hits a condition with no known key it doesn't invent a column — it records it and emits a `field_proposal`; recurring proposals get promoted to canonical fields (a governed, frequency-driven loop). `schema_version` allows re-parsing later.
- **Deterministic validation after the LLM:** schema check, sanity checks (price ranges, currency = EUR for DE, valid dates), dedupe/canonicalisation against existing routes, confidence downgrade on rule failure. Low confidence or failed rules → must-review.
- **Models:** cheap/fast model for Tier 1–2 extraction; a stronger model for ambiguous or agentic Tier 3–4 reasoning. (Pick at build time; the prompt can let Claude Code choose + make it swappable.)

## 6. Discovery logic (finding new deals & sources)
- **Seed registry** starts hand-curated (provider + bundler URLs for the 25 subscriptions). Each source has: type, tier, crawl cadence, reliability score, last_seen.
- **Community ingestion (Tier 3):** pull mydealz/Reddit by keywords (your services × "Bundle / inklusive / gratis / Aktion"); the agent triages relevance; hits become candidates **and** propose a source.
- **Broad discovery (Tier 4):** scheduled agentic search on intent queries; novel offers → candidates; **novel domains → *proposed* sources that a human approves** before they enter deterministic crawling (controls cost + quality).
- **Dedupe:** canonical key = service + provider + route_type + country + source origin (registrable domain of the source URL — **split-by-source**, so each source's report of a route is its own record); the same source re-crawling the same route still collapses to one, keeping the best evidence.

## 7. Monitoring & re-verification
- Each published deal gets a **recheck cadence by tier** (provider pages ~weekly; promos more often; community deals near their expiry).
- Re-crawl source → **diff** the price/terms region (field-level or hashed) → if changed: re-extract + re-queue for review, keep old evidence; if gone/expired: **auto-expire**.
- Surface a **"last verified" timestamp** to users; freshness SLA per tier. Repeated fetch failures lower a source's reliability and flag it for a human.

## 8. Evidence capture (every candidate, at crawl time)
Full-page **screenshot** + raw **HTML** + extracted **T&C/offer text** + **source URL** + **timestamp**, stored immutably (R2/S3); optionally also an independent archive (archive.org "Save Page Now"). Each deal record links its `evidence_id`; the review console and the public deal page both show it.

## 9. Hard cases & policy
> **POLICY CHANGE (2026-06-21):** the original "public pages only" default was **reversed** by the owner — the pipeline now **best-effort reads any page** it can fetch a body from (robots-disallowed + login-walled included). The bullets below are reframed to that policy; see `CLAUDE.md` → "Best-effort read any page" for the canonical statement.
- **Login-gated / member-area offers:** still **do not automate logins** (no credential system yet — deferred "later" work). But a login-wall / soft-block page is now **read best-effort**: the fetcher returns `ok` + a `fetchSignal` and the body is extracted (candidate stays must-review). Only a **`captcha`** challenge (no offer content) still becomes a **manual-capture task** for a human.
- **Anti-bot / JS-heavy:** use stealth fetch or a real hosted browser (Stagehand/Browserbase) for the few that need it; a soft anti-bot interstitial is read best-effort, **captcha → manual-capture**.
- **Politeness & legality:** `RESPECT_ROBOTS_TXT` now defaults **off** (opt-in via `=true`); the **per-domain rate-limit still always applies** (robots-off ≠ hammering hosts); identify sensibly; store *our own* screenshot + a source link rather than republishing full copyrighted T&C; add affiliate disclosure (EU Omnibus) at publish; never scrape personal data (GDPR). **Legal note:** ignoring robots.txt/ToS materially changes EU/DE legal exposure — a deliberate owner decision.
- **Cost control:** cap agentic runs (max steps, time, €); promote discovered domains into deterministic crawling; cheap model by default; cache fetches.

## 10. Orchestration & scheduling
A job queue + scheduler (e.g. a Postgres-backed queue like pg-boss + cron) runs four job types: deterministic crawl (by cadence), community ingestion, **rate/cost-limited** agentic discovery, and monitoring/diff. Jobs are idempotent, retried, logged per `crawl_run`, with per-domain concurrency limits.

## 11. Quality gates (summary)
LLM proposes → humans approve (nothing auto-publishes in v1) · grounding snippets required for key fields · confidence + validation rules gate the queue · agentic lane is bounded and new domains need human approval · dedupe + canonicalisation throughout.

## 12. Phased rollout (so the build stages cleanly)
- **Phase A — Deterministic core:** Tiers 1–2 seed list → extract → evidence → candidate queue → monitoring/diff. *(Most value, least risk — this alone is a usable product.)*
- **Phase B — Community ingestion:** Tier 3 feeds/search → agent triage → candidates.
- **Phase C — Agentic broad discovery:** Tier 4 with the source-promotion loop + tight guardrails.
- **Later:** credentialed/login-gated capture; auto-publish for high-confidence Tier-1; more countries.

## 13. Open decisions before the Claude Code prompt
1. **Tooling:** Firecrawl vs Crawl4AI (deterministic scrape/extract); Browser Use vs Stagehand + a hosted browser (agentic) — or let Claude Code choose and keep them swappable.
2. **Models:** cheap extraction model + stronger discovery model — or let Claude Code choose.
3. **Crawl cadences** per tier (e.g. provider weekly, promos every few days).
4. **Seed list:** the 25 subscriptions + their provider/bundler URLs — will you supply it, or should we generate a first draft?
5. ~~**Confirm** the public-only-v1 default for login-gated offers.~~ **Resolved 2026-06-21:** reversed to best-effort-read (robots default-off; login/soft-block read best-effort; captcha → manual; no login automation yet). See §9.

---
*Companion: `Delas_Verification_Pipeline_and_MVP_Stack.md` (the broader pipeline + stack) and `Delas_Prototype.html` (the verification console this feeds). Tool landscape per 2026 web-extraction comparisons (Firecrawl, Crawl4AI, Browser Use, Stagehand) — confirm current capabilities at build time.*

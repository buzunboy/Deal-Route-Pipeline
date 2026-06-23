# DealRoute — live-test results template

_The canonical template for recording a **real** live test (real sites + real LLM,
read-only dry-run). Copy this file to `docs/testing/results/LIVE_TEST_<YYYY-MM-DD>.md`
and fill every section. When Claude is asked to "run a real/live test", it uses THIS
template for the results. The point: every live run is recorded the same way, so runs
are comparable over time and nothing (deals, scores, evidence, trust checks) is dropped._

> **Extend this template when a feature adds a recordable field.** If a new feature
> introduces a new per-deal field, a new tier, a new trust guard, or a new cost
> signal, add a column/row/section HERE so future runs capture it. This file is the
> contract for what a "complete" live-test record contains. See the changelog at the
> bottom; add an entry when you extend it. (Referenced from `CLAUDE.md` + `.claude/rules/testing.md`.)
>
> **Rendering as HTML:** when asked to show results "visually" / "as an artifact",
> render a filled copy of this template via the visual artifact tool (a metric-card
> summary + per-tier deal cards + the score-reasoning + trust-checklist), then keep
> the Markdown copy as the committed record. The Markdown is the source of truth; the
> HTML is a view of it. (See `CLAUDE.md` → "Live testing".)

---

## 0. Run metadata

| Field | Value |
|---|---|
| Date (UTC) | `<YYYY-MM-DD HH:MM>` |
| Git commit (master) | `<short sha>` |
| Run kind | dry-run (read-only) / full-into-throwaway-DB |
| LLM provider + model | `anthropic` · `claude-haiku-4-5-...` |
| `LLM_MAX_OUTPUT_TOKENS` | `8192` |
| Fetcher | `playwright` / `browser` (render) / `firecrawl` |
| Search backend (Tier 4) | `stub` / `brave` / `firecrawl` |
| `AGENT` / `AGENT_INLINE_SCRAPE` | `noop`\|`search` / `true`\|`false` |
| Writes / publishes | **none** (dry-run) — confirm 0 |
| Total LLM cost (est. €) | `<sum>` |
| Notes | env caveats, credit state, anything unusual |

---

## 1. Summary (fill the counts)

| Metric | Value |
|---|---|
| Sources / pages tested | |
| Deals extracted (total) | |
| Passed gate (≥0.85, 0 rule failures) | |
| Must-review | |
| **Auto-published** (MUST be 0) | **0** |
| Fetch outcomes: robots_disallowed / blocked / 0-deals / crash | |
| Proposed novel domains (Tier 4) | |

---

## 2. Trust-invariant checklist (verify EVERY run)

Mark ✅/❌ and cite the evidence. A ❌ on any of these is a release blocker.

- [ ] **Nothing auto-published** — every deal is `must-review`; no `published` written.
- [ ] **Evidence required** — every persisted candidate has screenshot+html+terms (or, in dry-run, the evidence step ran without a hollow-bundle error).
- [ ] **Best-effort read** (2026-06-21; replaces "Public-only") — `RESPECT_ROBOTS_TXT` defaults OFF (note if you set `=true`); login-wall / soft-block pages are read best-effort (note any `fetchSignal` reads + confirm they stayed must-review); a `captcha` page still → manual-capture; soft-404/maintenance/expired still skip (`error`). The **per-domain rate-limit still applies**; Tier-4 inline-scrape (if on) still routes through `checkAccess` (rate-limit always + robots only when on).
- [ ] **Boundary validation** — no crash from raw LLM/scraped/feed data; malformed → handled (skipped/flagged), not trusted.
- [ ] **No invented columns** — unknown conditions → `field_proposals`, never new top-level fields.
- [ ] **Hallucination guard** — note any `grounding_quote_in_source` failures (the guard firing is GOOD).
- [ ] **Defaults safe** — `AGENT=noop`/`SEARCH_PROVIDER=stub`/`FETCHER=playwright` unless deliberately overridden for the test.

---

## 3. Score reasoning (how to read a confidence/review score)

`adjusted = self_confidence − 0.20 × (failed rules) − 0.15 × (key fields missing a grounding quote)`, clamped [0,1].
Must-review if `adjusted ≤ 0.70` **OR** any rule failed. Confidence is only ever lowered.
Rules that fire: `promo_pricing_needs_review`, `grounding_quote_in_source`, `billing_known`,
`prepaid_term_needed`, `extraction_input_truncated`, `price_within_band`, `currency_matches_country`,
`valid_dates` / `valid_date_order`, `grounding_present` / `grounding_not_verifiable`.
_(Add new rules here when they're introduced.)_

---

## 4. Per-tier results

Repeat the per-deal block for every deal. **Do not summarise to counts only** — list each deal.

### Tier 1 — provider pages (reference prices)
### Tier 2 — bundler pages (telco/fintech/retail — the bundle differentiator)
### Tier 3 — community (RSS ingest + community posts)
### Tier 4 — broad discovery (agentic search → fetch → extract → propose)

For each **source**:

> **Source:** `<url>` · tier `<n>` · fetch outcome `<ok|robots_disallowed|blocked|0-deals|crash>` · deals `<n>` · est. cost `€<x>`

…and for each **deal** under it:

| Field | Value |
|---|---|
| service | |
| provider | |
| route_type | `bundle`\|`standalone`\|`promo`\|`regional` |
| price | `<amount> <currency> / <billing>` (billing: monthly\|annual\|one_time\|**prepaid**\|unknown) |
| prepaid_months | `<n>` (only if billing=prepaid) |
| true_cost_monthly | `<€/mo>` (amortized for annual/prepaid) |
| eligibility flags | new_customer_only / residency_kyc / plan_tier / min_spend / stackable |
| validity | start / end / recheck_days |
| conditions[] | `key:label` each (mapped vocabulary) |
| field_proposals[] | suggested_key:label (novel conditions — never invented columns) |
| grounding | the verbatim quote per key field |
| confidence | `<0..1>` |
| must-review | yes/no |
| **rule failures (the WHY of the score)** | list each rule + what triggered it |
| evidence | screenshot+html+terms captured? (dry-run: would-capture). For S3/CDN: the `<id>/screenshot.png` URL the public DTO would expose |

### Tier 4 extras
- **Proposed novel domains** (each: url · rationale · deals found · pending human approval — NOT auto-crawled).
- **Run record:** queries / pages fetched / candidates / stop reason (`step_cap`/`cost_cap`/`time_cap`/`completed`) / cost.
- **Inline scrape** (if `AGENT_INLINE_SCRAPE=true`): per result, was inline content used or did it fall back to a polite fetch? Any robots-gate skips?

---

## 5. Findings (new this run)

For each finding: **severity** (blocker/high/medium/low) · **what** · **where** (`file:line` / URL) · **fix-or-defer** (and log deferrals in `docs/KNOWN_ISSUES.md`).

---

## 6. Expectations vs reality

A short prose paragraph: did the run match what we expected? What worked, what surprised us, what to do next.

---

## 7. Rerun inputs (so the run is reproducible)

The exact commands + env used, e.g.:
```
LLM_PROVIDER=anthropic FETCHER=playwright npm run cli -- dry-run-extract <url>
AGENT=search SEARCH_PROVIDER=firecrawl AGENT_INLINE_SCRAPE=true \
  npm run cli -- discover --broad "<query>" --max-steps N --max-queries N --dry-run
```

---

## Template changelog (append when you extend this template)

- **2026-06-20** — initial template (tiers 1–4, per-deal detail incl. score-reasoning,
  evidence, trust-invariant checklist). Added `prepaid`/`prepaid_months`,
  `extraction_input_truncated`, and Tier-4 inline-scrape fields reflecting features
  shipped to date.
- **2026-06-21** — **best-effort-read policy** (replaces the "Public-only" trust-checklist
  item with "Best-effort read"): record `RESPECT_ROBOTS_TXT` (now default OFF), any
  `fetchSignal` (`login_wall`/`soft_block`) best-effort reads (and that they stayed
  must-review), and that captcha still routes to manual-capture / soft-404 still skips.
  Note the per-domain rate-limit still applies.
- **2026-06-23** — **added an auth-flow variant** of the live-test convention. Auth/IAM is
  not extraction, so an against-a-running-`serve` auth run is recorded with a sibling
  format (run metadata + an 11-step IdP/RBAC table + an auth trust-invariant checklist)
  instead of per-deal tiers. The first filled run is
  `docs/testing/results/AUTH_PHASE2_ACCEPTANCE_2026-06-23.md` — use it as the shape for a
  future auth live run (e.g. Phase 3 Users/Roles or the post-deploy `test:live` smoke).

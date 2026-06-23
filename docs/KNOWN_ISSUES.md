# Known issues & deferred findings

A running register of findings we've **consciously decided not to fix yet** — gaps,
tech debt, fragilities, and open design questions. The goal is that nothing real is
silently forgotten: each entry says what it is, where it lives, why it's deferred,
and the trigger that should make us fix it.

**This is not a bug tracker for active work** (use the task list / a ticket for that).
It's the place a finding lands when it's real but not worth fixing in the current
change. Review it periodically and when starting related work.

## How to add an entry (for Claude and humans)

When you spot an issue you are NOT fixing immediately, append an entry below using the
template. Keep it one short block. Set **Severity** honestly (a security/trust issue is
never "low"). Always include a concrete **Location** (`file:line` or area) and a
**Fix-when** trigger so a future reader knows when it matters.

```
### <short title>
- **Severity**: low | medium | high
- **Area**: fetcher | extraction | discovery | db | api | ci | ...
- **Location**: `path/to/file.ts:line` (or "—")
- **What**: one or two sentences on the actual problem.
- **Why deferred**: why it's safe to leave for now.
- **Fix-when**: the trigger/condition that should prompt the fix.
- **Logged**: YYYY-MM-DD
```

---

## Open findings

### Ingest-community: a failed triage call's LLM cost is not credited to the budget tally
- **Severity**: low
- **Area**: ingest / cost
- **Location**: `src/application/ingest/ingest-community.ts` (the per-item `try/catch` ~`:186-204`; `costEur` is incremented only on a successful `resp.usage.costEur` and on successful extraction outcomes ~`:210`).
- **What**: when a triage LLM call throws, the item is counted as `failedItems++` but the cost of that failed call is NOT added to the run's `costEur`. So a run whose items repeatedly fail triage can spend slightly more LLM budget than the `costEur` it reports — a bounded undershoot of the per-run/daily budget guard.
- **Why deferred**: harmless at current scale — the overshoot is at most a few failed triage calls' worth of tokens per run, the daily ceiling still stops the batch, and nothing auto-publishes. Migrated here from the (now-retired) PostP3 handoff §5, where it was the one finding without a KNOWN_ISSUES home.
- **Fix-when**: if ingest cost accuracy becomes material (high failure rates or a tight daily ceiling) — credit the failed call's usage in the `catch` (the LLM port returns usage even on a parse failure; on a hard throw, estimate or surface it) so `costEur` reflects all spend.
- **Logged**: 2026-06-22

### Cloud-deployment follow-ups (API is live on Fly; these are post-deploy hardening)
- **Severity**: medium (operational/security hygiene; the API is live + working at `https://dealroute-api.fly.dev`)
- **Area**: deploy / ops / security
- **Location**: Fly app `dealroute-api` (region `fra`); `deploy/fly/fly.toml`; `.env` (local); GHCR package `ghcr.io/buzunboy/deal-route-pipeline`.
- **What**: the always-on `serve` API was deployed to Fly.io on 2026-06-22 (Postgres `dealroute-db` attached → `DATABASE_URL`; `REVIEW_API_TOKEN` + `S3_*` set as Fly secrets; image pulled from GHCR). Health/CORS/auth all verified. Open items the owner deliberately deferred to the end of the implementation phase:
  1. **Rotate exposed secrets.** During setup these were pasted into a chat and must be considered compromised: the **AWS access key** `AKIAYNW2LJGBMC65AXEH` (IAM user `dealroute-pipeline`) and a **GitHub PAT** `ghp_…` (classic, `read:packages`). Rotate the AWS key (new key → update the Fly secret + local `.env` → delete old) and delete the PAT (github.com/settings/tokens). The unused `FLY_REGISTRY_AUTH_TOKEN` Fly secret can also be unset (the image is public, so it isn't needed).
  2. **GHCR image is currently PUBLIC.** Fine for now (image holds only compiled code, no secrets) and lets `fly deploy` pull with no auth. To make it private later: GitHub → Packages → `deal-route-pipeline` → Package settings → Change visibility → Private, THEN wire a pull credential for Fly — either keep a classic PAT with `read:packages` as the `FLY_REGISTRY_AUTH_TOKEN` secret, or use a GitHub org/Actions token; fine-grained PATs do NOT support GHCR. Re-test a deploy after flipping.
  3. **`fly.toml` pins the image to `:edge` (rolling).** Every master push moves `:edge`, so a redeploy isn't reproducible. For prod, pin to an immutable `:sha-xxxxxxx` tag (or a released `vX.Y.Z`) in `deploy/fly/fly.toml` `[build] image`.
  4. **`ADMIN_CORS_ORIGIN` is unset.** The admin panel isn't deployed yet, so no browser origin is allowed on `/api/*`. When the panel has a URL: `fly secrets set -a dealroute-api ADMIN_CORS_ORIGIN="https://<panel-origin>"` (exact origin, never `*`; the app auto-restarts).
- **Why deferred**: the API runs correctly without them; the owner chose to finish the implementation phase first and harden (rotate creds, lock the image, pin the tag, wire CORS) at the end.
- **Fix-when**: rotate creds + pin the tag before going past dev/staging; set `ADMIN_CORS_ORIGIN` when the panel deploys; make the image private if/when the repo's exposure posture requires it.
- **Logged**: 2026-06-22

### Manual-capture screenshot/artifact UPLOAD channel is not built (capture is by-reference only)
- **Severity**: medium (a capability gap, not a defect; the trust invariant still holds)
- **Area**: api / evidence
- **Location**: `src/application/review/review.ts` (`completeManualCapture`); `POST /api/manual-capture-tasks/:id/complete`; `src/domain/evidence/evidence.ts` (`ReferencedEvidenceInput`).
- **What**: completing a manual-capture task takes the screenshot/HTML/terms as **references** (store
  keys/URLs) the human uploaded out-of-band, plus inline terms text. There is **no upload endpoint** to
  produce those refs — a human must place the artifacts in the evidence store/CDN themselves and pass
  the keys. The owner chose "reference, don't upload" deliberately for v1.
- **Why deferred**: the admin UI (separate repo) will own the file-upload UX; the pipeline only needs
  the durable refs. Building an upload channel now (multipart, content-type sniffing, virus scan, store
  write) is admin-panel work, not pipeline work.
- **Fix-when**: when the admin panel implements manual capture — add an `EvidenceStore`-backed upload
  endpoint (or pre-signed S3 URLs) that returns the refs `complete` consumes. Until then, document the
  manual-upload step in the runbook.
- **Logged**: 2026-06-21

### Field-proposal promotion to a first-class COLUMN (`target:"field"`) is not supported
- **Severity**: low
- **Area**: api / db
- **Location**: `src/application/review/review.ts` (`promoteFieldProposal` throws `PromotionTargetNotSupportedError`); `POST /api/field-proposals/:key/promote` → 400.
- **What**: promotion supports `target:"vocabulary"` only (an additive `condition_vocabulary` row).
  Promoting a recurring proposal to a typed first-class column would let the public feed filter/rank on
  it, but needs a drizzle migration + schema-version bump + a re-parse of `raw_conditions_text` for
  historical rows — out of scope for this API change.
- **Why deferred**: vocabulary promotion covers the common case (canonicalise a long-tail condition);
  a first-class column is a rare, deliberate schema decision that shouldn't be a one-call API action.
- **Fix-when**: when a specific proposal recurs often enough that the product wants to filter/rank on
  it as a typed field — do it as a planned migration (see the `promote-field-proposal` skill's "field"
  path), not via this endpoint.
- **Logged**: 2026-06-21

### Reviewer edit KEEPS the model grounding quotes beside a human-corrected value (stale-quote risk)
- **Severity**: low (mitigated by `human_edited`; an explicit owner trade-off)
- **Area**: api / extraction / trust
- **Location**: `src/application/review/review.ts` (`editCandidate` — grounding left unchanged); `src/adapters/http/public-dto.ts` (`PublicDeal.human_edited` IS surfaced).
- **What**: when a reviewer edits a field (e.g. `price`) via PATCH, the model's original `grounding`
  quote for that field is left in place — it may no longer back the corrected value. The owner chose
  "keep grounding, only tag `human_edited`" (lighter than dropping grounding + forcing re-review). The
  mitigation is DELIVERED: the edited field path is in `human_edited`, which the public DTO exposes
  (`toPublicDeal` → `PublicDeal.human_edited`), so a consumer can tell the value is human-set and the
  model quote may not match. The residual risk is only if a consumer ignores `human_edited`.
- **Why deferred**: owner decision in the build's clarifying questions. Dropping grounding for edited
  fields (the stricter alternative) would force the edited record back to must-review on every edit.
- **Fix-when**: if a public consumer ever renders the grounding quote next to the value AND mis-matches
  become a real trust problem — switch `editCandidate` to drop grounding for edited paths (the use-case
  is the single place to change it; `human_edited` already marks which).
- **Logged**: 2026-06-21

### Real authenticated access (login automation) — deferred "later" work behind the best-effort-read policy
- **Severity**: medium (a capability gap the new policy exposes; not a defect)
- **Area**: fetcher / discovery / legal
- **Location**: `src/adapters/fetcher/*` (no credential handling anywhere); `page-classifier.ts`
  (login walls now read best-effort); the `Fetcher` port (`fetch` never logs in).
- **What**: the **best-effort-read** policy (2026-06-21, see `CLAUDE.md`) reads login-walled pages
  best-effort, but there is **no credential system** — a login wall yields the login page, not the
  member-area offer. So "best-effort read a login-gated offer" today extracts a login screen
  (low-confidence, must-review, usually rejected). The owner accepted this for now ("we'll work on
  auth later").
- **What real auth needs (the deferred build)**: a `CredentialStore` port + per-source credential
  config (env/secret-manager, never in the DB), a login-form-fill step in the browser fetchers
  (Playwright can; Firecrawl can't easily), session/cookie persistence, and a hard policy/legal gate
  (automated authenticated access breaches many ToS — a bigger legal exposure than ignoring robots).
- **Why deferred**: owner decision — ship the read-any-public-or-walled-page capability now; build
  credentialed capture only when the value justifies the legal + engineering cost.
- **Fix-when**: when a high-value login-gated source (e.g. a bank/telco member area) is worth it —
  start with the `CredentialStore` port + one source, behind an explicit per-source opt-in.
- **Logged**: 2026-06-21

### robots.txt is now OFF by default — legal/ToS exposure is a standing business decision
- **Severity**: low (informational — a deliberate policy, logged so it isn't forgotten)
- **Area**: legal / fetcher policy
- **Location**: `src/config/config.ts` (`RESPECT_ROBOTS_TXT` defaults false); `CLAUDE.md` invariant.
- **What**: the best-effort-read policy makes `RESPECT_ROBOTS_TXT` default `false` — the crawler
  fetches robots-disallowed pages. For a Germany-v1 product this materially changes legal exposure
  (UWG/competition law, database rights, ToS breach). The per-domain rate-limit still always applies
  (good-citizen on load), and nothing auto-publishes, so the change is read-side only.
- **Why deferred**: the owner made this call deliberately to maximise read coverage. Flagged so the
  posture is revisited before/with any production launch + legal sign-off.
- **Fix-when**: at launch / legal review — decide whether production runs with robots off, or flips
  `RESPECT_ROBOTS_TXT=true` for the production deployment while keeping it off for research runs.
- **Logged**: 2026-06-21

### Enabling a real 2nd country (the Step-6 foundation is built; the data/launch work isn't)
- **Severity**: low (a feature-enablement task, not a defect — DE v1 is complete)
- **Area**: discovery / catalog / config
- **Location**: `src/domain/markets/markets.ts` (the MARKETS registry — the one logic seam); the
  seed list (`docs/DealRoute_Seed_List_DE.md`), catalog vocab, deny-list, Tier-4 intent queries (data).
- **What**: Step 6 made multi-country a CONFIG/DATA change (real PSL + pinned registrable domain +
  config-driven `Country`/`Currency` enums + per-country currency trust rule), but DE is the only
  ENABLED country. Actually launching e.g. AT/CH means: add a `MARKETS` row (country → currencies);
  add that country's seed sources + subscription catalog vocab; extend the deny-list + the Tier-4
  intent-query templates for it; parameterize the extraction prompt's "Germany v1 / DE / EUR" framing
  from the active market; and run a multi-country live test. No pipeline-LOGIC edit is needed (OCP).
- **Why deferred**: owner-decided — v1 ships DE-only; build the foundation now, enable a 2nd country
  only when the business expands. Doing it speculatively would add unmaintained per-country data.
- **Fix-when**: when expanding past Germany. Start with the `MARKETS` row + that country's seed/vocab
  data; the schema enums, the currency rule, and the public-API country filter all widen automatically.
- **Logged**: 2026-06-21

### A raw-Unicode IDN host resolves differently old↔new (no DE host today; would split on add)
- **Severity**: low (latent; no current data hits it)
- **Area**: discovery / dedupe / db
- **Location**: `src/adapters/suffix/tldts-suffix-oracle.ts`; pinned + documented in
  `test/golden/suffix-equivalence.golden.test.ts` (the "KNOWN divergence" block).
- **What**: the old last-two-labels rule resolved via `new URL().hostname` (always **punycode**),
  while `tldts.getDomain` returns the **Unicode** form — so a host typed with a raw umlaut/eszett
  diverges: `müller.de` → `müller.de` (new) vs `xn--mller-kva.de` (old). The DE seed list has NO
  such IDN host today (grep-confirmed), so there is no stored-key churn now — but a deal stored
  under the old punycode key and re-crawled under the new Unicode key would **split into two
  records** the moment a raw-IDN German source is added.
- **Why deferred**: unreachable with the current DE corpus; Step 6's golden gate documents the
  divergence as a conscious decision rather than letting it surprise a future reader.
- **Fix-when**: before adding a raw-IDN (umlaut/eszett) source — pick the canonical form (likely
  normalise the oracle output to punycode) so a deal can't split old↔new, and add that host to the
  golden corpus. (Related, same fix: a MALFORMED punycode host like `e.xn--ja.com` resolves to null
  under the old rule but to a domain under `tldts` — non-DE, benign today, same boundary-normalise fix.)
- **Logged**: 2026-06-21

### `source.registrable_domain` no-neutral-fold rests on write-site discipline, not a DB constraint
- **Severity**: low (defence-in-depth; all current write paths are correct)
- **Area**: db / discovery
- **Location**: `src/domain/source/source.ts` (`registrable_domain` is `.nullable().default(null)`);
  the pin sites: `seed-import.ts`, `lane-b-support.ts`, `source-review.ts` (spreads).
- **What**: the guarantee "a seed/discovered source joins to its real reliability, not neutral 0.5"
  is enforced only by every source-create path remembering to pin `registrable_domain` via the
  oracle — there is no NOT NULL column constraint or composition-root assertion. All current paths
  pin it (verified), but a FUTURE write path that forgets would silently fold that source's deals to
  neutral reliability (no error — `null` is a valid column value and `resolveReliability` `??`s to 0.5).
- **Why deferred**: every production write site is correct today; this is a guard against future
  regressions, not a live bug.
- **Fix-when**: if a new source-create path is added — add it to the pin discipline AND consider a
  belt-and-suspenders guard (a NOT NULL constraint after a one-time backfill, or an assertion at the
  composition root that every upserted active source has a non-null `registrable_domain`).
- **Logged**: 2026-06-21

### `withAbortableTimeout` can emit an unhandledRejection when the inner promise loses the race
- **Severity**: low (noise, not a control-flow bug)
- **Area**: shared / resilience
- **Location**: `src/adapters/shared/retry.ts` (`withAbortableTimeout`, the `Promise.race` loser).
- **What**: on a timeout, `withAbortableTimeout` rejects via the timer, but the inner `run` promise
  (the actual fetch) can still settle as a rejection LATER with no handler attached — surfacing as a
  process-level `unhandledRejection`. It does NOT crash or stall the awaited caller (the race already
  rejected and the caller caught it — e.g. `WebhookAlerter.alert` swallows it), so behaviour is
  correct; it's log/handler noise. Surfaced by the Step-5 alerting verify (the webhook path now
  exercises the timeout branch under load).
- **Why deferred**: no functional impact — the awaited control flow is correct everywhere this helper
  is used (search adapters, webhook alerter); it's a cosmetic unhandled-rejection event a hung remote
  could emit under load.
- **Fix-when**: if `unhandledRejection` noise becomes material — attach a no-op `.catch()` to the
  losing `run` promise inside `withAbortableTimeout`, or abort the inner work on timeout so it settles
  via the abort signal. One small change in the shared helper; benefits every caller.
- **Logged**: 2026-06-21

### Datadog / CloudWatch metrics-push alerting adapters not built (webhook is the v1 answer)
- **Severity**: low (capability gap, not a defect)
- **Area**: observability / alerting
- **Location**: `src/adapters/alerting/` (would be a new `Alerting` adapter); design recorded in
  `docs/DealRoute_Observability.md`.
- **What**: Step 5 shipped the `Alerting` port + Noop/Webhook adapters wired at the two
  silent-warn points (source reliability-low, daily-budget reached). A native Datadog/CloudWatch
  metrics-push adapter (for dashboards/aggregation, not just human notification) was deferred — a
  full metrics-backend adapter is materially heavier than a webhook (vendor SDK + creds + a
  metric/dashboard model) and the generic `WebhookAlerter` already covers the v1 "tell a human"
  need (and can front a collector/proxy that calls Datadog/CloudWatch in the meantime).
- **Why deferred**: owner-decided — build the native adapter only when a metrics backend is
  actually chosen for the deployment AND aggregation/dashboards are needed. The port is the OCP
  seam, so adding it later touches no use-case.
- **Fix-when**: a metrics backend is chosen + dashboards/aggregation are required — build a
  `DatadogAlerter`/`CloudWatchAlerter` per the recipe in `docs/DealRoute_Observability.md`
  (extend `alerting.kind`, map `AlertEvent` → events/metrics, keep the best-effort contract +
  run the shared `alertingContract`).
- **Logged**: 2026-06-21

### `listPublished` reads ALL active sources per public request (reliability index rebuilt each call)
- **Severity**: low (scaling ceiling, not a defect)
- **Area**: api / db
- **Location**: `src/adapters/db/postgres/postgres-db.ts` (`PgDealRepo.listPublished` → `this.sources.listByStatus('active')`), `src/adapters/db/in-memory/in-memory-db.ts` (same), the index built in `src/domain/deal-record/published-ranking.ts` (`buildReliabilityIndex`).
- **What**: Step 3 resolves a deal's reliability at read time via a registrable-domain join, so every `GET /v1/deals` rebuilds the `registrableDomain → reliability` index from a full `listByStatus('active')` scan (no `limit`). Combined with the concurrent `listPublished` + `countPublished` the feed already runs, a public request now does ~3 DB reads, one of which grows with the active-source corpus. The read-time rebuild is the owner-decided design (no new column / no denormalised reliability), so this is the cost of that choice, not a bug.
- **Why deferred**: harmless at DE-v1 scale (tens of active sources); nothing auto-publishes; the per-page cap already bounds the deals read. It's a scaling concern on an unauthenticated endpoint, the same class as the existing "no rate-limiting on `/v1/`" finding (a CDN/proxy in front is the planned mitigation).
- **Fix-when**: when the active-source count grows materially OR `/v1/` traffic does — cache the registrable-domain → reliability index with a short TTL (it changes only as monitor/crawl nudges reliability), or fold the join into the `listPublished` SQL once a real Public Suffix List adapter exists (the multi-country trigger), so eTLD+1 isn't reimplemented in SQL before then.
- **Logged**: 2026-06-20

### Deal `id` accepts uppercase UUIDs (value-parity drift across adapters, ordering unaffected)
- **Severity**: low (pre-existing; not reachable from the write path)
- **Area**: domain / db
- **Location**: `src/domain/deal-record/deal-record.ts` (`id: z.string().uuid()`); Postgres `uuid` column (`src/adapters/db/postgres/schema.ts`) read-back via `rowToDeal`.
- **What**: `z.string().uuid()` accepts UPPERCASE hex with no case transform, while Postgres's `uuid` column normalises to lowercase on read. A deal hypothetically stored with an uppercase id would therefore read back with a DIFFERENT id string from the in-memory adapter (which preserves case) — a value-parity gap. Surfaced (and dismissed as a non-blocker) by the Step-3 LSP adversarial verification. Relative ORDER is unaffected: canonical-UUID lexical order matches Postgres byte order, and the Step-3 fetch-cap relies on that ordering equivalence, not on value equality.
- **Why deferred**: not reachable from the real write path — every id is minted by `newId()` = `randomUUID()` (always canonical lowercase), and the contract suite only uses `randomUUID()`/explicit-lowercase ids. Pre-existing; Step 3 did not introduce it.
- **Fix-when**: if an id ever enters from an external/untrusted source (import, API) — lowercase-normalise `id` at the schema boundary (`.toLowerCase()` transform) so both adapters round-trip the same string.
- **Logged**: 2026-06-20

### `DealRecord` type doesn't force the defaulted fields to be present (runtime-guarded instead)
- **Severity**: low
- **Area**: domain / typing
- **Location**: `src/domain/deal-record/deal-record.ts` (`affiliate_disclosure`/`published_at` via `.default()`).
- **What**: zod `.default()` fields infer as effectively-optional in `z.infer<DealRecordSchema>`, so the
  TS compiler won't flag a hand-built `DealRecord` (e.g. a published one) that omits the disclosure
  fields. "published ⇒ disclosure present" is therefore enforced at RUNTIME (both DB adapters now
  `DealRecordSchema.parse()` on write, applying the defaults — LSP-consistent), not by the type.
- **Why deferred**: the runtime guard closes the actual gap (a stored/served deal always has the
  defaults), and the production approve path sets both fields explicitly. A branded
  `PublishedDealRecord` type would make it compile-time-load-bearing but is a larger refactor for
  marginal gain now.
- **Fix-when**: if a compile-time guarantee becomes worth it (e.g. more publish-only invariants) —
  introduce a refined `PublishedDealRecord`.
- **Logged**: 2026-06-20

### A defaulted (vs reviewer-explicit) affiliate_disclosure isn't durably queryable
- **Severity**: low
- **Area**: review / compliance
- **Location**: `src/application/review/review.ts` (approve — the omitted-disclosure warn).
- **What**: when a reviewer publishes without supplying `affiliate_disclosure`, the use-case
  defaults it to `true` (over-disclose, trust-safe) and emits a `logger.warn`. But the
  defaulted-vs-explicitly-decided distinction lives only in the log line, not as a durable
  record/audit attribute — so there's no query to answer "which published deals defaulted their
  disclosure vs had it explicitly set?".
- **Why deferred**: the stored value is correct and safe (always discloses when unsure) and the
  publish is visible in logs; for v1 that's sufficient. It's an auditability nice-to-have.
- **Fix-when**: if legal/compliance wants to audit disclosure provenance — record the
  defaulted/explicit signal on the `reviews` audit row (or a deal attribute) at approve-time.
- **Logged**: 2026-06-20

### Tier-4 can surface a non-DE source that passes the confidence gate
- **Severity**: low (curation/scoping; not a trust breach — nothing auto-publishes)
- **Area**: discovery / extraction
- **Location**: Tier-4 broad discovery (`discover --broad`); the deny-list
  (`src/domain/discovery/domain-denylist.ts`); country enum (`src/domain/deal-record/enums.ts`).
- **What**: the 2026-06-20 all-tiers live test surfaced a Swisscom (`.ch`) bluebinge deal via
  Tier-4 broad discovery that extracted with `mustReview:0` (passed the gate). Tier-4 is open-web,
  so non-DE sources can appear. Country is hard-coded `DE` in the schema but extraction doesn't
  reject a deal whose source/offer is plainly non-DE.
- **Reproduced + sharpened 2026-06-21**: a `.at` (Austria) source `magenta.at/tv/disney-plus`
  surfaced via Tier-4 with **2 deals stamped `country: DE`** (both must-review this run). The
  important wrinkle: the `currency_matches_country` guard **cannot** catch an Austrian source
  because **AT also uses EUR** — so for EUR-ccTLD neighbours (AT, and the EU generally) only a
  **source-ccTLD/country-of-origin check** discriminates; the currency rule is sufficient only
  for non-EUR cases (the original `.ch`/CHF). The deal is also silently mislabeled `country: DE`
  rather than flagged, because the active market is hard-coded.
- **Why deferred**: not a trust breach — nothing auto-publishes, and a human reviews the proposed
  domain before it ever enters deterministic crawling. It's a relevance/curation matter.
- **Fix-when**: when curating Tier-4 output / building multi-country — add non-DE domains to the
  deny-list and/or a country sanity rule that flags a deal whose **source registrable domain is a
  non-DE ccTLD** for a DE-only catalog (note: this must key on the source ccTLD, NOT currency,
  since EUR-ccTLD neighbours pass the currency guard). Overlaps the multi-country generalization work.
- **Logged**: 2026-06-20 (reproduced + sharpened with the `.at`/EUR case 2026-06-21)

### Tier-3 mydealz seed RSS URL is dead (HTTP 404) — seed-list curation
- **Severity**: low (curation; not a code defect — `parseFeed` handled it correctly)
- **Area**: ingest / seed list
- **Location**: seed list (`docs/DealRoute_Seed_List_DE.md` §D — mydealz row); ingest
  community-feed config.
- **What**: the 2026-06-21 live test ran the seed feed `mydealz.de/rss/alle` through `parseFeed`
  and got **HTTP 404** (the URL returns an HTML error page, not RSS). `parseFeed` correctly
  returned `[]` (the B1 boundary held — no crash, no garbage trusted), so the lane degrades
  gracefully, but the source contributes no leads. The DealDoktor feed (`dealdoktor.de/feed/`)
  was healthy (10 items, all passed `FeedItemSchema`).
- **Why deferred**: not a bug — the pipeline behaves correctly on a dead feed. It's seed-data
  freshness: mydealz changed/retired the `/rss/alle` path.
- **Fix-when**: when curating the real seed list / wiring Tier-3 community sources — replace with
  a live mydealz feed or per-keyword search endpoint, and add a periodic feed-health check so a
  silently-dead community source surfaces (it currently just yields 0 leads).
- **Logged**: 2026-06-21

### Tier-4 inline-scrape robots gate keys on `result.url`, no field for a Firecrawl-side redirect
- **Severity**: low (watch-item; not exploitable in the current data model)
- **Area**: discovery / fetcher
- **Location**: `src/adapters/agent/search-browser-agent.ts` (`obtainPage`, the `checkAccess`
  call + `finalUrl: result.url`); `src/application/ports/search-provider.ts` (`SearchResult.content`).
- **What**: when `AGENT_INLINE_SCRAPE=true`, the agent gates the inline-scraped content through
  `PoliteFetcher.checkAccess(result.url)` (our robots + rate-limit). If Firecrawl's server-side
  search-scrape silently followed a redirect to a DIFFERENT final URL, our robots check would be
  on the pre-redirect URL. Today this is unrepresentable — `SearchResult.content` carries no
  `finalUrl`, so there's only one URL per result, and the regular Firecrawl-as-fetcher path has
  the identical property (it trusts `data.url` without re-checking robots on a surfaced redirect).
- **Why deferred**: no second URL exists in the model; the inline path is no weaker than the
  already-shipped v2 fetch path. Confirmed by the 2026-06-20 adversarial verification (public-only
  HOLDS).
- **Fix-when**: if `SearchResult.content` ever gains a `finalUrl` (Firecrawl exposes the redirect
  chain), move the `checkAccess` gate to that final URL.
- **Logged**: 2026-06-20

### Unbounded screenshot data-URI string held in memory on the inline-scrape search path
- **Severity**: low
- **Area**: search / fetcher
- **Location**: `src/adapters/search/firecrawl-search-provider.ts` (the `screenshot` string in a
  v2 search result) → bounded at `src/adapters/shared/screenshot-download.ts`.
- **What**: the 16 MB body cap is on the *fetcher* path; a v2 *search*-with-scrape response isn't
  body-capped, so a huge inline `screenshot` data-URI string is held until `resolveScreenshotBytes`
  decodes + caps it (8 MB). Transient memory bloat on the opt-in `AGENT_INLINE_SCRAPE` path only;
  not a trust issue (the bytes are still capped before use).
- **Why deferred**: opt-in path, bounded at decode, no trust impact.
- **Fix-when**: if inline-scrape becomes a default/high-volume path — cap the search response body
  like the scrape body, or reject an over-long `screenshot` string before decode.
- **Logged**: 2026-06-20

### JS-heavy provider pages yield no deals from the homepage URL (seed-URL + render-fetcher)
- **Severity**: medium (coverage gap — these sources produce nothing until addressed)
- **Area**: discovery / fetcher
- **Location**: seed list (`docs/DealRoute_Seed_List_DE.md`) + per-source fetch config; the
  render fetcher is `src/adapters/fetcher/browser-render-fetcher.ts` (`FETCHER=browser`).
- **What**: a 2026-06-20 live test found NordVPN, Surfshark, and Vodafone GigaTV **homepages**
  extracted 0 deals on the default `playwright` (domcontentloaded) fetcher — the prices live behind
  JS rendering / a plan selector / a deeper `/pricing` page. The render fetcher (`FETCHER=browser`,
  networkidle+scroll) didn't rescue the NordVPN homepage either, and Surfshark's pricing page
  **hung the headless browser** (never reached networkidle — likely anti-bot or a never-idle SPA).
- **Why deferred**: not a code defect — it's (a) seed-URL quality (seeds should point at the actual
  pricing page, not the homepage) and (b) per-source fetcher selection. The pipeline behaves
  correctly (0 deals, no hallucination). Deeper investigation was also blocked mid-test by an
  exhausted Anthropic credit balance (couldn't compare extraction output across fetchers).
- **Fix-when**: when curating the real seed list — set each source's URL to its pricing page and
  mark JS-heavy ones to use `FETCHER=browser`; for sites that hang/anti-bot the headless browser,
  route to the hosted-browser fetcher or the manual-capture queue. Re-test extraction per source
  once a funded LLM key is available.
- **Confirmed 2026-06-21 (funded key)**: re-ran NordVPN `/de/` on BOTH fetchers — `playwright` 0
  deals, `FETCHER=browser` rendered 256,864 chars of JS content but STILL 0 deals (the `/de/`
  landing is a marketing splash, not a pricing page). ChatGPT pricing (`chatgpt.com/pricing`,
  650k chars) needed the bounded re-ask to parse, then returned 4 plans all at €0/unknown — SPA
  prices weren't in static text; the model honestly returned unknown rather than hallucinating.
  Confirms the finding is seed-URL-quality + per-source fetcher selection, not a code defect.
- **Logged**: 2026-06-20 (confirmed with a funded key 2026-06-21)

### No golden fixture for a prepaid offer
- **Severity**: low (coverage gap, not a defect)
- **Area**: extraction / testing
- **Location**: `test/fixtures/golden/` (only `telekom-magenta-disney` exists).
- **What**: the prepaid-billing path (`billing:'prepaid'` + `prepaid_months`, schema v2) was
  added after a live dry-run found CyberGhost "2 Jahre für 49,19 €" mis-ranked. It's covered by
  unit tests (true-cost amortisation, validate-record `prepaid_term_needed`) + the DB contract
  round-trip + a live dry-run, but there's no saved-HTML→expected-record golden asserting a
  prepaid offer extracts the term + amortised `true_cost_monthly` with grounding and no
  hallucinated monthly figure (`.claude/rules/testing.md`: "add a fixture whenever a real page
  breaks extraction").
- **Why deferred**: the behaviour is already covered by the three tiers above; the golden adds a
  regression pin against prompt/model drift, not new correctness.
- **Fix-when**: next time the extraction prompt/model/schema changes — save a prepaid page's HTML
  as a golden fixture and assert `billing:'prepaid'` + `prepaid_months` + amortised cost.
- **Logged**: 2026-06-20

### Interactive multi-step BrowserAgent (Phase C-2 "Option B") — not built
- **Severity**: low (a capability gap, not a defect)
- **Area**: discovery / fetcher
- **Location**: `src/adapters/agent/` (would be a new BrowserAgent) — n/a yet
- **What**: C-2 was delivered as a render-capable `Fetcher` (`BrowserRenderFetcher`,
  `FETCHER=browser`) driven by the existing `SearchBrowserAgent` — it renders JS-heavy
  pages but fetches each URL statelessly. It does NOT do *interactive multi-step*
  navigation (fill a filter form → click "load more" → read several result pages within
  ONE browser session). That needs a standalone `BrowserAgent` (Browser Use / Stagehand)
  that owns its browser session.
- **Why deferred**: most DE provider/bundler pages are server-rendered or lightly hydrated —
  "render the JS so the offer appears" (now handled) covers the dominant need. The
  interactive agent bypasses `PoliteFetcher` (robots/rate-limit/size caps would need
  re-implementing inside it), so it's a real trust-surface increase to take on only when
  justified. Chosen "Option A now, Option B later" deliberately.
- **Fix-when**: a real target requires form-driven / click-through multi-step discovery the
  stateless render fetch can't reach. Build it as a new `BrowserAgent` adapter behind the
  existing port (no use-case change), and re-secure robots/rate-limit/size inside it.
- **Logged**: 2026-06-20


### Screenshot height-detection failure falls back to fullPage (defeats the height cap)
- **Severity**: low
- **Area**: fetcher
- **Location**: `src/adapters/fetcher/playwright-capture.ts` (`boundedScreenshot`)
- **What**: `boundedScreenshot` reads `document.body.scrollHeight` via `page.evaluate` with
  `.catch(() => 0)`. If that evaluate throws (wedged JS), height becomes `0`, so the code
  takes the `fullPage: true` branch — the unbounded path the cap exists to prevent — for
  exactly the hostile page that wedged JS. Low risk (Playwright's `fullPage` shot still has
  `timeout: timeoutMs`), and behavior is unchanged from before C-2; flagged because the code
  is now shared by both Playwright-backed fetchers.
- **Why deferred**: pre-existing, low-risk (the screenshot timeout backstops it); the HTML
  size cap already contained the worst OOM path.
- **Fix-when**: touching `boundedScreenshot` — default `height` to `MAX_SCREENSHOT_HEIGHT + 1`
  on detection failure so an undeterminable page is CLIPPED, not shot full.
- **Logged**: 2026-06-20

### Charset / content-type guard missing in fetchers
- **Severity**: low
- **Area**: fetcher
- **Location**: `src/adapters/fetcher/playwright-fetcher.ts`, `src/adapters/fetcher/firecrawl-fetcher.ts`
- **What**: No `Content-Type`/charset handling. A non-HTML response (PDF/image) is still
  passed to extraction, and a declared non-UTF8 charset (e.g. `iso-8859-1`) is decoded as
  UTF-8 (mojibake on umlauts).
- **Why deferred**: DE v1 pages are almost all UTF-8 HTML; a browser-based C-2 agent
  decodes charset itself, so the value is low until non-HTML sources appear. (Was H5 in the
  hardening plan.)
- **Fix-when**: a real source produces mojibake or we start ingesting non-HTML sources;
  fold into C-2 or a fetcher-quality pass. Reject non-HTML content-types cleanly first.
- **Logged**: 2026-06-20

### JSON-recovery inner-quote heuristic is fragile
- **Severity**: low
- **Area**: extraction
- **Location**: `src/adapters/llm/json-recovery.ts`
- **What**: The single-pass inner-quote repair mis-handles quoted strings containing
  quotes (e.g. `"Joe "The King" Smith"`) and assumes ASCII whitespace in its lookahead.
  Adversarial German open-web text (Tier-4) raises the odds of a mis-repair.
- **Why deferred**: Low frequency; the LLM-truncation flag (now surfaced) and the boundary
  rejection make a bad repair visible rather than silently wrong, and nothing auto-publishes.
  (Was H6 in the hardening plan.)
- **Fix-when**: a real fixture breaks extraction via mis-repair — add it as a golden test,
  then tighten (consider a repair-retry or a stricter parser). Don't build a full JSON parser.
- **Logged**: 2026-06-20

### pg-boss queue pool not bounded
- **Severity**: low
- **Area**: db / queue
- **Location**: `src/adapters/queue/` (pg-boss adapter)
- **What**: The pg-boss adapter opens its own pool against the same DB and is NOT
  pool-bounded like `PostgresDb` (`max`/`statement_timeout`).
- **Why deferred**: The queue is intentionally unwired in v1 (external-cron model); it's a
  no-op at runtime today, so the unbounded pool is never created.
- **Fix-when**: the in-process pg-boss worker lands — bound it so the two pools' connection
  caps sum to a known ceiling.
- **Logged**: 2026-06-20

### robots.txt cross-origin redirect is treated as no-robots (allowed)
- **Severity**: low
- **Area**: fetcher
- **Location**: `src/adapters/fetcher/polite-fetcher.ts` (`loadRobots`, cross-origin redirect branch)
- **What**: A site whose `robots.txt` redirects to a different origin (e.g.
  `shop.de/robots.txt` → `cdn.shop.de/robots.txt`, a common CDN setup) has its rules
  *ignored* and the site treated as crawl-all. RFC 9309 says to follow the redirect and
  apply the resulting rules. We chose to ignore cross-origin to avoid one origin's robots
  poisoning another, which leans toward under-respecting a legitimate site's disallows.
- **Why deferred**: rare for DE v1 targets; the safer-for-them fix (follow same-registrable-domain
  redirects) is a small enhancement, not a correctness bug.
- **Fix-when**: a real target hosts robots.txt on a sibling CDN domain and we're wrongly
  crawling disallowed paths — follow same-registrable-domain redirects.
- **Logged**: 2026-06-20

### Monitor re-crawl not clamped to remaining daily headroom
- **Severity**: low
- **Area**: crawl / cost
- **Location**: `src/adapters/cli/commands/monitor.ts` (batch loop)
- **What**: The monitor batch now STOPS when the daily budget is exhausted (H1), but unlike
  discover/ingest it doesn't pass `effectiveCostCap()` into the re-crawl it triggers — so a
  pass at €9.99/€10 can overshoot by up to one per-run cap before the next iteration's
  stop-check fires.
- **Why deferred**: bounded, small overshoot (one per-run cap); the batch-level stop is the
  load-bearing guard and is in place. Clamping would mean threading a cost cap into
  MonitorSourceUseCase → CrawlSource, a larger change.
- **Fix-when**: the per-run cap is large relative to the daily ceiling, or monitor cost
  becomes material — thread `effectiveCostCap` into the re-crawl like discover/ingest.
- **Logged**: 2026-06-20

### No source-level advisory lock for concurrent crawl/monitor
- **Severity**: low
- **Area**: db / crawl
- **Location**: crawl/monitor use-cases
- **What**: The `(dedupe_key, evidence_id)` unique index prevents duplicate *rows*, but two
  concurrent runs hitting the same source still do duplicate *work*.
- **Why deferred**: Wasted work only matters once a real scheduler runs things concurrently;
  v1 external cron is sequential per invocation.
- **Fix-when**: a scheduler/worker introduces real concurrency on the same source.
- **Logged**: 2026-06-20


### Two differently-named EvidenceStore error classes
- **Severity**: low
- **Area**: evidence-store
- **Location**: `EvidenceStoreError` (`local-fs-evidence-store.ts`) vs `S3EvidenceStoreError`
  (`s3-evidence-store.ts`).
- **What**: Each adapter throws its own error class. The port contract only requires `rejects`,
  so substitutability (LSP) holds and the contract suite passes both — but a caller that
  pattern-matches on one error type won't catch the other.
- **Why deferred**: no caller currently type-matches EvidenceStore errors; purely a consistency nit.
- **Fix-when**: if error-type-based handling is ever added — extract a shared base class (or one
  exported `EvidenceStoreError`) both adapters throw.
- **Logged**: 2026-06-20

### Scheduler templates require the S3_* secrets before being armed (EVIDENCE_STORE=s3, fail-closed)
- **Severity**: low (template/ops, not runtime — no composition change)
- **Area**: api / deployment
- **Location**: `deploy/k8s/cronjobs.yaml` (ConfigMap `EVIDENCE_STORE: 's3'` + commented `S3_*`
  Secret placeholders); `deploy/README.md`; `.github/workflows/scheduled.yml`.
- **What**: the scheduler templates default `EVIDENCE_STORE=s3` (because a CronJob pod's
  filesystem is ephemeral, so `local` would silently discard evidence). The `S3_*` secrets are
  left as commented placeholders. An operator who arms the CronJobs (un-suspends discover /
  uncomments the cron) WITHOUT first setting the `S3_*` secrets gets a hard runtime failure on
  the first crawl. This is the SAFE direction — fail-closed (error), not silent evidence loss —
  and it's documented inline + in `deploy/README.md`, but it's a setup footgun.
- **Why deferred**: a template/setup concern, not a code path; the inline comments + README call
  it out, and fail-closed is the correct posture (better a loud error than a dangling evidence_id).
- **Fix-when**: when actually arming the scheduler in an environment — set the `S3_*` secrets (and
  scope the CDN per `ARCHITECTURE.md`) before un-suspending any lane. Optionally add a startup
  preflight that asserts the S3 creds are present when `EVIDENCE_STORE=s3`.
- **Logged**: 2026-06-20

### No rate-limiting on the public unauthenticated `/v1/` API
- **Severity**: medium
- **Area**: api
- **Location**: `src/adapters/http/public-api.ts`; mounted by `src/adapters/cli/commands/serve.ts`.
- **What**: `/v1/` is open and reads Postgres directly. A bot looping requests could load the DB
  and contend with the admin API for the same pool. P3 mitigates the worst case by hard-capping
  page size AND offset in the domain (`PUBLISHED_MAX_LIMIT = 100`, `PUBLISHED_MAX_OFFSET = 10000`;
  an over-cap request is a 400, not an unbounded/deep scan), but there is no request-rate limit.
- **Why deferred**: D-decision was to keep `/v1/` read-only with no in-process rate limiting and
  put a CDN/proxy in front at deploy (the natural place for rate-limit + caching + TLS). The
  per-page cap removes the unbounded-result risk; sustained-abuse protection is an edge concern.
- **Fix-when**: at production deploy — front `/v1/` with a CDN/reverse-proxy enforcing per-IP rate
  limits + response caching (the published feed is highly cacheable). If a proxy isn't available,
  add a lightweight in-process limiter before exposing `/v1/` publicly.
- **Logged**: 2026-06-20

### Inline `DealRecord` test literals don't satisfy the full schema type (only caught by `tsconfig.test.json`)
- **Severity**: low (test-only; runtime-correct via zod defaults + esbuild type-stripping)
- **Area**: ci / testing
- **Location**: `src/adapters/http/{public-api,public-dto,review-api}.test.ts`,
  `src/application/review/review.test.ts`, `src/application/monitor/monitor-source.test.ts` (the
  `seedPublishedDeal` literal), `test/integration/public-api.integration.test.ts` — inline objects
  typed as `DealRecord`/`ReviewRecord` that omit defaulted fields (`affiliate_disclosure`,
  `published_at`, and now `source_registrable_domain`).
- **What**: these literals are missing schema fields that carry a zod `.default()`, so they fail
  `tsc -p tsconfig.test.json` (which includes `*.test.ts` + `test/**`) but pass at runtime (the
  default fills the field) and under `npm run check` (its `typecheck` is `tsconfig.json`, which
  EXCLUDES `*.test.ts`). Count was 18 errors before the Step-6 PSL/multi-country refactor and 18
  after — this change neither introduced nor removed any; it only shifted which missing field each
  error names (`published_at` → `source_registrable_domain`). Pre-existing since Step 2 added
  `affiliate_disclosure`/`published_at`.
- **Why deferred**: out of scope for the Step-6 test-signature fixups (these files were not in the
  run-failing set), and not a CI gate — CI runs `lint` + `typecheck` (tsconfig.json) + `npm test`,
  none of which compile `tsconfig.test.json`. The literals are runtime-correct.
- **Fix-when**: route every test through the `dealRecord()` contract helper / `makeLlmDeal` factory
  (which now pin all defaulted fields) instead of hand-rolled literals, OR add `tsconfig.test.json`
  to CI as a typecheck gate. Do the former first; then the latter stays green. Verify with
  `npx tsc -p tsconfig.test.json --noEmit` (must be clean).
- **Logged**: 2026-06-21

### `POST /api/sources` URL-canonicalisation may miss an existing source stored in a different URL form
- **Severity**: low (a register-flow dedup/governance edge; nothing auto-publishes; the governance guard still holds for the canonical form)
- **Area**: api / discovery / db
- **Location**: `src/application/review/source-review.ts` (`createSource` → `normaliseToUrl` → `db.sources.getByUrl`); `sources.upsert` keys on the raw `url` string.
- **What**: `createSource` runs the admin-supplied domain through `new URL(...).toString()`, which canonicalises a bare host to a trailing slash (`nope.de` → `https://nope.de/`). The by-URL governance lookup + the upsert then key on that canonical string. A source row stored under a DIFFERENT form of the same URL (e.g. `https://nope.de` with no trailing slash, or with a `www.`/path variant — as a discovered/seeded source might be) would NOT be matched: the governance guard (refuse resurrecting a rejected/pending source) could be bypassed, and a duplicate row could be inserted. The trust-critical DEAL dedupe is unaffected (it folds on registrable domain, not the raw source URL).
- **Why deferred**: the panel's "+ Add source" flow sends a bare domain (the canonical case), and the common path is a NEW domain; canonicalising ALL source-URL storage/lookup (seed-import, discovery, monitor's `resolved_url`) to one form is a wider change than this endpoint. Surfaced by the ACR-10 code review.
- **Fix-when**: when source-URL handling is unified — normalise to one canonical URL form at every source write (seed-import, discovery proposal, register) and key `getByUrl`/upsert on it (or match on the pinned `registrable_domain` for the governance lookup instead of the exact URL). Add a test for the bare-host-vs-trailing-slash case.
- **Logged**: 2026-06-22

### `approver` is a free string — Team `review_count` + audit-feed `actor` filter can undercount on case/format drift
- **Severity**: low (a derived-count accuracy gap, not a trust bug — nothing auto-publishes; surfaced by the ACR-7/10/11 code review)
- **Area**: api / review / team
- **Location**: `src/application/team/team.ts` (`listTeam` joins `reviews.countByApprover()` on the member's lowercased `email`); `src/application/review/review.ts` (`auditFeed` `actor` filter); the write boundary — CLI `review approve|reject|edit` + the HTTP `approver` body — does NOT normalise `approver`.
- **What**: a deal decision is recorded with whatever `approver` string the caller passed (e.g. `Alice@Dealroute.DE`), while team members store a **lowercased** email and the audit-feed `?actor=` filter is an **exact** match. So a decision recorded under a differently-cased/spelled approver won't count toward that member's `review_count` and won't match an `actor=` query — the derived count can silently undercount. Not a trust issue (the audit row itself is correct + immutable); only the aggregation/filter is affected.
- **Why deferred**: fixing it cleanly means normalising `approver` to a canonical email at every write boundary (CLI + all HTTP write bodies) — a cross-cutting change wider than the ACR endpoints that surfaced it, and the current data is consistent in practice (the panel sends the signed-in email). Out of scope for the ACR build.
- **Fix-when**: when reviewer identity becomes canonical (it now lives in the pipeline `team_members` table — ACR-11) — normalise `approver` to the member's stored email at the write boundary (or resolve it against the team table on write), so the audit log, the team count, and the `actor` filter all key on one canonical identity.
- **Logged**: 2026-06-22

### Admin-panel new-endpoint requests — the FULL ACR set is now BUILT (incl. ACR-10 Settings)
- **Severity**: low (informational — the panel-side ACR endpoint set is complete; this entry is now a build record)
- **Area**: api / db / metrics / settings
- **Location**: `src/adapters/http/review-api.ts` + `src/application/{metrics,settings}/`; the panel's `docs/API_CHANGE_REQUESTS.md` (separate repo) has the exact contracts.
- **Built 2026-06-22 (ACR-10 Settings — the last one):** `GET /api/settings` (grouped knobs) + `PATCH /api/settings/:key {approver, value}` (writable knobs only). Design (owner-decided): the pipeline's operational config stays ENV-DRIVEN; a new `settings` table (migration **0018**) stores only OVERRIDES for the two writable knobs — `affiliate_disclosure` (the approve default, takes effect immediately) and `daily_budget_queued` (a budget stamped with the current `DEPLOYMENT_ID` that applies on the NEXT deploy, then self-clears; the in-effect `daily_budget` stays a read-only mirror). All other knobs (`evidence_store`/`respect_robots`/`active_markets`/`alerting`) are READ-ONLY env/derived mirrors — a PATCH on them is a 409. New config `DEPLOYMENT_ID` (defaults `local-dev`). Both-adapter parity + contract + unit + integration + OpenAPI/Postman. The panel-side handoff (add `read_only` to its row schema, render read-only rows view-only, drop the no-backing placeholders `auto_crawl`/`min_confidence`, render both budget fields) is in `docs/handoffs/ADMIN_PANEL_metrics_endpoints.md` §4.
- **Built 2026-06-22 (the cheap + keystone + opted-in set):** **ACR-5** `GET /api/candidates/counts`, **ACR-7** `GET /api/audit` (approve/reject/edit feed), **ACR-10** `GET /api/published` (admin history) + `GET/POST /api/sources` (registry), **ACR-12** `POST /api/manual-capture-tasks` (ad-hoc), **ACR-11 + ACR-10-Team** `GET/POST /api/team` + `PATCH /api/profile` (pipeline is now the reviewer-identity system of record — owner decision; `team_members`, migration 0016), **ACR-8** `GET /api/alerts` + ack/resolve (persisted `alert_events`, migration 0017, read-time auto-resolve — owner opted in).
- **Built 2026-06-22 (the metrics/aggregation layer):** **ACR-6** `GET /api/metrics/throughput?period=today` → `{ approved, rejected, edited, avg_review_seconds }` (today's reviewer counts + mean capture→decision latency); **ACR-9** `GET /api/candidates/freshness` → `[{ bucket: "<24h"|"1-3d"|">3d", percent }]` (pending-queue age distribution, aged by `now − evidence.captured_at`); **ACR-10 Metrics** `GET /api/metrics` → `{ kpis, cost_per_day (14 UTC days), confidence_distribution }`. Pure domain projections (`src/domain/metrics/{throughput,queue-freshness,dashboard-metrics}.ts`) over new ports `DealRepository.pendingQueueSignals` + `ReviewRepository.listDecisionLatenciesSince` — both adapters + contract suite, NO schema/migration. All with both-adapter parity + contract + unit + integration + OpenAPI/Postman.
  - **Owner-decided contract divergence (ACR-6):** the endpoint returns the ACR-doc `avg_review_seconds` (raw number), NOT the panel's current `throughputSchema` which parses a pre-formatted `avg_review` string. A one-line panel-side zod + formatter migration is handed off in `docs/handoffs/ADMIN_PANEL_metrics_endpoints.md` — give that file to the Admin-Panel project to self-update. Until it does, the panel's throughput card will reject the live response.
  - **Owner-decided basis:** `avg_review_seconds` + the freshness age use `evidence.captured_at` (capture→decision / now−capture) — the honest signal, since the pipeline has no separate "entered queue" timestamp. It is dominated by queue WAIT, not active review effort; revisit if a true review-effort metric is wanted (would need a queue-entered timestamp = a deal-record schema change).
- **What's STILL deferred (ACR set)**: NOTHING — the full new-endpoint set (ACR-5/6/7/8/9/10/11/12) is built. The two remaining items below are SMALLER follow-ups, not endpoints.
- **Follow-up — a real `min_confidence` auto-queue GATE** (owner deferred building it): the panel's Settings placeholder modelled a "minimum confidence to auto-queue" knob, but no such gate exists in the pipeline (nothing auto-queues by confidence). The Settings endpoint deliberately does NOT serve that key (the handoff tells the panel to drop it). Build the gate (+ make it a writable setting) only if the product wants confidence-based routing.
- **Follow-up (ACR-7):** the audit feed currently serves only the persisted review actions `approve|reject|edit`; the panel additionally models `promote` (field-proposal→vocabulary) and `extract` (a crawl produced a candidate), which are **not yet written as audit rows**. Add audit-row writes at `promoteFieldProposal` + the crawl candidate-sink, plus an entity-type on the audit row (extract/promote aren't always deal-scoped), to surface them.
- **Ops note (daily_budget_queued):** the queued-budget override is ADOPTED at the next deployment's boot — `Container.init()` (called by `serve` + the budget-using CLI lanes) runs `SettingsUseCase.consumeQueuedBudget()`, which adopts a prior-deploy queued value as that process's `DailyBudgetGuard` ceiling and DELETES the row (self-clear). Production MUST set a real, per-deploy `DEPLOYMENT_ID` (image SHA / release tag) for this to fire; the default `local-dev` never changes, so a queued value set locally would only be adopted on a config-bumped restart (fine for dev). Wire `DEPLOYMENT_ID` into the Fly deploy when pinning the image tag (the `fly.toml` `[env]` block documents it). NOTE: a long-running `serve` process consumes the queue once at startup — a NEW budget queued WHILE that process runs still applies only on its NEXT restart/deploy (the guard isn't re-read mid-process), which is the intended "next deployment" semantics.
- **Fix-when**: build the `min_confidence` gate if confidence-based auto-queue is wanted; add promote/extract audit rows when the audit screen needs the full action vocabulary; set `DEPLOYMENT_ID` per deploy in prod.
- **Logged**: 2026-06-22 (updated 2026-06-22: ACR-5/7/8/10/11/12 + the ACR-6/9/10-Metrics layer + ACR-10 Settings ALL shipped — the ACR endpoint set is complete)

### Auth/IAM migrations 0019–0022 carry STALE intermediate drizzle snapshots (only 0023 is final-shape)
- **Severity**: low (dev-time tooling only; runtime is unaffected)
- **Area**: db / migrations
- **Location**: `drizzle/meta/0019_snapshot.json`…`0022_snapshot.json` (vs the correct `0023_snapshot.json`); `drizzle/0019–0023_*.sql`.
- **What**: the five auth migrations were authored via `drizzle-kit generate --custom` because drizzle-kit's table-RENAME detection is interactive (it can't run non-interactively here, and these migrations also need seeds/backfills/a column-drop it never generates). `--custom` copied the prior (0018) snapshot forward, so the intermediate `0019–0022` meta snapshots still describe `team_members`/no-auth-tables. The FINAL snapshot `0023_snapshot.json` was regenerated to the true final schema (verified: a fresh `db:generate` reports "No schema changes"), and `migrate()` uses ONLY the journal + `.sql` files (which are correct + verified applying cleanly from scratch AND on top of an existing `team_members`), so runtime + CI integration are unaffected.
- **Why deferred**: harmless — the only consumer of intermediate snapshots is a hypothetical `db:generate` run pinned to an intermediate migration, which the repo never does; there is no `db:check` CI gate on snapshot content; the latest snapshot (the one future generates diff against) is correct.
- **Fix-when**: if a future `db:generate` ever produces a spurious diff, or if a snapshot-integrity check is added — regenerate the intermediate snapshots in an interactive terminal (answer the rename prompt `team_members → users`) and commit them. Not worth the interactive-tooling risk now.
- **Logged**: 2026-06-23 (Auth/IAM Phase 1)

### Phase-2 login: lockout must stay anti-enumeration (429 shape identical for known vs unknown email)
- **Severity**: medium (a trust/anti-enumeration design constraint for the NOT-YET-BUILT login use-case; no live surface yet)
- **Area**: auth (Phase 2)
- **Location**: `src/domain/auth/auth-errors.ts` (`AccountLockedError`, `lockedUntil` now nullable); the future `AuthenticateUseCase` (Phase 2/3).
- **What**: lockout is keyed to a real account's `failed_login_count`/`locked_until`, so an unknown email has no counter and never "locks". If the login use-case returns a 401 (`InvalidCredentialsError`) for an unknown email but a 429 (`AccountLockedError`) for a known-but-locked one, the differing status/shape is an account-enumeration oracle — defeating the constant-time-hasher work `DUMMY_PASSWORD_HASH` exists for. `AccountLockedError.lockedUntil` was made nullable in Phase 1 so the use-case CAN return an identical 429 shape on the unknown-email path if it chooses to model a per-email/per-IP attempt counter that doesn't require a user row (the panel already keeps such a sliding-window limiter as defense-in-depth).
- **Why deferred**: the login use-case + HTTP handler are Phase 2/3; Phase 1 only ships the error type + the pure `lockoutPolicy`. The decision (and a timing/return-shape parity test for unknown-vs-known email) belongs with the use-case that produces these errors — `.claude/rules/testing.md` already mandates that adversarial "timing parity unknown-vs-known email" test for `/auth/login`.
- **Fix-when**: when building `AuthenticateUseCase` (Phase 2) — decide the unknown-email-under-attack behavior, keep the 401-vs-429 distinction from leaking account existence, and add the timing/shape-parity boundary test.
- **Logged**: 2026-06-23 (Auth/IAM Phase 1 — code-reviewer follow-up)

### Integration harness `seedAuthBaseline` reseeds the permissions catalog with `label = key` (not migration 0021's human labels)
- **Severity**: low (test-fixture fidelity; no runtime/contract impact)
- **Area**: testing / db
- **Location**: `test/integration/harness.ts` (`seedAuthBaseline`, the `permissions` INSERT uses `VALUES ($1, $1)`).
- **What**: after a TRUNCATE, the harness restores the permission KEYS but sets each `label` to the key itself, whereas migration 0021 installs human labels ("View the review queue", …). Current tests assert only keys, so this is harmless, but a future test asserting a permission label would pass against test data that diverges from prod.
- **Why deferred**: no test reads labels yet; importing the labels would couple the harness to the migration's label strings for no current benefit.
- **Fix-when**: when a test (or the Phase-3 `GET /api/permissions` integration test) asserts permission labels — source the labels from a shared constant the migration also uses, or assert keys only.
- **Logged**: 2026-06-23 (Auth/IAM Phase 1 — code-reviewer follow-up)

### `team.upsert` over the consolidated `users` table loses the auth columns it can't express
- **Severity**: low (a projection seam, by design; no data is corrupted)
- **Area**: db / auth
- **Location**: `PgTeamRepo`/`InMemoryTeamRepo` (`src/adapters/db/{postgres,in-memory}`); `src/domain/team/team-member.ts`.
- **What**: `TeamMember` is now a PROJECTION of `User` (the `team_members → users` consolidation). `team.upsert` writes only name/email/role/status, defaulting the auth columns (`password_hash=null`, `token_version=0`, `auth_provider='password'`) on a fresh row — and a custom (non-admin/non-reviewer) role projects to `'reviewer'` on read (TeamMember.role is the closed admin|reviewer enum). So the legacy Team write path can't set a password or a custom role.
- **Why deferred**: intended for the dual-accept window — the legacy `/api/team` path keeps working unchanged (invite → invited user, no password yet), and real login-capable provisioning + custom roles arrive via `ProvisionUserUseCase` / the `/api/users` screen in Phase 3. The panel migrates off `/api/team` in Phase 4; `/api/team` is removed in Phase 5.
- **Fix-when**: when `/api/team` is retired (Phase 5) — drop the projection and the `TeamMember.role`→reviewer fallback; until then it is the correct compatibility shim.
- **Logged**: 2026-06-23 (Auth/IAM Phase 1)

### Auth dual-accept window: the legacy static `REVIEW_API_TOKEN` is still accepted on `/api/*` (must be time-boxed; remove in Phase 5)
- **Severity**: medium (a deliberately-temporary widening of the trust boundary)
- **Area**: api / auth (Phase 2)
- **Location**: `src/adapters/http/review-api.ts` (`authenticate()` legacy branch → `{ kind:'legacy' }`); wired via `serve.ts` (`auth.tokenIssuer` + `config.reviewApi.authToken`).
- **What**: to let the panel cut over without a flag-day, the per-request guard accepts the **legacy static bearer** alongside per-user JWTs. A legacy caller is given NO identity and NO per-user permissions — it deliberately does **not** synthesize a `legacy-token@system` actor, so it cannot pollute the email-keyed `reviews.approver` audit trail (a legacy write still records the BODY `approver`, the pre-Phase-2 behaviour; the registry per-permission check is skipped for it, as the static token was always all-or-nothing). It is still a single shared all-powerful credential whose leak = full write access until retired.
- **Why deferred**: the window is required so the panel (separate repo) can migrate to `/auth/login` + per-user tokens without a lockstep deploy. It is bounded: the plan retires `REVIEW_API_TOKEN` + this branch in **Phase 5**, after the panel cutover (Phase 4).
- **Fix-when**: Phase 5 — delete the legacy branch in `authenticate()`, drop `REVIEW_API_TOKEN` from config + `serve.ts`, and remove the accept-but-ignore body `approver` (make it a required token-derived field). Keep `adminCorsAllowOrigin`.
- **Logged**: 2026-06-23 (Auth/IAM Phase 2)

### Login lockout (429) remains account-specific, while unknown-email is 401 — a residual enumeration signal
- **Severity**: medium (anti-enumeration; partially mitigated)
- **Area**: auth (Phase 2)
- **Location**: `src/application/auth/authenticate.ts` (`AuthenticateUseCase` — lockout is read from a real user's `getLoginState`; unknown email throws `InvalidCredentialsError`/401).
- **What**: the login path is constant-time + generic-401 for unknown-vs-wrong-password (the `DUMMY_PASSWORD_HASH` verify runs on the unknown-email path). But lockout is keyed to a real account, so a locked **known** email returns 429 while an unknown email always returns 401 — the differing status under repeated attempts can still hint that an email exists. (Flagged in the Phase-1 note "Phase-2 login: lockout must stay anti-enumeration".)
- **Why deferred**: closing it fully needs a per-email/per-IP sliding-window limiter that locks WITHOUT a user row (so an unknown email can also surface a 429) — the panel already runs such a limiter as defense-in-depth, and the pipeline lockout is the second layer. The status-vs-existence leak is low-signal (it requires crossing the threshold) and the higher-value fix (the per-IP limiter) belongs with a rate-limit pass, not this phase.
- **Fix-when**: when adding a pipeline-side per-IP/per-email attempt limiter — return an identical 429 shape for an unknown-but-attacked email, and add the `testing.md`-mandated timing/shape-parity boundary test for unknown-vs-known email on `/auth/login`.
- **Logged**: 2026-06-23 (Auth/IAM Phase 2)

### Granular `*:read` permissions are defined but not enforced on bare GETs — every authed user can read every gated GET (deliberate Phase-2 posture)
- **Severity**: low (defense-in-depth / least-privilege; not an identity or leak hole)
- **Area**: api / auth (Phase 2)
- **Location**: `src/adapters/http/review-api.ts` (`requireRead` — authorizes any valid identity, no permission check); `src/domain/auth/permission.ts` (`candidate:read`/`sources:read`/`settings:read`/`team:read`).
- **What**: the plan's route→permission registry maps "every bare `GET /api/*` read → valid token only, no named permission" — so `requireRead` grants any verified user every gated read, and the `*:read` enum keys (which exist so a FUTURE role can be *denied* a read) aren't consulted. Only `GET /api/evidence/:id/:artifact` keeps a named permission (`evidence:read`, the one sensitive GET). A reviewer with no `team:read`/`settings:read` can still read `/api/team` and `/api/settings`. Every reader is still a verified active user, and the public-DTO leak boundary is untouched — this is a least-privilege gap, not a forge/leak hole.
- **Why deferred**: it's the intended Phase-2 design (the handoff §2.4 registry + the `permission.ts` comment both state bare GETs are "auth required" by default). Wiring per-read denial needs the Phase-3 Roles UI to even create a role that lacks a read perm — there's no way to exercise it until custom roles exist.
- **Fix-when**: Phase 3 (Users & Roles) — add a route→read-permission lookup in `requireRead` and a "low-permission user is denied a read → 403" test, once a role without a given `*:read` can be created.
- **Logged**: 2026-06-23 (Auth/IAM Phase 2 — code-reviewer follow-up)

---

## Resolved

### Public landing page GDPR/affiliate-disclosure fields — RESOLVED 2026-06-23
- **Was**: high (legal/compliance launch gate), api / schema / legal. P3 shipped the public `/v1/`
  read API without the EU-Omnibus / GDPR affiliate-disclosure fields; the landing page could not go
  live off the feed until they existed + legal confirmed what a DE deal page must show.
- **Resolution**: Step 2 (schema v3) added `affiliate_disclosure` (bool, default true — over-disclose)
  + `published_at` to the deal record, set by the reviewer at approve, and the public DTO exposes both
  (`PublicDeal.affiliate_disclosure` / `published_at`) — contract-tested as part of the no-leak
  allow-list. The **field side is delivered**, and the owner has **confirmed the legal/compliance side
  is fine** (2026-06-23), so the launch gate is cleared. (Any further per-page legal copy is a landing-
  page-repo concern, not a pipeline/schema gap.)

### Public CDN must expose ONLY `screenshot.png`, not the whole evidence bundle — RESOLVED 2026-06-23
- **Was**: high (trust / copyright — a deployment-config gap), evidence-store / api / deployment.
  A bundle stores `screenshot.png` + `page.html` + `terms.txt` + `evidence.json` under one `<id>/`
  prefix; the public DTO emits only the screenshot URL, but a public CDN over that prefix would let a
  consumer edit the URL to `…/<id>/terms.txt` / `…/page.html` and fetch the raw HTML snapshot + the
  verbatim (copyrighted) terms text the DTO deliberately drops.
- **Resolution**: a committable screenshot-only CDN artifact under `deploy/aws/` —
  `setup-evidence-cdn.sh` (idempotent; mirrors `setup-evidence-s3.sh`) builds CloudFront + Origin
  Access Control over the fully-access-blocked bucket + a CloudFront **Function**
  (`cloudfront-screenshot-only.js`, allow-list `^/<id>/screenshot.png$`, 403 otherwise; unit-verified
  against bypass shapes) + an OAC-only bucket policy (`evidence-cdn-bucket-policy.json`, scoped to one
  distribution via `aws:SourceArn`). The bucket itself stays fully public-access-blocked — CloudFront
  is the only door, the function is the lock. Docs point at it: `deploy/fly/README.md` §2.4 (incl. the
  scoping acceptance test), `ARCHITECTURE.md` "Public read surface", Status §3.
- **Verified live (2026-06-23)**: provisioned the CDN (distribution `EWO9T0BEK3PYG`, domain
  `d31ssbttp5kfu7.cloudfront.net`) over `dealroute-evidence-prod`, crawled a real bundle to S3, and ran
  the acceptance test against a genuine `<id>/` bundle: `…/screenshot.png` → **200**; `…/terms.txt`,
  `…/page.html`, `…/evidence.json` → **403**; a direct unsigned S3 fetch of `…/terms.txt` → **403**.
  The gate holds. (Setting the `S3_CDN_BASE_URL` Fly secret to switch on public screenshot URLs is a
  separate, deliberate go-live step; leaving it unset remains the safe default.)

### Reviewer access to evidence HTML/terms over the screenshot-only public CDN — RESOLVED 2026-06-23
- **Was**: a usability/contract gap surfaced when `S3_CDN_BASE_URL` was set — the admin DTO resolved
  `evidence_html_url` against the public CDN, but that CDN is screenshot-only (it 403s `page.html` /
  `terms.txt`), so the panel's archived-HTML link would 403. Root cause: reviewers (full bundle) and
  the public page (screenshot only) were both reading evidence through one public CDN.
- **Resolution**: a Bearer-gated `GET /api/evidence/:id/:artifact` (artifact ∈ screenshot|html|terms)
  that streams the bytes from the `EvidenceStore` (new `getArtifact(id,kind)` port method, implemented
  by local-fs + S3 + the fake, covered by the shared contract). The admin DTO's `evidence_*_url` now
  point at this authed path (relative, always present) + a new `evidence_terms_url`; the public `/v1/`
  feed keeps its CDN screenshot URL untouched. `Cache-Control: private, no-store`; the only gated GET.
  This is the READ-side twin of the still-open "manual-capture UPLOAD channel" finding below. Panel
  handoff: `docs/handoffs/ADMIN_PANEL_evidence_fetch.md` (the panel must fetch-with-bearer → blob URL).

### Postgres `Database` contract suite isn't isolated per-test and isn't run in CI — RESOLVED 2026-06-23 (P1)
- **Was**: medium, ci / db / testing, `src/adapters/db/postgres/postgres-db.test.ts` +
  `test/contracts/database-contract.ts` + the vitest configs.
- **Problem**: the Postgres adapter contract (the LSP substitutability gate) never ran in CI —
  it self-skipped in the unit tier (no DB) and wasn't in the integration glob — and its cases
  polluted each other (no per-test truncation) when the file ran whole.
- **Resolution**: `databaseContract` gained an optional `reset` hook run in `beforeEach`; the
  Postgres entry shares ONE connection and supplies a TRUNCATE-all reset (a separate pool, so
  the adapter under test is never reached for the reset). The file moved into the integration
  tier (`vitest.integration.config.ts` include + excluded from the unit config so it isn't
  double-run), so CI's Postgres-backed integration job now runs all 63 contract cases. Fixing
  isolation also surfaced a real latent test bug — `updateStatus(... 'r', 't')` passed `'t'`
  as a `timestamptz` (Postgres rejected it; the more-permissive in-memory adapter had masked
  it) — now a valid ISO timestamp. The whole file passes (63/63) against real Postgres.

### A malformed (non-UUID) `:id` on an HTTP route 500s instead of 404 — RESOLVED 2026-06-23 (P1)
- **Was**: low, api / db, `src/adapters/http/public-api.ts` + `review-api.ts`.
- **Problem**: `GET /v1/deals/abc` / `POST /api/candidates/abc/approve` (any non-UUID id) hit
  the `uuid` column and 500'd with `invalid input syntax for type uuid`, instead of a clean 404.
- **Resolution**: a shared `isUuid` boundary helper (`src/adapters/http/http-ids.ts`). The
  public `getDeal` 404s a non-UUID id before the DB call; the gated review-API `:id` routes
  whose id maps to a `uuid` column (candidates/sources/alerts/manual-complete) embed the UUID
  shape in their route regex (`UUID_SEG`), so a malformed id falls through to the catch-all 404
  — never reaching the DB. The string-keyed routes (`field-proposals/:key`, `settings/:key`)
  are unchanged. Covered by unit tests on both routers + an `isUuid` table test.

### Monitor source-scoped lookups keyed off `source.url`, not the resolved `finalUrl` — RESOLVED 2026-06-20 (Step 4 / Prereq A)
- **Was**: medium (trust-relevant for cross-domain-redirecting sources), monitor / db,
  `src/application/monitor/monitor-source.ts`.
- **Problem**: monitor found/expired a source's deals by exact-string match of `source.url`, but
  deals pin `source_url = fetched.finalUrl` (post-redirect). A source whose canonical URL
  redirected to a different URL/domain → monitor's lookups never matched its own deals → every
  pass looked like a first observation, and `expirePublishedBySourceUrl` never matched, so those
  published deals could not auto-expire. A real trust gap once unattended scheduling lands.
- **Resolution** (Step 4 prerequisite): added a nullable `resolved_url` to the Source (schema +
  migration `0011`, additive/backfill-safe), set on the first successful crawl/monitor pass
  (= `fetched.finalUrl`) via the shared pure `applyCrawlOutcome(source, true, now, resolvedUrl)`
  (success-only; never overwritten with undefined; a failed/blocked/robots pass leaves it
  untouched). Monitor now matches its expiry + diff-baseline on `dealMatchUrl(source) =
  source.resolved_url ?? source.url`. Existing rows are `NULL` → fall back to `url`, self-healing
  on the next crawl. Unit (crawl sets it / failed pass preserves it / `applyCrawlOutcome`
  permutations / monitor expires a redirecting source / non-redirecting url fallback) +
  integration (real Container+Postgres end-to-end: a redirecting source's published deal DOES
  expire) + contract round-trip. code-reviewer APPROVED + a 4-angle adversarial-verify returned
  SAFE-TO-MERGE (no live deal wrongly expired; `resolved_url` never corrupted). 607 unit tests green.

### Firecrawl adapters on `/v1` while the guideline documents `/v2` — RESOLVED 2026-06-20
- **Was**: low (forward-compat), search/fetcher, the two Firecrawl adapters.
- **Problem**: adapters called `/v1/search` (flat `data[]`) + `/v1/scrape`; the official guideline
  documents `/v2`, whose search returns the different shape `data.web[]`.
- **Resolution**: both adapters refactored to `/v2`. `firecrawl-search-provider` parses
  `data.web[]` (+ optional `position`); `firecrawl-fetcher` calls `/v2/scrape` and now
  **zod-validates** the response (was a TS cast — fixed in the same pass per the boundary rule).
  Added the v2 value-add: optional inline search-scrape (`SearchOptions.scrape` →
  `SearchResult.content`), consumed by the Tier-4 agent ONLY behind our authoritative robots/
  rate-limit gate (`PoliteFetcher.checkAccess`) so the public-only invariant holds; off by default
  (`AGENT_INLINE_SCRAPE`). Screenshot resolution shared via `adapters/shared/screenshot-download`.
  Verified live + adversarially (public-only, evidence-required, v2-boundary all HOLD); 566 tests green.

### RSS feed items bypassed zod validation at the boundary (B1) — RESOLVED 2026-06-20
- **Was**: high (broken invariant "never trust raw external data"), feed/ingestion,
  `src/adapters/feed/rss-feed-reader.ts` (`parseFeed`).
- **Problem**: `parseFeed` built `FeedItem[]` from regex-extracted XML with no `zod.parse()`;
  `item.link` reached `fetcher.fetch()` with its scheme/format unvalidated, and title/summary
  entered the LLM triage prompt. Surfaced by the 2026-06-20 full audit. Not exploitable
  (triage already `frameUntrusted`-wraps the item; link still hits PoliteFetcher) but a genuine
  invariant violation.
- **Resolution**: added `FeedItemSchema` (zod) — `link` validated as an http/https URL (via a
  throw-safe `isHttpUrl` refine), title/summary strings, publishedAt ISO-or-null. `parseFeed`
  `safeParse`s each item and DROPS failures (keeps the "bad feed → []"/skip-bad-item resilience).
  5 adversarial unit tests added (non-URL link; `javascript:`/`file:`/`data:`/`ftp:` schemes
  dropped; a valid item survives alongside a dropped one; injection strings in title/summary
  preserved verbatim on a valid item — framed untrusted downstream, not parseFeed's job to strip).
  `npm run check` green (537 tests).

### `cdnBaseUrl` config parsed but not yet consumed — RESOLVED 2026-06-20
- **Was**: low, api / config, `src/config/config.ts` (`evidence.s3.cdnBaseUrl`, env `S3_CDN_BASE_URL`).
- **Problem**: the field was added in P2 (S3 adapter) for the upcoming public read API but nothing
  read it (no public API existed).
- **Resolution**: P3 consumes it. The public DTO (`src/adapters/http/public-dto.ts`,
  `resolveScreenshotUrl`) builds `${cdnBaseUrl}/${evidence_id}/screenshot.png` from the
  deterministic evidence layout (`src/domain/evidence/evidence-layout.ts`, shared by both
  EvidenceStore adapters), returning null when `cdnBaseUrl` is unset (local-fs evidence). No
  evidence-store I/O — the screenshot path is derived purely from `evidence_id`.

### Dedupe-key omits source/origin (provenance) — RESOLVED 2026-06-20
- **Was**: medium (trust-relevant), domain / schema, `src/domain/rules/dedupe-key.ts`.
- **Problem**: the key was `service + provider + route_type + country`, so two sources
  reporting the same route collapsed to (or churned) the same key.
- **Resolution**: schema-owner decision was **split-by-source**. `dedupeKey` now takes the
  trusted fetched source URL and folds `registrableDomain(sourceUrl)` (sentinel
  `unknown-source` when unparseable) as a 5th key segment after country. Each source's report
  of a route is its own record, preserving per-source evidence/confidence/terms. The
  registrable domain (not the full URL) is the discriminator, so `www.`/bare-host, trailing
  slash, and path/query variants on the same site still collapse (re-crawl idempotency holds).
  Consistency invariant: the extract-time key and the recompute-from-row key are identical
  because `CandidateSink` pins `deal.source_url = evidence.source_url` (the same fetched
  finalUrl extract received), and every recompute site passes `dedupeKey(d, d.source_url)`.
  Greenfield — no data migration; the `(dedupe_key, evidence_id)` unique index +
  `deals_dedupe_idx` are unchanged (they index whatever the key is).

### Lane-A extract-key used `source.url` instead of `fetched.finalUrl` — RESOLVED 2026-06-20
- **Was**: medium (trust), `src/application/crawl/crawl-source.ts`. Caught by the P1
  adversarial-verify pass.
- **Problem**: with split-by-source live, the dedupe key folds in the source's registrable
  domain. Lane A called `extract.execute({ sourceUrl: source.url })` while evidence pinned
  `source_url = fetched.finalUrl`. A source redirecting to a different registrable domain made
  the extract-time key (from `source.url`) differ from the recompute-from-row key (from
  `finalUrl`), so `findByDedupeKey` missed the prior row → silent duplicate every re-crawl.
- **Resolution**: Lane A now passes `fetched.finalUrl` to `extract.execute` (matching the Lane-B
  paths + the evidence pin), so extract-time and recompute-from-row keys are identical. Pinned by
  a crawl-source regression test (cross-domain redirect → dedupes to one record; proven to fail
  without the fix). NB: monitor's source-scoped lookups have a RELATED but distinct gap, still
  open above ("Monitor source-scoped lookups key off `source.url`…").

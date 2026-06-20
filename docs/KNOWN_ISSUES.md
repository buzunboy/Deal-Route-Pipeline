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

### Postgres `Database` contract suite isn't isolated per-test and isn't run in CI
- **Severity**: medium
- **Area**: ci / db / testing
- **Location**: `src/adapters/db/postgres/postgres-db.test.ts`, `test/contracts/database-contract.ts`, `vitest.integration.config.ts`
- **What**: Two linked gaps. (1) The shared `databaseContract` gives each test a fresh store
  for the in-memory adapter, but for Postgres `makeDb()` just reconnects to the same DB with
  no per-test truncation — so count/global-list tests (`fieldProposals` repeat-sighting,
  `expirePublishedBySourceUrl`, `findByDedupeKey` canonical) collide and fail when the file
  is run as a whole. (2) The suite only runs under the default vitest config and self-skips
  without `DATABASE_URL_TEST`; the integration config includes only `test/integration/**`, and
  the CI `check` job has no DB — so the Postgres adapter contract effectively **never runs in
  CI** (contradicting the testing-rules claim that it runs in the integration tier).
- **Why deferred**: not gating anything today (it skips in CI) and the adapter is covered
  end-to-end by `test/integration/**` (all green). Fixing isolation means giving the contract
  a per-test reset hook (truncate for Postgres / fresh map for in-memory) and wiring the file
  into the integration tier — a focused test-harness change, not a product fix.
- **Fix-when**: before relying on the contract suite as the substitutability gate, or when
  wiring the Postgres contract into the integration run — add a `resetBetweenTests` hook to
  `databaseContract` and include the file in `vitest.integration.config.ts`.
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

### Monitor source-scoped lookups key off `source.url`, not the resolved `finalUrl`
- **Severity**: medium (trust-relevant for cross-domain-redirecting sources)
- **Area**: monitor / db
- **Location**: `src/application/monitor/monitor-source.ts` (`expirePublishedBySourceUrl(source.url, …)`
  and `listBySourceUrl(source.url, …)` in `lastHashForSource`); the deals carry
  `source_url = fetched.finalUrl` (pinned by CandidateSink).
- **What**: Monitor finds/expires a source's deals by exact-string match of `source.url` against
  the persisted `deal.source_url`. But deals pin `source_url` to `fetched.finalUrl` (post-redirect).
  If a source's canonical URL redirects to a **different** URL/domain, monitor's lookups never match
  its own deals → every monitor pass looks like a first observation (needless re-crawl each cycle),
  and `expirePublishedBySourceUrl` never matches so those published deals can't auto-expire.
  Pre-existing (evidence pinned `finalUrl` before split-by-source too); surfaced by the P1 review.
  NOT the same as the crawl-source extract-key bug, which IS fixed (see Resolved below).
- **Why deferred**: only bites sources whose canonical URL redirects across the matched URL; the
  proper fix means tracking the resolved/final URL on the `sources` row (or matching by registrable
  domain), a separate behavioural change with its own schema touch + tests.
- **Fix-when**: before unattended Lane-A monitoring of sources known to redirect; track the
  resolved URL on the source (set on first successful crawl) and have monitor match on it.
- **Logged**: 2026-06-20

### Public landing page must NOT launch off `/v1/` without GDPR/affiliate-disclosure fields
- **Severity**: high (legal/compliance gate — not a code defect, a launch dependency)
- **Area**: api / schema / legal
- **Location**: the public deal record / DTO (`src/adapters/http/public-dto.ts`); the schema
  (`src/domain/deal-record/`). Tracked against post-C Step 2 (`docs/DealRoute_PostC_Handoff.md`).
- **What**: P3 ships the public `/v1/` READ API but deliberately does NOT add affiliate-disclosure
  / data-protection (EU-Omnibus / GDPR) fields — that was an explicit owner decision (P3 = API
  surface only; the fields gate the public PAGE, not the API existing). PostC flags these as
  "cheap to add WITH Step 1, expensive to retrofit."
- **Why deferred**: the API can exist and be tested without them; they are a schema-owner call and
  belong with the page launch (post-C Step 2), not the read surface.
- **Fix-when**: BEFORE the landing page goes live off this API. Add the disclosure field(s) to the
  deal record + the public DTO (a schema change → ask the schema owner per CLAUDE.md), and confirm
  with legal what must be shown on a public DE deal page.
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

### Public CDN must expose ONLY `screenshot.png`, not the whole evidence bundle
- **Severity**: high (trust / copyright — a deployment-config gap, not a code defect)
- **Area**: evidence-store / api / deployment
- **Location**: `src/adapters/evidence-store/s3-evidence-store.ts` (bundle layout); consumed by
  `src/adapters/http/public-dto.ts` (`resolveScreenshotUrl`) via `S3_CDN_BASE_URL`.
- **What**: a bundle stores `screenshot.png` + `page.html` + `terms.txt` + `evidence.json` under one
  `<id>/` prefix with fixed public-constant names (`src/domain/evidence/evidence-layout.ts`). The
  public DTO only emits the `screenshot.png` URL, but if `S3_CDN_BASE_URL` fronts that prefix
  publicly, a consumer can edit the URL to `…/<id>/terms.txt` / `…/page.html` and fetch the raw HTML
  snapshot + the **verbatim (copyrighted) terms text** the DTO deliberately drops. That re-exposes
  exactly the data the `source_quote`/`raw_conditions_text` no-leak invariant protects.
- **Why deferred**: it's a deployment/bucket-policy concern, not a code path — the API exposes only
  the screenshot URL. Fully separating screenshots into their own public bucket/prefix is an
  evidence-store change (P2 territory) that would touch the write-once / no-partial-bundle
  guarantees, so it's documented + enforced at deploy rather than re-architected for P3.
- **Mitigation in place**: the deployment contract is documented loudly next to `S3_CDN_BASE_URL`
  (config JSDoc + README + ARCHITECTURE.md "Public read surface").
- **Fix-when**: BEFORE pointing `S3_CDN_BASE_URL` at a public bucket — scope the CDN/bucket policy
  to `*/screenshot.png` objects only (deny `page.html`/`terms.txt`/`evidence.json`), or write
  screenshots to a separate public prefix/bucket from the rest of the bundle. Verify by attempting
  to fetch `…/<id>/terms.txt` against the public CDN (must be denied).
- **Logged**: 2026-06-20

---

## Resolved

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

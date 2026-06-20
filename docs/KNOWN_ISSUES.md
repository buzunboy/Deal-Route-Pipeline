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

### CI jobs not dependency-ordered
- **Severity**: low
- **Area**: ci
- **Location**: `.github/workflows/ci.yml`
- **What**: The unit `check` job and the `integration` job run in parallel (no `needs:`).
  Migrations are applied idempotently inside the integration harness, so it works, but a
  unit-only break still spins up Postgres before failing.
- **Why deferred**: Purely cosmetic / minor CI-time waste; correctness is unaffected.
- **Fix-when**: touching CI for another reason — add `needs: check` to the integration job.
- **Logged**: 2026-06-20

### Dedupe-key omits source/origin (provenance)
- **Severity**: medium (trust-relevant)
- **Area**: domain / schema
- **Location**: `src/domain/rules/dedupe-key.ts` (`service + provider + route_type + country`)
- **What**: Two sources reporting the same route collapse to (or churn) the same dedupe key,
  producing duplicate `in_review` candidates. It's unclear whether that's the intended
  canonicalization (one offer regardless of who reports it) or should split by source.
- **Why deferred**: It's a **schema-owner decision** that affects the trust model — must be
  confirmed with the owner before changing, not decided unilaterally (roadmap §6.3).
- **Fix-when**: Tier-4 churn makes duplicates a real review-queue problem, or the schema
  owner rules on canonicalization-vs-provenance.
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

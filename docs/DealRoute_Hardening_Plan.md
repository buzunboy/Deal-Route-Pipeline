# DealRoute — leftover-hardening plan (post Phase C C-1)

> **✅ DELIVERED + merged (2026-06-20).** This was a build plan; the batch it
> describes (monitor daily-budget guard, LLM-truncation flag, Firecrawl size caps,
> robots hardening) is **done and on `master`** — its slices are marked ✅ DONE
> inline below. Kept as the historical build/design record. **NOT pending work.**
> For current next-steps read `docs/DealRoute_Status_and_Roadmap.md`.

_Standalone build plan for a fresh session. Phase A, B, Pre-C-1/2/3, the
monitor-reliability fix, **and Phase C C-1** (search-API-first Tier-4 broad
discovery) are all built, tested, and merged to `master` (at `3ad51bc`, pushed to
origin). This batch closes the **medium/low audit gaps that are still open** so
the agentic lane can run unattended safely — it is NOT C-2 (the real-browser
agent), which is the separate next stage. Authoritative companions:
`docs/DealRoute_Phase_C_and_Roadmap.md` §3 (remaining gaps) + §4/§5, and the
binding `CLAUDE.md` + `.claude/rules/`._

## 0. Orient first (before any code)

1. Read `CLAUDE.md` + `.claude/rules/` (`architecture.md`, `code-style.md`,
   `extraction-and-schema.md`, `testing.md`) — **binding**.
2. Confirm baseline green from your own worktree: `git rev-parse --abbrev-ref HEAD`
   then `npm run check && npm run build` (expect ~432 unit tests + lint + typecheck
   green; Postgres integration self-skips locally without `DATABASE_URL_TEST`).
3. Re-read the workflow/env gotchas in `docs/NEXT_SESSION_HANDOFF.md` §"Workflow /
   environment facts" (worktree `.env`, ff-only merge, no local Postgres → statically
   verify integration tests, drizzle migration flow, `.prettierignore`). Still apply.

## Hard rules (non-negotiable — unchanged)

- LLM proposes, humans approve. **Nothing auto-publishes.** Evidence required.
- Public-only; validate at every boundary (zod); never trust raw LLM/scraped data.
- Clean layered architecture / OCP; new vendors are adapters behind ports from the
  one composition root. Reuse existing building blocks; don't reinvent.
- Every external call is timeout-bounded, retried with backoff, idempotent; one
  failed source/run never crashes the batch; typed errors, no silent catches.
- **Testing rule**: every new/changed feature gets unit + integration tests (live for
  a new external edge). See `.claude/rules/testing.md`.
- Commits: small, conventional, **no `Co-Authored-By` trailer**. Run `code-reviewer`
  before merging each batch. Keep `master` ff-mergeable and green.

## What's already handled (verified — do NOT redo)

- Playwright `page.content()` is bounded by `page.setDefaultTimeout`; screenshots are
  clipped at `MAX_SCREENSHOT_HEIGHT`; HTML over `MAX_HTML_BYTES` returns `error`.
- CI applies migrations via the integration harness (`applyMigrations()`, idempotent).
- PoliteFetcher already has the injectable `RobotsClient` seam (Phase C Slice 0d).
- Prompt-injection framing (`untrusted-text.ts`) is applied in both prompts; the
  post-LLM boundary strips pipeline-owned fields. Failed-extraction cost is accounted.

---

## 1. Build order (one reviewed batch; commit in these slices, smallest-risk first)

> **Status (2026-06-20):** Slices 1–4 (the C-2 prerequisites: unattended safety + cost)
> are **DONE**. Slices 5–6 (charset, JSON-recovery/CI — quality/cosmetic) were
> **deferred** to `docs/KNOWN_ISSUES.md` rather than built. C-2 (the real-browser
> agent) is the separate next stage.

### Slice 1 — Monitor batch daily-budget guard (highest value, smallest fix) — ✅ DONE

- **Gap**: `src/adapters/cli/commands/monitor.ts` loops every due source with NO
  `DailyBudgetGuard` check. A monitor pass makes no LLM call itself, BUT a
  `content_changed` result triggers a Lane-A re-crawl (`crawlSource.execute`) that
  DOES cost money and logs a `crawl_runs` row. So an unattended monitor batch can
  blow the daily €-ceiling.
- **Fix**: mirror the `ingest`/`discover` pattern — `await container.dailyBudgetGuard.check()`
  before each source; `break` + report when `!ok`. (Monitor itself has no per-run
  €-cap to clamp, so just the stop-check; the re-crawl it spawns already respects its
  own caps.) Set a `budgetStopped` flag for the summary line.
- **Tests**: unit — monitor batch stops early when the guard reports exhausted
  (fake `crawlRuns.spentSince` over the ceiling); integration — a monitor `--due`
  run with a tiny `DAILY_BUDGET_EUR` stops before processing all due sources.

### Slice 2 — LLM truncation detection (silent zero-candidate bug) — ✅ DONE (option (a): `truncated` flag)

- **Gap**: neither `anthropic-llm.ts` nor `openai-llm.ts` inspects
  `stop_reason === 'max_tokens'` / `finish_reason === 'length'`. A reply truncated at
  the token limit silently becomes invalid JSON → zero candidates with no signal.
- **Fix**: in both adapters, read the stop/finish reason. On truncation, either (a)
  surface it on the `LlmResponse` (add an optional `truncated: boolean` to the `Llm`
  port's response type) so `ExtractUseCase` can log/flag it, OR (b) throw a typed
  `LlmTruncatedError` the use-case catches and logs distinctly. Prefer (a) — a flag is
  less disruptive and lets the extractor still attempt recovery. Keep `StubLlm` returning
  `truncated: false`. **Port change → update the contract + every adapter.**
- **Tests**: unit per adapter (mock a `max_tokens`/`length` response → flag set);
  extract unit test (a truncated response is logged/flagged, never silently dropped);
  the LLM contract suite asserts the flag is present on every adapter.

### Slice 3 — Firecrawl response/screenshot size caps — ✅ DONE

- **Gap**: `firecrawl-fetcher.ts` — `res.json()` (response body) and `downloadBytes`
  (`res.arrayBuffer()` + data-URI decode) have NO byte cap. A runaway/malicious
  response can OOM the worker. (Playwright is already bounded; this is the Firecrawl edge.)
- **Fix**: add a `MAX_*_BYTES` cap mirroring the Playwright adapter — check
  `Content-Length` where present, and bound the read (stream-with-limit or cap the
  decoded length). Over the cap → `error` outcome, not a crash. Make the limit a
  named constant (config-overridable if cheap).
- **Tests**: unit — an oversized Firecrawl body/screenshot yields `error`, not OOM
  (scripted `fetch` returning a large/`Content-Length`-lying body). Gated live edge
  optional.

### Slice 4 — robots.txt fetch hardening (size cap + 4xx/5xx nuance + redirect origin) — ✅ DONE

> **NB (2026-06-21):** robots.txt is now **opt-in** (`RESPECT_ROBOTS_TXT` defaults off under the
> best-effort-read policy — see `CLAUDE.md`). This hardening still applies when robots is turned on;
> the robots engine was kept, just disabled by default.

- **Gap**: `polite-fetcher.ts` `loadRobots` — `res.text()` has no size cap; 4xx and
  5xx both fail-open identically; the underlying fetch follows redirects without
  validating the final origin.
- **Fix**: cap the robots body read; on a 5xx (server error) prefer fail-CLOSED or a
  short retry rather than fail-open (a transient 5xx shouldn't silently grant
  crawl-all); keep 404/410 = no-robots = allowed. Validate the redirect lands on the
  same origin (a redirect to another domain's robots is not authoritative). Use the
  `RobotsClient` seam (already injectable) so it's unit-testable.
- **Tests**: extend `polite-fetcher.test.ts` — oversized robots body capped; 5xx
  handled (not naive fail-open); cross-origin redirect rejected. All via the scripted
  `RobotsClient`.

### Slice 5 — Charset / content-type guard — ⏸ DEFERRED → `docs/KNOWN_ISSUES.md`

- **Gap**: no `Content-Type`/charset handling in the fetchers; a non-UTF8
  (`iso-8859-1`) or non-HTML response is assumed UTF-8/HTML.
- **Fix**: read the response `Content-Type`; for non-HTML content types route to a
  skip/`error` outcome (we only extract HTML pages); for a declared non-UTF8 charset,
  decode with `TextDecoder(charset)` before turndown. Keep it minimal — DE v1 is almost
  all UTF-8, so the high-value part is rejecting non-HTML (PDF/image) responses cleanly.
- **Tests**: unit — a non-HTML content-type is not extracted; an iso-8859-1 page decodes
  correctly (a fixture with an umlaut).

### Slice 6 — JSON-recovery robustness + CI ordering — ⏸ DEFERRED → `docs/KNOWN_ISSUES.md`

- **JSON recovery**: `json-recovery.ts` inner-quote heuristic is fragile on quoted
  strings containing quotes (e.g. `"Joe "The King" Smith"`) and assumes ASCII
  whitespace. Low frequency, but adversarial German open-web text (Tier-4) raises the
  odds. Cheap win: add the failing cases as golden/unit tests first (pin current
  behavior), then tighten only if a real fixture breaks. Don't over-engineer a JSON parser.
- **CI ordering**: add an explicit `needs:` so integration runs after unit `check`
  (cosmetic — migrations are idempotent — but makes intent clear and fails fast on a
  unit break before spinning up Postgres).

---

## 2. Definition of done

- `npm run check && npm run build` green from the worktree; integration tests added +
  statically verified (no local Postgres → trace assertions, or rely on CI Postgres).
- `code-reviewer` run on the batch; an adversarial-verify pass on any port change
  (the Slice 2 `Llm` response shape) is appropriate.
- Docs updated: `CLAUDE.md` (if the `Llm` port / any command changes), `.env.example`
  (new size-cap / charset env if added), and this plan's items ticked.
- Defaults unchanged: `AGENT=noop` / `SEARCH_PROVIDER=stub` stay the Tier-4 off-switch.

## 3. Explicitly OUT of scope for this batch

- **Phase C C-2** (real headless-browser `BrowserAgent`: Browser Use / Stagehand +
  hosted browser) — the separate next stage, behind the same port.
- Scheduler / in-process pg-boss worker (v1 = external cron; port intentionally unwired).
- Published-deals read API; GDPR/affiliate disclosure at publish; multi-country;
  credentialed capture; auto-publish for Tier-1. (All post-C — roadmap §5.)
- Dedupe-key provenance change (schema-owner call — roadmap §6.3).

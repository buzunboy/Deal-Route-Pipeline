# DealRoute — P3 build handoff: the public `/v1/` read API

> **✅ DELIVERED + merged (2026-06-20).** This was the build prompt for P3 (the public
> `/v1/` read API = roadmap Step 1); it is **built and on `master`** (commit `a8491f3`).
> Step 2 (disclosure) has also since shipped. Kept as the historical build/design record.
> **NOT pending work.** For current next-steps read `docs/DealRoute_Status_and_Roadmap.md`.

_Standalone build prompt for a FRESH Claude Code session. Everything below is
verified against the code on `master` (at `b5e00ce`) on 2026-06-20. Read this start
to finish before writing code; it is self-contained, but the binding rules in
`CLAUDE.md` + `.claude/rules/` still govern. Authoritative companions:
`docs/DealRoute_PostC_Handoff.md` (the post-C audit this P3 came from),
`docs/KNOWN_ISSUES.md` (deferred findings), `docs/DealRoute_Phase_C_and_Roadmap.md` §5._

---

## 0. Orient first (before any code)

1. Read `CLAUDE.md` + the auto-loaded `.claude/rules/` (`architecture.md`,
   `code-style.md`, `extraction-and-schema.md`, `testing.md`) — **binding**.
2. Confirm a green baseline from YOUR OWN worktree:
   `git rev-parse --abbrev-ref HEAD` then `npm run check && npm run build`.
   Expect ~500 unit tests + lint + typecheck green; the Postgres integration tier
   self-skips locally without `DATABASE_URL_TEST` (CI runs it).
3. Re-read the **Workflow / environment gotchas** in §8 below — they bit earlier
   sessions (worktree `.env`, ff-only merge, no local Postgres → statically verify
   integration tests, drizzle migration flow, and a real mid-flight push collision).

## Hard rules (non-negotiable — restated because P3 is the first PUBLIC surface)

- **Nothing auto-publishes.** P3 is READ-only over already-`published` deals. It must
  NEVER write, NEVER change status, NEVER expose a non-published deal.
- **The public DTO is a deliberate projection.** Internal/LLM-audit fields
  (`grounding`, `attributes`, `confidence`, `verified_by`, `schema_version`,
  `field_proposals`, `unmapped_conditions`, `raw_conditions_text`, `evidence_id`,
  `status`) MUST NOT appear in any public response. This is the load-bearing trust
  contract of P3 — make it a contract-tested invariant, not a convention.
- **Public reads are unauthenticated; admin stays gated.** The `/v1/` routes are
  read-only and open; the existing `/api/` admin routes keep their `REVIEW_API_TOKEN`
  bearer gate. Do not add auth to `/v1/`; do not remove it from `/api/`.
- **Clean layered architecture / OCP.** New repo methods go behind the `DealRepository`
  port and are implemented in BOTH adapters (Postgres + in-memory) with identical
  semantics (LSP). HTTP handlers live in the adapters layer. No vendor SDK in domain.
- **Every boundary zod-validated.** Parse query params (filters/sort/pagination)
  through a zod schema into typed values before use — never trust raw query strings.
- **Testing rule**: new repo method → unit (in-memory) + integration (real
  Container + Postgres) tests; new HTTP routes → the existing fetch-over-socket
  harness; the DTO projection → a contract test proving NO internal field leaks.
- Commits: small, conventional, **no `Co-Authored-By` trailer**. Run `code-reviewer`
  before merging. Keep `master` ff-mergeable and green.

---

## 1. Where we are (verified state on `master` @ `b5e00ce`)

Built, merged, pushed: Phase A/B, Pre-C-1/2/3, Phase C C-1 (search broad discovery)
+ C-2 (render-capable Fetcher + S3/R2 evidence scaffold→adapter), the leftover-
hardening batch, CI/CD (GHCR release + scaffolded deploy), **P1 dedupe split-by-source**,
and **P2 the S3/R2 EvidenceStore adapter**. ~500 unit tests green. A separate PR #1
(Postgres integration greening + Docker/husky fix) also merged — already integrated.

**The four P3 decisions (already made — do NOT re-litigate):**
- **D1** Public API = the SAME `serve` process, a NEW read-only `/v1/` router mounted
  alongside `/api/` (admin). One container, one port; separated by route prefix.
- **D2** Public DTO = a curated projection **+ a coarse trust badge** (freshness
  band; never raw `reliability_score`/`confidence`).
- **D3** Evidence = **S3/R2 + CDN URLs**. The public DTO exposes a resolved
  `evidence_screenshot_url` built from `s3.cdnBaseUrl` + the screenshot ref — NOT a
  raw `evidence_id`, and NO screenshot-streaming route (CDN serves it). When
  `cdnBaseUrl` is unset (e.g. local-fs evidence), omit the URL (null).
- **D4** Dedupe = split-by-source (DONE in P1) — so each published deal already
  carries its own clean `source_url` + evidence chain. No "which source?" ambiguity.

---

## 2. PRE-REQUISITES (do these / confirm before the build)

1. **Green baseline from your worktree** (§0.2). If red, stop and fix before P3.
2. **`cdnBaseUrl` config already exists** (P2): `config.evidence.s3.cdnBaseUrl`
   (env `S3_CDN_BASE_URL`, optional URL). The public DTO reads it for D3. Nothing
   consumes it yet — P3 is its consumer (logged in KNOWN_ISSUES as such).
3. **No new vendor/dep needed.** The HTTP layer is raw `node:http` (no framework);
   zod is already a dep for param validation; `@aws-sdk/client-s3` is installed.
4. **Decide ONE small open question before coding** (it doesn't block, but pick a
   default and state it): does the public feed serve `published` only, or also
   `expired` deals marked as ended? **Recommendation: `published` only for v1**
   (expired = not a live offer; the landing page shows current deals). If you want an
   "ended deals" view later, that's a separate filter.
5. **Postgres index = a migration.** P3 adds a composite index for filtered/sorted
   published queries → a drizzle migration. You CAN'T run Postgres locally; generate
   the migration, statically verify, and rely on CI (§8).

---

## 3. The exact surfaces P3 extends (audited @ b5e00ce — quote-accurate)

### 3a. Deal-record schema (`src/domain/deal-record/deal-record.ts`)

`DealRecord` fields, split for the DTO:

**PUBLIC-safe (expose):** `id`, `service`, `provider`, `headline`,
`price` (`{ amount, currency:'EUR', billing }`), `true_cost_monthly`, `country`,
`route_type`, `eligibility` (the typed flags — `new_customer_only`, `residency_kyc`,
`plan_tier_required`, `min_spend`, `stackable`; see note on `conditions[]` below),
`validity` (`start`, `end`, `recheck_days`), `included_items`, `source_url`,
`verified_at`.

**INTERNAL (NEVER expose):** `status`, `confidence`, `grounding`, `attributes`,
`raw_conditions_text`, `unmapped_conditions`, `field_proposals`, `schema_version`,
`evidence_id` (expose a resolved CDN URL instead — see D3), `verified_by`.

- `eligibility.conditions[]` / `validity.conditions[]`: these are mapped vocabulary
  entries with `label` + `source_quote`. `label` is public-friendly; `source_quote`
  is a verbatim page excerpt — **decide**: expose `{ key, label }` only (recommended;
  drop `source_quote`/`value` from the public shape) to avoid leaking large/raw text.
- **Enums** (`src/domain/deal-record/enums.ts`): `DealStatus = candidate | in_review |
  published | expired | rejected`; `RouteType = bundle | standalone | promo | regional`.
  The public API filters by `RouteType` and serves `status='published'`.

### 3b. Repository (`src/application/ports/repositories.ts` — `DealRepository`)

Current methods (no filtered/sorted/paginated list exists):
`insert`, `getById(id)`, `listByStatus(status, limit)`,
`listBySourceUrl(sourceUrl, statuses[], limit)`, `findByDedupeKey`,
`findActiveByDedupeKeyAndHash`, `updateStatus`, `expirePublishedBySourceUrl`, `update`.

**Add:** `listPublished(filters, sort, limit, offset)` + `countPublished(filters)`
where `filters = { service?, country?, routeType?, priceMax? }` and
`sort = 'cost_asc' | 'verified_desc'`. Implement in BOTH adapters with identical
semantics (filter → sort → paginate). `getById` already exists for `GET /v1/deals/:id`
(but the handler must 404 a non-`published` deal — don't leak in-review/rejected).

- **Postgres** (`src/adapters/db/postgres/postgres-db.ts`): mirror the drizzle idiom
  in `listBySourceUrl` — `select().from(deals).where(and(...predicates)).orderBy(...)
  .limit().offset()`. Build predicates conditionally; `status='published'` always first.
- **In-memory** (`src/adapters/db/in-memory/in-memory-db.ts`): `[...store.values()]
  .filter(...).sort(...).slice(offset, offset+limit)` — MUST match Postgres ordering
  (e.g. `verified_desc` = `(b.verified_at ?? '').localeCompare(a.verified_at ?? '')`).

### 3c. Indexes + migration (`src/adapters/db/postgres/schema.ts`, `drizzle/`)

Existing `deals` indexes: `deals_status_idx (status)`, `deals_dedupe_idx (dedupe_key)`,
`deals_source_url_idx (source_url, status)`, `deals_dedupe_evidence_unique
(dedupe_key, evidence_id)`. Latest migration: `drizzle/0007_*.sql`.

**Add** a composite index for the filtered published feed, e.g.
`deals_published_idx` on `(status, country, service)` (extend with
`true_cost_monthly` only if price-range filtering proves hot). Migration flow: edit
`schema.ts` → `npm run db:generate` → commit the generated `drizzle/0008_*.sql` +
`drizzle/meta/*` (these are in `.prettierignore` — don't reformat) → `npm run
db:migrate` applies it (the Docker entrypoint also applies on container start).

### 3d. HTTP layer (`src/adapters/http/review-api.ts`, `cli/commands/serve.ts`)

- Raw `node:http` `createServer`; a `ReviewApi` class with a manual `handle(req,res)`
  dispatch (regex match on `method + path`). Helpers: `sendJson(res, status, body)`;
  body-read with a 64KB bound; errors → `{ error }` JSON; top-level catch → generic
  500 (never leak internals). Auth: `Authorization: Bearer <token>` via
  `timingSafeEqual`, applied ONLY to state-changing `/api/` POSTs.
- **D1 implementation**: create a NEW `PublicApi` router class
  (`src/adapters/http/public-api.ts`) following the same raw-http handler style, and
  mount it in `serve` on the same port — dispatch `/v1/*` to `PublicApi.handle`,
  everything else to the existing `ReviewApi.handle`. (Cleaner than bolting `/v1/`
  onto `ReviewApi`; keeps public/admin separable and independently testable.) If
  wiring two handlers on one server is awkward, the acceptable fallback is one
  `serve` that tries `PublicApi` first then `ReviewApi`; either way the public router
  is its OWN class.
- **Test harness** (`src/adapters/http/review-api.test.ts` pattern): instantiate the
  API with an in-memory DB, `listen(0)`, read the OS-assigned port, drive with native
  `fetch`. Mirror this for `public-api.test.ts`.

---

## 4. Build order (one reviewed batch; commit in these slices)

### Slice 1 — `listPublished` + `countPublished` repo methods (+ index/migration)
- Add to the `DealRepository` port; implement in in-memory + Postgres; add the
  composite index + generated migration. Tests: in-memory unit (filters, sort,
  pagination, only-`published`); integration (real Container + Postgres round-trip:
  seed published+non-published, assert filters/sort/offset, non-published excluded).

### Slice 2 — Public DTO projection + trust badge (pure, the trust core)
- `src/adapters/http/public-dto.ts` (or `src/application/` if you prefer it port-side):
  `toPublicDeal(deal, opts: { cdnBaseUrl?: string }): PublicDeal`. Curated fields only
  (§3a public list); resolve `evidence_screenshot_url` from `cdnBaseUrl` + the
  screenshot ref (null when unset); compute the **trust badge** from `verified_at`
  freshness — bands e.g. `recent` (<7d), `verified` (7–30d), `stale` (>30d or null).
  No deal→source join (reliability lives on Source; freshness-only for v1 — Step 3
  later blends reliability). **Contract test (load-bearing): assert the DTO object
  has NONE of the internal keys** (grounding/attributes/confidence/verified_by/
  status/schema_version/field_proposals/unmapped_conditions/raw_conditions_text/
  evidence_id) for a deal that HAS all of them populated. Pin it against a future
  schema change.

### Slice 3 — `PublicApi` `/v1/` router + wiring
- `GET /v1/deals?service=&country=&route_type=&price_max=&sort=&limit=&offset=` →
  zod-validate params → `listPublished` → map each to the DTO → `{ deals, total,
  limit, offset }` (use `countPublished` for `total`). `GET /v1/deals/:id` →
  `getById`; 404 if missing OR not `published` (never leak non-published). A
  `GET /v1/health`. NO auth on `/v1/`. Mount in `serve`. Tests: fetch-over-socket —
  filter/sort/paginate; a non-published id returns 404; the response body carries NO
  internal fields (DTO contract at the HTTP boundary too); malformed params → 400.

### Slice 4 — Docs + wiring polish
- Update `CLAUDE.md` (Commands if `serve` semantics change; Repo layout: `http/public-api`,
  `public-dto`, the new repo methods), `README.md` (a "Public read API" section +
  `S3_CDN_BASE_URL` already documented), `ARCHITECTURE.md` (a "Public read surface"
  note + the new routes), and the roadmap §5 (mark "published-deals read API" done).
  Resolve the `cdnBaseUrl`-unused KNOWN_ISSUES entry (now consumed).

---

## 5. Guardrails checklist (verify each before merge)

- [ ] `/v1/` serves ONLY `status='published'` deals (list AND get-by-id). A
      non-published id → 404, never the record.
- [ ] The public DTO contains NO internal field — proven by a contract test that
      feeds a fully-populated DealRecord and asserts the forbidden keys are absent.
- [ ] `/v1/` is unauthenticated read-only; `/api/` keeps its bearer gate; `/v1/`
      never writes / never changes status.
- [ ] Query params zod-validated; malformed → 400 (not a 500, not silent default
      that could over-return).
- [ ] `evidence_screenshot_url` resolved from `cdnBaseUrl`; null when unset (no
      broken/relative URL leaked).
- [ ] `listPublished` semantics identical across in-memory + Postgres (LSP) — same
      filter/sort/pagination; covered by both tiers.
- [ ] New index has a committed drizzle migration; `db:migrate` flow verified.
- [ ] Defaults unchanged elsewhere (AGENT=noop, SEARCH_PROVIDER=stub,
      FETCHER=playwright, EVIDENCE_STORE=local).

## 6. Definition of done

- `npm run check && npm run build` green from the worktree; integration tests added
  + statically verified (no local Postgres) or relied on CI Postgres. `code-reviewer`
  on the batch + an adversarial-verify pass on the DTO-no-leak + only-published
  invariants (the trust core). Docs updated. Merge ff-only to `master` + push.

## 7. Explicitly OUT of scope for P3 (do not build)

- GDPR/affiliate-disclosure fields at publish (post-C Step 2 — schema-owner call).
- Reliability-blended ranking / deal→source join (Step 3 — DTO badge is freshness-only now).
- Scheduler / pg-boss worker (Step 4); observability/alerting (Step 5); multi-country (Step 6).
- Any write/auth/rate-limit on `/v1/` beyond read-only (add a CDN/proxy later if needed).
- A screenshot-streaming route (D3 chose CDN URLs).

---

## 8. Workflow / environment facts (these bit earlier sessions — don't rediscover)

- You're in a git **worktree** on your own branch. The runtime `.env` (gitignored,
  real keys) lives ONLY in the main repo root. To run real LLM/fetch/S3 commands from
  a worktree, copy `.env` in temporarily (gitignored) and delete after — or run from
  the main worktree. Dry-run/tests need no keys (stub/in-memory).
- **Run gates from your own worktree.** A shell `cd` that resets to the main repo can
  run stale code; confirm `git rev-parse --abbrev-ref HEAD` before testing.
- **No Docker/Postgres locally** → integration tests self-skip; CI is their first real
  run. After writing integration tests you can't run, statically verify (trace
  assertions against the real adapter) before relying on CI.
- **Merge to `master` via fast-forward only.** `master` may be checked out in the main
  worktree; reset it to `origin/master` first if it's behind. **A push can be rejected
  if origin advanced** (it happened: PR #1 merged mid-flight) — do NOT force-push;
  `git fetch`, inspect the divergence, `git rebase origin/master` your commit(s),
  resolve conflicts (KNOWN_ISSUES.md / package.json are the usual additive ones),
  re-run `npm run check`, then ff master and push.
- Migrations: edit `schema.ts` → `npm run db:generate` → commit the generated
  `drizzle/*.sql` + `drizzle/meta/*` (in `.prettierignore` — don't reformat).
- **ultracode pattern** (used throughout): drive each trust-critical slice as a
  Workflow (implement → independent adversarial verifiers on the invariants), then
  run `code-reviewer` as the independent merge gate, fix findings, merge. The DTO-no-
  leak and only-published invariants are exactly what to adversarially verify here.
- Husky pre-commit runs prettier+eslint+typecheck; commits auto-format staged files.

## 9. First moves for the fresh session

1. Confirm orientation reads + green baseline (`npm run check && npm run build`).
2. Confirm the one open question (§2.4: published-only feed — recommended) and the
   `conditions[]` public shape (§3a: `{ key, label }` only — recommended).
3. Build Slice 1 (repo methods + index/migration) → Slice 2 (DTO + badge, the trust
   core) → Slice 3 (`/v1/` router) → Slice 4 (docs). Workflow-verify the trust
   invariants on Slices 2–3; `code-reviewer` before merge; ff to master.

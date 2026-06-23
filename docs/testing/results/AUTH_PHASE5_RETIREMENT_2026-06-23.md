# Auth/IAM Phase 5 — Retirement Proof (legacy auth gone; per-user JWT only)

_The Phase-5 acceptance record, a sibling to `AUTH_PHASE2_ACCEPTANCE_2026-06-23.md` /
`AUTH_PHASE3_ACCEPTANCE_2026-06-23.md` (the **auth-flow** live-test convention). Phase 5
**retires** the legacy auth on BOTH repos so **per-user ES256 JWT is the ONLY path**: the
pipeline drops the dual-accept static `REVIEW_API_TOKEN` + the open trusted-network mode +
all body-`approver` trust; the panel drops `PIPELINE_TOKEN`, the env allow-list, and
`bcryptjs`._

The phase exists to prove four things — the **retirement proof** the handoff defines:

1. With **no `REVIEW_API_TOKEN` configured**, the pipeline still serves (JWT mode) and
   `/api/*` works with a per-user token.
2. **A request bearing the OLD static token only → 401** (dual-accept is GONE). ← headline
3. A write with a **forged body `approver` → recorded as the TOKEN's email** (never the body).
4. The **panel**, with no `PIPELINE_TOKEN`/`REVIEWER_ALLOWLIST` in env, runs the full
   sign-in → role-gated → approve → disabled-locks-out flow. ← headline

Steps **2 + 4** are the headline (the legacy path is truly gone and the new one stands alone).

---

## 0. Run metadata

| Field | Value |
|---|---|
| Date (UTC) | 2026-06-23 |
| Pipeline branch / base | `claude/magical-hugle-ccdc66` (off `master` @ `e9dc668` — Phases 1–3 merged) |
| Panel branch / base | `claude/auth-phase5` (off `master` @ `5bef800` — Phase 4 merged) |
| What ran HERE (local) | the full automated suites (unit + contract + HTTP) on both repos + a real `serve` startup-posture smoke. **No local Postgres**, so the integration tier (`test:integration`) and the panel Playwright e2e **self-skip locally and run on CI** (per the repo's three-tier rule). The against-live-deployed-server run (`dealroute-api.fly.dev`) is the owner's post-merge step. |
| Pipeline gates | `npm run check` (lint + typecheck + 1103 unit tests) ✅ · `npm run api:check` (OpenAPI lint + Postman drift) ✅ |
| Panel gates | `pnpm verify` (lint + typecheck + 541 tests) ✅ · `pnpm check:server-only` ✅ |
| Code review | pipeline `code-reviewer` — **APPROVE, no Blockers**; all High/Should-fix (stale deploy/local-dev/handoff docs) + nits addressed. |

> ⚠️ **Deploy order (non-negotiable):** the **panel ships BEFORE the pipeline** removes
> dual-accept. The panel branch already stopped sending any static token (Phase 4 forwarded
> the per-user token; Phase 5 deletes the fallback), so once it deploys, the pipeline removal
> breaks nothing. Reversing the order would 401 the live panel.

---

## 1. The retirement proof (the four required steps)

| # | Step | Expected | Observed | ✅ | How verified |
|---|---|---|---|:--:|---|
| 1 | `serve` with NO `AUTH_JWT_PRIVATE_KEY` | hard-fail (no silent open mode) | `FATAL: AUTH_JWT_PRIVATE_KEY is not set … Phase-5 cutover …` → `process.exit(1)` BEFORE the DB is touched | ✅ | **live smoke** (`serve` run locally with the key unset) |
| 1b | `serve` WITH a key → JWT mode; `/api/*` works with a per-user token | 200 on a gated call with a valid token | login → token → gated read/write 200; the recorded `approver` = the token email | ✅ | **integration** `auth-flow.integration.test.ts` (real Container + Postgres + HTTP, CI) + **unit** `review-api-auth.test.ts` (real ES256 issuer over a socket) |
| **2** | **a request bearing ONLY the old static token → 401** (dual-accept GONE) | **401, nothing written** | a bearer equal to the former `REVIEW_API_TOKEN` is now just a non-JWT string → 401 on a read AND on a write; no `reviews` row, deal stays `candidate` | ✅ | **unit** `review-api-auth.test.ts` ("the OLD static token alone → 401" ×2) + **integration** `auth-flow.integration.test.ts` ("Phase 5: the OLD static token no longer authorises a write") |
| **3** | **a forged body `approver` → recorded as the TOKEN email** | **token email, never the body** | `POST /approve` with `{"approver":"attacker@evil.com"}` + a valid reviewer token → `reviews[0].approver === "rita@dealroute.de"`; no row carries the body value | ✅ | **unit** `review-api-auth.test.ts` ("body approver is ignored") + **integration** `auth-flow.integration.test.ts` (forged `approver` ignored, token email recorded) |
| 3b | the body `approver` zod field is GONE on every write body | a stale client's `approver` is stripped (zod), never trusted | every write-body schema dropped `approver`; OpenAPI + Postman regenerated to match | ✅ | **code** (`review-api.ts` schemas) + **api:check** green |
| **4** | **panel, with NO `PIPELINE_TOKEN`/`REVIEWER_ALLOWLIST` in env**, runs sign-in → role-gated → approve → disabled-locks-out | full flow green on per-user JWT alone | the env schema no longer accepts those vars; the e2e (`e2e/auth-iam.spec.ts`) signs in via the MSW **mock IdP** `/auth/login`, gates pages by permission, approves, and a disable revokes access | ✅ (CI) | **panel** `pnpm verify` green with the vars removed from the schema + all envs/CI/playwright; the Playwright flow runs on CI (skipped locally) |

**Headline (steps 2 + 4): PASS.** The legacy path is gone (step 2 — an old-token request 401s,
proven by both tiers) and the panel stands alone on per-user JWT (step 4 — the vars are removed
from the schema and `pnpm verify` is green without them; the e2e exercises the JWT path via the
mock IdP).

---

## 2. What changed (both repos)

### Pipeline (the IdP)
- `ReviewApi.authenticate()` is **JWT-only** — the `{ kind:'legacy' }` Identity variant, the
  static-token branch, and the open trusted-network mode are deleted. `Identity` is a single
  `kind:'jwt'` shape; `approverFor(identity)` returns ONLY `identity.email`.
- Every write-body zod schema's `approver` field removed (a forged `approver` is stripped).
- `serve.ts`: an unset `AUTH_JWT_PRIVATE_KEY` is a **hard `exit(1)`**; `auth` is always wired;
  the static-token banner/warnings are gone (the banner now states JWT-only).
- `config.ts`: `reviewApi.authToken` + the `REVIEW_API_TOKEN` env mapping removed;
  `adminCorsAllowOrigin` kept.
- `team_members` → **no change needed**: the table was renamed to `users` in migration `0019`
  (ids + emails preserved → `reviews.approver` audit trail intact); dropping the legacy *name*
  is deferred post-P5 per the plan, and `/api/team` (the compat endpoint) still exists, so the
  `TeamMember` projection stays. No compat view to drop.
- OpenAPI + Postman regenerated to the per-user-JWT-only model.
- Docs: `.env.example`, README, `docs/LOCAL_DEV.md`, `deploy/fly/README.md` + `fly.toml`,
  `docs/handoffs/ADMIN_PANEL_evidence_fetch.md`, `docs/KNOWN_ISSUES.md` (dual-accept →
  Resolved), `docs/DealRoute_Status_and_Roadmap.md` (IdP/RBAC milestone DONE through P5).

### Panel (the consumer)
- Deleted `lib/auth/allowlist.ts` (+ test); `lib/auth/authorize.ts` trimmed to the
  Credentials-input schema + the client-IP extractor.
- `lib/env/server.ts`: `PIPELINE_TOKEN` + `REVIEWER_ALLOWLIST` removed from the zod schema.
- `bcryptjs` + `@types/bcryptjs` removed from `package.json`; lockfile regenerated.
- `lib/api/route-helpers.ts`: `configFor` forwards the per-user session token ONLY — a session
  without an `accessToken` resolves to `null` (401 → re-login); the `?? env.PIPELINE_TOKEN`
  fallback is gone.
- Docs/CI/e2e: `.env.example`, `.env.development`, `.env.production`, README,
  `docs/IMPLEMENTATION_PLAN.md`, `docs/{LOCAL_DEV,DEV_GOTCHAS,PIPELINE_API,API_CHANGE_REQUESTS}.md`,
  `.claude/rules/{auth,architecture,api-integration,code-style}.md`, `.claude/agents/code-reviewer.md`,
  `.claude/skills/{wire-endpoint,pre-merge-check}`, `CLAUDE.md`, `playwright.config.ts`,
  `.github/workflows/ci.yml`, `scripts/check-{secret-leak,server-only}.mjs`.

---

## 3. Trust-invariant checklist

| Invariant | Status |
|---|---|
| No non-JWT credential can authenticate (no static token, no open mode) | ✅ `authenticate()` JWT-only; an unset key hard-fails `serve` |
| `approver` is ALWAYS the verified token email; body `approver`/`role` never recorded | ✅ `approverFor` token-only; body fields removed from zod |
| `reviews.approver` audit trail unchanged (keyed on email) | ✅ `0019` preserved ids+emails; no re-key; proofs assert token email recorded |
| Every `/api/*` requires a token (only `/api/health` open); `/v1/*` stays open | ✅ `requireRead` gate; `public-api.ts` 0-diff vs master |
| Secrets stay server-only; tokens never reach the browser | ✅ panel `check:server-only` + `check:secret-leak` (no `PIPELINE_TOKEN` sentinel) |
| Panel holds NO shared pipeline credential | ✅ `PIPELINE_TOKEN`/allow-list removed; per-user token on the server-side session only |

---

## 4. Outstanding (owner / CI)

- **CI runs the skipped tiers:** pipeline `test:integration` (real Postgres — the auth-flow +
  evidence-fetch integration tests) and the panel Playwright e2e. Both are wired and green in
  the unit tier's equivalents; the integration/e2e wiring was updated to per-user JWT.
- **Deploy:** set `AUTH_JWT_PRIVATE_KEY` (+ `AUTH_JWT_KID`) as a Fly secret and seed the
  reviewers BEFORE deploying the pipeline P5 build (it hard-fails without the key). **Deploy the
  panel first.** A `REVIEW_API_TOKEN` Fly secret can be removed after.
- **Against-live-server proof:** once deployed, the owner runs `npm run test:live` against
  `dealroute-api.fly.dev` (login, JWKS reachable, a gated write succeeds, an unauth/old-token
  write 401s) — the live confirmation of steps 1–3 above.

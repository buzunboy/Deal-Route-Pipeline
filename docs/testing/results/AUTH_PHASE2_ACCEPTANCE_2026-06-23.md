# Auth/IAM Phase 2 — Acceptance Proof (live, against a running server)

_A **real** against-a-running-`serve` run (NOT a unit test), recorded with the repo's
live-test convention (a sibling to `docs/testing/LIVE_TEST_TEMPLATE.md` — this is the
**auth-flow** variant, which records an 11-step IdP/RBAC proof instead of per-deal
extraction. See the template's changelog entry for 2026-06-23.)_

The point of this run: prove the three things the whole Auth/IAM consolidation exists to
guarantee — **identity can't be forged** (the `approver` on an audited decision is the
verified token's email, never the request body), **a disabled user dies immediately** (a
`token_version` bump kills a still-unexpired access token on the next request), and
**refresh reuse is caught** (replaying a rotated-out refresh token revokes the whole
family). Those are steps **5**, **9**, and **10** below; if any fails, the phase is not done.

---

## 0. Run metadata

| Field | Value |
|---|---|
| Date (UTC) | 2026-06-23 ~17:02 |
| Git branch / base commit | `claude/auth-phase2` @ `4f6af63` (Phase 1) |
| Run kind | full-into-throwaway-DB (`dealroute_auth_live`, local Postgres 16) |
| Server | real `serve` on `http://localhost:3055` (AuthApi + ReviewApi + PublicApi, one port) |
| JWT signing | real **ES256** key (JWK) via `AUTH_JWT_PRIVATE_KEY` + `AUTH_JWT_KID=live-key-1` |
| Password hash | real **Argon2id** (`@node-rs/argon2`, OWASP-floor params) |
| Access TTL / legacy token | 900s / `REVIEW_API_TOKEN=legacy-live-token` (dual-accept) |
| LLM / Fetcher | `stub` / `playwright` (no extraction in this run — candidate seeded directly) |
| Writes / publishes | 2 deals approved→published (into the throwaway DB), by design |
| Secrets handling | the ES256 key + `.env` were gitignored and **deleted after the run** |

---

## 1. The 11-step acceptance flow

| # | Step | Expected | Observed | ✅ |
|---|---|---|---|:--:|
| 1 | `seed-user` → create a reviewer with a known password | a login-capable account, no hand-SQL | `Created user rita@dealroute.de (reviewer) — can now POST /auth/login.` | ✅ |
| 2 | `POST /auth/login` (correct pw) | 200 + access + refresh + permissions | 200; ES256 JWT (`kid=live-key-1`), opaque refresh, reviewer perm bundle (`candidate:approve`, `evidence:read`, …) | ✅ |
| 3 | `POST /auth/login` (wrong pw) | 401, generic (no enumeration) | 401 `{"error":"invalid email or password"}` — identical to an unknown-email reply | ✅ |
| 4 | `GET /.well-known/jwks.json` | the ES256 **public** key | 200 `{keys:[{kty:EC, crv:P-256, alg:ES256, kid:live-key-1, use:sig}]}`; **no private `d`** | ✅ |
| **5** | **gated approve WITH the access token; body `approver:"forged@evil.com"`** | **200, and the reviews row's `approver` == the TOKEN's email** | **200; deal `published`, `verified_by:"rita@dealroute.de"`; reviews `approver=rita@dealroute.de` (NOT `forged@evil.com`)** | ✅ |
| 6 | same approve with **NO** token | 401 | 401 `{"error":"unauthorized"}` | ✅ |
| 7 | same approve with a **TAMPERED** token (flipped bytes) | 401 | 401 `{"error":"unauthorized"}` | ✅ |
| 8 | `GET /api/candidates` with no token | 401 (was 200 before — the behaviour change) | 401 `{"error":"unauthorized"}` | ✅ |
| **9** | **disable the user (bump `token_version` via SQL) → the SAME still-unexpired access token** | **next call 401 (immediate revocation)** | **before bump: 200; after `UPDATE users SET token_version=token_version+1`: 401** | ✅ |
| **10** | **`POST /auth/refresh`, then REUSE the old refresh token** | **401 + family revoked** | **rotate → 200 (new token ≠ old); reuse old → 401; the successor is ALSO dead (whole family revoked) → 401** | ✅ |
| 11 | the OLD static token on a write (dual-accept intact) | 200, body `approver` recorded (no synthetic actor) | 200; reviews `approver=human@dealroute.de` — **never** a synthetic `legacy-token@system` | ✅ |

**Bonus (registry + adversarial), same run:**

| Check | Expected | Observed | ✅ |
|---|---|---|:--:|
| reviewer → `POST /api/team` (needs `team:manage`) | 403 | 403 `{"error":"forbidden"}` | ✅ |
| `alg:none` forged token on a read | 401 | 401 `{"error":"unauthorized"}` | ✅ |

---

## 2. The three reason-for-existing proofs (verbatim observations)

**Step 5 — identity can't be forged.** The approve body carried `"approver":"forged@evil.com"`.
The published deal came back with `verified_by:"rita@dealroute.de"` and the reviews audit row
read `approver= rita@dealroute.de action= approve`. The body field was ignored; the actor is
the verified JWT email.

**Step 9 — a disabled user dies immediately.** `GET /api/candidates` with the access token
returned **200**; after `UPDATE users SET token_version = token_version + 1`, the **same
still-unexpired** token returned **401**. No wait for `exp`.

**Step 10 — refresh reuse is caught.** `refresh(REFRESH1) → 200` with `REFRESH2 ≠ REFRESH1`.
Replaying `REFRESH1 → 401 (invalid or expired refresh token)`. The successor `REFRESH2`, which
had been valid, then **also** returned 401 — the reuse triggered a whole-family revoke.

---

## 3. Trust-invariant checklist (verify EVERY auth run)

- [x] **Approver is token-derived, never body-derived** on a JWT request (step 5).
- [x] **Login is non-enumerable** — wrong-password and unknown-email yield the identical generic 401 (step 3).
- [x] **All `/api/*` reads now require a token**; `GET /api/health` stays open (step 8 + health probe at boot).
- [x] **Immediate revocation** works via `token_version` (step 9).
- [x] **Refresh rotates + reuse revokes the family** (step 10).
- [x] **Dual-accept** keeps the legacy static token working, with NO synthetic `legacy-token@system` on the audit trail (step 11).
- [x] **JWKS is public-only** (no `d`), pinned to ES256 (step 4).
- [x] **alg-confusion-safe** — an `alg:none` token is rejected (bonus).
- [x] **Permission registry** enforced — a reviewer is 403 on a `team:manage` route (bonus).
- [x] **No secret leaked** — the login/refresh responses never contain a password hash; the ES256 private key + `.env` were gitignored and deleted post-run.

---

## 4. How to reproduce

```sh
createdb dealroute_auth_live
# generate an ES256 JWK, write a gitignored .env with:
#   DATABASE_URL / QUEUE_DATABASE_URL = postgres://localhost:5432/dealroute_auth_live
#   LLM_PROVIDER=stub  FETCHER=playwright  EVIDENCE_STORE=local
#   REVIEW_API_PORT=3055  REVIEW_API_TOKEN=legacy-live-token
#   AUTH_JWT_KID=live-key-1  AUTH_JWT_PRIVATE_KEY='<single-line JWK JSON>'
npm run db:migrate
npm run cli -- seed-user --email rita@dealroute.de --name "Reviewer Rita" \
  --role reviewer --password "a-strong-password-123"
# seed a candidate deal (evidence + a `candidate`-status deal), then:
npm run cli -- serve            # → http://localhost:3055
# run the 11 curl steps in §1 against /auth/* and /api/*.
# Clean up: delete .env + the ES256 key; dropdb dealroute_auth_live.
```

A hermetic version of the same flow (real Container + Postgres, no manual server) runs in
`test/integration/auth-flow.integration.test.ts` under `npm run test:integration`.

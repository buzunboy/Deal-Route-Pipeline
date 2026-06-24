# Environment Separation Plan — PIPELINE (this repo)

**Status:** PLAN (awaiting approval) · **Date:** 2026-06-24
**Companion doc:** `docs/handoffs/ADMIN_PANEL_environments.md` (the HQ / admin-panel side).

This doc covers the **pipeline API + DB** side only. The admin-panel (HQ) changes live in
the companion handoff doc above (separate repo).

---

## Phasing — Staging is DEFERRED

> **Build now: Local + Dev + Prod.** **Skip Staging (Test) for now** — it comes later.

The project is new and lightly used; the Test/Staging environment (`test-api` /
`test-hq`, read-only against prod) is **not built in the first pass**. The `READ_ONLY`
mechanism that Staging depends on is still designed and built in Piece 1 (it's cheap,
self-contained, and trust-critical to get right once), but **no `test-api` instance is
deployed and no `test-hq` is wired** until a later phase. Everything below marks what is
**Phase 1 (now)** vs **Deferred (Staging)**.

---

## The full target model (for reference — Staging deferred)

### Pipeline API instances — each owns one DB + one access mode

| API   | Host                       | DB           | Mode          | Phase            |
| ----- | -------------------------- | ------------ | ------------- | ---------------- |
| Local | `localhost:{PORT}`         | configurable | full r/w      | **Phase 1 (now)** |
| Dev   | `dev-api.deal-route.com`   | **dev DB**   | full r/w      | **Phase 1 (now)** |
| Prod  | `api.deal-route.com`       | **prod DB**  | full r/w      | **Phase 1 (now)** |
| Test  | `test-api.deal-route.com`  | **prod DB**  | **READ-ONLY** | **Deferred**      |

**Two databases total** (dev + prod). Test (deferred) will share the prod DB; the *only*
thing protecting prod data from the Test API is `READ_ONLY` enforcement — which is why
that guard is the most trust-critical part and is built (with full tests) in Phase 1 even
though no Test instance is deployed yet.

Guiding principle: **less-stable code must never WRITE more-stable data.** The Test API
(runs the dev/RC build) may *read* prod, never write it.

---

## Piece 1 — `READ_ONLY` flag (Phase 1; the only trust-critical code change)

Built now even though Staging is deferred: the flag is small, self-contained, and the
right thing to harden once. Until Staging exists, every deployed instance simply runs
`READ_ONLY=false` (the default), so this change is a **no-op for Local/Dev/Prod** — it
only ever activates when a future Test instance sets `READ_ONLY=true`.

### Why the seam is clean (verified against the code)
- `serve.ts` dispatches by prefix: `/auth/*` + JWKS → `AuthApi`; `/v1/*` → `PublicApi`
  (already read-only by nature); everything else → `ReviewApi`.
- The only writes that must stay open in read-only mode — `POST /auth/login|refresh|logout`
  — live entirely in `AuthApi`, a **separate router**. A blanket write-block in
  `ReviewApi` automatically spares login. No special-casing.
- `ReviewApi.handle` is one flat dispatcher (`src/adapters/http/review-api.ts:222`). A
  guard placed right after `method` is parsed (after the CORS/OPTIONS short-circuit, ~line
  238) covers **every current and future** `POST`/`PATCH`/`DELETE` under `/api/*`.

### The rule
In read-only mode, in `ReviewApi.handle`, before auth and before any handler:
> if `readOnly` **and** `method !== 'GET' && method !== 'OPTIONS'` **and** `path` starts
> with `/api/` → `403 { error: 'read_only', message: 'This API instance is read-only (Test environment).' }`

`GET`, `OPTIONS` (CORS preflight), `GET /`, `GET /api/health` are unaffected. `/auth/*`
login is unaffected (different router). `/v1/*` is read-only already.

The guard keys on **HTTP method**, not an endpoint allow-list — so a future write route
can't accidentally bypass it (single chokepoint, no per-route opt-in to forget).

### DECIDED: read-only fires BEFORE auth (owner, 2026-06-24)
An unauthenticated write to the Test API returns `403 read_only` (honest — writes are off
for everyone on this instance) rather than `401` (which would misleadingly imply "log in
and you can write"). The env property is true regardless of identity, so it's checked
first. The unit test asserts this precedence (write with no bearer → 403 read_only, not 401).

### Changes
1. **`src/config/config.ts`**
   - Add `readOnly: boolean` to the `reviewApi` config object (zod), using the existing
     `boolish` transform. Env var: `READ_ONLY` (default `false`).
   - Wire in `loadConfig`: `readOnly: boolish.parse(env.READ_ONLY ?? 'false')`.
2. **`src/adapters/http/review-api.ts`**
   - Add `readOnly?: boolean` to `ReviewApiOptions` (interface at line 94, beside
     `corsAllowOrigin`). Store as `private readonly readOnly: boolean` (default `false`).
   - Insert the guard in `handle()` right after the `OPTIONS` short-circuit, before the
     `GET /` and health routes (so it sits ahead of auth). Use `sendJson(res, 403,
     { error: 'read_only', message: ... })` — a typed body HQ detects via `error === 'read_only'`.
3. **`src/adapters/cli/commands/serve.ts`**
   - Pass `readOnly: config.reviewApi.readOnly` in the existing `options` object handed to
     `new ReviewApi(...)` (alongside `corsAllowOrigin`). No constructor-signature change.

### Tests (per `.claude/rules/testing.md` — trust-critical path, explicit)
- **Unit (`review-api.test.ts`)**, with `readOnly: true`:
  - every write route (`POST /api/candidates/:id/approve`, `/reject`, `PATCH
    /api/candidates/:id`, `POST .../complete`, `POST /api/field-proposals/:key/promote`,
    `POST /api/sources`, `POST /api/team`, `PATCH /api/profile`, `PATCH /api/settings/:key`,
    `POST /api/alerts/:id/acknowledge|resolve`, `POST /api/sources/:id/approve|reject`,
    `POST /api/users`, `PATCH /api/users/:id`, `POST /api/roles`, `PATCH/DELETE
    /api/roles/:name`) → **403 `{error:'read_only'}`**, body is the typed shape.
  - every read route still **200** (sample: `GET /api/candidates`, `/api/metrics`,
    `/api/published`, evidence-fetch).
  - guard fires **before auth**: a write with NO bearer → 403 read_only (not 401).
  - `GET /api/health` and `GET /` still 200 under `readOnly: true`.
  - **Adversarial/trust:** under `readOnly`, the injected use-case fakes
    (`review.approveCandidate`, etc.) are **never called** for a write request — no write
    reaches the application layer.
- **Config unit (`config.test.ts`)**: `READ_ONLY` parses (`true`/`1`/`false`/`0`/absent→false).
- **Integration (`test/integration/`)**: real `Container` + Postgres with `READ_ONLY=true` —
  a `POST .../approve` returns 403 **and** a follow-up DB read confirms the candidate row
  is unchanged (no write hit Postgres). The "wrong data can't be written to prod" proof.

### OpenAPI spec (`.claude/rules/api-and-openapi.md` — same commit)
- Add the `403 read_only` response to every gated write operation in
  `docs/api/openapi.yaml` (a shared `ReadOnlyError` response component + a one-line note
  that it appears only when the instance runs `READ_ONLY=true`).
- `npm run api:lint` + `npm run api:postman`; commit both. (Structural drift gate won't
  trip — no route added/removed — but the spec must describe the new status.)

### Docs
- `docs/DealRoute_Status_and_Roadmap.md` §2: note the `READ_ONLY` capability shipped.
- Promote the deploy matrix below into an evergreen `docs/ENVIRONMENTS.md` once built.

---

## Piece 2 — Deploy instances + subdomains (infra/config, NO code)

**Deploy target: Fly.io** (matches the existing API). **DNS registrar: GoDaddy** (the
`deal-route.com` zone). This is per-env Fly apps/configs + GoDaddy DNS for the subdomains.

**Phase 1 builds Local + Dev + Prod only.** `test-api` is deferred.

### One app per environment (NOT one app, many hostnames)
A custom domain only **renames** an app — it does not create the Dev/Prod split. Because
Dev → dev DB and Prod → prod DB (different `DATABASE_URL`, secrets, `READ_ONLY`), each
environment is a **separate Fly app**:

| Env  | Fly app             | `.fly.dev` host             | DB        | `READ_ONLY` |
| ---- | ------------------- | --------------------------- | --------- | ----------- |
| Prod | `dealroute-api` (existing) | `dealroute-api.fly.dev`     | prod DB   | `false`     |
| Dev  | `dealroute-api-dev` (NEW)  | `dealroute-api-dev.fly.dev` | **dev DB** | `false`    |
| Test | `dealroute-api-test` (deferred) | `dealroute-api-test.fly.dev` | prod DB | `true` |

The existing `dealroute-api` app **becomes Prod**. Dev is a brand-new app running the same
image against a **new dev database** (owner decision, 2026-06-24: separate Fly app +
separate dev DB — true isolation):
```sh
fly apps create dealroute-api-dev
# create/point a NEW dev Postgres (a 2nd Fly Postgres app, or a 2nd DB on the cluster):
#   fly postgres create --name dealroute-db-dev   (or reuse dealroute-db with a new database)
fly secrets set -a dealroute-api-dev DATABASE_URL=... READ_ONLY=false AUTH_JWT_PRIVATE_KEY=... ANTHROPIC_API_KEY=...
fly deploy -a dealroute-api-dev -c deploy/fly/fly.toml   # same image, dev config
```
> Note: the highest-value deferred infra item (per the project memory) is moving Postgres
> to a managed provider — now doubly relevant since you're about to run two DBs. Not a
> blocker for this, but the natural moment to revisit it.

### Custom domains (GoDaddy + Fly) — the `*.fly.dev` → `deal-route.com` connection
Fly's `*.fly.dev` URL is the default; custom hostnames attach via `fly certs`. The
handshake: **Fly issues a TLS cert for the hostname → GoDaddy DNS points the hostname at
Fly.** No redeploy, no app code change. All our hostnames are **subdomains** (`api.`,
`dev-api.`, …) so each is a simple **CNAME** — we never touch the awkward apex
(`deal-route.com` itself), which GoDaddy can't CNAME.

Per hostname (example: `api.deal-route.com` → the Prod app):
```sh
fly certs add api.deal-route.com -a dealroute-api     # prints the exact DNS records
fly ips list -a dealroute-api                         # only if Fly asks for A/AAAA instead of CNAME
fly certs show api.deal-route.com -a dealroute-api    # watch until cert is "Ready"/"Configured"
```
Then in **GoDaddy → Manage DNS for `deal-route.com`** add what Fly printed. CNAME path
(GoDaddy's **Name** is just the label — it appends `.deal-route.com`):

| Type  | Name                    | Value (from Fly)            | TTL  |
| ----- | ----------------------- | --------------------------- | ---- |
| CNAME | `api`                   | `dealroute-api.fly.dev`     | 600  |
| CNAME | `_acme-challenge.api`   | (the ACME value Fly prints) | 600  |

If Fly returns A/AAAA instead of a CNAME, use the `fly ips list` IPv4 (A) + IPv6 (AAAA)
plus the `_acme-challenge` CNAME. Propagation is usually minutes (GoDaddy default TTL
~1h). Verify: `curl https://api.deal-route.com/api/health`.

### Phase 1 hostnames to provision (one `fly certs add` + one GoDaddy CNAME each)
| Hostname                  | `fly certs add` app   | GoDaddy CNAME →               |
| ------------------------- | --------------------- | ----------------------------- |
| `api.deal-route.com`      | `dealroute-api`       | `dealroute-api.fly.dev`       |
| `dev-api.deal-route.com`  | `dealroute-api-dev`   | `dealroute-api-dev.fly.dev`   |
| (`test-api...` deferred)  | `dealroute-api-test`  | `dealroute-api-test.fly.dev`  |

> The **HQ** subdomains (`hq.`, `dev-hq.`, `test-hq.`) attach to wherever the panel deploys
> (separate repo) — same GoDaddy-CNAME pattern, target host TBD. See the companion handoff.

### Env matrix (per API instance)

| Var                    | Local                          | Dev                              | Prod                         | Test (DEFERRED)                  |
| ---------------------- | ------------------------------ | -------------------------------- | ---------------------------- | -------------------------------- |
| `REVIEW_API_PORT`      | 3000                           | (platform)                       | (platform)                   | (platform)                       |
| `READ_ONLY`            | `false`                        | `false`                          | `false`                      | **`true`**                       |
| `DATABASE_URL`         | local/dev                      | **dev DB**                       | **prod DB**                  | **prod DB**                      |
| `ADMIN_CORS_ORIGIN`    | `http://localhost:{HQ port}`   | `https://dev-hq.deal-route.com`  | `https://hq.deal-route.com`  | `https://test-hq.deal-route.com` |
| `AUTH_JWT_PRIVATE_KEY` | dev key                        | dev key                          | prod key                     | **prod key**¹                    |
| (evidence, LLM, etc.)  | per existing                   | per existing                     | per existing                 | per existing                     |

¹ Test (deferred) reads prod data → it authenticates real reviewers against prod users, so
it needs the **prod** JWT/JWKS signing context. (It still can't write.) Confirm at build.

### Phase 1 subdomains to provision
- `dev-api.deal-route.com` → Dev API
- `api.deal-route.com` → Prod API
- (`test-api.deal-route.com` → deferred with Staging)

### Notes / guards
- `concurrencyPolicy`, evidence `S3` requirement under any non-local instance, etc. follow
  the existing `deploy/README.md` posture.
- This is infra/config only — **no pipeline code change** beyond Piece 1's `READ_ONLY` flag.

---

## When Staging is un-deferred (later)
Because Piece 1 ships the `READ_ONLY` flag fully tested in Phase 1, standing up Staging
later is **pure infra/config — no new pipeline code**:
1. Create a `dealroute-api-test` Fly app with `READ_ONLY=true`, `DATABASE_URL`=**prod** DB,
   prod JWT context, `ADMIN_CORS_ORIGIN=https://test-hq.deal-route.com`.
2. Attach the domain: `fly certs add test-api.deal-route.com -a dealroute-api-test` + the
   GoDaddy CNAME `test-api → dealroute-api-test.fly.dev` (+ `_acme-challenge`). Same for
   `test-hq` on the panel host.
3. Wire `test-hq` in the admin panel (companion doc).

## Sequencing (Phase 1)
1. Piece 1 — code + tests + spec, one reviewable commit. Run `code-reviewer`.
2. `docs/ENVIRONMENTS.md` (Local/Dev/Prod matrix; Staging marked deferred).
3. Companion: `docs/handoffs/ADMIN_PANEL_environments.md` for the HQ side.
4. Piece 2 infra wiring (Fly): create `dealroute-api-dev` + dev DB; attach the
   `api.` + `dev-api.` custom domains via `fly certs` + GoDaddy CNAMEs.

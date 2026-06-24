# Admin-Panel (HQ) Handoff — Environment Separation

**Status:** PLAN (awaiting approval) · **Date:** 2026-06-24
**Companion doc:** `docs/ENVIRONMENTS_PLAN_PIPELINE.md` (the pipeline-API + DB side).
**Repo:** this work lands in the **Admin-Panel** repo (separate from the pipeline).

This doc describes the HQ (admin-panel) changes needed for clean environment separation.
Each deployed HQ instance talks to exactly one pipeline API; Local HQ can switch APIs from
its own Settings screen without a restart.

---

## Phasing — Staging is DEFERRED

> **Build now: Local + Dev + Prod HQ.** **Skip Staging (`test-hq`) for now** — it comes later.

The project is new and lightly used. The Test/Staging HQ (`test-hq.deal-route.com`,
pointing at the read-only Test API) is **not built in the first pass**. The API switcher
on Local HQ should still include a **Test** preset in its list (it's just a URL), but no
`test-hq` instance is deployed and no Test API exists to point it at yet. Everything below
marks **Phase 1 (now)** vs **Deferred (Staging)**.

---

## The target model (Staging deferred)

| HQ instance | Host                      | Points at API                     | Phase             |
| ----------- | ------------------------- | --------------------------------- | ----------------- |
| Local       | localhost                 | **switchable from Settings, no restart** | **Phase 1 (now)** |
| Dev         | `dev-hq.deal-route.com`   | Dev API (`dev-api.deal-route.com`) | **Phase 1 (now)** |
| Prod        | `hq.deal-route.com`       | Prod API (`api.deal-route.com`)    | **Phase 1 (now)** |
| Test        | `test-hq.deal-route.com`  | Test API (`test-api...`, read-only) | **Deferred**      |

---

## What to build

### 1. Local HQ — runtime API switcher (no restart)
- A **Settings-screen control** that selects which pipeline API the panel talks to and
  switches **live**, without re-running the app.
- Persist the selection (e.g. `localStorage`); the **API client reads the active base URL
  per request** so a switch takes effect immediately (no rebuild, no restart).
- Presets to offer: **Local** (`http://localhost:{PORT}`), **Dev** (`https://dev-api.deal-route.com`),
  **Prod** (`https://api.deal-route.com`), plus a **custom URL** field. Include a **Test**
  preset (`https://test-api.deal-route.com`) in the list now even though that API isn't
  deployed yet — it's harmless until it resolves.
- **Only Local HQ** exposes this switcher (see #3 — it's disabled in deployed builds).

### 2. Dev / Prod HQ — fixed per-domain API binding
- `API_BASE_URL` is **fixed per deployed domain** via the panel's build/runtime env:
  - `dev-hq.deal-route.com` → `https://dev-api.deal-route.com`
  - `hq.deal-route.com` → `https://api.deal-route.com`
  - (`test-hq` → `https://test-api.deal-route.com` — **deferred**)
- The build env var (whatever the panel's convention is, e.g. `NEXT_PUBLIC_API_BASE_URL`)
  is set per deployment.

### 3. Disable the switcher in deployed builds
- The Settings API-switcher is **Local-only**. In any deployed env (`dev-hq`, `hq`, future
  `test-hq`) the switcher is **hidden/disabled** and the env-configured `API_BASE_URL`
  wins.
- **Why this matters:** if `test-hq` (future) could be repointed at the **prod** API, a
  reviewer could approve real candidates from the "test" panel — exactly the prod-write
  risk the read-only Test API exists to prevent. Locking the deployed switcher closes the
  loophole on the panel side too. Gate on the same build flag that distinguishes
  local-dev from a deployed build.

### 4. Read-only environment UX (needed when Staging lands; harmless to add now)
- The pipeline returns **`403 { error: 'read_only', message: ... }`** on any write to a
  read-only API instance (the Test API). The panel should:
  - **Detect** the `error === 'read_only'` body in the API client and surface a persistent
    banner: *"Read-only (Test) environment — changes are disabled."*
  - **Disable write controls** (approve / reject / edit / promote / settings PATCH / etc.)
    in the UI when the active environment is read-only, so a reviewer isn't led to a button
    that will 403. (The 403 is the server-side guarantee; the banner + disabled controls
    are UX on top of it.)
- This can be built in Phase 1 (it's inert against Local/Dev/Prod, which never return
  `read_only`) or deferred with Staging — owner's call. Recommended: build the **client
  detection + banner** now (cheap), defer fine-grained control-disabling if desired.

---

## Tests (per the panel's own rules)
- **API-client base-URL switch** (Local): switching the Settings selector changes the URL
  the client calls, live, with no reload. Trust-critical: prove a deployed build ignores
  the switcher and uses the env `API_BASE_URL`.
- **Read-only banner**: a `403 {error:'read_only'}` response renders the banner and (if
  built) disables the write controls.
- **Per-domain binding**: the env→API-base mapping resolves correctly for each host.

---

## Phase 1 deliverables (HQ)
1. Local API switcher (Settings) + per-request base-URL client read.
2. Per-domain `API_BASE_URL` for `dev-hq` + `hq`.
3. Switcher disabled in deployed builds.
4. (Recommended) `403 read_only` client detection + banner — inert until Staging exists.

## Deferred with Staging
- Deploy `test-hq.deal-route.com` bound to the (deferred) Test API.
- Fine-grained write-control disabling in read-only mode, if not done in Phase 1.

## Cross-repo dependency
The `403 read_only` contract this panel detects is produced by the pipeline's `READ_ONLY`
flag — see `docs/ENVIRONMENTS_PLAN_PIPELINE.md` Piece 1. That flag ships in the pipeline's
Phase 1 (built + tested even though no Test instance is deployed yet), so the panel can
rely on the `error: 'read_only'` body being a stable contract.

# Dev Environment Setup — Fly (`dealroute-api-dev` + `dev-api.deal-route.com`)

**Status:** in-progress runbook · **Date:** 2026-06-24

Stands up the **Dev** pipeline API as a separate Fly app sharing the existing Postgres
cluster via a separate `dealroute_dev` database (owner decision 2026-06-24: same cluster,
new DB — splittable later by changing `DATABASE_URL`). See
`docs/ENVIRONMENTS_PLAN_PIPELINE.md` Piece 2 for the why.

> **Credential rule:** steps that involve the dev DB password or the `DATABASE_URL` secret
> are run **by you** so the password never lands in a chat transcript or a committed file.

---

## Target

| | Value |
| --- | --- |
| Dev app | `dealroute-api-dev` (`https://dealroute-api-dev.fly.dev`) |
| Dev DB | `dealroute_dev` database on the existing `dealroute-db` cluster, user `dealroute_dev` (scoped, non-superuser) |
| `READ_ONLY` | `false` |
| Custom domain | `dev-api.deal-route.com` |
| CORS | `ADMIN_CORS_ORIGIN=https://dev-hq.deal-route.com` |

---

## Step 0 — DONE
- [x] `fly apps create dealroute-api-dev` (created 2026-06-24).

## Step 1 — DONE (2026-06-24): dev database + scoped user + ISOLATION enforced
- [x] `dealroute_dev` database + `dealroute_dev` user (non-superuser) exist on the
  `dealroute-db` cluster; `public` schema owned by `dealroute_dev` (migrations can run).
- [x] **Isolation hardened:** `REVOKE CONNECT ON DATABASE dealroute_api FROM PUBLIC`
  (Postgres grants PUBLIC connect by default — the dev user could initially open the prod
  DB; now it gets `FATAL: permission denied for database "dealroute_api"`). Prod user
  re-granted explicitly; verified prod app access intact. Same revoke applied to the dev
  DB for symmetry.
- [x] Verified all three: dev→dev OK, prod→prod OK, dev→prod DENIED.
> The dev DB password was set by Claude during setup and is stored ONLY in the dev app's
> `DATABASE_URL` Fly secret (Step 2). It is in this session's transcript → **rotate it**
> along with the prod password (see "Security follow-ups" at the bottom).
> Connection was done via `fly proxy 15432:5432 -a dealroute-db` + local `psql` (the
> `fly postgres connect` path hit `invalid integer value "ON" for port` — a flyctl bug;
> use the proxy). NOTE: the proxy listens on IPv4 only — use `127.0.0.1`, not `localhost`.

## Step 2 — DONE (2026-06-24): dev secrets STAGED (not yet deployed — no VM exists yet)
Staged on `dealroute-api-dev` (visible as `Staged` in `fly secrets list`):
- [x] `DATABASE_URL` → the dev DB (`dealroute_dev@dealroute-db.flycast/dealroute_dev`)
- [x] `READ_ONLY=false`
- [x] `ADMIN_CORS_ORIGIN=https://dev-hq.deal-route.com`
- [x] `AUTH_JWT_PRIVATE_KEY` → a **separate dev ES256 key** (owner chose dev-only auth),
  generated via `openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256` (PKCS8
  PEM, the format `jose.importPKCS8` expects). The key exists ONLY as this secret now.
- [x] `AUTH_JWT_KID=dev-key-2026-06`

### Dev S3 + CloudFront — DONE (2026-06-24)
Provisioned with the parameterized `deploy/aws/` scripts (fish: prefix env vars with `env`,
NOT bash's `VAR=value cmd`). Run as AWS account root (works; "AWS-root→admin-IAM" is a
standing deferred item). Results:
- [x] **Bucket** `dealroute-evidence-dev` (`eu-central-1`), public-access fully blocked.
- [x] **Scoped IAM user** `dealroute-pipeline-dev` (policy `dealroute-evidence-rw-dev`,
  scoped to `arn:aws:s3:::dealroute-evidence-dev/*` only — cannot read the prod bucket).
- [x] **Screenshot-only CloudFront**: function `dealroute-evidence-screenshot-only-dev`,
  OAC `E3NK32K7RWTS3M`, distribution **`E2SO4R2NV7K6TD`** → **`https://djbml5gpmeupn.cloudfront.net`**
  (= dev `S3_CDN_BASE_URL`). Bucket readable ONLY via this distribution's OAC.

> ⚠️ The CDN script's printed copy/paste line says `-a dealroute-api` (prod) — IGNORE it.
> Set the dev CDN on the DEV app only.
> ⚠️ Run the scoping acceptance test against the DEV domain once a real bundle exists:
> `curl -sI https://djbml5gpmeupn.cloudfront.net/<id>/screenshot.png` → 200;
> `…/terms.txt` and `…/page.html` → 403. If terms.txt is reachable, UNSET the secret.

### Reference — how the dev S3/CDN was created (for re-runs / Test env later)
Prod is AWS S3 `dealroute-evidence-prod` (`eu-central-1`) + screenshot-only CloudFront
(`https://d31ssbttp5kfu7.cloudfront.net`). Dev = the SAME scripts with **dev overrides**
(AWS admin/bootstrap profile). Two collision traps the overrides avoid: (a) the S3 IAM
policy file is bucket-scoped — use `evidence-bucket-policy-dev.json` via `POLICY_FILE`;
(b) the CDN script's function/OAC/distribution names have NO env suffix and would otherwise
REUSE the prod CDN — override `FUNCTION_NAME`/`OAC_NAME`/`DIST_COMMENT`.

**1. Dev bucket + scoped IAM user + access key** (prints the `S3_*` values; secret shown ONCE):
```sh
CREATE_ACCESS_KEY=1 \
BUCKET=dealroute-evidence-dev \
REGION=eu-central-1 \
USER_NAME=dealroute-pipeline-dev \
POLICY_NAME=dealroute-evidence-rw-dev \
POLICY_FILE=deploy/aws/evidence-bucket-policy-dev.json \
  deploy/aws/setup-evidence-s3.sh
```
The dev user is scoped to `arn:aws:s3:::dealroute-evidence-dev/*` ONLY — it cannot touch
the prod bucket (isolation, matching the dev-DB isolation).

**2. Dev screenshot-only CloudFront** (prints the dev `S3_CDN_BASE_URL`):
```sh
BUCKET=dealroute-evidence-dev \
REGION=eu-central-1 \
FUNCTION_NAME=dealroute-evidence-screenshot-only-dev \
OAC_NAME=dealroute-evidence-oac-dev \
DIST_COMMENT='dealroute-evidence-cdn-dev (screenshot-only public read)' \
  deploy/aws/setup-evidence-cdn.sh
```
> ⚠️ Without the `FUNCTION_NAME`/`OAC_NAME`/`DIST_COMMENT` overrides this script would
> match + reuse the PROD CloudFront resources. The overrides are MANDATORY for dev.
> After it prints the dev CloudFront domain, run the screenshot 200 / terms+html 403
> acceptance test (deploy/fly/README.md §2.4) against the DEV domain.

**3. Set the dev S3 secrets on the Fly app** (YOU run — keeps the secret out of chat):
```sh
fly secrets set -a dealroute-api-dev --stage \
  S3_BUCKET='dealroute-evidence-dev' \
  S3_REGION='eu-central-1' \
  S3_ACCESS_KEY_ID='<from step 1>' \
  S3_SECRET_ACCESS_KEY='<from step 1>' \
  S3_CDN_BASE_URL='<dev CloudFront domain from step 2>'
# Anthropic key only needed if you run crawl lanes against dev (the API itself doesn't
# call the LLM — fly.toml sets LLM_PROVIDER=stub). If you will crawl in dev:
#   fly secrets set -a dealroute-api-dev --stage ANTHROPIC_API_KEY='<key>'
```
Then tell Claude "S3 secrets set" to resume at Step 3 (deploy).

> Alternative to skip S3 entirely for now: set `EVIDENCE_STORE=local` on the dev app (it
> only serves the API; evidence is ephemeral). Then no S3 secrets are needed to boot.

## (ORIGINAL Step 2 instructions — kept for reference)
The dev `DATABASE_URL` host uses the private Fly service host `.flycast`:
Build the dev `DATABASE_URL` (internal Fly host — `.flycast` is the private service host):
```
postgres://dealroute_dev:CHOOSE_A_PASSWORD@dealroute-db.flycast:5432/dealroute_dev
```
Set it + the rest of the dev secrets (mirror prod, EXCEPT the DB + CORS). Reuse the SAME
S3 / Anthropic / JWT values as prod for now unless you want dev-specific ones:
```sh
fly secrets set -a dealroute-api-dev \
  DATABASE_URL='postgres://dealroute_dev:CHOOSE_A_PASSWORD@dealroute-db.flycast:5432/dealroute_dev' \
  READ_ONLY='false' \
  ADMIN_CORS_ORIGIN='https://dev-hq.deal-route.com' \
  ANTHROPIC_API_KEY='<same as prod or a dev key>' \
  AUTH_JWT_PRIVATE_KEY='<same as prod, or a DEV signing key — see note>' \
  AUTH_JWT_KID='<matching kid>' \
  S3_BUCKET='<same or a dev bucket>' \
  S3_REGION='<same>' \
  S3_ACCESS_KEY_ID='<same>' \
  S3_SECRET_ACCESS_KEY='<same>' \
  S3_CDN_BASE_URL='<same or dev CDN>'
```
> **JWT note:** Dev → dev DB → dev users. If you want dev logins independent of prod, use a
> SEPARATE dev signing key here (and seed dev reviewers in the dev DB). If you just want
> dev to accept prod tokens for now, reuse the prod key. Either is fine for Dev (unlike
> Test, which MUST use the prod key because it reads prod users).

## Step 3 — DEPLOYED (2026-06-24)
- [x] `fly deploy -a dealroute-api-dev -c deploy/fly/fly.toml` — pulled the SAME
  `ghcr.io/buzunboy/deal-route-pipeline:edge` image prod runs (revision `2fb4317`). 2
  machines in `fra`, both `started`, 1/1 health checks passing.
- [x] Migrations ran on boot (entrypoint runs them before `serve`): **19 tables** in
  `dealroute_dev` incl. `deals`/`sources`/`reviews`/`users`/`settings`/`crawl_runs`.
- [x] `https://dealroute-api-dev.fly.dev/v1/health` → `200 {"ok":true}`.

### Seed a dev admin so you can log into dev-hq (YOU run — keeps the password out of chat)
Dev has its OWN JWT signing key, so prod logins do NOT work on dev — seed a dev user.
Roles: `admin` | `reviewer` (created by migration). Password **min 12 chars**.
One-off Fly machine on the dev app (inherits dev secrets → writes to `dealroute_dev`):
```fish
fly machine run ghcr.io/buzunboy/deal-route-pipeline:edge \
  --app dealroute-api-dev --region fra --rm \
  -- seed-user --email 'you@deal-route.com' --name 'Your Name' --role admin \
     --password 'CHOOSE_A_PASSWORD_MIN_12_CHARS'
```

## Step 4 — custom domain `dev-api.deal-route.com` — LIVE & VERIFIED (2026-06-24)
- [x] `fly certs add dev-api.deal-route.com -a dealroute-api-dev` — cert **Issued & active**
  (Let's Encrypt; `fly certs check` → "Certificate is verified and active").
- [x] **GoDaddy DNS** added + resolving to Fly's IPs:

| Type   | Name      | Value                     | TTL |
| ------ | --------- | ------------------------- | --- |
| **A**    | `dev-api` | `66.241.125.195`          | 600 |
| **AAAA** | `dev-api` | `2a09:8280:1::133:bc40:0` | 600 |

  (`dig A` → `66.241.125.195`, `dig AAAA` → `2a09:8280:1::133:bc40:0`.)
- [x] End-to-end: `https://dev-api.deal-route.com/v1/health` → `200 {"ok":true}`;
  `/v1/deals` → `200` (DB-backed via the custom domain).

(Fly's recommended A+AAAA setup; the IPv6 made ACME validation automatic — no
`_acme-challenge` record needed.)

### DB passwords ROTATED + verified (2026-06-24)
Both DB passwords that appeared in the setup session transcript were rotated and confirmed:
- [x] **dev** (`dealroute_dev`): old password rejected (`password authentication failed`),
  new password live, dev app healthy + DB-backed `/v1/deals` returns valid JSON.
- [x] **prod** (`dealroute_api`): old password rejected, prod app rolled to a new release,
  `/v1/deals` returns real prod data on the new credential. New passwords held only by the
  owner (not in any transcript or committed file).

> ⚠️ **CORS depends on the HQ origin, not the API domain.** The dev app's
> `ADMIN_CORS_ORIGIN` is `https://dev-hq.deal-route.com`. The dev admin panel must be
> served from exactly that origin or browser calls will be CORS-blocked (see the
> companion `docs/handoffs/ADMIN_PANEL_environments.md`).

---

## Deferred
- **Split the dev DB to its own cluster.** Today it shares the `dealroute-db` 256MB
  machine with prod (a dev load spike could degrade prod). Splitting later = create a new
  Fly Postgres + change only `DATABASE_URL`. Logged in `docs/KNOWN_ISSUES.md`.

## Security follow-ups — DONE (2026-06-24)
During setup the prod DB connection string was read off the running machine to unblock dev
DB creation, so both passwords were in the session transcript. Both rotated + verified
(old rejected, apps healthy on new creds — see the "DB passwords ROTATED" block above):
- [x] Prod DB password (`dealroute_api`) rotated; prod redeployed; serving real data.
- [x] Dev DB password (`dealroute_dev`) rotated; dev redeployed; `/v1/deals` returns JSON.
- [ ] Dev JWT key: generated locally, temp PEM shredded, lives only in the dev Fly secret
  (never printed in full) — lowest urgency; regenerate if desired.

## Prod custom domain `api.deal-route.com` — LIVE & VERIFIED (2026-06-24)
The existing `dealroute-api` app just needed its domain attached (no new app/DB):
- [x] `fly certs add api.deal-route.com -a dealroute-api` — cert **Issued & active**.
- [x] **GoDaddy DNS** (Name = label only; A+AAAA, NOT the same IPs as dev):

| Type   | Name  | Value                     |
| ------ | ----- | ------------------------- |
| **A**    | `api` | `66.241.125.110`          |
| **AAAA** | `api` | `2a09:8280:1::131:291a:0` |

  Authoritative NS (`ns09/ns10.domaincontrol.com`) return these correctly; a local
  resolver may lag a few min on propagation (flush local DNS cache if impatient).
- [x] End-to-end: `https://api.deal-route.com/v1/health` → `200`; `/v1/deals` → `200`
  (real prod data).

> The IPs differ per app — dev-api: A `66.241.125.195` / AAAA `2a09:8280:1::133:bc40:0`;
> api (prod): A `66.241.125.110` / AAAA `2a09:8280:1::131:291a:0`.

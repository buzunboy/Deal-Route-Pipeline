# Deploying the DealRoute API to the cloud (Fly.io)

This guides you through standing up the **always-on `serve` API** (gated `/api/*`
for the admin panel + public `/v1/*` feed) on Fly.io, end to end, including the
exact external services and credentials.

> **Scope.** This deploys the long-running API only. The crawl/monitor/ingest/discover
> **cron lanes** are separate, short-lived runs — use `deploy/k8s/cronjobs.yaml` (K8s)
> or schedule `fly machine run ... <lane>` / a host crontab. They share the same image
> and the same `DATABASE_URL` + `S3_*` secrets.

There are **four services** to provision, in order. Do them top to bottom — each later
step needs values from an earlier one.

```
1. Postgres (managed)        → DATABASE_URL
2. AWS S3 bucket + IAM user  → S3_BUCKET / S3_REGION / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY
3. GHCR image                → ghcr.io/buzunboy/deal-route-pipeline:<tag>  (already built by CI)
4. Fly.io app                → ties it all together; injects the secrets; gives you the HTTPS URL
```

---

## 0. Install the CLIs (one-time, local)

```sh
brew install flyctl awscli
fly auth login        # opens a browser
aws --version         # any v2.x
```

---

## 1. Postgres (managed) → `DATABASE_URL`

The API needs a real Postgres reachable from Fly. Two clean options:

### Option A — Fly Postgres (simplest; same network as the app)
```sh
fly postgres create --name dealroute-db --region fra --vm-size shared-cpu-1x --volume-size 10
# Note the connection string it prints ONCE (postgres://postgres:<pw>@dealroute-db.flycast:5432).
```
After you create the app (step 4) attach it so the secret is injected automatically:
```sh
fly postgres attach dealroute-db -a dealroute-api      # sets DATABASE_URL on the app
```
> `.flycast` is private to your Fly org — the DB is never exposed to the internet. Good.

### Option B — external managed Postgres (RDS, Supabase, Neon, …)
Provision a Postgres 16 instance **in eu-central-1 / Frankfurt** for DE data residency.
Copy its connection string; you'll set it as a secret in step 4:
```
DATABASE_URL=postgres://USER:PASS@HOST:5432/dealroute?sslmode=require
```
Make sure Fly egress can reach it (allowlist, or keep it public with TLS + a strong password).

**Migrations run automatically** on container start (the image entrypoint runs
`db:migrate`, idempotent) — you do not run migrations by hand.

---

## 2. AWS S3 — evidence bucket + scoped credentials

The evidence bundles (screenshot + HTML + terms + metadata) live in S3. The public
feed turns a screenshot ref into a URL; the panel reads evidence by reference. This is
the credentials-heavy part, so here it is click by click.

> **Shortcut — do all of §2.1–§2.3 with one script.** `deploy/aws/setup-evidence-s3.sh`
> creates the bucket (public access blocked), the least-privilege policy
> ([`deploy/aws/evidence-bucket-policy.json`](../aws/evidence-bucket-policy.json)),
> the IAM user, attaches it, and mints an access key — idempotent, and it prints the
> `fly secrets set` line for you. Run it with an **admin** AWS profile (not the app user):
> ```sh
> CREATE_ACCESS_KEY=1 deploy/aws/setup-evidence-s3.sh
> # override defaults if needed: BUCKET=... REGION=... USER_NAME=... CREATE_ACCESS_KEY=1 deploy/aws/setup-evidence-s3.sh
> ```
> Prefer the manual console steps below if you'd rather click through it / can't run
> the script. (CloudFront for public screenshots, §2.4, is manual either way.)

### 2.1 Create the bucket
Console → **S3 → Create bucket**:
- **Name:** `dealroute-evidence-prod` (globally unique → your `S3_BUCKET`)
- **Region:** **Europe (Frankfurt) `eu-central-1`** (→ your `S3_REGION`; keeps DE evidence in-region)
- **Block Public Access:** **leave ALL four boxes CHECKED (fully blocked).** ⚠️ The
  bundle's `page.html` and `terms.txt` (verbatim, copyrighted terms) must NEVER be
  public. (Public screenshots, if you want them, are exposed via CloudFront in §2.4 —
  not by unblocking the bucket.)
- Versioning: optional (recommended; bundles are write-once anyway).
- Create.

Or with the CLI:
```sh
aws s3api create-bucket --bucket dealroute-evidence-prod \
  --region eu-central-1 --create-bucket-configuration LocationConstraint=eu-central-1
aws s3api put-public-access-block --bucket dealroute-evidence-prod \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

### 2.2 Create an IAM policy scoped to JUST this bucket
The adapter writes objects and reads them back — including a `HeadObject` (metadata)
call to check a bundle exists. NOTE: there is **no `s3:HeadObject` IAM action** — the
HeadObject API is authorized by `s3:GetObject` (HEAD is a metadata-only GET). So the
policy needs exactly two actions. Console → **IAM → Policies → Create policy → JSON**, paste:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DealRouteEvidenceObjectRW",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::dealroute-evidence-prod/*"
    }
  ]
}
```
Name it `dealroute-evidence-rw`. (No `s3:ListBucket`, no `Delete` — least privilege;
evidence is write-once and the app never lists or deletes.)

### 2.3 Create a programmatic IAM user and get the access key
Console → **IAM → Users → Create user** → `dealroute-pipeline` → **do NOT** enable
console access → attach the `dealroute-evidence-rw` policy → create.
Then **Create access key** → use case **"Application running outside AWS"** → download:
- **Access key ID** → your `S3_ACCESS_KEY_ID`
- **Secret access key** → your `S3_SECRET_ACCESS_KEY` (shown once — copy it now)

> The app injects these credentials explicitly (no ambient AWS credential chain), so
> both are required. Prefer rotating them periodically.

CLI equivalent (the policy JSON is committed at `deploy/aws/evidence-bucket-policy.json`):
```sh
aws iam create-policy --policy-name dealroute-evidence-rw \
  --policy-document file://deploy/aws/evidence-bucket-policy.json
aws iam create-user --user-name dealroute-pipeline
aws iam attach-user-policy --user-name dealroute-pipeline \
  --policy-arn arn:aws:iam::<ACCOUNT_ID>:policy/dealroute-evidence-rw
aws iam create-access-key --user-name dealroute-pipeline   # prints the key pair ONCE
```
> If you change the bucket name, update the `Resource` ARN in
> `deploy/aws/evidence-bucket-policy.json` to match (the setup script enforces this).

### 2.4 (Optional) Public screenshot URLs via CloudFront → `S3_CDN_BASE_URL`
`S3_CDN_BASE_URL` is **optional**. Leave it UNSET and the public feed exposes no
evidence URL (`evidence_screenshot_url: null`); the panel still sees screenshots via
the authenticated path. Set it only if the landing page should show screenshots.

If you set it, the **hard rule** (see `ARCHITECTURE.md` "Public read surface"): only
`*/screenshot.png` may be publicly reachable — `page.html`, `terms.txt`, `evidence.json`
(the raw HTML snapshot + the verbatim, copyrighted terms text) must stay private.

> **Shortcut — do all of §2.4 with one script.** `deploy/aws/setup-evidence-cdn.sh`
> builds the screenshot-only CDN end to end: a CloudFront **Function** (from
> [`deploy/aws/cloudfront-screenshot-only.js`](../aws/cloudfront-screenshot-only.js))
> that 403s any path not ending in `/screenshot.png`, an **Origin Access Control (OAC)**
> so only CloudFront can read the bucket, a CloudFront **distribution** wiring them
> together, and a **bucket policy**
> ([`deploy/aws/evidence-cdn-bucket-policy.json`](../aws/evidence-cdn-bucket-policy.json))
> granting read to that one distribution only. The bucket stays fully access-blocked —
> CloudFront is the single public door, the function is the lock. Idempotent; it prints
> the `fly secrets set S3_CDN_BASE_URL=…` line. Run it with an **admin** AWS profile
> (after §2.1–§2.3):
> ```sh
> deploy/aws/setup-evidence-cdn.sh
> # override defaults if needed: BUCKET=... REGION=... deploy/aws/setup-evidence-cdn.sh
> ```

The clean AWS way (what the script does, if you'd rather click through it):
1. Create a **CloudFront distribution**, origin = the S3 bucket, with **Origin Access
   Control (OAC)** so only CloudFront can read the bucket (the bucket stays fully
   public-access-blocked from §2.1).
2. Attach a **CloudFront Function** on the viewer-request event that 403s any path NOT
   ending in `/screenshot.png` (the committed `cloudfront-screenshot-only.js`). This
   is the load-bearing gate — a single key-pattern cache behavior can't express
   "ends with `screenshot.png`" across arbitrary `<id>/` prefixes; the function can.
3. Set `S3_CDN_BASE_URL` = the CloudFront domain (e.g. `https://dxxxx.cloudfront.net`):
   `fly secrets set -a dealroute-api S3_CDN_BASE_URL=https://dxxxx.cloudfront.net`.

#### The SCOPING acceptance test (run this BEFORE relying on public screenshots)
After the distribution deploys (status `Deployed`), produce a real bundle (a small
crawl/dry-run — see §7) and against the **public CloudFront URL**:
```sh
CDN=https://dxxxx.cloudfront.net          # the distribution domain
ID=<a-real-bundle-id>                      # from aws s3 ls s3://dealroute-evidence-prod/

curl -sI "$CDN/$ID/screenshot.png"   # MUST be 200
curl -sI "$CDN/$ID/terms.txt"        # MUST be 403  (verbatim terms — never public)
curl -sI "$CDN/$ID/page.html"        # MUST be 403  (raw HTML snapshot — never public)
```
If `terms.txt` is reachable, **STOP — do not go live.** Unset the secret
(`fly secrets unset -a dealroute-api S3_CDN_BASE_URL`) until the scoping is fixed.
Also confirm the bucket itself is NOT public (a direct fetch without CloudFront is denied):
```sh
aws s3api get-object --bucket dealroute-evidence-prod --key "$ID/terms.txt" /tmp/x \
  --no-sign-request                  # MUST fail (AccessDenied) — the bucket stays private
```

If you can't scope it tightly / the acceptance test doesn't pass, **leave
`S3_CDN_BASE_URL` unset.** Safer default — the public feed simply omits screenshot URLs.

---

## 3. GHCR image (already built — just make it pullable)

CI (`.github/workflows/release.yml`) builds + pushes the image on every push to master:
- `ghcr.io/buzunboy/deal-route-pipeline:edge`   (rolling)
- `ghcr.io/buzunboy/deal-route-pipeline:sha-<short>`  (immutable — pin this in prod)

> ⚠️ **Lowercase.** GHCR paths are lowercase; the repo is `buzunboy/Deal-Route-Pipeline`
> but the image is `…/deal-route-pipeline`. The `fly.toml` already uses the lowercase form.

**Make it pullable by Fly.** The package is private by default. Two choices:
- **Easiest:** GitHub → your profile → **Packages → deal-route-pipeline → Package
  settings → Change visibility → Public.** (The image holds no secrets.) Fly then pulls
  it with no auth.
- **Keep it private:** create a GitHub PAT with `read:packages`, then give it to Fly at
  deploy time:
  ```sh
  fly deploy -c deploy/fly/fly.toml \
    --image ghcr.io/buzunboy/deal-route-pipeline:edge \
    --build-arg ignored=1 \
    --depot=false
  # For a private registry, set the pull secret:
  fly secrets set FLY_REGISTRY_AUTH="$(echo -n 'USERNAME:GHCR_PAT' | base64)"  # if needed
  ```
  (Simplest is public; revisit private only if required.)

---

## 4. Fly.io app — tie it together

### 4.1 Create the app
```sh
fly apps create dealroute-api          # or let `fly launch` do it; name must be globally unique
# If you used Fly Postgres (1A): attach it now (sets DATABASE_URL automatically)
fly postgres attach dealroute-db -a dealroute-api
```

### 4.2 Set the secrets
Everything sensitive goes here (NOT in `fly.toml`). One command:
```sh
fly secrets set -a dealroute-api \
  AUTH_JWT_PRIVATE_KEY="$(cat es256-private.pem)" \
  AUTH_JWT_KID="prod-1" \
  ADMIN_CORS_ORIGIN="https://admin.dealroute.example" \
  PUBLIC_CORS_ORIGIN="https://dealroute.example" \
  S3_BUCKET="dealroute-evidence-prod" \
  S3_REGION="eu-central-1" \
  S3_ACCESS_KEY_ID="AKIA..." \
  S3_SECRET_ACCESS_KEY="..." \
  DATABASE_URL="postgres://USER:PASS@HOST:5432/dealroute?sslmode=require"
  # ^ OMIT DATABASE_URL if you used `fly postgres attach` (it set it for you)
  # Add S3_CDN_BASE_URL="https://dxxxx.cloudfront.net" only if you did §2.4
```
- **`AUTH_JWT_PRIVATE_KEY`** — **REQUIRED** (Auth/IAM Phase 5: the legacy `REVIEW_API_TOKEN` is
  retired; per-user JWT is the only auth path). The ES256 signing key for the IdP — a PKCS8 PEM
  (generate: `openssl ecparam -name prime256v1 -genkey -noout -out k.pem && openssl pkcs8 -topk8
  -nocrypt -in k.pem -out es256-private.pem`) or a JWK JSON string. `serve` HARD-FAILS at startup
  without it — there is no static-token or open fallback. Also set `AUTH_JWT_KID` (any stable id).
  After deploy, seed the reviewers: `fly ssh console -a dealroute-api -C "node … cli seed-user …"`
  (or run the seed-user CLI as a one-off machine). The panel forwards each reviewer's per-user token;
  it holds NO shared pipeline secret.
- **`ADMIN_CORS_ORIGIN`** — the panel's EXACT deployed origin (scheme+host, no trailing slash).
  Must NOT be `*` (the surface is credentialed).

### 4.3 Deploy
```sh
fly deploy -c deploy/fly/fly.toml
```
The entrypoint migrates the DB, then starts `serve`. Watch logs:
```sh
fly logs -a dealroute-api
# expect:  "entrypoint: applying database migrations..."  then the three serve URLs
```

### 4.4 Get the URL
```sh
fly status -a dealroute-api      # shows the hostname, e.g. https://dealroute-api.fly.dev
```

---

## 5. Verify (the same checks we ran locally, now against the cloud URL)

```sh
API=https://dealroute-api.fly.dev

curl -s $API/api/health                 # {"ok":true}
curl -s $API/v1/health                  # {"ok":true}
curl -s "$API/v1/deals"                 # {"deals":[],"total":0,...}  (empty until data exists)

# CORS preflight from the panel origin → 204 with the panel origin echoed:
curl -i -X OPTIONS $API/api/candidates/x/approve \
  -H "Origin: https://admin.dealroute.example" \
  -H "Access-Control-Request-Method: POST"

# Auth (per-user JWT only): a read without a token → 401; the IdP JWKS is public:
curl -s $API/.well-known/jwks.json      # the IdP public key(s)
curl -i $API/api/candidates             # 401 unauthorized

# Get a per-user token, then call a gated endpoint with it:
TOKEN=$(curl -s -X POST $API/auth/login -H "Content-Type: application/json" \
  -d '{"email":"you@dealroute.example","password":"<seeded-pw>"}' | jq -r .accessToken)
curl -i -X POST $API/api/candidates/<uuid>/approve \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'
```

---

## 6. Point the admin panel at it

In the admin panel repo's deployed env:
- API base URL → `https://dealroute-api.fly.dev` (also where `/auth/login` lives)
- No shared token — the panel authenticates Credentials against `/auth/login` and forwards each
  reviewer's per-user access token. There is no `PIPELINE_TOKEN`/`REVIEW_API_TOKEN` (Auth/IAM Phase 5).
- The panel's deployed origin MUST equal `ADMIN_CORS_ORIGIN`. If it changes, update the
  secret and redeploy:
  ```sh
  fly secrets set -a dealroute-api ADMIN_CORS_ORIGIN="https://new-panel-origin"
  ```

The contract the panel codes against is `docs/api/openapi.yaml` (+ the Postman
collection). Set its `baseUrl` variable to the Fly URL and `bearerToken` to the token.

---

## 7. Running the cron lanes in the cloud (when you're ready)

The lanes are NOT part of this always-on app. Cheapest on Fly: scheduled one-off Machines
that exit. They reuse the SAME image + the DB/S3 secrets, but set `LLM_PROVIDER=anthropic`
(+ `ANTHROPIC_API_KEY`) since they DO call the model:
```sh
fly secrets set -a dealroute-api ANTHROPIC_API_KEY="sk-ant-..."   # lanes need it; serve doesn't
fly machine run ghcr.io/buzunboy/deal-route-pipeline:edge \
  -a dealroute-api --region fra --rm \
  --vm-size shared-cpu-2x --vm-memory 2048 \
  -e LLM_PROVIDER=anthropic -e EVIDENCE_STORE=s3 \
  -- monitor --due
```
Wire those to a scheduler (GitHub Actions `scheduled.yml`, a Fly scheduled Machine, or
host cron). Keep Tier-4 (`discover`) dark unless you set `AGENT=search` + a search backend.

> ⚠️ **Two footguns these examples bake in (both bit a real run):**
> 1. **VM sizing — `fly machine run` does NOT read `fly.toml`'s `[[vm]]`.** A one-off
>    Machine gets Fly's **256 MB default**, which is far too small for the lanes' headless
>    Chromium (Playwright) — the crawl OOM-stalls. Always pass
>    **`--vm-size shared-cpu-2x --vm-memory 2048`** (≈2 GB; matches the discover CronJob's
>    `limits.memory: 2Gi` in `k8s/cronjobs.yaml`). The always-on `serve` machine is the
>    exception — it's light and stays at the `fly.toml` 512 MB.
> 2. **The `-- ` separator is MANDATORY** before the lane command (`-- monitor --due`,
>    not `monitor --due`). Without it `fly` eats `--due` as its own flag and dies with
>    `unknown flag: --due`. Don't bury the `--` inside a shell variable either — word-splitting
>    a var that *ends* in `--` can drop it; put it literally on the command line.

---

## Secrets checklist (what the API needs at runtime)

| Secret | Required | From | Notes |
|---|---|---|---|
| `DATABASE_URL` | ✅ | §1 | `fly postgres attach` sets it, or set manually |
| `AUTH_JWT_PRIVATE_KEY` | ✅ (required) | §4.2 (ES256 PEM/JWK) | the IdP signing key; `serve` HARD-FAILS without it (per-user JWT is the only auth path — Phase 5). Set `AUTH_JWT_KID` too. |
| `ADMIN_CORS_ORIGIN` | ✅ (browser panel) | the panel's deployed origin | exact origin, never `*` |
| `PUBLIC_CORS_ORIGIN` | optional | landing origin | defaults to `*` |
| `S3_BUCKET` / `S3_REGION` | ✅ | §2.1 | `dealroute-evidence-prod` / `eu-central-1` |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | ✅ | §2.3 | scoped IAM user key |
| `S3_CDN_BASE_URL` | optional | §2.4 (`deploy/aws/setup-evidence-cdn.sh`) | only if exposing public screenshots; CloudFront scoped to `*/screenshot.png`. Unset = safe default |
| `ANTHROPIC_API_KEY` | only for lanes | Anthropic console | `serve` doesn't need it; crawl/extract do |

# Running DealRoute locally (cross-repo dev)

How to stand up the pipeline's APIs on `localhost` so the **admin panel** and
**landing page** (separate repos) can talk to them. Set up 2026-06-21.

The pipeline serves **two** HTTP surfaces from one process (`serve`), on **one** port:

| Surface | Path | Auth | Consumed by |
|---|---|---|---|
| Gated admin API | `http://localhost:3000/api/*` | Bearer token (writes) | **Admin panel** |
| Public read feed | `http://localhost:3000/v1/*` | none (read-only) | **Landing page** |
| Test page | `http://localhost:3000/` | none | browser sanity check |

## Prerequisites (one-time)

### 1. Postgres 16 (Homebrew)
```sh
brew install postgresql@16
brew services start postgresql@16          # runs on :5432, restarts at login
```
`postgresql@16` is keg-only (not on PATH). Use full paths for its tools, e.g.
`/opt/homebrew/opt/postgresql@16/bin/psql`.

### 2. Role + databases
```sh
PSQL=/opt/homebrew/opt/postgresql@16/bin/psql
$PSQL -d postgres -c "CREATE ROLE dealroute WITH LOGIN PASSWORD 'dealroute' CREATEDB;"
$PSQL -d postgres -c "CREATE DATABASE dealroute      OWNER dealroute;"
$PSQL -d postgres -c "CREATE DATABASE dealroute_test OWNER dealroute;"   # for integration tests
```

### 3. `.env`
A local `.env` already exists at the repo root (gitignored). Key values:
- `DATABASE_URL=postgres://dealroute:dealroute@localhost:5432/dealroute`
- `REVIEW_API_PORT=3000`
- `REVIEW_API_TOKEN=local-dev-token` — the panel sends this as `Authorization: Bearer local-dev-token`
- `ADMIN_CORS_ORIGIN=http://localhost:5173` — **the admin panel's dev origin**. Vite defaults to 5173;
  Next.js dev defaults to 3000 (which collides with this API — change one). Must match the panel's
  origin exactly (scheme + host + port, no trailing slash).
- `PUBLIC_CORS_ORIGIN=*` — landing page; fine as `*` locally.
- `LLM_PROVIDER=stub` — the API needs no LLM. To run real `crawl`/`dry-run-extract`, paste your
  `ANTHROPIC_API_KEY` and set `LLM_PROVIDER=anthropic`.

> **`.env` is auto-loaded** by the `dev`/`cli`/`db:migrate`/`seed:import`/`dry-run-extract` npm
> scripts (via `tsx --env-file-if-exists=.env`). CI/Docker set env explicitly and ignore `.env`.

### 4. Apply migrations
```sh
npm run db:migrate                 # creates the 11 tables in `dealroute`
```

## Run the API
```sh
npm run cli -- serve
```
You'll see the three URLs printed. **No** "no REVIEW_API_TOKEN" warning = the token loaded
(writes are gated). Stop with Ctrl-C (or `lsof -ti:3000 | xargs kill`).

## Verify it works
```sh
curl http://localhost:3000/api/health                 # {"ok":true}
curl http://localhost:3000/v1/deals                   # {"deals":[],"total":0,...}

# CORS preflight from the panel origin → 204 with the headers the browser needs:
curl -i -X OPTIONS http://localhost:3000/api/candidates/x/approve \
  -H "Origin: http://localhost:5173" -H "Access-Control-Request-Method: POST"

# Write without the token → 401; with it → reaches the handler:
curl -i -X POST http://localhost:3000/api/candidates/<uuid>/approve \
  -H "Authorization: Bearer local-dev-token" -H "Content-Type: application/json" \
  -d '{"approver":"me"}'
```

## Connecting the admin panel repo
In the admin panel's own env (e.g. `.env.local`):
- API base URL → `http://localhost:3000`
- Bearer token → `local-dev-token` (sent as `Authorization: Bearer <token>` on every write)
- Run the panel on `http://localhost:5173` (or update `ADMIN_CORS_ORIGIN` in this repo's `.env` to
  whatever port it uses, then restart `serve`).

The panel's first calls will be `GET /api/candidates`, `GET /api/field-proposals`,
`GET /api/manual-capture-tasks`, `GET /api/sources/pending` — all return `[]` until you populate data.

## Populating data for the panel to show
The review queue is empty on a fresh DB. To get candidates:
1. Paste `ANTHROPIC_API_KEY` into `.env`, set `LLM_PROVIDER=anthropic`.
2. `npm run cli -- seed-import` then `npm run cli -- crawl --due` (real crawl + extract), **or**
3. add a source via the `add-source` skill and crawl it.

Nothing auto-publishes — candidates land in the review queue for the panel to approve.

## Known local gotcha
A malformed (non-UUID) `:id` on `/api/candidates/:id/*` or `/v1/deals/:id` returns a clean **404**
(a UUID-shape boundary guard, `src/adapters/http/http-ids.ts`, rejects it before it reaches the
Postgres `uuid` column). Fixed in P1 (was a 500); see `docs/KNOWN_ISSUES.md` → Resolved.

## Integration tests against the local DB
Now that `dealroute_test` exists and `DATABASE_URL_TEST` is in `.env`:
```sh
DATABASE_URL="postgres://dealroute:dealroute@localhost:5432/dealroute_test" npm run db:migrate
npm run test:integration            # 39 tests, real Container + Postgres
```

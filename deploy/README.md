# Deploying & scheduling DealRoute (v1 — external cron)

DealRoute is a **CLI, not a self-running daemon**. The `Queue` (pg-boss) port exists
in the tree but is **intentionally unwired** from the composition root — v1 runs each
lane as a **scheduled invocation of the published container image**. This directory
holds the scheduler templates (Step 4). The image build + the SSH-deploy hook live in
`.github/workflows/release.yml` and `.github/workflows/deploy.yml`.

> **Why external cron (not pg-boss) for v1:** the lanes are independent, idempotent,
> and `--due`-selected, so a plain scheduler is enough and adds no moving parts. Wire
> the in-process pg-boss worker only when concurrency/autonomy justify it — and when
> you do, **bound its pool** and add a **source-level advisory lock** first (both in
> `docs/KNOWN_ISSUES.md`), because concurrency then becomes real (two workers must
> never crawl one source at once). Until then `concurrencyPolicy: Forbid` /
> `concurrency:` guards keep each lane from overlapping itself.

## Pick one scheduler

| Option | File | Use when |
|---|---|---|
| **Kubernetes CronJobs** (recommended) | [`k8s/cronjobs.yaml`](k8s/cronjobs.yaml) | You run K8s; want tight, reliable cron + resource limits. |
| **Scheduled GitHub Action** | [`../.github/workflows/scheduled.yml`](../.github/workflows/scheduled.yml) | No K8s/ECS; simplest possible scheduler. Best-effort timing. |
| **Host crontab / ECS scheduled task** | — (use the commands below) | A single VM or ECS — run the same image + args from your platform's scheduler. |

All three run the **same artifact**: `ghcr.io/<owner>/<repo>:<tag>` (built by
`release.yml`). The container entrypoint applies pending **migrations** (idempotent),
then runs the CLI command you pass.

## The four lanes + their cadence

| Lane | Command | Cadence | Why |
|---|---|---|---|
| **Crawl** (Lane A) | `crawl --due` | every **6 h** | Re-crawl seed sources whose `next_due` elapsed. Reliability back-off already stretches flaky sources, so a frequent sweep is cheap. |
| **Monitor** | `monitor --due` | every **3 h** | Re-verify published deals, diff price/terms, expire on disappearance. This drives the freshness `trust` badge users see — the tightest cadence. |
| **Ingest** (Lane B / Tier 3) | `ingest --community-due` | **hourly** | Community RSS promos are short-lived; catch them fast. |
| **Discover** (Tier 4) | `discover --broad` | **daily**, OFF by default | Agentic open-web discovery. Expensive; does nothing unless `AGENT=search` + a search backend are set. Capped by per-run limits **and** the daily €-budget guard. |

`--due` selectors only act on what's actually due, so a slightly-late or skipped run
is self-correcting — it just picks up the backlog on the next firing.

## Environment

Non-secret config (a ConfigMap in K8s; repo vars / `-e` flags otherwise). **The
defaults keep every expensive/agentic path dark — change them deliberately:**

| Var | v1 value | Note |
|---|---|---|
| `LLM_PROVIDER` | `anthropic` | the cheap extractor; needs `ANTHROPIC_API_KEY`. |
| `FETCHER` | `playwright` | `browser` for JS-heavy pages (see KNOWN_ISSUES). |
| `EVIDENCE_STORE` | **`s3`** (under cron) | `local` is dev/CLI-only: a CronJob/Action pod has an **ephemeral filesystem**, so a local bundle is discarded on exit, leaving the candidate's `evidence_id` dangling (breaks evidence-required in practice). Under any scheduler use `s3` (set `S3_*`) — and read the CDN-scoping contract in `ARCHITECTURE.md` (expose **only** `*/screenshot.png`). |
| `DAILY_BUDGET_EUR` | `10.00` | aggregate €/UTC-day ceiling for the agentic lane (`0` disables). |
| `AGENT` / `SEARCH_PROVIDER` | unset (`noop`/`stub`) | **only** set `AGENT=search` (+ a search backend) on the **discover** lane to enable Tier-4. |

Secrets (a Secret in K8s; environment secrets in Actions; never committed):
`DATABASE_URL`, `ANTHROPIC_API_KEY`, and — only if used — `SEARCH_API_KEY`, `S3_*`.

## Migrations

Each scheduled run self-applies migrations (the entrypoint runs `db:migrate` first;
drizzle tracks applied ones, so it's idempotent). If you prefer a single owner of the
schema, run one migration Job and set `RUN_MIGRATIONS=false` on the lane containers.

## Trust posture (unchanged by scheduling)

Running unattended changes **nothing** about the invariants: **nothing auto-publishes**
(only a human `review approve` publishes), evidence is captured before any candidate,
public pages only, and every lane is bounded. The one scheduling-specific fix that
landed with this step is **Prereq A**: monitor now tracks each source's resolved
(post-redirect) URL so a redirecting source's published deals **do** auto-expire — see
the source's `resolved_url` and `docs/DealRoute_PostP3_Handoff.md` §4.

## Quick reference (any scheduler)

```sh
# One lane, once (the image entrypoint migrates then runs the command):
docker run --rm -e DATABASE_URL -e ANTHROPIC_API_KEY \
  ghcr.io/<owner>/<repo>:<tag> monitor --due

# Crontab sketch on a single host (UTC):
#   0 */6 * * *  docker run --rm --env-file /etc/dealroute.env ghcr.io/<owner>/<repo>:edge crawl --due
#  30 */3 * * *  docker run --rm --env-file /etc/dealroute.env ghcr.io/<owner>/<repo>:edge monitor --due
#  15 *   * * *  docker run --rm --env-file /etc/dealroute.env ghcr.io/<owner>/<repo>:edge ingest --community-due
```

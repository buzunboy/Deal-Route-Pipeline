# DealRoute — Observability (alerting + metrics) — design & roadmap

> **Status: LIVING (reference for the observability track).** Step 5 shipped the
> alerting spine (an `Alerting` port + Noop/Webhook adapters, wired at the two
> silent-warn points). This doc records what's built and **how the deferred
> Datadog/CloudWatch metrics-push adapters should be implemented** when a metrics
> backend is chosen — so they slot in via OCP without touching the use-cases.

## What's built (Step 5, 2026-06-21)

The pipeline had two **silent** failure signals — a source's reliability falling
below the flag threshold (a persistently-failing source) and the daily €-budget
guard reaching its ceiling — that only emitted a `logger.warn`. Step 5 turns them
into a proactive signal:

- **`Alerting` port** (`src/application/ports/alerting.ts`): `alert(event): Promise<void>`.
  **Best-effort by contract** — `alert()` resolves even on delivery failure, so
  alerting can NEVER crash or stall the lane it observes (callers `await` it with no
  try/catch). A shared contract suite (`test/contracts/alerting-contract.ts`) pins this.
- **Pure domain** (`src/domain/alerting/alert-event.ts`): a vendor-neutral typed
  `AlertEvent` (`kind`, `severity`, `title`, `summary`, stable `dedupe_key`, `at`,
  structured `context`) + pure builders (`sourceReliabilityLowAlert`,
  `dailyBudgetReachedAlert`). No I/O, no clock (the caller supplies `at`). A new alert
  kind is a new builder + an enum entry — never an adapter change.
- **Adapters** (`src/adapters/alerting/`): `NoopAlerter` (DEFAULT off-switch — logs at
  debug, delivers nowhere) and `WebhookAlerter` (POSTs JSON to a configured URL; the
  body carries a top-level `text` so a **Slack incoming webhook** renders it directly,
  plus the full structured event for a **generic collector**). Timeout-bounded;
  every transport failure is logged + swallowed.
- **Wiring**: config-selected (`ALERT_KIND` `noop|webhook`, `ALERT_WEBHOOK_URL`,
  `ALERT_TIMEOUT_MS`), built in the one composition root, injected into
  `CrawlSourceUseCase` + `MonitorSourceUseCase` (reliability-low) and `DailyBudgetGuard`
  (budget-reached). Dark by default — `noop` until a URL is set; no schema/trust impact.

**Triggers wired:** `source_reliability_low` (crawl + monitor) and
`daily_budget_reached`. Deliberately NOT per-failed-crawl-run — that's noisy and
transient failures already feed reliability-low.

## Deferred: Datadog / CloudWatch metrics-push adapters (how to build them)

The owner asked for these to be "ready to use" but they were deferred from Step 5
because a full metrics-backend adapter is materially heavier than a webhook (a vendor
SDK + credentials + a metrics/dashboard model) and the generic webhook already covers
the v1 "tell a human a source is failing / cost spiked" need. They slot in cleanly
later **without touching any use-case** — the `Alerting` port is the seam.

### The shape (both backends)

1. **New config values** (`src/config/config.ts`): extend `alerting.kind` to
   `'noop' | 'webhook' | 'datadog' | 'cloudwatch'`; add the backend's settings
   (Datadog: `DD_API_KEY`, optional `DD_SITE`; CloudWatch: AWS creds/region +
   `CW_NAMESPACE`, reusing the existing AWS credential chain the S3 store uses). Keep
   the loud-failure rule: selecting a backend without its key throws at the
   composition root (mirror `buildAlerter`/`buildSearchProvider`).
2. **New adapter** (`src/adapters/alerting/datadog-alerter.ts` /
   `cloudwatch-alerter.ts`) implementing `Alerting`. Map an `AlertEvent` to the
   backend's wire format:
   - **Datadog**: POST to the Events API (`/api/v1/events`) — `title` ← `event.title`,
     `text` ← `event.summary`, `alert_type` ← map `severity` (warning→warning,
     critical→error, info→info), `tags` ← `[kind:<kind>, ...context as k:v]`,
     `aggregation_key` ← `event.dedupe_key`. Optionally also `count`/`gauge` a metric
     (e.g. `dealroute.source.reliability_low`) via the Metrics API for dashboards.
     Prefer plain HTTPS POST (like the webhook adapter — an injected fetch seam) over
     the `@datadog/datadog-api-client` SDK unless a metrics submission cadence needs it.
   - **CloudWatch**: `PutMetricData` (a counter per kind, e.g.
     `Namespace=DealRoute, MetricName=SourceReliabilityLow, Value=1`, dimensions from
     `context`) and/or a structured log line a CloudWatch metric-filter alarms on.
     Uses `@aws-sdk/client-cloudwatch` (the AWS SDK is already a dependency for S3).
3. **Keep the best-effort contract**: catch + log every transport error, resolve
   normally, run the shared `alertingContract` (ok + failing fixtures). Timeout-bound
   the call with `withAbortableTimeout` like the webhook adapter.
4. **No use-case change**: the warn points already emit `AlertEvent`s; only the
   composition root learns the new `kind`. That's the OCP payoff.

### Interim option (no new adapter)

A generic HTTP collector/proxy can already front Datadog/CloudWatch **today** via the
`WebhookAlerter` (point `ALERT_WEBHOOK_URL` at a Datadog log-intake / a Lambda that
calls `PutMetricData`). Build the native adapter only when the indirection or the
metric-submission semantics justify it.

### When to build it

When a metrics backend is actually chosen for the deployment AND dashboards/aggregation
(not just human notification) are needed. Until then, webhook→Slack/collector is the
v1 answer. Tracked as a low-severity deferred item in `docs/KNOWN_ISSUES.md`.

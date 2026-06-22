# Admin-Panel handoff — metrics + settings endpoints are LIVE (ACR-6 / ACR-9 / ACR-10 Metrics + Settings)

**For:** the Admin-Panel project (separate repo). **From:** the DealRoute pipeline.
**Date:** 2026-06-22.

> **Scope:** §1–§3 cover the metrics endpoints (already shipped). §4 covers the **new
> Settings endpoints** (`GET /api/settings` + `PATCH /api/settings/:key`) — read §4
> carefully: several panel placeholder settings are **read-only** or **have no pipeline
> backing**, so the Settings screen needs view-only handling + some rows dropped.

The pipeline now serves the three metrics/dashboard endpoints the panel had placeholders
for. Wire each screen's typed client to the real endpoint (`wire-endpoint`) and drop the
`lib/<screen>/sample.ts` fixture. The **one** breaking shape change is ACR-6's throughput
(details below) — everything else matches the placeholders you already render.

All three are **GET, unauthenticated reads** (like the existing `/api/candidates/counts`,
`/api/audit`, `/api/published`). Base URL is the same gated admin API the panel already
calls. The pipeline's OpenAPI source of truth is `docs/api/openapi.yaml` (schemas
`ThroughputSummary`, `FreshnessBand`, `DashboardMetrics` + `MetricKpi`/`CostBar`/
`ConfidenceBand`).

---

## 1. ACR-6 — `GET /api/metrics/throughput?period=today` ⚠️ SHAPE CHANGE

**Returns:**

```json
{ "approved": 18, "rejected": 7, "edited": 5, "avg_review_seconds": 1843 }
```

- `approved` / `rejected` / `edited` — counts of today's (UTC) review decisions.
- `avg_review_seconds` — **integer seconds** (NOT a formatted string), or `null` when no
  decision today has a resolvable capture time. It is the mean of
  `decided_at − evidence.captured_at` over today's decisions (capture→decision latency).
- `period` — only `today` is supported; any other value is a `400`.

### Why this breaks the current panel zod, and the fix

The panel's `throughputSchema` (in `lib/api/schemas.ts`) currently expects a **pre-formatted
string** field `avg_review` (e.g. `"2.4m"`, `"—"`). The pipeline instead returns the raw
`avg_review_seconds` number — this was a deliberate owner decision (keep formatting on the
client; match the written ACR-6 contract). **Until you migrate, the throughput card will
reject the live response.**

**Migration (panel side):**

1. In `lib/api/schemas.ts`, change `throughputSchema`:

   ```ts
   // BEFORE
   export const throughputSchema = z.object({
     approved: z.number().int(),
     rejected: z.number().int(),
     edited: z.number().int(),
     avg_review: z.string(),           // ← formatted string
   });

   // AFTER
   export const throughputSchema = z.object({
     approved: z.number().int(),
     rejected: z.number().int(),
     edited: z.number().int(),
     avg_review_seconds: z.number().int().min(0).nullable(),  // ← raw seconds
   });
   ```

2. Format for display where the card reads it (`throughput-card.tsx`,
   the `avg_review` → "Avg / review" row). Suggested formatter (`null` → em-dash):

   ```ts
   function formatReviewTime(seconds: number | null): string {
     if (seconds === null) return "—";
     if (seconds < 60) return `${seconds}s`;
     if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
     return `${(seconds / 3600).toFixed(1)}h`;
   }
   // ...
   { key: "avg", label: "Avg / review", value: formatReviewTime(throughput.avg_review_seconds) }
   ```

3. Update `lib/dashboard/sample.ts` (the `throughput` placeholder) to the new field if you
   keep the fixture for tests, and the Dashboard's `dashboardSummarySchema.throughput`
   reference if the dashboard reuses the same shape.

> **Note on the metric's meaning:** `avg_review_seconds` is *capture→decision* latency,
> which is dominated by how long the candidate sat in the queue (queue wait), not active
> reviewer effort. The pipeline has no separate "started reviewing" timestamp. If the card's
> copy implies "time spent reviewing," consider relabelling to "Avg time-to-decision" / "Avg
> queue→decision." A true review-effort metric would need a new queue-entered timestamp in
> the pipeline (a deal-record schema change) — out of scope for now.

---

## 2. ACR-9 — `GET /api/candidates/freshness` ✅ matches placeholder

**Returns** an array of exactly three bands (always present; an empty queue returns all at 0):

```json
[
  { "bucket": "<24h", "percent": 68 },
  { "bucket": "1-3d", "percent": 24 },
  { "bucket": ">3d",  "percent": 8 }
]
```

- `bucket` — one of `"<24h" | "1-3d" | ">3d"` (freshest first). Boundaries: `<24h` is age
  `< 24h`, `1-3d` is `24h ≤ age < 72h`, `>3d` is `≥ 72h`. Age = `now − evidence.captured_at`
  of each pending (`candidate` + `in_review`) deal.
- `percent` — integer 0–100; the three always sum to exactly 100 (largest-remainder rounding).

**Panel mapping:** the pipeline returns the *bucket key + percent* only. Your placeholder
(`lib/dashboard/sample.ts`) carries a display `label` ("< 24h old" / "1–3 days" /
"> 3 days (stale)") and a `tone` ("fresh"/"aging"/"stale") — keep deriving those on the panel
from `bucket` (a 3-entry lookup), since they're presentation. So adapt the freshness read to
map `{ bucket, percent }` → `{ label, percent, tone }` via a fixed `bucket → {label,tone}`
table. No server round-trips for the labels.

---

## 3. ACR-10 Metrics — `GET /api/metrics` ✅ matches placeholder

**Returns:**

```json
{
  "kpis": [
    { "key": "crawl-cost",    "label": "Crawl cost today", "value": "€164", "trend": "", "direction": "flat" },
    { "key": "throughput",    "label": "Throughput today", "value": "30",   "trend": "", "direction": "flat" },
    { "key": "approval-rate", "label": "Approval rate",    "value": "72%",  "trend": "", "direction": "flat" },
    { "key": "avg-confidence","label": "Avg confidence",   "value": "0.83", "trend": "", "direction": "flat" }
  ],
  "cost_per_day": [ { "day": "08", "cost": 40, "highlight": false }, … 14 entries … ],
  "confidence_distribution": [
    { "label": "High (≥ 0.80)",      "percent": 64, "level": "success" },
    { "label": "Medium (0.60–0.79)", "percent": 27, "level": "warning" },
    { "label": "Low (< 0.60)",       "percent": 9,  "level": "danger" }
  ]
}
```

This matches the panel's `metricsSchema` field-for-field (`MetricKpi` / `CostBar` /
`ConfidenceBand`). Notes:

- `kpis` — four cards, keys `crawl-cost` / `throughput` / `approval-rate` / `avg-confidence`,
  all real-data-derived. `value` is **pre-formatted** (e.g. `"€164"`, `"72%"`, `"0.83"`, or
  `"—"` when undefined). `trend` is currently an **empty string** and `direction` is `"flat"`
  for every card — the pipeline doesn't compute period-over-period trends yet (the trend
  caption + arrow color will populate when that's built; the panel's existing
  `direction` enum already accepts `flat`, so no change needed).
- `cost_per_day` — always **14 entries**, oldest→newest, one per UTC day (a day with no crawl
  cost still appears with `cost: 0`). `day` is the UTC day-of-month label ("08"…"21");
  `highlight` is true for the 2 most-recent days. Derive bar heights from `cost` (as your
  screen already does).
- `confidence_distribution` — three bands over the *pending* queue's confidences, bucketed
  High ≥ 0.80 / Medium 0.60–0.79 / Low < 0.60; `level` is `success|warning|danger`; percents
  sum to 100.

The dashboard's "Today's throughput" and "Queue freshness" cards can keep using the dedicated
ACR-6 / ACR-9 endpoints above (more focused than re-deriving from `/api/metrics`).

---

## 4. ACR-10 Settings — `GET /api/settings` + `PATCH /api/settings/:key` ⚠️ SHAPE CHANGE + view-only rows

The pipeline now serves the Settings screen. **Key principle:** the pipeline's operational
config is **env-driven** (the source of truth for a running process). Only a small set of
knobs are durable, panel-editable **overrides**; the rest are **read-only mirrors** the
panel must render view-only. Some of your placeholder settings have **no pipeline backing
at all** and should be dropped or moved.

### 4a. The response shape (one additive field: `read_only`)

```
GET /api/settings → {
  "groups": [
    { "key": "pipeline", "label": "Pipeline", "rows": [
      { "key": "daily_budget", "label": "...", "control": "value", "value": "€10.00", "read_only": true },
      ...
    ]}
  ]
}
```

Every row now carries **`read_only: boolean`** (added to both the `toggle` and `value`
variants of your `settingRowSchema`). Migration:

```ts
// lib/api/schemas.ts — add read_only to BOTH members of settingRowSchema:
export const settingRowSchema = z.discriminatedUnion("control", [
  z.object({ key: z.string(), label: z.string(), hint: z.string().optional(),
             control: z.literal("toggle"), enabled: z.boolean(), read_only: z.boolean() }),
  z.object({ key: z.string(), label: z.string(), hint: z.string().optional(),
             control: z.literal("value"),  value: z.string(),   read_only: z.boolean() }),
]);
```

Render a `read_only: true` row as a **view-only** component (no toggle interactivity / no
edit affordance) — a `PATCH` on it returns **409**.

### 4b. PATCH a writable setting

```
PATCH /api/settings/:key   { "approver": "<email>", "value": <bool|string|number> }
   → 200 { "key": "...", "updated": true }
   → 409 if the key is read-only or unknown
   → 400 if the value is invalid for that key
```

Bearer-gated (like the other writes). `value` is loose (a toggle sends a boolean, a value
chip a string/number); the pipeline validates per key.

### 4c. Exactly which keys exist, and what to do with each

The pipeline serves THIS catalog (the keys the panel must use — your placeholder keys
`auto_crawl`, `min_confidence`, `currency_eur`, `slack_alerts` are **not** served; see 4e):

| key                    | group          | control | writable? | notes |
|------------------------|----------------|---------|-----------|-------|
| `daily_budget`         | Pipeline       | value   | **read-only** | The €-budget currently IN EFFECT. View-only. |
| `daily_budget_queued`  | Pipeline       | value   | **writable**  | A new budget that applies on the NEXT deploy (see 4d). |
| `evidence_store`       | Pipeline       | value   | **read-only** | `local`/`s3`; a deploy concern. View-only. |
| `respect_robots`       | Pipeline       | toggle  | **read-only** | Legal/policy posture; env-set. View-only. |
| `affiliate_disclosure` | Review defaults| toggle  | **writable**  | The default applied at approve when a reviewer omits it. Takes effect immediately. |
| `active_markets`       | Markets        | value   | **read-only** | Derived from the MARKETS registry (currently `DE`). View-only. |
| `alerting`             | Integrations   | value   | **read-only** | `noop`/`webhook`; env-set. View-only. |

Only **`daily_budget_queued`** and **`affiliate_disclosure`** accept a PATCH.

### 4d. The two budget fields — render BOTH

There are intentionally two budget rows:

- **`daily_budget`** (read-only) — the budget the running pipeline is enforcing NOW.
- **`daily_budget_queued`** (writable) — a budget that the pipeline **cannot adopt
  mid-life** (the budget guard is built once at boot). A PATCH stores it stamped with the
  current deployment; it takes effect on the **next deployment**, then **self-clears**
  (reads back empty). GET always reports the in-effect value via `daily_budget`.

**Panel UI:** when `daily_budget_queued` has a value, show something like _"Currently
€10.00/day. A change to €25.00/day will take effect on the next deployment."_ When it's
empty, just show the in-effect `daily_budget`. A small inline description on the queued
field ("applies on next deploy") is recommended.

### 4e. Settings the panel shows that the pipeline does NOT serve (drop or rework)

Your `lib/settings/sample.ts` has placeholder rows with **no pipeline backing**. They are
**not** in the served catalog, so a wired Settings screen won't receive them:

- **`auto_crawl`** ("Automatic crawling" toggle) — there is no runtime crawl on/off flag;
  scheduling is external cron (a deploy concern). **Drop it**, or move it to docs.
- **`min_confidence`** ("Minimum confidence to auto-queue") — **no such gate exists** in
  the pipeline (nothing auto-queues by confidence today). **Drop it** until/unless the gate
  is built (the pipeline owner deferred building it).
- **`currency_eur` / "Show EUR equivalents"** — a display concern that belongs to the panel
  or landing page, not the pipeline. **Keep it panel-local** (don't expect it from the API).
- **`slack_alerts`** — superseded by the read-only **`alerting`** row (which reflects the
  real `ALERT_KIND`). If you want a Slack-specific toggle, it's env/deploy config, not a
  writable pipeline setting. **Replace your `slack_alerts` placeholder with the read-only
  `alerting` row.**

---

## Checklist

- [ ] ACR-9 freshness → `wire-endpoint` `/api/candidates/freshness`, map bucket→label/tone, drop sample.
- [ ] ACR-10 Metrics → `wire-endpoint` `/api/metrics`, drop `lib/metrics/sample.ts`.
- [ ] **ACR-6 throughput → migrate `throughputSchema` to `avg_review_seconds`, add a formatter,
      then `wire-endpoint` `/api/metrics/throughput?period=today`.** (The breaking one.)
- [ ] Re-point the Dashboard's throughput + freshness placeholder cards at the live reads.
- [ ] Optionally relabel the "Avg / review" copy to "time-to-decision" (see the note in §1).
- [ ] **ACR-10 Settings → add `read_only` to `settingRowSchema`; render read-only rows view-only.**
- [ ] **Wire `/api/settings` GET + `/api/settings/:key` PATCH; drop `lib/settings/sample.ts`.**
- [ ] **Use the served catalog keys (4c); drop `auto_crawl` / `min_confidence`, keep `currency_eur`
      panel-local, replace `slack_alerts` with the read-only `alerting` row.**
- [ ] **Render BOTH `daily_budget` (in effect) + `daily_budget_queued` (next deploy) with the
      "applies on next deployment" messaging (4d).**

# Admin-Panel handoff — the metrics endpoints are LIVE (ACR-6 / ACR-9 / ACR-10 Metrics)

**For:** the Admin-Panel project (separate repo). **From:** the DealRoute pipeline.
**Date:** 2026-06-22.

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

## Checklist

- [ ] ACR-9 freshness → `wire-endpoint` `/api/candidates/freshness`, map bucket→label/tone, drop sample.
- [ ] ACR-10 Metrics → `wire-endpoint` `/api/metrics`, drop `lib/metrics/sample.ts`.
- [ ] **ACR-6 throughput → migrate `throughputSchema` to `avg_review_seconds`, add a formatter,
      then `wire-endpoint` `/api/metrics/throughput?period=today`.** (The breaking one.)
- [ ] Re-point the Dashboard's throughput + freshness placeholder cards at the live reads.
- [ ] Optionally relabel the "Avg / review" copy to "time-to-decision" (see the note in §1).

import { z } from 'zod';

/**
 * Pure alerting domain (Step 5 — observability). An `AlertEvent` is the typed,
 * vendor-neutral shape the application emits at the existing silent-warn points
 * (a source's reliability falling low; the daily €-budget ceiling reached). The
 * `Alerting` port consumes it; adapters (webhook/Slack now, Datadog/CloudWatch
 * later — see docs/DealRoute_Observability.md) map it to their wire format.
 *
 * Everything here is PURE: the builders shape an event from the warn-point inputs;
 * no I/O, no clock (the caller supplies `at`). Keeping the event in the domain
 * means the use-cases never know about a vendor, and a new alert kind is a new
 * builder + an enum entry, never a change to an adapter (OCP).
 */

/** What an alert is about. Add a kind here + a builder below; adapters need no change. */
export const AlertKind = z.enum(['source_reliability_low', 'daily_budget_reached']);
export type AlertKind = z.infer<typeof AlertKind>;

/**
 * Severity, so an adapter can route/colour by it (e.g. Slack colour, PagerDuty
 * urgency). `warning` = a human should look soon; `critical` = act now. v1 uses
 * `warning` for both wired kinds (neither is an outage), but the field is here so
 * a future kind (e.g. an outage) can be `critical` without reshaping the event.
 */
export const AlertSeverity = z.enum(['info', 'warning', 'critical']);
export type AlertSeverity = z.infer<typeof AlertSeverity>;

/**
 * The vendor-neutral alert. `dedupe_key` is a stable identity for this alert
 * occurrence (e.g. `source_reliability_low:<sourceId>`) so a future adapter or a
 * collector can group/rate-limit repeats without the domain knowing how. `context`
 * is structured detail for the adapter to render; it must NOT carry secrets or raw
 * scraped/LLM data (the warn-point callers only put ids/urls/numbers in it).
 */
export const AlertEventSchema = z.object({
  kind: AlertKind,
  severity: AlertSeverity,
  /** Short human title, e.g. "Source reliability low". */
  title: z.string().min(1),
  /** One-line human summary with the salient numbers. */
  summary: z.string().min(1),
  /** Stable identity for this occurrence — for grouping/rate-limiting downstream. */
  dedupe_key: z.string().min(1),
  /** ISO-8601 time the condition was observed (caller-supplied; keeps this pure). */
  at: z.string(),
  /** Structured, non-sensitive detail for the adapter to render. */
  context: z.record(z.unknown()),
});
export type AlertEvent = z.infer<typeof AlertEventSchema>;

/**
 * Build the alert for a source whose reliability fell below the flag threshold
 * (the crawl + monitor `reliability low — backing off cadence` warn). Dedupe by
 * source so repeats over time collapse to one identity.
 */
export function sourceReliabilityLowAlert(input: {
  sourceId: string;
  url: string;
  reliability: number;
  nextDue: string | null;
  at: string;
}): AlertEvent {
  return {
    kind: 'source_reliability_low',
    severity: 'warning',
    title: 'Source reliability low',
    summary: `Source ${input.url} reliability fell to ${input.reliability.toFixed(2)} — backing off its crawl cadence (needs a human look).`,
    dedupe_key: `source_reliability_low:${input.sourceId}`,
    at: input.at,
    context: {
      source_id: input.sourceId,
      url: input.url,
      reliability: input.reliability,
      next_due: input.nextDue,
    },
  };
}

/**
 * Build the alert for the aggregate daily €-budget ceiling being reached (the
 * `DailyBudgetGuard` `daily budget reached — stopping batch` warn). Dedupe by the
 * UTC day so one alert fires per day the ceiling is hit, not per stopped run.
 */
export function dailyBudgetReachedAlert(input: {
  ceilingEur: number;
  spentTodayEur: number;
  at: string;
}): AlertEvent {
  const day = input.at.slice(0, 10); // YYYY-MM-DD (UTC; `at` is ISO-Z)
  return {
    kind: 'daily_budget_reached',
    severity: 'warning',
    title: 'Daily budget reached',
    summary: `Daily agentic budget of €${input.ceilingEur.toFixed(2)} reached (spent €${input.spentTodayEur.toFixed(2)} today) — discovery is stopping for the rest of the UTC day.`,
    dedupe_key: `daily_budget_reached:${day}`,
    at: input.at,
    context: {
      ceiling_eur: input.ceilingEur,
      spent_today_eur: input.spentTodayEur,
      utc_day: day,
    },
  };
}

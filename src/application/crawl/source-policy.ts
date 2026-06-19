/**
 * Pure source-cadence + reliability policy. Kept separate from the I/O-bound
 * crawl use-case so it is unit-testable in isolation.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Reliability nudge per crawl: successes raise it, failures lower it, clamped. */
const SUCCESS_DELTA = 0.05;
const FAILURE_DELTA = 0.2;

/** Repeated failures should flag a source; below this it warrants human attention. */
export const RELIABILITY_FLAG_THRESHOLD = 0.3;

/**
 * Reliability back-off (plan §7: "reliability score decides cadence and trust").
 * A flaky source should be re-crawled LESS often than its nominal `cadence_days`
 * so we stop hammering an unreliable origin and stop wasting budget on it.
 *
 * Linear inverse-reliability: the cadence multiplier grows as reliability falls.
 *   multiplier = clamp(1 + (1 - reliability) * SLOPE, 1, MAX)
 * A perfectly reliable source (1.0) stays on its base cadence (1x); a fully
 * unreliable one (0.0) is capped at MAX. The curve is smooth and predictable so
 * ops can reason about when a given source will next be due.
 */
const BACKOFF_SLOPE = 4;
/** A back-off never stretches cadence beyond this many times the base. */
export const MAX_BACKOFF_MULTIPLIER = 5;

export function reliabilityAfter(current: number, success: boolean): number {
  const next = success ? current + SUCCESS_DELTA : current - FAILURE_DELTA;
  return clamp01(next);
}

/**
 * Cadence multiplier for a reliability score in [0,1]. 1x when healthy, growing
 * linearly as reliability falls, clamped to `MAX_BACKOFF_MULTIPLIER`. Pure and
 * rounded so `next_due` lands on whole-day boundaries.
 */
export function backoffMultiplier(reliability: number): number {
  const r = clamp01(reliability);
  const raw = 1 + (1 - r) * BACKOFF_SLOPE;
  return Math.min(MAX_BACKOFF_MULTIPLIER, Math.round(raw));
}

/** Effective cadence for a source: base cadence stretched by the back-off curve. */
export function effectiveCadenceDays(cadenceDays: number, reliability: number): number {
  return cadenceDays * backoffMultiplier(reliability);
}

/** ISO-8601 timestamp `cadenceDays` after `from`. */
export function nextDueIso(from: Date, cadenceDays: number): string {
  return new Date(from.getTime() + cadenceDays * MS_PER_DAY).toISOString();
}

/**
 * Reliability-aware `next_due`: applies the back-off curve so a low-reliability
 * source is scheduled further out than a healthy one on the same base cadence.
 */
export function nextDueWithBackoffIso(
  from: Date,
  cadenceDays: number,
  reliability: number,
): string {
  return nextDueIso(from, effectiveCadenceDays(cadenceDays, reliability));
}

export function isReliabilityLow(score: number): boolean {
  return score < RELIABILITY_FLAG_THRESHOLD;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

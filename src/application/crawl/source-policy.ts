/**
 * Pure source-cadence + reliability policy. Kept separate from the I/O-bound
 * crawl use-case so it is unit-testable in isolation.
 */

import type { Source } from '../../domain/index.js';

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

/** The post-crawl source mutation + whether it now warrants a human-attention flag. */
export interface CrawlOutcomeUpdate {
  source: Source;
  /** True when the new reliability is below the flag threshold (caller logs/alerts). */
  reliabilityLow: boolean;
}

/**
 * Apply a crawl/re-verify outcome to a source's reliability + schedule — the ONE
 * place both Lane A (crawl) and monitoring derive the post-pass source state, so
 * the two can't drift on the reliability/back-off policy (plan §7). Pure: given the
 * source, the outcome, and `now`, returns the updated source (no I/O, no clock).
 *
 *  - `success` raises reliability and refreshes `last_seen`; failure lowers it and
 *    keeps the prior `last_seen` (we did NOT see the source this pass).
 *  - `next_due` always uses the reliability-aware back-off curve, so a flaky source
 *    is scheduled further out (stops hammering an unreliable origin / wasting budget).
 *  - on `success`, the post-redirect `resolvedUrl` (the fetch's `finalUrl`) is pinned
 *    onto `resolved_url` so MONITOR can match its source-scoped lookups on the same
 *    URL that deals are keyed by (`source_url = finalUrl`). Only set on success (a failed
 *    pass saw no final URL) and only when supplied; otherwise the prior value stands.
 *
 * NB a `blocked` page (login/captcha/anti-bot wall) is NOT a reliability failure —
 * it's a manual-capture route (plan §9). Callers pass it through as a non-mutating
 * schedule advance, not as `success:false`.
 */
export function applyCrawlOutcome(
  source: Source,
  success: boolean,
  now: Date,
  resolvedUrl?: string,
): CrawlOutcomeUpdate {
  const reliability = reliabilityAfter(source.reliability_score, success);
  return {
    source: {
      ...source,
      reliability_score: reliability,
      last_seen: success ? now.toISOString() : source.last_seen,
      next_due: nextDueWithBackoffIso(now, source.cadence_days, reliability),
      // Pin the resolved (post-redirect) URL on a successful pass so monitor's
      // expiry/baseline lookups match the URL deals are keyed by. A failed pass
      // (or no resolvedUrl supplied) leaves the prior value untouched.
      resolved_url: success && resolvedUrl !== undefined ? resolvedUrl : source.resolved_url,
    },
    reliabilityLow: isReliabilityLow(reliability),
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

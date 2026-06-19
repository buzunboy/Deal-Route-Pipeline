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

export function reliabilityAfter(current: number, success: boolean): number {
  const next = success ? current + SUCCESS_DELTA : current - FAILURE_DELTA;
  return clamp01(next);
}

/** ISO-8601 timestamp `cadenceDays` after `from`. */
export function nextDueIso(from: Date, cadenceDays: number): string {
  return new Date(from.getTime() + cadenceDays * MS_PER_DAY).toISOString();
}

export function isReliabilityLow(score: number): boolean {
  return score < RELIABILITY_FLAG_THRESHOLD;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

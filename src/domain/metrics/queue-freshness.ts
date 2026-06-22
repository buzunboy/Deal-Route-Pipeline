import { z } from 'zod';

/**
 * Queue-freshness age distribution (ACR-9) — the pending review queue bucketed by
 * how long each candidate has been waiting. Backs `GET /api/candidates/freshness`
 * and the Dashboard's dark "Queue freshness" card.
 *
 * "Age" is `now − evidence.captured_at`: the wall-clock time since the offer was
 * captured (an owner decision — the pipeline has no separate "entered queue"
 * timestamp, so capture time is the honest age signal; it is dominated by queue
 * wait, which is exactly what the card communicates). A pending deal whose evidence
 * is missing a capture time can't be aged and is excluded from the denominator.
 *
 * PURE: the use-case loads the captured-at timestamps of the pending queue and
 * passes them here with the current instant; this module owns the bucket boundaries
 * and the percentage rounding so both reads agree. No I/O.
 */

/** The three age bands the panel renders, in display order (freshest first). */
export const FRESHNESS_BUCKETS = ['<24h', '1-3d', '>3d'] as const;
export type FreshnessBucket = (typeof FRESHNESS_BUCKETS)[number];

/** One band: its label + the share (0..100, integer) of the pending queue in it. */
export const FreshnessBandSchema = z.object({
  bucket: z.enum(FRESHNESS_BUCKETS),
  percent: z.number().int().min(0).max(100),
});
export type FreshnessBand = z.infer<typeof FreshnessBandSchema>;

/** Hours that separate `<24h` from `1-3d` (a deal exactly 24h old is `1-3d`). */
const ONE_DAY_HOURS = 24;
/** Hours that separate `1-3d` from `>3d` (a deal exactly 72h old is `>3d`). */
const THREE_DAYS_HOURS = 72;
const MS_PER_HOUR = 60 * 60 * 1000;

/** Classify one candidate's age in hours into its freshness band. */
export function bucketForAgeHours(ageHours: number): FreshnessBucket {
  if (ageHours < ONE_DAY_HOURS) return '<24h';
  if (ageHours < THREE_DAYS_HOURS) return '1-3d';
  return '>3d';
}

/**
 * Build the three-band freshness distribution from the pending queue's capture
 * timestamps and the current instant. Each age is `now − capturedAt` (negative ages
 * — a clock skew where capture is in the future — clamp to band `<24h`, never drop a
 * pending deal from the denominator). The three percentages are rounded so they sum
 * to exactly 100 (largest-remainder), so the card's bars never over/under-fill.
 *
 * An EMPTY queue returns all three bands at 0% (not an empty array) — the card always
 * renders its three labelled bars.
 */
export function buildFreshness(capturedAts: readonly Date[], now: Date): FreshnessBand[] {
  const counts: Record<FreshnessBucket, number> = { '<24h': 0, '1-3d': 0, '>3d': 0 };
  for (const capturedAt of capturedAts) {
    const ageHours = (now.getTime() - capturedAt.getTime()) / MS_PER_HOUR;
    counts[bucketForAgeHours(ageHours)]++;
  }
  const total = capturedAts.length;
  const percents = largestRemainderPercents(
    FRESHNESS_BUCKETS.map((b) => counts[b]),
    total,
  );
  return FRESHNESS_BUCKETS.map((bucket, i) => ({ bucket, percent: percents[i]! }));
}

/**
 * Convert raw counts into integer percentages summing to exactly 100 via the
 * largest-remainder method (floor each share, then hand the leftover points to the
 * buckets with the largest fractional parts). A zero total returns all zeros. Shared
 * here so the freshness + confidence distributions round identically.
 */
export function largestRemainderPercents(counts: readonly number[], total: number): number[] {
  if (total <= 0) return counts.map(() => 0);
  const exact = counts.map((c) => (c / total) * 100);
  const floors = exact.map((x) => Math.floor(x));
  let remaining = 100 - floors.reduce((a, b) => a + b, 0);
  // Distribute the remaining points to the largest fractional remainders, breaking
  // ties by index (lowest index first) so the result is deterministic.
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const result = [...floors];
  for (const { i } of order) {
    if (remaining <= 0) break;
    result[i]!++;
    remaining--;
  }
  return result;
}

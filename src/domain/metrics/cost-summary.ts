import { z } from 'zod';

/**
 * Aggregated, boundary-validated view of logged crawl-run cost
 * (`crawl_runs.cost_eur`). Produced by `CrawlRunRepository.costSummary` and
 * surfaced by the `stats` CLI. Pure domain shape — no vendor SDK.
 *
 * ## Rounding convention (must agree across adapters bit-for-bit)
 * `cost_eur` is a `doublePrecision` float, and IEEE-754 float addition is
 * ORDER-DEPENDENT — the in-memory adapter folds in Map order, Postgres `SUM()`
 * folds in scan/hash-aggregation order, and those orders are not the same. If we
 * summed the raw floats and rounded once, an un-rounded total landing within a
 * float-epsilon of an `x.xx5` half-cent boundary could round to DIFFERENT cents
 * per adapter for the SAME rows (e.g. {0.005, 0.01, 0.02} sums to 0.035 or
 * 0.034999999999999996 → €0.04 vs €0.03). That breaks the design goal that float
 * noise can't make the adapters disagree.
 *
 * So both adapters quantise each row to an EXACT integer number of micro-euros
 * (`EUR_MICRO_SCALE` = 1e6, i.e. 6 dp — far finer than a cent, so sub-cent
 * per-run token costs are NOT lost the way per-row cent rounding would lose
 * them), then sum those integers. Integer addition is exact and associative, so
 * the micro-euro total is byte-identical regardless of fold order. `roundEur`
 * (half-up to cents) is then applied ONCE per bucket to `micros / EUR_MICRO_SCALE`.
 * Because the input to that final round is the SAME exact value in both adapters,
 * it can never straddle a half-cent boundary differently. `run_count` is an
 * integer count and is never rounded.
 *
 * Per-row quantisation is byte-identical across adapters: in JS
 * `Math.round(cost_eur * EUR_MICRO_SCALE)`; in SQL
 * `round((cost_eur * 1000000)::numeric)`. The multiplication is IEEE-754 double
 * in BOTH (the SQL operand is `doublePrecision`), yielding the same product; both
 * then round that value half-up (`Math.round` and numeric `round()` both round
 * half-away-from-zero, which for non-negative costs is half-up). The micro sum
 * itself is exact integer (numeric `SUM` in SQL, integer accumulator in JS).
 *
 * ## Window semantics (half-open)
 * `costSummary({ since, until })` filters on `started_at`: `since` is INCLUSIVE
 * (`started_at >= since`) and `until` is EXCLUSIVE (`started_at < until`). A run
 * whose `started_at` equals `until` is EXCLUDED; one equal to `since` is
 * INCLUDED. Both bounds are optional and independent. Half-open ranges compose
 * across adjacent windows without double-counting.
 *
 * ## Day buckets
 * `per_day.day` is the UTC calendar day of `started_at` as `YYYY-MM-DD`
 * (in-memory: `new Date(started_at).toISOString().slice(0,10)`; Postgres:
 * `to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD')` — identical strings).
 *
 * ## Sort order
 * `per_day` ascending by `day` (chronological). `per_source` descending by
 * `cost_eur`, then ascending by `source_id` as a deterministic tiebreaker (the
 * tiebreak is computed on the already-rounded cost in both adapters).
 */
/**
 * `per_source` bucket key for runs with no `source_id` (Lane-B discover/ingest
 * crawl arbitrary URLs that have no `sources` row). Both adapters MUST fold such
 * runs under this exact sentinel so the per-source breakdown — and its
 * deterministic sort tiebreaker — is byte-identical across adapters (LSP). It is
 * not a UUID, so it can never collide with a real `source_id`.
 */
export const SOURCELESS_RUN_BUCKET = '(sourceless)';

export const CostSummarySchema = z.object({
  total_eur: z.number().nonnegative(),
  run_count: z.number().int().nonnegative(),
  per_day: z.array(
    z.object({
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      cost_eur: z.number().nonnegative(),
      run_count: z.number().int().nonnegative(),
    }),
  ),
  per_source: z.array(
    z.object({
      source_id: z.string(),
      cost_eur: z.number().nonnegative(),
      run_count: z.number().int().nonnegative(),
    }),
  ),
});
export type CostSummary = z.infer<typeof CostSummarySchema>;

/**
 * Integer sub-unit each `cost_eur` row is quantised to BEFORE summing, so the
 * cross-adapter sum is exact and order-independent (see the rounding-convention
 * note above). 1e6 = micro-euros (6 dp): finer than a cent, so sub-cent per-run
 * costs survive aggregation, while still being an exact integer to sum.
 */
export const EUR_MICRO_SCALE = 1_000_000;

/**
 * Quantise one raw `cost_eur` float to an exact integer number of micro-euros,
 * half-up. Both DB adapters apply this per row before summing. The SQL mirror is
 * `round((cost_eur * 1000000)::numeric)`; the IEEE-754 double multiplication and
 * the half-up rounding are identical, so the integer is byte-for-byte the same.
 */
export function toEurMicros(costEur: number): number {
  return Math.round(costEur * EUR_MICRO_SCALE);
}

/**
 * Collapse an exact micro-euro integer sum to EUR rounded to cents (half-up).
 * The ONE place the final cents rounding lives; both DB adapters call it on the
 * SAME micro-euro total, so an identical input set yields an identical
 * CostSummary regardless of adapter. Costs are non-negative, so half-up vs
 * half-away-from-zero is moot.
 */
export function eurFromMicros(micros: number): number {
  return roundEur(micros / EUR_MICRO_SCALE);
}

/**
 * Round a EUR amount to cents, half-up. Costs are non-negative, so half-up vs
 * half-away-from-zero is moot.
 */
export function roundEur(n: number): number {
  return Math.round(n * 100) / 100;
}

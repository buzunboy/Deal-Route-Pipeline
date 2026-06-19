import type { Price } from '../deal-record/index.js';

/** Months per year — named to avoid a magic number in the normalisation. */
const MONTHS_PER_YEAR = 12;

/**
 * Normalise a price to a comparable monthly cost (the figure we rank on).
 *
 * Pure and deterministic. Annual prices are divided across 12 months; one-time
 * prices are treated as a single up-front cost with no monthly amortisation in
 * v1 (we surface them as-is rather than guessing a contract length — guessing
 * would be a trust violation). `unknown` billing returns the raw amount so the
 * value is never silently dropped; validation flags `unknown` billing for review.
 *
 * Rounded to whole cents to avoid floating-point noise in comparisons.
 */
export function trueCostMonthly(price: Price): number {
  const { amount, billing } = price;
  switch (billing) {
    case 'monthly':
      return roundCents(amount);
    case 'annual':
      return roundCents(amount / MONTHS_PER_YEAR);
    case 'one_time':
    case 'unknown':
      return roundCents(amount);
    default: {
      // Exhaustiveness guard: a new billing enum value must be handled here.
      const _never: never = billing;
      throw new Error(`Unhandled billing type: ${String(_never)}`);
    }
  }
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

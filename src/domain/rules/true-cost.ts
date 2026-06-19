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
 * IMPORTANT (intro/promo pricing): this normalises only the *headline* price.
 * A deal that is "0 € for 6 months, then 15 €/mo" is extracted with
 * `price.amount = 0`, so this returns 0 — the steady-state 15 €/mo lives in an
 * `intro_period` condition, not in `price`. We deliberately do NOT guess the
 * post-intro figure here (that would be invention). Instead `validateRecord`
 * forces such deals to must-review (`promo_pricing_needs_review`), so a human
 * confirms the real cost before it can rank as "free". See `validate-record.ts`.
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

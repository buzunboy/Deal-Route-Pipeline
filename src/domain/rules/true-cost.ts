import type { Price } from '../deal-record/index.js';

/** Months per year — named to avoid a magic number in the normalisation. */
const MONTHS_PER_YEAR = 12;

/**
 * Normalise a price to a comparable monthly cost (the figure we rank on).
 *
 * Pure and deterministic. Annual prices are divided across 12 months. A `prepaid`
 * price (a single up-front amount covering a fixed, page-stated term) is amortised
 * over its `prepaid_months` — this is NOT a guess: the term is extracted from the
 * page. A `prepaid` price with no `prepaid_months` can't be normalised, so we
 * return the raw amount and let validation force review (never invent a length).
 * `one_time` prices are a single up-front cost with no monthly amortisation (a
 * genuine one-off; guessing a length would be a trust violation). `unknown`
 * billing returns the raw amount so the value is never silently dropped;
 * validation flags `unknown`/term-less `prepaid` billing for review.
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
    case 'prepaid':
      // Amortise over the page-stated term when we have it; otherwise we can't
      // normalise without inventing a length, so surface the raw amount and let
      // validateRecord force must-review (`prepaid_term_needed`).
      return price.prepaid_months !== undefined && price.prepaid_months > 0
        ? roundCents(amount / price.prepaid_months)
        : roundCents(amount);
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

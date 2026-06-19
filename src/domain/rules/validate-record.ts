import type { LlmExtractedDeal } from '../deal-record/index.js';
import { KEY_GROUNDED_FIELDS } from './confidence.js';
import { trueCostMonthly } from './true-cost.js';

/**
 * Vocabulary key signalling a discounted introductory period (see
 * `seed-vocabulary.ts`). When present, the headline price understates the
 * steady-state cost, so the normalised `true_cost_monthly` cannot be trusted
 * for ranking without a human confirming the post-intro figure.
 */
const INTRO_PERIOD_KEY = 'intro_period';

/** A single sanity-rule failure. Non-fatal: it downgrades to must-review. */
export interface RuleFailure {
  rule: string;
  message: string;
  field?: string;
}

export interface ValidationResult {
  failures: RuleFailure[];
  /** Convenience: failures.length === 0. */
  ok: boolean;
}

/** Plausible monthly price band for a consumer subscription in EUR (sanity only). */
const MAX_PLAUSIBLE_MONTHLY_EUR = 1000;

/**
 * Deterministic sanity validation applied AFTER schema parsing and BEFORE the
 * candidate is queued. It never throws and never drops the record — each failure
 * is collected; failures downgrade confidence and force human review
 * (`.claude/rules/extraction-and-schema.md`: low confidence / failed rules →
 * must-review, never auto-publish).
 *
 * `sourceText` (when provided) is the cleaned page text; grounding quotes are
 * checked to be genuine substrings of it — the primary hallucination guard.
 */
export function validateRecord(deal: LlmExtractedDeal, sourceText?: string): ValidationResult {
  const failures: RuleFailure[] = [];

  // ── Currency vs country (DE ⇒ EUR). The schema already constrains the enums,
  //    but this guards against a future widening that forgets the pairing.
  if (deal.country === 'DE' && deal.price.currency !== 'EUR') {
    failures.push({
      rule: 'currency_matches_country',
      field: 'price.currency',
      message: `DE deals must be priced in EUR, got ${deal.price.currency}.`,
    });
  }

  // ── Price sanity band, checked on the NORMALISED monthly cost (so an annual
  //    1200 €/yr = 100 €/mo deal is judged on the same basis as a monthly one).
  const monthly = trueCostMonthly(deal.price);
  if (monthly < 0 || monthly > MAX_PLAUSIBLE_MONTHLY_EUR) {
    failures.push({
      rule: 'price_within_band',
      field: 'price.amount',
      message: `Normalised cost ${monthly}/mo is outside the plausible band (0–${MAX_PLAUSIBLE_MONTHLY_EUR}).`,
    });
  }

  // ── Unknown billing is allowed but always reviewed (we can't normalise cost).
  if (deal.price.billing === 'unknown') {
    failures.push({
      rule: 'billing_known',
      field: 'price.billing',
      message: 'Billing period is unknown; true cost cannot be normalised.',
    });
  }

  // ── Promo / intro pricing: the headline price understates the steady-state
  //    cost, so true_cost_monthly is misleading (a "0 € for 6 months" deal
  //    normalises to 0 and would rank as permanently free). Force must-review so
  //    a human confirms the real post-intro cost before it can rank/publish.
  validatePromoPricing(deal, failures);

  // ── Validity dates parse and are ordered.
  validateDates(deal, failures);

  // ── Grounding: every key field has a quote, and every quote is real.
  validateGrounding(deal, sourceText, failures);

  return { failures, ok: failures.length === 0 };
}

function validatePromoPricing(deal: LlmExtractedDeal, failures: RuleFailure[]): void {
  const hasIntroCondition = [...deal.eligibility.conditions, ...deal.validity.conditions].some(
    (c) => c.key === INTRO_PERIOD_KEY,
  );
  if (deal.route_type === 'promo' || hasIntroCondition) {
    failures.push({
      rule: 'promo_pricing_needs_review',
      field: 'true_cost_monthly',
      message:
        'Promo/introductory pricing detected: the headline price may understate the steady-state cost. ' +
        'A human must confirm the true monthly cost before this deal can rank or publish.',
    });
  }
}

function validateDates(deal: LlmExtractedDeal, failures: RuleFailure[]): void {
  const start = parseDate(deal.validity.start);
  const end = parseDate(deal.validity.end);

  if (deal.validity.start !== null && start === null) {
    failures.push({
      rule: 'valid_dates',
      field: 'validity.start',
      message: `Unparseable start date: ${deal.validity.start}.`,
    });
  }
  if (deal.validity.end !== null && end === null) {
    failures.push({
      rule: 'valid_dates',
      field: 'validity.end',
      message: `Unparseable end date: ${deal.validity.end}.`,
    });
  }
  if (start !== null && end !== null && start > end) {
    failures.push({
      rule: 'valid_date_order',
      field: 'validity',
      message: `Validity start (${deal.validity.start}) is after end (${deal.validity.end}).`,
    });
  }
}

function validateGrounding(
  deal: LlmExtractedDeal,
  sourceText: string | undefined,
  failures: RuleFailure[],
): void {
  const groundedTopLevel = new Set(deal.grounding.map((g) => g.field.split('.')[0]));
  for (const field of KEY_GROUNDED_FIELDS) {
    if (!groundedTopLevel.has(field)) {
      failures.push({
        rule: 'grounding_present',
        field,
        message: `Key field "${field}" has no grounding quote.`,
      });
    }
  }

  if (sourceText === undefined) {
    // The quote-in-source check is the primary hallucination guard. If a caller
    // validates without the page text we can't run it — fail closed (force
    // review) rather than letting an ungrounded record pass as ok.
    failures.push({
      rule: 'grounding_not_verifiable',
      message:
        'Source text was not provided; grounding quotes could not be verified against the page.',
    });
    return;
  }

  const haystack = normalizeForMatch(sourceText);
  for (const g of deal.grounding) {
    const needle = normalizeForMatch(g.quote);
    if (needle.length > 0 && !haystack.includes(needle)) {
      failures.push({
        rule: 'grounding_quote_in_source',
        field: g.field,
        message: `Grounding quote for "${g.field}" not found in source text (possible hallucination).`,
      });
    }
  }
}

/** ISO-8601 date (YYYY-MM-DD) or full datetime — what we promise validity dates are. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T.*)?$/;

/**
 * Parse a strict-ISO date string to epoch ms, or null if it isn't ISO-8601 or
 * isn't a real date. We reject `Date.parse`-lenient forms (bare years, locale
 * strings) so "valid dates" actually means valid ISO dates, not just parseable.
 */
function parseDate(value: string | null): number | null {
  if (value === null) return null;
  if (!ISO_DATE_RE.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Whitespace-insensitive, case-insensitive match form for quote checking. */
function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

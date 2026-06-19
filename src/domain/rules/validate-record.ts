import type { LlmExtractedDeal } from '../deal-record/index.js';
import { KEY_GROUNDED_FIELDS } from './confidence.js';

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

  // ── Price sanity band.
  if (deal.price.amount > MAX_PLAUSIBLE_MONTHLY_EUR) {
    failures.push({
      rule: 'price_within_band',
      field: 'price.amount',
      message: `Price ${deal.price.amount} exceeds plausible band (${MAX_PLAUSIBLE_MONTHLY_EUR}).`,
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

  // ── Validity dates parse and are ordered.
  validateDates(deal, failures);

  // ── Grounding: every key field has a quote, and every quote is real.
  validateGrounding(deal, sourceText, failures);

  return { failures, ok: failures.length === 0 };
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

  if (sourceText !== undefined) {
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
}

/** Parse an ISO date string to epoch ms, or null if invalid. */
function parseDate(value: string | null): number | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Whitespace-insensitive, case-insensitive match form for quote checking. */
function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

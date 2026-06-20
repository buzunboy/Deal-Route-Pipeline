import { describe, it, expect } from 'vitest';
import { validateRecord } from './validate-record.js';
import { makeLlmDeal } from '../../../test/factories/deal.js';

const SOURCE_TEXT =
  'Disney+ ist im Tarif MagentaTV SmartStream enthalten. Das Angebot gilt ab 01.01.2026.';

describe('validateRecord — sanity rules', () => {
  it('passes a clean, fully-grounded deal', () => {
    const deal = makeLlmDeal();
    const result = validateRecord(deal, SOURCE_TEXT);
    expect(result.ok).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it('flags an implausibly high price', () => {
    const deal = makeLlmDeal({ price: { amount: 5000, currency: 'EUR', billing: 'monthly' } });
    const result = validateRecord(deal, SOURCE_TEXT);
    expect(result.failures.some((f) => f.rule === 'price_within_band')).toBe(true);
  });

  it('flags unknown billing (cannot normalise cost)', () => {
    const deal = makeLlmDeal({ price: { amount: 5, currency: 'EUR', billing: 'unknown' } });
    const result = validateRecord(deal, SOURCE_TEXT);
    expect(result.failures.some((f) => f.rule === 'billing_known')).toBe(true);
  });

  it('flags a prepaid price with no stated term (cannot amortise without guessing)', () => {
    const deal = makeLlmDeal({ price: { amount: 49.19, currency: 'EUR', billing: 'prepaid' } });
    const result = validateRecord(deal, SOURCE_TEXT);
    expect(result.failures.some((f) => f.rule === 'prepaid_term_needed')).toBe(true);
  });

  it('does NOT flag a prepaid price WITH a stated term (amortises cleanly)', () => {
    const deal = makeLlmDeal({
      price: { amount: 49.19, currency: 'EUR', billing: 'prepaid', prepaid_months: 24 },
    });
    const result = validateRecord(deal, SOURCE_TEXT);
    expect(result.failures.some((f) => f.rule === 'prepaid_term_needed')).toBe(false);
  });

  it('flags a start date after the end date', () => {
    const deal = makeLlmDeal({
      validity: { start: '2026-12-01', end: '2026-01-01', recheck_days: 3, conditions: [] },
    });
    const result = validateRecord(deal, SOURCE_TEXT);
    expect(result.failures.some((f) => f.rule === 'valid_date_order')).toBe(true);
  });

  it('flags an unparseable date', () => {
    const deal = makeLlmDeal({
      validity: { start: 'someday soon', end: null, recheck_days: 3, conditions: [] },
    });
    const result = validateRecord(deal, SOURCE_TEXT);
    expect(result.failures.some((f) => f.rule === 'valid_dates')).toBe(true);
  });
});

describe('validateRecord — grounding (hallucination guard)', () => {
  it('flags a missing grounding quote on a key field', () => {
    const deal = makeLlmDeal({ grounding: [{ field: 'price', quote: SOURCE_TEXT }] });
    const result = validateRecord(deal, SOURCE_TEXT);
    const missing = result.failures.filter((f) => f.rule === 'grounding_present');
    expect(missing.map((f) => f.field).sort()).toEqual(['eligibility', 'validity']);
  });

  it('flags a grounding quote that does NOT appear in the source (hallucination)', () => {
    const deal = makeLlmDeal({
      grounding: [
        { field: 'price', quote: 'Netflix is completely free forever, no strings attached.' },
        { field: 'eligibility', quote: SOURCE_TEXT },
        { field: 'validity', quote: SOURCE_TEXT },
      ],
    });
    const result = validateRecord(deal, SOURCE_TEXT);
    expect(result.failures.some((f) => f.rule === 'grounding_quote_in_source')).toBe(true);
  });

  it('accepts a real quote regardless of whitespace/case differences', () => {
    const deal = makeLlmDeal({
      grounding: [
        { field: 'price', quote: '  DISNEY+ ist im   Tarif MagentaTV SmartStream enthalten. ' },
        { field: 'eligibility', quote: SOURCE_TEXT },
        { field: 'validity', quote: SOURCE_TEXT },
      ],
    });
    const result = validateRecord(deal, SOURCE_TEXT);
    expect(result.failures.some((f) => f.rule === 'grounding_quote_in_source')).toBe(false);
  });

  it('fails closed when no source text is supplied (guard cannot run → review)', () => {
    const deal = makeLlmDeal();
    const result = validateRecord(deal); // no sourceText
    // The substring check itself can't run without the page text…
    expect(result.failures.some((f) => f.rule === 'grounding_quote_in_source')).toBe(false);
    // …so we fail closed: the record is not ok and is forced to review.
    expect(result.failures.some((f) => f.rule === 'grounding_not_verifiable')).toBe(true);
    expect(result.ok).toBe(false);
  });
});

describe('validateRecord — promo/intro pricing (true-cost trust guard)', () => {
  it('forces review when route_type is promo', () => {
    const deal = makeLlmDeal({ route_type: 'promo' });
    const result = validateRecord(deal, SOURCE_TEXT);
    expect(result.failures.some((f) => f.rule === 'promo_pricing_needs_review')).toBe(true);
  });

  it('forces review when an intro_period condition is present', () => {
    const base = makeLlmDeal();
    const deal = {
      ...base,
      eligibility: {
        ...base.eligibility,
        conditions: [
          {
            key: 'intro_period',
            label: 'Discounted introductory period',
            value: { months: 6 },
            source_quote: '6 Monate gratis, danach 15 €/Monat.',
          },
        ],
      },
    };
    const result = validateRecord(deal, SOURCE_TEXT);
    expect(result.failures.some((f) => f.rule === 'promo_pricing_needs_review')).toBe(true);
  });

  it('does not flag promo pricing on a normal bundle with no intro condition', () => {
    const result = validateRecord(makeLlmDeal(), SOURCE_TEXT);
    expect(result.failures.some((f) => f.rule === 'promo_pricing_needs_review')).toBe(false);
  });
});

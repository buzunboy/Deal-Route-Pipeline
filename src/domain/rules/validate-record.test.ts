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

  it('skips the substring check when no source text is supplied', () => {
    const deal = makeLlmDeal();
    const result = validateRecord(deal); // no sourceText
    expect(result.failures.some((f) => f.rule === 'grounding_quote_in_source')).toBe(false);
  });
});

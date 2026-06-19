import { describe, it, expect } from 'vitest';
import { parseLlmDeals } from './parse-llm-output.js';
import { BoundaryValidationError } from './errors/index.js';
import { makeLlmDeal } from '../../test/factories/deal.js';

describe('parseLlmDeals — boundary validation', () => {
  it('parses a valid envelope with one deal', () => {
    const deals = parseLlmDeals({ deals: [makeLlmDeal()] });
    expect(deals).toHaveLength(1);
    expect(deals[0]?.service).toBe('Disney+');
  });

  it('accepts a JSON string', () => {
    const deals = parseLlmDeals(JSON.stringify({ deals: [makeLlmDeal()] }));
    expect(deals).toHaveLength(1);
  });

  it('accepts an empty deals array (a page may hold no offers)', () => {
    expect(parseLlmDeals({ deals: [] })).toEqual([]);
  });

  it('applies schema defaults (e.g. included_items, attributes)', () => {
    const minimal = makeLlmDeal();
    // Strip defaulted fields to prove the schema fills them.
    const { included_items: _i, attributes: _a, ...rest } = minimal;
    const deals = parseLlmDeals({ deals: [rest] });
    expect(deals[0]?.included_items).toEqual([]);
    expect(deals[0]?.attributes).toEqual({});
  });

  it('rejects invalid JSON with a typed BoundaryValidationError', () => {
    expect(() => parseLlmDeals('{ not json')).toThrow(BoundaryValidationError);
  });

  it('rejects a missing required field (service) with issue paths', () => {
    const bad = makeLlmDeal();
    // @ts-expect-error deliberately removing a required field
    delete bad.service;
    try {
      parseLlmDeals({ deals: [bad] });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BoundaryValidationError);
      const issues = (err as BoundaryValidationError).issues;
      expect(issues.some((i) => i.path.includes('service'))).toBe(true);
    }
  });

  it('rejects an out-of-range confidence', () => {
    expect(() => parseLlmDeals({ deals: [makeLlmDeal({ confidence: 1.5 })] })).toThrow(
      BoundaryValidationError,
    );
  });

  it('rejects an unknown route_type (no invented enum values)', () => {
    const bad = { ...makeLlmDeal(), route_type: 'mystery' };
    expect(() => parseLlmDeals({ deals: [bad] })).toThrow(BoundaryValidationError);
  });

  it('rejects a non-EUR currency for v1', () => {
    const bad = { ...makeLlmDeal(), price: { amount: 5, currency: 'USD', billing: 'monthly' } };
    expect(() => parseLlmDeals({ deals: [bad] })).toThrow(BoundaryValidationError);
  });
});

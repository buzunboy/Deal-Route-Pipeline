import { describe, it, expect } from 'vitest';
import { mapConditions, normalizeKey } from './vocab-mapping.js';
import { SEED_VOCABULARY } from './seed-vocabulary.js';
import { OTHER_CONDITION_KEY, type Condition } from '../deal-record/condition.js';

function cond(key: string, label = 'lbl', quote = 'some source quote'): Condition {
  return { key, label, source_quote: quote };
}

describe('normalizeKey', () => {
  it('lowercases and underscores', () => {
    expect(normalizeKey('Requires Other-Product!')).toBe('requires_other_product');
  });
});

describe('mapConditions', () => {
  it('maps a known key to its canonical label', () => {
    const result = mapConditions([cond('requires_other_product', 'raw label')], SEED_VOCABULARY);
    expect(result.conditions[0]?.key).toBe('requires_other_product');
    expect(result.conditions[0]?.label).toBe('Requires another product/subscription');
    expect(result.unmappedConditions).toBe(false);
    expect(result.fieldProposals).toHaveLength(0);
  });

  it('maps via an alias', () => {
    const result = mapConditions([cond('neukunden')], SEED_VOCABULARY);
    expect(result.conditions[0]?.key).toBe('new_customer_only');
    expect(result.unmappedConditions).toBe(false);
  });

  it('marks unknown conditions as "other" and emits a proposal (never invents a column)', () => {
    const result = mapConditions(
      [cond('requires_firstborn_child', 'Firstborn required', 'You must pledge your firstborn.')],
      SEED_VOCABULARY,
    );
    expect(result.conditions[0]?.key).toBe(OTHER_CONDITION_KEY);
    expect(result.unmappedConditions).toBe(true);
    expect(result.fieldProposals).toHaveLength(1);
    expect(result.fieldProposals[0]?.suggested_key).toBe('requires_firstborn_child');
    expect(result.fieldProposals[0]?.example_quote).toBe('You must pledge your firstborn.');
  });

  it('preserves source_quote and value when canonicalising', () => {
    const c = { ...cond('intro_period'), value: { months: 6 }, source_quote: '6 Monate gratis' };
    const result = mapConditions([c], SEED_VOCABULARY);
    expect(result.conditions[0]?.value).toEqual({ months: 6 });
    expect(result.conditions[0]?.source_quote).toBe('6 Monate gratis');
  });

  it('dedupes proposals by suggested_key', () => {
    const result = mapConditions(
      [cond('mystery_key', 'A', 'quote A'), cond('mystery_key', 'B', 'quote B')],
      SEED_VOCABULARY,
    );
    expect(result.fieldProposals).toHaveLength(1);
    expect(result.conditions).toHaveLength(2);
  });
});

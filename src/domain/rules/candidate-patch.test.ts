import { describe, it, expect } from 'vitest';
import { applyCandidatePatch, PATCHABLE_FIELDS } from './candidate-patch.js';
import { InvalidPatchError } from '../errors/index.js';
import { makeDealRecord } from '../../../test/factories/deal.js';

describe('applyCandidatePatch', () => {
  it('applies an editable field and reports it as changed', () => {
    const deal = makeDealRecord({ headline: 'old headline' });
    const { deal: next, changed } = applyCandidatePatch(deal, { headline: 'new headline' });
    expect(next.headline).toBe('new headline');
    expect(changed).toEqual(['headline']);
    // input untouched (pure)
    expect(deal.headline).toBe('old headline');
  });

  it('recomputes true_cost_monthly from price when price changes (annual → /12)', () => {
    const deal = makeDealRecord({
      price: { amount: 10, currency: 'EUR', billing: 'monthly' },
      true_cost_monthly: 10,
    });
    const { deal: next, changed } = applyCandidatePatch(deal, {
      price: { amount: 120, currency: 'EUR', billing: 'annual' },
    });
    expect(next.price.billing).toBe('annual');
    expect(next.true_cost_monthly).toBe(10); // 120 / 12
    // the recompute is reported under `price`, not double-counted as true_cost_monthly
    expect(changed).toEqual(['price']);
  });

  it('a price edit OVERRIDES an explicit true_cost_monthly in the same patch (derived wins)', () => {
    const deal = makeDealRecord();
    const { deal: next, changed } = applyCandidatePatch(deal, {
      price: { amount: 120, currency: 'EUR', billing: 'annual' },
      true_cost_monthly: 999, // ignored — price drives the derived cost
    });
    expect(next.true_cost_monthly).toBe(10);
    expect(changed).toEqual(['price']);
  });

  it('allows a manual true_cost_monthly override when price is untouched', () => {
    const deal = makeDealRecord({ true_cost_monthly: 10 });
    const { deal: next, changed } = applyCandidatePatch(deal, { true_cost_monthly: 7.5 });
    expect(next.true_cost_monthly).toBe(7.5);
    expect(changed).toEqual(['true_cost_monthly']);
  });

  it('patches nested eligibility + validity + conditions', () => {
    const deal = makeDealRecord();
    const { deal: next, changed } = applyCandidatePatch(deal, {
      eligibility: {
        new_customer_only: true,
        residency_kyc: false,
        plan_tier_required: null,
        min_spend: null,
        stackable: null,
        conditions: [
          { key: 'new_customer_only', label: 'New customers only', source_quote: 'Nur Neukunden' },
        ],
      },
      validity: { start: null, end: '2026-12-31', recheck_days: 7, conditions: [] },
    });
    expect(next.eligibility.new_customer_only).toBe(true);
    expect(next.validity.end).toBe('2026-12-31');
    expect(changed.sort()).toEqual(['eligibility', 'validity']);
  });

  it('a no-op patch (same value) reports no change', () => {
    const deal = makeDealRecord({ headline: 'same' });
    const { changed } = applyCandidatePatch(deal, { headline: 'same' });
    expect(changed).toEqual([]);
  });

  // ── Trust boundary: forbidden fields ──────────────────────────────────────
  it.each([
    ['id', { id: 'x' }],
    ['evidence_id', { evidence_id: 'x' }],
    ['source_url', { source_url: 'https://evil.example/phish' }],
    ['status', { status: 'published' }],
    ['schema_version', { schema_version: 99 }],
    ['verified_by', { verified_by: 'attacker' }],
    ['confidence', { confidence: 1 }],
    ['grounding', { grounding: [] }],
    ['human_edited', { human_edited: [] }],
  ])('rejects a patch touching the non-editable field %s', (_label, patch) => {
    const deal = makeDealRecord();
    expect(() => applyCandidatePatch(deal, patch)).toThrow(InvalidPatchError);
  });

  it('rejects a structurally invalid patch (negative price, bad enum)', () => {
    const deal = makeDealRecord();
    expect(() =>
      applyCandidatePatch(deal, { price: { amount: -5, currency: 'EUR', billing: 'monthly' } }),
    ).toThrow(InvalidPatchError);
    expect(() => applyCandidatePatch(deal, { route_type: 'not-a-route' })).toThrow(
      InvalidPatchError,
    );
    expect(() => applyCandidatePatch(deal, { country: 'US' })).toThrow(InvalidPatchError);
  });

  it('rejects a non-object patch body', () => {
    const deal = makeDealRecord();
    expect(() => applyCandidatePatch(deal, null)).toThrow(InvalidPatchError);
    expect(() => applyCandidatePatch(deal, [1, 2])).toThrow(InvalidPatchError);
    expect(() => applyCandidatePatch(deal, 'nope')).toThrow(InvalidPatchError);
  });

  it('does not mutate status, grounding, or human_edited (caller owns those)', () => {
    const deal = makeDealRecord({ status: 'candidate', human_edited: [] });
    const { deal: next } = applyCandidatePatch(deal, { headline: 'changed' });
    expect(next.status).toBe('candidate');
    expect(next.grounding).toEqual(deal.grounding);
    expect(next.human_edited).toEqual([]);
  });

  it('the allowlist matches the documented reviewer-editable set', () => {
    expect([...PATCHABLE_FIELDS].sort()).toEqual(
      [
        'attributes',
        'country',
        'eligibility',
        'headline',
        'included_items',
        'price',
        'route_type',
        'true_cost_monthly',
        'validity',
      ].sort(),
    );
  });
});

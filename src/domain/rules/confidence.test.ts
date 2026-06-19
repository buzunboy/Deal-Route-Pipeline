import { describe, it, expect } from 'vitest';
import { adjustConfidence, mustReview, MUST_REVIEW_CONFIDENCE_THRESHOLD } from './confidence.js';
import { makeLlmDeal } from '../../../test/factories/deal.js';

describe('adjustConfidence', () => {
  it('leaves a fully-grounded, rule-passing deal unchanged', () => {
    const deal = makeLlmDeal({ confidence: 0.9 });
    expect(adjustConfidence(deal, 0)).toBeCloseTo(0.9);
  });

  it('penalises per failed rule', () => {
    const deal = makeLlmDeal({ confidence: 0.9 });
    expect(adjustConfidence(deal, 2)).toBeCloseTo(0.5); // 0.9 - 2*0.2
  });

  it('penalises missing grounding on key fields', () => {
    const deal = makeLlmDeal({
      confidence: 0.9,
      grounding: [{ field: 'price', quote: 'x' }], // missing eligibility + validity
    });
    expect(adjustConfidence(deal, 0)).toBeCloseTo(0.6); // 0.9 - 2*0.15
  });

  it('never raises confidence and never goes below 0', () => {
    const deal = makeLlmDeal({ confidence: 0.1, grounding: [] });
    expect(adjustConfidence(deal, 5)).toBe(0);
  });
});

describe('mustReview', () => {
  it('forces review when confidence is at/below threshold', () => {
    expect(mustReview(MUST_REVIEW_CONFIDENCE_THRESHOLD, 0)).toBe(true);
    expect(mustReview(MUST_REVIEW_CONFIDENCE_THRESHOLD - 0.01, 0)).toBe(true);
  });

  it('forces review when any rule failed, even with high confidence', () => {
    expect(mustReview(0.99, 1)).toBe(true);
  });

  it('allows a clean, high-confidence deal past the gate', () => {
    expect(mustReview(0.95, 0)).toBe(false);
  });
});

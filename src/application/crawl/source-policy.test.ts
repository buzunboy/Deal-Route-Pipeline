import { describe, it, expect } from 'vitest';
import {
  reliabilityAfter,
  nextDueIso,
  isReliabilityLow,
  RELIABILITY_FLAG_THRESHOLD,
} from './source-policy.js';

describe('reliabilityAfter', () => {
  it('raises on success, clamped at 1', () => {
    expect(reliabilityAfter(0.5, true)).toBeCloseTo(0.55);
    expect(reliabilityAfter(0.99, true)).toBe(1);
  });
  it('lowers more sharply on failure, clamped at 0', () => {
    expect(reliabilityAfter(0.5, false)).toBeCloseTo(0.3);
    expect(reliabilityAfter(0.1, false)).toBe(0);
  });
});

describe('nextDueIso', () => {
  it('adds cadence days', () => {
    const from = new Date('2026-06-19T00:00:00.000Z');
    expect(nextDueIso(from, 3)).toBe('2026-06-22T00:00:00.000Z');
  });
});

describe('isReliabilityLow', () => {
  it('flags below the threshold', () => {
    expect(isReliabilityLow(RELIABILITY_FLAG_THRESHOLD - 0.01)).toBe(true);
    expect(isReliabilityLow(RELIABILITY_FLAG_THRESHOLD)).toBe(false);
  });
});

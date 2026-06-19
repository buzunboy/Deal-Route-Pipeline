import { describe, it, expect } from 'vitest';
import {
  reliabilityAfter,
  nextDueIso,
  nextDueWithBackoffIso,
  backoffMultiplier,
  effectiveCadenceDays,
  isReliabilityLow,
  RELIABILITY_FLAG_THRESHOLD,
  MAX_BACKOFF_MULTIPLIER,
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

describe('backoffMultiplier', () => {
  it('keeps a fully-reliable source on its base cadence (1x)', () => {
    expect(backoffMultiplier(1)).toBe(1);
  });
  it('grows the multiplier linearly as reliability falls', () => {
    // round(1 + (1 - r) * 4).
    expect(backoffMultiplier(0.9)).toBe(1); // 1.4 → 1
    expect(backoffMultiplier(0.5)).toBe(3); // 3.0 → 3
    expect(backoffMultiplier(0.3)).toBe(4); // 3.8 → 4
  });
  it('caps at MAX_BACKOFF_MULTIPLIER for a fully-unreliable source', () => {
    expect(backoffMultiplier(0)).toBe(MAX_BACKOFF_MULTIPLIER); // raw 5 → 5 (cap binds)
    expect(MAX_BACKOFF_MULTIPLIER).toBe(5);
  });
  it('clamps out-of-range reliability before computing', () => {
    expect(backoffMultiplier(1.5)).toBe(1);
    expect(backoffMultiplier(-1)).toBe(MAX_BACKOFF_MULTIPLIER);
  });
});

describe('effectiveCadenceDays', () => {
  it('is the base cadence for a healthy source', () => {
    expect(effectiveCadenceDays(3, 1)).toBe(3);
  });
  it('stretches the cadence for a flaky source', () => {
    expect(effectiveCadenceDays(3, 0.5)).toBe(9); // 3 * 3
    expect(effectiveCadenceDays(2, 0)).toBe(2 * MAX_BACKOFF_MULTIPLIER);
  });
});

describe('nextDueWithBackoffIso', () => {
  const from = new Date('2026-06-19T00:00:00.000Z');
  it('matches the flat next-due when reliability is perfect', () => {
    expect(nextDueWithBackoffIso(from, 3, 1)).toBe(nextDueIso(from, 3));
  });
  it('schedules a flaky source further out than a healthy one', () => {
    const healthy = new Date(nextDueWithBackoffIso(from, 3, 1)).getTime();
    const flaky = new Date(nextDueWithBackoffIso(from, 3, 0.2)).getTime();
    expect(flaky).toBeGreaterThan(healthy);
    // reliability 0.2 → multiplier round(1 + 0.8*4 = 4.2) = 4 → 12 days out.
    expect(nextDueWithBackoffIso(from, 3, 0.2)).toBe('2026-07-01T00:00:00.000Z');
  });
});

describe('isReliabilityLow', () => {
  it('flags below the threshold', () => {
    expect(isReliabilityLow(RELIABILITY_FLAG_THRESHOLD - 0.01)).toBe(true);
    expect(isReliabilityLow(RELIABILITY_FLAG_THRESHOLD)).toBe(false);
  });
});

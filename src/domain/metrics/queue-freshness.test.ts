import { describe, it, expect } from 'vitest';
import {
  buildFreshness,
  bucketForAgeHours,
  largestRemainderPercents,
  FreshnessBandSchema,
  FRESHNESS_BUCKETS,
} from './queue-freshness.js';

const NOW = new Date('2026-06-22T12:00:00.000Z');
const hoursAgo = (h: number): Date => new Date(NOW.getTime() - h * 60 * 60 * 1000);

describe('queue-freshness', () => {
  describe('bucketForAgeHours boundaries', () => {
    it('< 24h is fresh', () => {
      expect(bucketForAgeHours(0)).toBe('<24h');
      expect(bucketForAgeHours(23.99)).toBe('<24h');
    });
    it('exactly 24h crosses into 1-3d (inclusive lower edge)', () => {
      expect(bucketForAgeHours(24)).toBe('1-3d');
      expect(bucketForAgeHours(71.99)).toBe('1-3d');
    });
    it('exactly 72h crosses into >3d', () => {
      expect(bucketForAgeHours(72)).toBe('>3d');
      expect(bucketForAgeHours(1000)).toBe('>3d');
    });
  });

  it('distributes a queue across the three bands, percentages summing to 100', () => {
    const captured = [
      hoursAgo(1), // <24h
      hoursAgo(5), // <24h
      hoursAgo(30), // 1-3d
      hoursAgo(100), // >3d
    ];
    const bands = buildFreshness(captured, NOW);
    expect(bands).toEqual([
      { bucket: '<24h', percent: 50 },
      { bucket: '1-3d', percent: 25 },
      { bucket: '>3d', percent: 25 },
    ]);
    expect(bands.reduce((a, b) => a + b.percent, 0)).toBe(100);
    for (const b of bands) expect(FreshnessBandSchema.parse(b)).toEqual(b);
  });

  it('an empty queue returns all three bands at 0% (never an empty array)', () => {
    const bands = buildFreshness([], NOW);
    expect(bands.map((b) => b.bucket)).toEqual([...FRESHNESS_BUCKETS]);
    expect(bands.every((b) => b.percent === 0)).toBe(true);
  });

  it('clamps a future capture (clock skew) into <24h rather than dropping it', () => {
    const bands = buildFreshness([new Date(NOW.getTime() + 60_000)], NOW);
    expect(bands).toEqual([
      { bucket: '<24h', percent: 100 },
      { bucket: '1-3d', percent: 0 },
      { bucket: '>3d', percent: 0 },
    ]);
  });

  describe('largestRemainderPercents', () => {
    it('rounds thirds to sum exactly 100 (33/33/34)', () => {
      expect(largestRemainderPercents([1, 1, 1], 3)).toEqual([34, 33, 33]);
    });
    it('returns zeros for a zero total', () => {
      expect(largestRemainderPercents([0, 0, 0], 0)).toEqual([0, 0, 0]);
    });
    it('always sums to 100 for a non-empty total', () => {
      const out = largestRemainderPercents([5, 3, 1], 9);
      expect(out.reduce((a, b) => a + b, 0)).toBe(100);
    });
  });
});

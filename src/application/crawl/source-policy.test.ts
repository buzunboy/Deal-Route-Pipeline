import { describe, it, expect } from 'vitest';
import {
  reliabilityAfter,
  nextDueIso,
  nextDueWithBackoffIso,
  backoffMultiplier,
  effectiveCadenceDays,
  isReliabilityLow,
  applyCrawlOutcome,
  RELIABILITY_FLAG_THRESHOLD,
  MAX_BACKOFF_MULTIPLIER,
} from './source-policy.js';
import { makeSource } from '../../../test/factories/source.js';

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

describe('applyCrawlOutcome (shared crawl + monitor policy)', () => {
  const now = new Date('2026-06-19T00:00:00.000Z');

  it('on success: raises reliability, refreshes last_seen, backs off cadence by the new score', () => {
    const src = makeSource({ reliability_score: 0.5, cadence_days: 3, last_seen: null });
    const { source, reliabilityLow } = applyCrawlOutcome(src, true, now);
    expect(source.reliability_score).toBeCloseTo(0.55, 10);
    expect(source.last_seen).toBe(now.toISOString());
    // backoffMultiplier(0.55) = round(1 + 0.45*4 = 2.8) = 3 → 9 days.
    expect(source.next_due).toBe(nextDueWithBackoffIso(now, 3, 0.55));
    expect(reliabilityLow).toBe(false);
  });

  it('on failure: lowers reliability, KEEPS the prior last_seen (we did not see it), backs off', () => {
    const prior = '2026-06-10T00:00:00.000Z';
    const src = makeSource({ reliability_score: 0.5, cadence_days: 3, last_seen: prior });
    const { source } = applyCrawlOutcome(src, false, now);
    expect(source.reliability_score).toBeCloseTo(0.3, 10);
    expect(source.last_seen).toBe(prior); // unchanged — a failed pass is not a sighting
    expect(source.next_due).toBe(nextDueWithBackoffIso(now, 3, 0.3));
  });

  it('flags reliabilityLow once the new score is below the threshold', () => {
    const src = makeSource({ reliability_score: 0.3 }); // → 0.1 on failure (< 0.3)
    expect(applyCrawlOutcome(src, false, now).reliabilityLow).toBe(true);
  });

  it('does not mutate the input source (pure)', () => {
    const src = makeSource({ reliability_score: 0.5 });
    const before = { ...src };
    applyCrawlOutcome(src, false, now);
    expect(src).toEqual(before);
  });

  // Prereq A: pin the post-redirect resolved_url on a successful pass so monitor
  // can match deals by the URL they're keyed by (source_url = finalUrl).
  it('on success: pins the supplied resolvedUrl onto resolved_url', () => {
    const src = makeSource({ url: 'https://telekom.de/x', resolved_url: null });
    const { source } = applyCrawlOutcome(src, true, now, 'https://www.telekom.de/final');
    expect(source.resolved_url).toBe('https://www.telekom.de/final');
  });

  it('on success with NO resolvedUrl supplied: leaves the prior resolved_url untouched', () => {
    const src = makeSource({ resolved_url: 'https://prior.de/r' });
    const { source } = applyCrawlOutcome(src, true, now); // resolvedUrl omitted
    expect(source.resolved_url).toBe('https://prior.de/r');
  });

  it('on FAILURE: never overwrites resolved_url (a failed pass saw no final URL)', () => {
    const src = makeSource({ resolved_url: 'https://prior.de/r' });
    const { source } = applyCrawlOutcome(src, false, now, 'https://ignored.de/x');
    expect(source.resolved_url).toBe('https://prior.de/r');
  });

  it('on success: a fresh source (resolved_url=null) with no resolvedUrl stays null', () => {
    const src = makeSource({ resolved_url: null });
    const { source } = applyCrawlOutcome(src, true, now);
    expect(source.resolved_url).toBeNull();
  });
});

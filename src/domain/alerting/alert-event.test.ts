import { describe, it, expect } from 'vitest';
import {
  AlertEventSchema,
  sourceReliabilityLowAlert,
  dailyBudgetReachedAlert,
} from './alert-event.js';

const AT = '2026-06-21T09:30:00.000Z';

describe('sourceReliabilityLowAlert', () => {
  const event = sourceReliabilityLowAlert({
    sourceId: 'src-123',
    url: 'https://www.telekom.de/magenta',
    reliability: 0.1,
    nextDue: '2026-07-01T00:00:00.000Z',
    at: AT,
  });

  it('is a valid AlertEvent of kind source_reliability_low, severity warning', () => {
    expect(() => AlertEventSchema.parse(event)).not.toThrow();
    expect(event.kind).toBe('source_reliability_low');
    expect(event.severity).toBe('warning');
  });

  it('dedupes by source id (repeats over time collapse to one identity)', () => {
    expect(event.dedupe_key).toBe('source_reliability_low:src-123');
    const again = sourceReliabilityLowAlert({
      sourceId: 'src-123',
      url: 'https://www.telekom.de/magenta',
      reliability: 0.05, // a later, even-lower reading
      nextDue: null,
      at: '2026-06-22T00:00:00.000Z',
    });
    expect(again.dedupe_key).toBe(event.dedupe_key);
  });

  it('carries the salient context (id, url, score, next_due) — no secrets/raw data', () => {
    expect(event.context).toEqual({
      source_id: 'src-123',
      url: 'https://www.telekom.de/magenta',
      reliability: 0.1,
      next_due: '2026-07-01T00:00:00.000Z',
    });
    expect(event.summary).toContain('0.10');
    expect(event.at).toBe(AT);
  });
});

describe('dailyBudgetReachedAlert', () => {
  const event = dailyBudgetReachedAlert({ ceilingEur: 10, spentTodayEur: 10.02, at: AT });

  it('is a valid AlertEvent of kind daily_budget_reached, severity warning', () => {
    expect(() => AlertEventSchema.parse(event)).not.toThrow();
    expect(event.kind).toBe('daily_budget_reached');
    expect(event.severity).toBe('warning');
  });

  it('dedupes by UTC day (one alert per day the ceiling is hit, not per stopped run)', () => {
    expect(event.dedupe_key).toBe('daily_budget_reached:2026-06-21');
    const laterSameDay = dailyBudgetReachedAlert({
      ceilingEur: 10,
      spentTodayEur: 10.5,
      at: '2026-06-21T23:00:00.000Z',
    });
    expect(laterSameDay.dedupe_key).toBe(event.dedupe_key);
    const nextDay = dailyBudgetReachedAlert({
      ceilingEur: 10,
      spentTodayEur: 10.0,
      at: '2026-06-22T01:00:00.000Z',
    });
    expect(nextDay.dedupe_key).toBe('daily_budget_reached:2026-06-22');
  });

  it('summarises the ceiling + spend as euros to 2dp', () => {
    expect(event.summary).toContain('€10.00');
    expect(event.summary).toContain('€10.02');
    expect(event.context).toEqual({
      ceiling_eur: 10,
      spent_today_eur: 10.02,
      utc_day: '2026-06-21',
    });
  });
});

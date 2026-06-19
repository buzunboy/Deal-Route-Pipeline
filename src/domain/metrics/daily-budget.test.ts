import { describe, it, expect } from 'vitest';
import {
  dailyBudgetEnabled,
  remainingDailyBudget,
  dailyBudgetExhausted,
  effectiveRunCostCap,
  utcDayStart,
} from './daily-budget.js';

describe('daily-budget rules', () => {
  describe('dailyBudgetEnabled', () => {
    it.each([
      [10, true],
      [0.01, true],
      [0, false],
      [-1, false],
    ])('ceiling %d → enabled %s', (ceiling, expected) => {
      expect(dailyBudgetEnabled(ceiling)).toBe(expected);
    });
  });

  describe('remainingDailyBudget', () => {
    it('returns Infinity when disabled (ceiling 0), regardless of spend', () => {
      expect(remainingDailyBudget(0, 5)).toBe(Infinity);
    });
    it('returns the cent-rounded difference when under the ceiling', () => {
      expect(remainingDailyBudget(10, 3.5)).toBe(6.5);
    });
    it('never goes negative once spend exceeds the ceiling', () => {
      expect(remainingDailyBudget(10, 12)).toBe(0);
    });
    it('is exactly 0 at the ceiling', () => {
      expect(remainingDailyBudget(10, 10)).toBe(0);
    });
    it('rounds to cents so it composes with ledger sums', () => {
      // 10 - 3.333 = 6.667 → 6.67 (half-up to cents).
      expect(remainingDailyBudget(10, 3.333)).toBe(6.67);
    });
  });

  describe('dailyBudgetExhausted', () => {
    it('disabled guard is never exhausted', () => {
      expect(dailyBudgetExhausted(0, 1000)).toBe(false);
    });
    it('not exhausted while spend is below the ceiling', () => {
      expect(dailyBudgetExhausted(10, 9.99)).toBe(false);
    });
    it('exhausted exactly at the ceiling (>= boundary)', () => {
      expect(dailyBudgetExhausted(10, 10)).toBe(true);
    });
    it('exhausted past the ceiling', () => {
      expect(dailyBudgetExhausted(10, 10.5)).toBe(true);
    });
  });

  describe('effectiveRunCostCap', () => {
    it('disabled guard leaves the per-run cap unchanged', () => {
      expect(effectiveRunCostCap(1.0, 0, 999)).toBe(1.0);
    });
    it('uses the per-run cap when ample budget remains', () => {
      expect(effectiveRunCostCap(1.0, 10, 2)).toBe(1.0); // remaining 8 > 1
    });
    it('clamps to remaining budget when it is the tighter bound', () => {
      expect(effectiveRunCostCap(1.0, 10, 9.5)).toBe(0.5); // remaining 0.5 < 1
    });
    it('clamps to 0 when no budget remains', () => {
      expect(effectiveRunCostCap(1.0, 10, 10)).toBe(0);
    });
  });

  describe('utcDayStart', () => {
    it('truncates an instant to UTC midnight of the same day', () => {
      expect(utcDayStart(new Date('2026-06-19T13:47:09.123Z')).toISOString()).toBe(
        '2026-06-19T00:00:00.000Z',
      );
    });
    it('keeps a value already at UTC midnight', () => {
      expect(utcDayStart(new Date('2026-06-19T00:00:00.000Z')).toISOString()).toBe(
        '2026-06-19T00:00:00.000Z',
      );
    });
    it('uses the UTC day even near a day boundary in another zone', () => {
      // 23:30Z on the 19th is still the 19th in UTC (would be the 20th at +01:00).
      expect(utcDayStart(new Date('2026-06-19T23:30:00.000Z')).toISOString()).toBe(
        '2026-06-19T00:00:00.000Z',
      );
    });
  });
});

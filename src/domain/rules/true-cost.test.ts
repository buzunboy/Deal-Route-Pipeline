import { describe, it, expect } from 'vitest';
import { trueCostMonthly } from './true-cost.js';
import type { Price } from '../deal-record/index.js';

describe('trueCostMonthly', () => {
  const cases: { name: string; price: Price; expected: number }[] = [
    { name: 'monthly passes through', price: p(9.99, 'monthly'), expected: 9.99 },
    { name: 'annual divides by 12', price: p(120, 'annual'), expected: 10 },
    { name: 'annual rounds to cents', price: p(100, 'annual'), expected: 8.33 },
    { name: 'one_time passes through', price: p(49.99, 'one_time'), expected: 49.99 },
    { name: 'unknown passes through (flagged elsewhere)', price: p(5, 'unknown'), expected: 5 },
    { name: 'free route is zero', price: p(0, 'monthly'), expected: 0 },
    // prepaid amortises over the page-stated term (grounded, not guessed):
    { name: 'prepaid 2yr €49.19 → ~€2.05/mo', price: p(49.19, 'prepaid', 24), expected: 2.05 },
    { name: 'prepaid 12mo divides by 12', price: p(120, 'prepaid', 12), expected: 10 },
    // prepaid WITHOUT a term can't be amortised → raw amount (validation flags it):
    { name: 'prepaid no term → raw (no guessing)', price: p(49.19, 'prepaid'), expected: 49.19 },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(trueCostMonthly(c.price)).toBe(c.expected);
    });
  }

  it('is deterministic', () => {
    const price = p(120, 'annual');
    expect(trueCostMonthly(price)).toBe(trueCostMonthly(price));
  });
});

function p(amount: number, billing: Price['billing'], prepaidMonths?: number): Price {
  return { amount, currency: 'EUR', billing, prepaid_months: prepaidMonths };
}

import { describe, it, expect } from 'vitest';
import {
  CostSummarySchema,
  roundEur,
  toEurMicros,
  eurFromMicros,
  EUR_MICRO_SCALE,
} from './cost-summary.js';

describe('roundEur', () => {
  it('rounds to cents half-up', () => {
    expect(roundEur(0)).toBe(0);
    expect(roundEur(0.001)).toBe(0);
    expect(roundEur(0.005)).toBe(0.01); // half rounds up
    expect(roundEur(0.007)).toBe(0.01);
    expect(roundEur(0.014)).toBe(0.01);
    expect(roundEur(0.015)).toBe(0.02); // half rounds up
    expect(roundEur(1.005)).toBe(1.0); // float: 1.005*100 === 100.49999… → 100
    expect(roundEur(10)).toBe(10);
  });
});

describe('micro-euro accumulation (cross-adapter parity)', () => {
  it('quantises a raw cost to exact integer micro-euros, half-up', () => {
    expect(toEurMicros(0)).toBe(0);
    expect(toEurMicros(0.001)).toBe(1000); // sub-cent costs survive (NOT zeroed)
    expect(toEurMicros(0.005)).toBe(5000);
    expect(toEurMicros(1)).toBe(EUR_MICRO_SCALE);
    expect(toEurMicros(0.0000005)).toBe(1); // half-up at the micro boundary
  });

  it('collapses a micro-euro sum to cents half-up', () => {
    expect(eurFromMicros(0)).toBe(0);
    expect(eurFromMicros(35000)).toBe(0.04); // 0.035 → half-up → 0.04
    expect(eurFromMicros(7000)).toBe(0.01); // 7×0.001 preserved as a cent
    expect(eurFromMicros(EUR_MICRO_SCALE)).toBe(1);
  });

  it('micro-sum is order-INDEPENDENT where raw-float-sum is not (the bug fixed)', () => {
    // These multisets sum to different doubles in different orders, so the OLD
    // "sum raw floats, round once" convention gave a 1-cent disagreement between
    // adapters. Summing exact integer micro-euros removes the order dependence.
    const cases: { rows: number[]; eur: number }[] = [
      { rows: [0.005, 0.01, 0.02], eur: 0.04 }, // raw: 0.035 vs 0.034999… → 0.04/0.03
      { rows: [0.005, 0.005, 0.045], eur: 0.06 }, // raw: 0.055 vs 0.05499… → 0.06/0.05
      { rows: [0.005, 0.01, 0.21], eur: 0.23 }, // raw: 0.225 vs 0.22499… → 0.23/0.22
      { rows: [0.001, 0.001, 0.001, 0.001, 0.001, 0.001, 0.001], eur: 0.01 }, // sub-cent kept
    ];
    for (const { rows, eur } of cases) {
      const fwd = rows.reduce((s, n) => s + toEurMicros(n), 0);
      const bwd = [...rows].reverse().reduce((s, n) => s + toEurMicros(n), 0);
      expect(fwd).toBe(bwd); // integer sum: identical in any order
      expect(eurFromMicros(fwd)).toBe(eur);
      expect(eurFromMicros(bwd)).toBe(eur);
    }
  });
});

describe('CostSummarySchema', () => {
  const valid = {
    total_eur: 1.23,
    run_count: 3,
    per_day: [{ day: '2026-06-19', cost_eur: 1.23, run_count: 3 }],
    per_source: [{ source_id: 's1', cost_eur: 1.23, run_count: 3 }],
  };

  it('accepts a well-formed summary, including the empty-window zeros shape', () => {
    expect(CostSummarySchema.parse(valid)).toEqual(valid);
    expect(
      CostSummarySchema.parse({ total_eur: 0, run_count: 0, per_day: [], per_source: [] }),
    ).toEqual({ total_eur: 0, run_count: 0, per_day: [], per_source: [] });
  });

  it('rejects a negative total_eur', () => {
    expect(() => CostSummarySchema.parse({ ...valid, total_eur: -0.01 })).toThrow();
  });

  it('rejects a non-integer run_count', () => {
    expect(() => CostSummarySchema.parse({ ...valid, run_count: 2.5 })).toThrow();
  });

  it('rejects a malformed day string (not YYYY-MM-DD)', () => {
    expect(() =>
      CostSummarySchema.parse({
        ...valid,
        per_day: [{ day: '2026-6-9', cost_eur: 1, run_count: 1 }],
      }),
    ).toThrow();
    expect(() =>
      CostSummarySchema.parse({
        ...valid,
        per_day: [{ day: '2026-06-19T00:00:00Z', cost_eur: 1, run_count: 1 }],
      }),
    ).toThrow();
  });

  it('rejects a negative per_source cost_eur', () => {
    expect(() =>
      CostSummarySchema.parse({
        ...valid,
        per_source: [{ source_id: 's1', cost_eur: -1, run_count: 1 }],
      }),
    ).toThrow();
  });
});

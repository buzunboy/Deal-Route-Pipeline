import { describe, it, expect } from 'vitest';
import {
  buildDashboardMetrics,
  buildConfidenceDistribution,
  DashboardMetricsSchema,
  COST_HIGHLIGHT_RECENT,
  type DashboardMetricsInput,
} from './dashboard-metrics.js';

describe('dashboard-metrics', () => {
  describe('buildConfidenceDistribution', () => {
    it('buckets on inclusive lower edges (≥0.80 high, ≥0.60 medium, else low)', () => {
      const bands = buildConfidenceDistribution([0.95, 0.8, 0.79, 0.6, 0.59, 0.1]);
      expect(bands.map((b) => ({ level: b.level, percent: b.percent }))).toEqual([
        // Equal counts (2/6 each = 33.33%) ⇒ equal remainders; the leftover point
        // breaks the tie by lowest index, so 'high' (index 0) gets the extra one.
        { level: 'success', percent: 34 }, // 0.95, 0.80 → 2/6
        { level: 'warning', percent: 33 }, // 0.79, 0.60 → 2/6
        { level: 'danger', percent: 33 }, // 0.59, 0.10 → 2/6
      ]);
      expect(bands.reduce((a, b) => a + b.percent, 0)).toBe(100);
    });
    it('an empty pending queue returns all three bands at 0%', () => {
      const bands = buildConfidenceDistribution([]);
      expect(bands.map((b) => b.percent)).toEqual([0, 0, 0]);
      expect(bands.map((b) => b.level)).toEqual(['success', 'warning', 'danger']);
    });
  });

  const baseInput = (): DashboardMetricsInput => ({
    costPerDay: [
      { day: '2026-06-19', cost: 40 },
      { day: '2026-06-20', cost: 55 },
      { day: '2026-06-21', cost: 80 },
      { day: '2026-06-22', cost: 72 },
    ],
    costToday: 72,
    today: { approved: 18, rejected: 7, edited: 5 },
    pendingConfidences: [0.9, 0.7, 0.5],
  });

  it('builds KPIs from real inputs (cost / throughput / approval-rate / avg-confidence)', () => {
    const m = buildDashboardMetrics(baseInput());
    const kpi = (key: string) => m.kpis.find((k) => k.key === key)!;
    expect(kpi('crawl-cost').value).toBe('€72');
    expect(kpi('throughput').value).toBe('30'); // 18+7+5 decisions
    expect(kpi('approval-rate').value).toBe('72%'); // 18/(18+7); edits excluded
    expect(kpi('avg-confidence').value).toBe('0.70'); // (0.9+0.7+0.5)/3
    expect(DashboardMetricsSchema.parse(m)).toEqual(m);
  });

  it('approval rate is "—" with no resolving decisions; avg confidence "—" with no queue', () => {
    const m = buildDashboardMetrics({
      costPerDay: [],
      costToday: 0,
      today: { approved: 0, rejected: 0, edited: 3 }, // edits don't resolve
      pendingConfidences: [],
    });
    expect(m.kpis.find((k) => k.key === 'approval-rate')!.value).toBe('—');
    expect(m.kpis.find((k) => k.key === 'avg-confidence')!.value).toBe('—');
    expect(m.cost_per_day).toEqual([]);
  });

  it('labels cost bars by UTC day-of-month and highlights the most-recent days', () => {
    const m = buildDashboardMetrics(baseInput());
    expect(m.cost_per_day.map((b) => b.day)).toEqual(['19', '20', '21', '22']);
    const highlighted = m.cost_per_day.filter((b) => b.highlight).map((b) => b.day);
    expect(highlighted).toEqual(['21', '22']); // last COST_HIGHLIGHT_RECENT
    expect(highlighted).toHaveLength(COST_HIGHLIGHT_RECENT);
  });
});

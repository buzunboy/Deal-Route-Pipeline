import { z } from 'zod';
import { largestRemainderPercents } from './queue-freshness.js';

/**
 * The Metrics screen rollup (ACR-10 Metrics) — KPI cards, the cost-per-day chart, and
 * the confidence distribution. Backs `GET /api/metrics`.
 *
 * Every number is derived from real pipeline data (an owner decision — no
 * placeholders): KPIs from `crawl_runs` (cost today) + the `reviews` log (throughput,
 * approval rate) + the pending `deals` (avg confidence); `cost_per_day` from the last
 * {@link COST_DAYS} UTC days of logged crawl cost; `confidence_distribution` from the
 * pending queue's confidences bucketed into trust bands.
 *
 * PURE: the use-case gathers the raw inputs (a cost-per-day series, today's review
 * counts, the pending-deal confidences) and this module shapes them into the panel's
 * contract — value formatting, trend captions, percentage rounding. No I/O.
 */

/** Days of cost history the chart shows (the panel renders ~14 bars). */
export const COST_DAYS = 14;
/** The most-recent N days are highlighted in the chart (matches the panel prototype). */
export const COST_HIGHLIGHT_RECENT = 2;

/** A KPI card: a labelled, pre-formatted value with a colored trend caption. */
export const MetricKpiSchema = z.object({
  key: z.string(),
  label: z.string(),
  /** Pre-formatted value (e.g. "€164", "72%", "0.83"). */
  value: z.string(),
  /** Trend caption (e.g. "▲ 5 reviews"); empty string when no trend is shown. */
  trend: z.string(),
  /** Drives the caption color; the ▲/▼ glyph + text carry the meaning (never color-only). */
  direction: z.enum(['up-good', 'up-bad', 'down-good', 'down-bad', 'flat']),
});
export type MetricKpi = z.infer<typeof MetricKpiSchema>;

/** One bar in the cost-per-day chart: the day label + the raw euro cost. */
export const CostBarSchema = z.object({
  /** Day label under the bar (the UTC day-of-month, e.g. "08"). */
  day: z.string(),
  /** Crawl cost in euros for that UTC day (drives the bar height + the readable value). */
  cost: z.number().nonnegative(),
  /** Whether this is one of the recent (highlighted) days. */
  highlight: z.boolean(),
});
export type CostBar = z.infer<typeof CostBarSchema>;

/** Trust band for the confidence distribution (matches the panel's trust levels). */
export const ConfidenceLevel = z.enum(['success', 'warning', 'danger']);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevel>;

/** One confidence-distribution band: a labelled % bar colored by trust level. */
export const ConfidenceBandSchema = z.object({
  label: z.string(),
  /** Share of pending candidates in this band, 0..100 (integer). */
  percent: z.number().int().min(0).max(100),
  level: ConfidenceLevel,
});
export type ConfidenceBand = z.infer<typeof ConfidenceBandSchema>;

export const DashboardMetricsSchema = z.object({
  kpis: z.array(MetricKpiSchema),
  cost_per_day: z.array(CostBarSchema),
  confidence_distribution: z.array(ConfidenceBandSchema),
});
export type DashboardMetrics = z.infer<typeof DashboardMetricsSchema>;

/**
 * The confidence bands, high→low. Boundaries are INCLUSIVE on the lower edge:
 * High ≥ 0.80, Medium 0.60–0.79 (≥ 0.60 and < 0.80), Low < 0.60.
 */
export const CONFIDENCE_BANDS: readonly { label: string; level: ConfidenceLevel; min: number }[] = [
  { label: 'High (≥ 0.80)', level: 'success', min: 0.8 },
  { label: 'Medium (0.60–0.79)', level: 'warning', min: 0.6 },
  { label: 'Low (< 0.60)', level: 'danger', min: 0 },
];

/** Classify one confidence into its band index (0=high, 1=medium, 2=low). */
function confidenceBandIndex(confidence: number): number {
  for (let i = 0; i < CONFIDENCE_BANDS.length; i++) {
    if (confidence >= CONFIDENCE_BANDS[i]!.min) return i;
  }
  return CONFIDENCE_BANDS.length - 1; // unreachable (last min is 0), defensive
}

/**
 * Build the confidence distribution from the pending queue's confidence scores.
 * Percentages use the largest-remainder method so the three bands sum to exactly 100
 * (no over/under-filled bars). An empty queue returns all three bands at 0%.
 */
export function buildConfidenceDistribution(confidences: readonly number[]): ConfidenceBand[] {
  const counts = CONFIDENCE_BANDS.map(() => 0);
  for (const c of confidences) counts[confidenceBandIndex(c)]!++;
  const percents = largestRemainderPercents(counts, confidences.length);
  return CONFIDENCE_BANDS.map((band, i) => ({
    label: band.label,
    percent: percents[i]!,
    level: band.level,
  }));
}

/**
 * The raw inputs the use-case gathers for {@link buildDashboardMetrics}: a cost
 * series (ascending by day, each `{ day: 'YYYY-MM-DD', cost }`), today's review
 * decision counts, and the pending-queue confidences. Keeping the gather in the
 * use-case (I/O) and the shaping here (pure) preserves the layering.
 */
export interface DashboardMetricsInput {
  /** Cost per UTC day, oldest→newest, `YYYY-MM-DD` day keys. */
  costPerDay: readonly { day: string; cost: number }[];
  /** Today's crawl cost in euros (the cost-today KPI). */
  costToday: number;
  /** Today's review decision counts (the throughput + approval-rate KPIs). */
  today: { approved: number; rejected: number; edited: number };
  /** The pending queue's confidence scores (the avg-confidence KPI + distribution). */
  pendingConfidences: readonly number[];
}

/** Shape the gathered inputs into the panel's Metrics contract (pure). */
export function buildDashboardMetrics(input: DashboardMetricsInput): DashboardMetrics {
  return {
    kpis: buildKpis(input),
    cost_per_day: buildCostPerDay(input.costPerDay),
    confidence_distribution: buildConfidenceDistribution(input.pendingConfidences),
  };
}

/** The four KPI cards, derived from the gathered inputs. */
function buildKpis(input: DashboardMetricsInput): MetricKpi[] {
  const { approved, rejected, edited } = input.today;
  const decided = approved + rejected + edited;
  const avgConfidence =
    input.pendingConfidences.length === 0
      ? null
      : input.pendingConfidences.reduce((a, b) => a + b, 0) / input.pendingConfidences.length;
  return [
    {
      key: 'crawl-cost',
      label: 'Crawl cost today',
      value: formatEur(input.costToday),
      trend: '',
      direction: 'flat',
    },
    {
      key: 'throughput',
      label: 'Throughput today',
      value: String(decided),
      trend: '',
      direction: 'flat',
    },
    {
      key: 'approval-rate',
      label: 'Approval rate',
      // Approvals over decisions that resolve a candidate (approve + reject); an edit
      // doesn't resolve, so it's excluded from the rate's denominator. No decisions ⇒ "—".
      value: formatApprovalRate(approved, rejected),
      trend: '',
      direction: 'flat',
    },
    {
      key: 'avg-confidence',
      label: 'Avg confidence',
      value: avgConfidence === null ? '—' : avgConfidence.toFixed(2),
      trend: '',
      direction: 'flat',
    },
  ];
}

/** Project the cost series into chart bars, highlighting the most-recent days. */
function buildCostPerDay(series: readonly { day: string; cost: number }[]): CostBar[] {
  return series.map((point, i) => ({
    // The panel labels bars with the UTC day-of-month (last two chars of YYYY-MM-DD).
    day: point.day.slice(8, 10),
    cost: point.cost,
    highlight: i >= series.length - COST_HIGHLIGHT_RECENT,
  }));
}

/** Format a euro amount as a whole-euro KPI value (e.g. 163.7 → "€164"). */
function formatEur(amount: number): string {
  return `€${Math.round(amount)}`;
}

/** Format the approval rate as a whole-percent string, or "—" when no decisions resolved. */
function formatApprovalRate(approved: number, rejected: number): string {
  const resolved = approved + rejected;
  if (resolved === 0) return '—';
  return `${Math.round((approved / resolved) * 100)}%`;
}

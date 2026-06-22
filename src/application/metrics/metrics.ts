import {
  buildThroughput,
  buildFreshness,
  buildDashboardMetrics,
  COST_DAYS,
  type CostSummary,
  type CrawlRun,
  type ThroughputSummary,
  type FreshnessBand,
  type DashboardMetrics,
} from '../../domain/index.js';
import type { Clock, Database, Logger } from '../ports/index.js';

/** Default cap on the per-run ledger view, so an unbounded table can't flood output. */
export const DEFAULT_RUNS_LIMIT = 50;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Cost, observability & dashboard-metrics use-case. Thin orchestration over the
 * repositories: the `costSummary`/`recentRuns` ledger over `crawl_runs`, plus the
 * admin-panel dashboard rollups (ACR-6 throughput, ACR-9 queue-freshness, ACR-10
 * Metrics) — each gathers raw rows from the repos and shapes them via a PURE domain
 * builder (the math + bucketing + rounding live in `src/domain/metrics/`, not here).
 *
 * The `Clock` resolves "today" (UTC) for the throughput + metrics windows; all other
 * windows stay absolute `Date` bounds supplied by the caller.
 */
export class MetricsUseCase {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  /**
   * Aggregate logged crawl-run cost over a half-open `started_at` window (`since`
   * inclusive, `until` exclusive; both optional). Delegates to the repository,
   * which owns the rounding + sort + UTC-day-bucketing contract.
   */
  async costSummary(filter: { since?: Date; until?: Date }): Promise<CostSummary> {
    this.logger.debug('metrics.costSummary', {
      since: filter.since?.toISOString(),
      until: filter.until?.toISOString(),
    });
    return this.db.crawlRuns.costSummary(filter);
  }

  /**
   * Recent runs (newest first) over the same half-open window as `costSummary` —
   * the per-run observability surface (kind / status / candidates / proposals /
   * cost / stop-reason). `limit` defaults to a sane cap so the ledger view can't
   * flood output.
   */
  async recentRuns(filter: { since?: Date; until?: Date; limit?: number }): Promise<CrawlRun[]> {
    const limit = filter.limit ?? DEFAULT_RUNS_LIMIT;
    this.logger.debug('metrics.recentRuns', {
      since: filter.since?.toISOString(),
      until: filter.until?.toISOString(),
      limit,
    });
    return this.db.crawlRuns.recentRuns({ since: filter.since, until: filter.until, limit });
  }

  /**
   * Today's reviewer-throughput summary (ACR-6): counts of approve/reject/edit on the
   * current UTC day plus the mean capture→decision latency (`avg_review_seconds`).
   * Gathers today's decisions (each joined to its deal's evidence capture time) from
   * the reviews repo and shapes them via the pure {@link buildThroughput}.
   */
  async throughputToday(): Promise<ThroughputSummary> {
    const since = utcMidnight(this.clock.now());
    this.logger.debug('metrics.throughputToday', { since: since.toISOString() });
    const decisions = await this.db.reviews.listDecisionLatenciesSince(since);
    return buildThroughput(decisions);
  }

  /**
   * Pending-queue freshness distribution (ACR-9): the share of reviewable candidates
   * in each age band (`<24h` / `1-3d` / `>3d`), aged by `now − evidence.captured_at`.
   * Gathers the queue's capture timestamps and buckets them via {@link buildFreshness}.
   */
  async queueFreshness(): Promise<FreshnessBand[]> {
    const now = this.clock.now();
    this.logger.debug('metrics.queueFreshness', { now: now.toISOString() });
    const signals = await this.db.deals.pendingQueueSignals();
    const capturedAts = signals
      .filter((s): s is { capturedAt: string; confidence: number } => s.capturedAt !== null)
      .map((s) => new Date(s.capturedAt));
    return buildFreshness(capturedAts, now);
  }

  /**
   * The Metrics screen rollup (ACR-10 Metrics): KPI cards + the last {@link COST_DAYS}
   * UTC days of crawl cost + the pending-queue confidence distribution. Gathers the
   * cost series, today's review counts, and the pending confidences from the repos,
   * then shapes them via the pure {@link buildDashboardMetrics}. All three rollups are
   * derived from real data.
   */
  async dashboardMetrics(): Promise<DashboardMetrics> {
    const now = this.clock.now();
    const todayMidnight = utcMidnight(now);
    // The cost window is the last COST_DAYS UTC days, inclusive of today: [start, now].
    const windowStart = new Date(todayMidnight.getTime() - (COST_DAYS - 1) * MS_PER_DAY);
    this.logger.debug('metrics.dashboardMetrics', {
      windowStart: windowStart.toISOString(),
      now: now.toISOString(),
    });

    const [summary, decisions, signals] = await Promise.all([
      this.db.crawlRuns.costSummary({ since: windowStart }),
      this.db.reviews.listDecisionLatenciesSince(todayMidnight),
      this.db.deals.pendingQueueSignals(),
    ]);

    // Densify the cost series: a zero-cost day has no crawl_runs row, but the chart
    // must still show its (empty) bar. Map the sparse per_day buckets onto a dense
    // COST_DAYS-long sequence of UTC days, oldest → newest.
    const costByDay = new Map(summary.per_day.map((d) => [d.day, d.cost_eur]));
    const costPerDay = Array.from({ length: COST_DAYS }, (_, i) => {
      const dayKey = utcDayKey(new Date(windowStart.getTime() + i * MS_PER_DAY));
      return { day: dayKey, cost: costByDay.get(dayKey) ?? 0 };
    });
    const costToday = costByDay.get(utcDayKey(now)) ?? 0;

    const today = { approved: 0, rejected: 0, edited: 0 };
    for (const d of decisions) {
      if (d.action === 'approve') today.approved++;
      else if (d.action === 'reject') today.rejected++;
      else today.edited++;
    }
    const pendingConfidences = signals.map((s) => s.confidence);

    return buildDashboardMetrics({ costPerDay, costToday, today, pendingConfidences });
  }
}

/** Midnight (00:00:00.000Z) of the UTC day containing `at` — the "today" bound. */
function utcMidnight(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/** The UTC calendar day of `at` as `YYYY-MM-DD` — the cost-summary day-bucket key. */
function utcDayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

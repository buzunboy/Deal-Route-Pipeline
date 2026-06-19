import type { CostSummary, CrawlRun } from '../../domain/index.js';
import type { Database, Logger } from '../ports/index.js';

/** Default cap on the per-run ledger view, so an unbounded table can't flood output. */
export const DEFAULT_RUNS_LIMIT = 50;

/**
 * Cost & observability use-case. Thin orchestration over the `CrawlRunRepository`
 * aggregation: surfaces the per-run `crawl_runs.cost_eur` already logged by the
 * crawl pipeline as a rolled-up `CostSummary`. No Clock — windows are absolute
 * `Date` bounds supplied by the caller (no relative-window resolution in v1).
 */
export class MetricsUseCase {
  constructor(
    private readonly db: Database,
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
}

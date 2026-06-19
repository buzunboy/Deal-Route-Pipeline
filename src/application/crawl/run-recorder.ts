import type { CrawlRun, CrawlRunKind, CrawlRunStoppedReason } from '../../domain/index.js';
import type { Database, Clock, Logger } from '../ports/index.js';
import { newId } from '../shared/id.js';

/** The metrics a bounded lane reports when its run finishes. */
export interface RunOutcome {
  candidatesProduced: number;
  proposalsProduced: number;
  costEur: number;
  stoppedReason: CrawlRunStoppedReason;
}

/**
 * Records a `crawl_runs` row for the bounded lanes (discover / ingest / monitor)
 * so the run ledger + cost stats + daily-budget guard see EVERY lane, not just
 * Lane A (which writes its own row inline). One place owns the start/finish/fail
 * dance so the lanes can't drift on what a run row looks like.
 *
 * Lane-B runs crawl arbitrary URLs with no `sources` row, so `sourceId` is
 * nullable here (cost stats bucket null-source runs under a shared sentinel).
 *
 * Dry-run writes nothing — `start()` returns an in-memory run the caller still
 * threads through `finish()`/`fail()`, but no DB write happens (mirrors how the
 * lanes already gate every other write on `dryRun`).
 */
export class RunRecorder {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly kind: CrawlRunKind,
  ) {}

  /** Begin a run (status `running`); persists it unless dry-run. */
  async start(sourceId: string | null, dryRun: boolean): Promise<CrawlRun> {
    const run: CrawlRun = {
      id: newId(),
      source_id: sourceId,
      run_kind: this.kind,
      status: 'running',
      started_at: this.clock.nowIso(),
      finished_at: null,
      candidates_produced: 0,
      proposals_produced: 0,
      cost_eur: 0,
      stopped_reason: null,
      error: null,
    };
    if (!dryRun) await this.safeWrite('insert', () => this.db.crawlRuns.insert(run));
    return run;
  }

  /** Close a run as succeeded with its final metrics; persists unless dry-run. */
  async finish(run: CrawlRun, outcome: RunOutcome, dryRun: boolean): Promise<CrawlRun> {
    run.status = 'succeeded';
    run.finished_at = this.clock.nowIso();
    run.candidates_produced = outcome.candidatesProduced;
    run.proposals_produced = outcome.proposalsProduced;
    run.cost_eur = outcome.costEur;
    run.stopped_reason = outcome.stoppedReason;
    if (!dryRun) await this.safeWrite('update', () => this.db.crawlRuns.update(run));
    return run;
  }

  /**
   * Close a run as failed, preserving whatever metrics accrued before the error.
   * The lanes already contain their own per-item failures; this is for an error
   * that aborts the whole run.
   */
  async fail(
    run: CrawlRun,
    err: unknown,
    partial: Partial<RunOutcome>,
    dryRun: boolean,
  ): Promise<CrawlRun> {
    run.status = 'failed';
    run.finished_at = this.clock.nowIso();
    run.error = err instanceof Error ? err.message : String(err);
    run.stopped_reason = 'error';
    if (partial.candidatesProduced !== undefined)
      run.candidates_produced = partial.candidatesProduced;
    if (partial.proposalsProduced !== undefined) run.proposals_produced = partial.proposalsProduced;
    if (partial.costEur !== undefined) run.cost_eur = partial.costEur;
    if (!dryRun) await this.safeWrite('update', () => this.db.crawlRuns.update(run));
    return run;
  }

  /**
   * A run-ledger write must NEVER crash the lane it's measuring — observability is
   * not allowed to take down the thing it observes. A failed write is logged
   * (loudly, with context) and swallowed; the lane's own result is still returned.
   */
  private async safeWrite(op: string, write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } catch (err) {
      this.logger.error(`run-recorder: ${this.kind} run ${op} failed (metrics only)`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

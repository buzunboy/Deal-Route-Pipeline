import {
  SourceStatus,
  SourceNotFoundError,
  SourceNotReviewableError,
  MissingApproverError,
  type Source,
  type SourceReviewRecord,
} from '../../domain/index.js';
import type { Database, Clock, Logger } from '../ports/index.js';
import { newId } from '../shared/id.js';

/**
 * Human-in-the-loop for the SOURCE-promotion loop (Pre-Phase-C). Discovery and
 * community ingestion surface novel domains as `pending_approval` tier-4 sources;
 * this is the ONLY path by which such a source becomes `active` (crawlable) or
 * `rejected`. Like deal review: a decision requires an approver identity (no
 * anonymous promotion) and is written to an append-only audit log BEFORE the
 * status change (log-before-act), so a mid-call failure can never promote a
 * source with no audit trail.
 */
export class SourceReviewUseCase {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  /** Sources awaiting human approval (the discovery/ingest proposal queue). */
  async listPending(): Promise<Source[]> {
    return this.db.sources.listByStatus(SourceStatus.enum.pending_approval);
  }

  /**
   * Promote a proposed source → `active`. Keeps its discovered tier + cadence and
   * sets `next_due=null` so the next `crawl --due` picks it up promptly.
   */
  async approveSource(sourceId: string, approver: string): Promise<Source> {
    this.assertApprover(approver, 'approve-source');
    const source = await this.requirePending(sourceId);

    const at = this.clock.nowIso();
    await this.recordReview(sourceId, 'approve', approver, null, at);
    const updated: Source = {
      ...source,
      status: SourceStatus.enum.active,
      next_due: null, // due now → crawled on the next due sweep
    };
    await this.db.sources.update(updated);
    this.logger.info('source approved → active', { sourceId, url: source.url, approver });
    return updated;
  }

  /**
   * Reject a proposed source → `rejected`. A rejected domain is never crawled and
   * never re-proposed (the discovery/ingest dedup skips `rejected`).
   */
  async rejectSource(sourceId: string, approver: string, reason?: string): Promise<Source> {
    this.assertApprover(approver, 'reject-source');
    const source = await this.requirePending(sourceId);

    const at = this.clock.nowIso();
    const trimmedReason = reason && reason.trim() !== '' ? reason.trim() : null;
    await this.recordReview(sourceId, 'reject', approver, trimmedReason, at);
    const updated: Source = { ...source, status: SourceStatus.enum.rejected };
    await this.db.sources.update(updated);
    this.logger.info('source rejected', {
      sourceId,
      url: source.url,
      approver,
      reason: trimmedReason,
    });
    return updated;
  }

  /** The append-only decision history for one source (newest first). */
  async listReviews(sourceId: string, limit = 50): Promise<SourceReviewRecord[]> {
    return this.db.sourceReviews.listForSource(sourceId, limit);
  }

  private async recordReview(
    sourceId: string,
    action: SourceReviewRecord['action'],
    approver: string,
    reason: string | null,
    at: string,
  ): Promise<void> {
    await this.db.sourceReviews.insert({
      id: newId(),
      source_id: sourceId,
      action,
      approver,
      reason,
      decided_at: at,
    });
  }

  private assertApprover(approver: string, action: string): void {
    if (approver.trim() === '') throw new MissingApproverError(action);
  }

  /** Only a `pending_approval` source can be promoted/rejected. */
  private async requirePending(sourceId: string): Promise<Source> {
    const source = await this.db.sources.getById(sourceId);
    if (source === null) throw new SourceNotFoundError(sourceId);
    if (source.status !== SourceStatus.enum.pending_approval) {
      throw new SourceNotReviewableError(sourceId, source.status);
    }
    return source;
  }
}

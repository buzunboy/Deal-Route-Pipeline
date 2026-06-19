import {
  DealStatus,
  DealNotFoundError,
  NotReviewableError,
  MissingApproverError,
  type DealRecord,
  type Evidence,
  type ManualCaptureTask,
  type FieldProposalRecord,
} from '../../domain/index.js';
import type { Database, Clock, Logger } from '../ports/index.js';

/** A candidate joined with its evidence, for the review API/console. */
export interface CandidateView {
  deal: DealRecord;
  evidence: Evidence | null;
}

/**
 * Human-in-the-loop review. This is the ONLY path by which a deal becomes
 * `published`. Nothing auto-publishes (v1 trust invariant): publication requires
 * an explicit approve call carrying the approver's identity.
 *
 * Evidence metadata is resolved from the `evidence` repository (where the crawl
 * pipeline records each bundle's pointers) — not the artifact store — so review
 * does not depend on where screenshots/HTML physically live.
 */
export class ReviewUseCase {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  /**
   * List deals awaiting review (both `candidate` and the flagged `in_review`
   * states), each with its evidence bundle. Flagged ones carry the must-review
   * signal so a reviewer can triage.
   */
  async listCandidates(limit = 50): Promise<CandidateView[]> {
    const [candidates, inReview] = await Promise.all([
      this.db.deals.listByStatus(DealStatus.enum.candidate, limit),
      this.db.deals.listByStatus(DealStatus.enum.in_review, limit),
    ]);
    const deals = [...candidates, ...inReview].slice(0, limit);
    return Promise.all(
      deals.map(async (deal) => ({
        deal,
        evidence: deal.evidence_id ? await this.db.evidence.getById(deal.evidence_id) : null,
      })),
    );
  }

  /** Approve a candidate → published. Requires an approver (no anonymous publish). */
  async approve(dealId: string, approver: string): Promise<DealRecord> {
    this.assertApprover(approver, 'approve');
    const deal = await this.requireDeal(dealId);
    this.assertReviewable(deal);

    const at = this.clock.nowIso();
    await this.db.deals.updateStatus(dealId, DealStatus.enum.published, approver, at);
    this.logger.info('deal approved → published', { dealId, approver });
    return { ...deal, status: DealStatus.enum.published, verified_by: approver, verified_at: at };
  }

  /**
   * Reject a candidate → rejected (archived). Requires an approver (symmetric with
   * approve — no anonymous state changes). The rejection reason is recorded in the
   * record's `attributes` (an open JSONB area) so the decision is auditable
   * without inventing a column.
   */
  async reject(dealId: string, approver: string, reason?: string): Promise<DealRecord> {
    this.assertApprover(approver, 'reject');
    const deal = await this.requireDeal(dealId);
    this.assertReviewable(deal);

    const at = this.clock.nowIso();
    if (reason && reason.trim() !== '') {
      await this.db.deals.update({
        ...deal,
        attributes: { ...deal.attributes, rejection_reason: reason },
      });
    }
    await this.db.deals.updateStatus(dealId, DealStatus.enum.rejected, approver, at);
    this.logger.info('deal rejected → archived', { dealId, approver, reason });
    return { ...deal, status: DealStatus.enum.rejected, verified_by: approver, verified_at: at };
  }

  private assertApprover(approver: string, action: string): void {
    if (approver.trim() === '') {
      throw new MissingApproverError(action);
    }
  }

  async listFieldProposals(limit = 50): Promise<FieldProposalRecord[]> {
    return this.db.fieldProposals.listOpen(limit);
  }

  async listManualCaptureTasks(limit = 50): Promise<ManualCaptureTask[]> {
    return this.db.manualCapture.listOpen(limit);
  }

  private async requireDeal(dealId: string): Promise<DealRecord> {
    const deal = await this.db.deals.getById(dealId);
    if (deal === null) throw new DealNotFoundError(dealId);
    return deal;
  }

  /** Only pre-approval states can be approved/rejected — never re-decide a terminal deal. */
  private assertReviewable(deal: DealRecord): void {
    const reviewable: DealStatus[] = [DealStatus.enum.candidate, DealStatus.enum.in_review];
    if (!reviewable.includes(deal.status)) {
      throw new NotReviewableError(deal.id, deal.status);
    }
  }
}

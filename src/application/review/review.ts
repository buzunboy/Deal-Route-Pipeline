import {
  DealStatus,
  DealNotFoundError,
  NotReviewableError,
  MissingApproverError,
  type DealRecord,
  type Evidence,
  type ManualCaptureTask,
  type FieldProposalRecord,
  type ReviewRecord,
} from '../../domain/index.js';
import type { Database, Clock, Logger } from '../ports/index.js';
import { newId } from '../shared/id.js';

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

  /**
   * Approve a candidate → published. Requires an approver (no anonymous publish).
   *
   * At publish we set the EU-Omnibus disclosure fields (Step 2): `published_at` (the
   * approve instant, distinct from `verified_at`) and `affiliate_disclosure`. The
   * reviewer supplies the disclosure; when omitted it **defaults to `true`** (the
   * safe, over-disclosing side) and we LOG a flag so a defaulted publish is visible,
   * never silent. The fields are set here by the human — never LLM-proposed.
   */
  async approve(
    dealId: string,
    approver: string,
    opts: { affiliateDisclosure?: boolean } = {},
  ): Promise<DealRecord> {
    this.assertApprover(approver, 'approve');
    const deal = await this.requireDeal(dealId);
    this.assertReviewable(deal);

    const at = this.clock.nowIso();
    const affiliateDisclosure = opts.affiliateDisclosure ?? true;
    if (opts.affiliateDisclosure === undefined) {
      this.logger.warn(
        'deal published with DEFAULTED affiliate_disclosure=true (reviewer omitted)',
        {
          dealId,
          approver,
        },
      );
    }

    // Log-before-act: append the audit row FIRST, so the worst case on a mid-call
    // failure is an orphan review row — never a published deal with no audit trail.
    await this.recordReview(dealId, 'approve', approver, null, at);
    // Persist the full updated record (update() is the all-fields writer; updateStatus
    // only touches status/verified_*, so it can't carry the disclosure + published_at).
    const published: DealRecord = {
      ...deal,
      status: DealStatus.enum.published,
      verified_by: approver,
      verified_at: at,
      published_at: at,
      affiliate_disclosure: affiliateDisclosure,
    };
    await this.db.deals.update(published);
    this.logger.info('deal approved → published', { dealId, approver, affiliateDisclosure });
    return published;
  }

  /**
   * Reject a candidate → rejected (archived). Requires an approver (symmetric with
   * approve — no anonymous state changes). The rejection reason is recorded both in
   * the immutable `reviews` audit log and on the record's `attributes` (an open
   * JSONB area) for at-a-glance context, without inventing a column.
   */
  async reject(dealId: string, approver: string, reason?: string): Promise<DealRecord> {
    this.assertApprover(approver, 'reject');
    const deal = await this.requireDeal(dealId);
    this.assertReviewable(deal);

    const at = this.clock.nowIso();
    const trimmedReason = reason && reason.trim() !== '' ? reason.trim() : null;
    // Log-before-act (see approve): the audit row is the durable record of the
    // decision, written before any status mutation.
    await this.recordReview(dealId, 'reject', approver, trimmedReason, at);
    if (trimmedReason !== null) {
      await this.db.deals.update({
        ...deal,
        attributes: { ...deal.attributes, rejection_reason: trimmedReason },
      });
    }
    await this.db.deals.updateStatus(dealId, DealStatus.enum.rejected, approver, at);
    this.logger.info('deal rejected → archived', { dealId, approver, reason: trimmedReason });
    return { ...deal, status: DealStatus.enum.rejected, verified_by: approver, verified_at: at };
  }

  /** The append-only decision history for one deal (newest first). */
  async listReviews(dealId: string, limit = 50): Promise<ReviewRecord[]> {
    return this.db.reviews.listForDeal(dealId, limit);
  }

  private async recordReview(
    dealId: string,
    action: ReviewRecord['action'],
    approver: string,
    reason: string | null,
    at: string,
  ): Promise<void> {
    await this.db.reviews.insert({
      id: newId(),
      deal_id: dealId,
      action,
      approver,
      reason,
      decided_at: at,
    });
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

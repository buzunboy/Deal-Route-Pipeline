import {
  DealStatus,
  type DealRecord,
  type Evidence,
  type ManualCaptureTask,
  type FieldProposalRecord,
} from '../../domain/index.js';
import type { Database, EvidenceStore, Clock, Logger } from '../ports/index.js';

/** A candidate joined with its evidence, for the review API/console. */
export interface CandidateView {
  deal: DealRecord;
  evidence: Evidence | null;
}

/**
 * Human-in-the-loop review. This is the ONLY path by which a deal becomes
 * `published`. Nothing auto-publishes (v1 trust invariant): publication requires
 * an explicit approve call carrying the approver's identity.
 */
export class ReviewUseCase {
  constructor(
    private readonly db: Database,
    private readonly evidenceStore: EvidenceStore,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  /** List candidates awaiting review, each with its evidence bundle. */
  async listCandidates(limit = 50): Promise<CandidateView[]> {
    const deals = await this.db.deals.listByStatus(DealStatus.enum.candidate, limit);
    return Promise.all(
      deals.map(async (deal) => ({
        deal,
        evidence: deal.evidence_id ? await this.evidenceStore.get(deal.evidence_id) : null,
      })),
    );
  }

  /** Approve a candidate → published. Requires an approver (no anonymous publish). */
  async approve(dealId: string, approver: string): Promise<DealRecord> {
    if (approver.trim() === '') {
      throw new Error('approve requires a non-empty approver identity.');
    }
    const deal = await this.requireDeal(dealId);
    this.assertReviewable(deal);

    const at = this.clock.nowIso();
    await this.db.deals.updateStatus(dealId, DealStatus.enum.published, approver, at);
    this.logger.info('deal approved → published', { dealId, approver });
    return { ...deal, status: DealStatus.enum.published, verified_by: approver, verified_at: at };
  }

  /** Reject a candidate → rejected (archived). */
  async reject(dealId: string, approver: string, _reason?: string): Promise<DealRecord> {
    const deal = await this.requireDeal(dealId);
    this.assertReviewable(deal);

    const at = this.clock.nowIso();
    await this.db.deals.updateStatus(dealId, DealStatus.enum.rejected, approver, at);
    this.logger.info('deal rejected → archived', { dealId, approver });
    return { ...deal, status: DealStatus.enum.rejected, verified_by: approver, verified_at: at };
  }

  async listFieldProposals(limit = 50): Promise<FieldProposalRecord[]> {
    return this.db.fieldProposals.listOpen(limit);
  }

  async listManualCaptureTasks(limit = 50): Promise<ManualCaptureTask[]> {
    return this.db.manualCapture.listOpen(limit);
  }

  private async requireDeal(dealId: string): Promise<DealRecord> {
    const deal = await this.db.deals.getById(dealId);
    if (deal === null) throw new Error(`Deal not found: ${dealId}`);
    return deal;
  }

  /** Only pre-approval states can be approved/rejected — never re-decide a terminal deal. */
  private assertReviewable(deal: DealRecord): void {
    const reviewable: DealStatus[] = [DealStatus.enum.candidate, DealStatus.enum.in_review];
    if (!reviewable.includes(deal.status)) {
      throw new Error(`Deal ${deal.id} is not reviewable (status: ${deal.status}).`);
    }
  }
}

import { DealStatus, type DealRecord, type Evidence } from '../../domain/index.js';
import type { Database, Clock, Logger } from '../ports/index.js';
import type { ExtractedCandidate } from '../extract/extract.js';
import { newId } from '../shared/id.js';

/**
 * The single place extracted candidates become persisted deal records — shared by
 * the deterministic crawl (Lane A) and site discovery (Lane B) so the
 * trust-critical persist rules live in ONE implementation:
 *  - dedupe on the canonical key; a same-key match with CHANGED content (different
 *    evidence hash) queues a fresh `in_review` candidate, leaving the prior intact;
 *  - an unchanged duplicate keeps the existing record;
 *  - low-confidence / rule-failing extractions enter `in_review`, clean ones
 *    `candidate`; nothing ever auto-publishes;
 *  - every candidate's `field_proposals` are recorded (governed promotion loop).
 *
 * Evidence is captured by the caller BEFORE this runs (evidence-required invariant).
 */
export class CandidateSink {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  /** Persist all candidates from one page against one evidence bundle. */
  async persist(candidates: ExtractedCandidate[], evidence: Evidence): Promise<void> {
    for (const candidate of candidates) {
      const existing = await this.db.deals.findByDedupeKey(candidate.dedupeKey);

      if (existing === null) {
        await this.db.deals.insert(this.toDealRecord(candidate, evidence));
      } else if (await this.contentDiffers(existing, evidence)) {
        this.logger.info('route changed — queuing a fresh candidate for re-review', {
          dedupeKey: candidate.dedupeKey,
          existingId: existing.id,
        });
        await this.db.deals.insert(this.toDealRecord(candidate, evidence, true));
      } else {
        this.logger.info('duplicate route, unchanged content — keeping existing record', {
          dedupeKey: candidate.dedupeKey,
          existingId: existing.id,
        });
      }

      for (const proposal of candidate.fieldProposals) {
        await this.db.fieldProposals.upsertAndCount({
          suggested_key: proposal.suggested_key,
          label: proposal.label,
          rationale: proposal.rationale,
          example_quote: proposal.example_quote,
          first_seen_at: this.clock.nowIso(),
          last_seen_at: this.clock.nowIso(),
        });
      }
    }
  }

  /**
   * Has the page content changed since the matched deal was captured? Compares
   * evidence content hashes; a missing prior bundle counts as changed (fail toward
   * review, never silently keep a possibly-stale record).
   */
  private async contentDiffers(existing: DealRecord, fresh: Evidence): Promise<boolean> {
    const priorEvidence = await this.db.evidence.getById(existing.evidence_id);
    if (priorEvidence === null) return true;
    return priorEvidence.content_hash !== fresh.content_hash;
  }

  private toDealRecord(
    candidate: ExtractedCandidate,
    evidence: Evidence,
    forceReview = false,
  ): DealRecord {
    const status =
      candidate.mustReview || forceReview ? DealStatus.enum.in_review : DealStatus.enum.candidate;
    return {
      ...candidate.deal,
      id: newId(),
      schema_version: candidate.schemaVersion,
      true_cost_monthly: candidate.trueCostMonthly,
      evidence_id: evidence.id,
      status,
      verified_by: null,
      verified_at: null,
    };
  }
}

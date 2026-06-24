import { DealStatus, type DealRecord, type Evidence } from '../../domain/index.js';
import type { Database, Clock, Logger } from '../ports/index.js';
import type { ExtractedCandidate } from '../extract/extract.js';
import { randomUUID } from 'node:crypto';

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
      } else if (await this.alreadyQueuedForThisCapture(candidate.dedupeKey, evidence)) {
        // A non-rejected candidate already exists for this route AND this exact
        // content hash → don't re-queue. Prevents a page with a rotating token
        // (timestamp, CSRF, A/B banner) from flooding the review queue with a new
        // in_review row every monitor cycle even though the offer hasn't changed.
        this.logger.info('route already queued for this capture — skipping duplicate', {
          dedupeKey: candidate.dedupeKey,
        });
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
   * Is there already a non-rejected candidate for this route whose evidence has
   * THIS exact content hash? If so, the current capture is identical to one we've
   * already queued — re-queuing would just duplicate it (idempotency on re-crawl /
   * flapping content). Compares by hash, not by which row `findByDedupeKey` picks.
   */
  private async alreadyQueuedForThisCapture(dedupeKey: string, fresh: Evidence): Promise<boolean> {
    const match = await this.db.deals.findActiveByDedupeKeyAndHash(dedupeKey, fresh.content_hash);
    return match !== null;
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
      // Pin source_url to the URL we actually fetched (the evidence bundle's), NOT
      // the LLM-supplied value — never trust raw LLM data for a provenance field.
      // The reviewer must verify against the page the evidence came from, and
      // monitoring finds/expires deals by source_url, so it must match the source.
      source_url: evidence.source_url,
      id: randomUUID(),
      schema_version: candidate.schemaVersion,
      true_cost_monthly: candidate.trueCostMonthly,
      evidence_id: evidence.id,
      status,
      verified_by: null,
      verified_at: null,
      // Disclosure fields are only meaningful once PUBLISHED; a candidate carries the
      // safe default (true) + no published_at. The reviewer confirms/sets them at approve.
      affiliate_disclosure: true,
      published_at: null,
      // The eTLD+1 of the fetched source URL, resolved once at extract via the real
      // PSL (Step 6) — pinned so the dedupe key + reliability join read a frozen
      // value, never recompute. Derived from the SAME fetched URL evidence.source_url
      // pins above, so the extract-time and recompute-from-row dedupe keys agree.
      source_registrable_domain: candidate.sourceRegistrableDomain,
      // An automatically-extracted candidate has no human-set fields (v5). The
      // reviewer-edit (PATCH) and manual-capture paths populate this; never the LLM.
      human_edited: [],
    };
  }
}

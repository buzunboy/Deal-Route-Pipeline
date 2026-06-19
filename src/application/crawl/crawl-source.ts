import { createHash } from 'node:crypto';
import {
  DealStatus,
  type Source,
  type DealRecord,
  type CrawlRun,
  type Evidence,
  type Vocabulary,
} from '../../domain/index.js';
import type {
  Fetcher,
  EvidenceStore,
  Database,
  Clock,
  Logger,
  FetchResult,
} from '../ports/index.js';
import { ExtractUseCase, type ExtractedCandidate } from '../extract/extract.js';
import { newId } from '../shared/id.js';
import { reliabilityAfter, nextDueIso } from './source-policy.js';

export interface CrawlSourceInput {
  sourceId: string;
  /** When true, no DB/evidence writes happen — used by dry-run-extract. */
  dryRun?: boolean;
}

export interface CrawlSourceResult {
  run: CrawlRun;
  candidates: ExtractedCandidate[];
  evidence: Evidence | null;
  routedToManualCapture: boolean;
}

/**
 * Lane A orchestration for one source: fetch a public page → (route blocked/
 * login pages to manual capture) → capture evidence → extract candidates →
 * persist as `candidate` status (deduping against existing routes) → log the run
 * and update source reliability/next-due.
 *
 * A single source failure is logged and contained — it never throws past here
 * and never crashes a batch (`architecture.md`: resilience). Nothing is ever
 * published; candidates land in the queue for human review.
 */
export class CrawlSourceUseCase {
  constructor(
    private readonly fetcher: Fetcher,
    private readonly evidenceStore: EvidenceStore,
    private readonly db: Database,
    private readonly extract: ExtractUseCase,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly vocabulary: Vocabulary,
    private readonly fetchUserAgent: string,
    private readonly fetchTimeoutMs: number,
  ) {}

  async execute(input: CrawlSourceInput): Promise<CrawlSourceResult> {
    const source = await this.db.sources.getById(input.sourceId);
    if (source === null) {
      throw new Error(`Source not found: ${input.sourceId}`);
    }

    const run = this.startRun(source);
    if (!input.dryRun) await this.db.crawlRuns.insert(run);

    try {
      const fetched = await this.fetcher.fetch(source.url, {
        timeoutMs: this.fetchTimeoutMs,
        userAgent: this.fetchUserAgent,
      });

      const manual = await this.maybeRouteToManualCapture(source, fetched, input.dryRun ?? false);
      if (manual) {
        return await this.finishRun(run, source, [], null, true, input.dryRun ?? false);
      }

      const evidence = await this.captureEvidence(fetched, input.dryRun ?? false);
      const extraction = await this.extract.execute({
        pageText: fetched.text,
        sourceUrl: source.url,
        targetService: source.subscription_service,
        vocabulary: this.vocabulary,
      });
      run.cost_eur = extraction.costEur;

      if (!input.dryRun) {
        await this.persistCandidates(extraction.candidates, evidence);
      }

      return await this.finishRun(
        run,
        source,
        extraction.candidates,
        evidence,
        false,
        input.dryRun ?? false,
      );
    } catch (err) {
      return await this.failRun(run, source, err, input.dryRun ?? false);
    }
  }

  private startRun(source: Source): CrawlRun {
    return {
      id: newId(),
      source_id: source.id,
      status: 'running',
      started_at: this.clock.nowIso(),
      finished_at: null,
      candidates_produced: 0,
      cost_eur: 0,
      error: null,
    };
  }

  private async maybeRouteToManualCapture(
    source: Source,
    fetched: FetchResult,
    dryRun: boolean,
  ): Promise<boolean> {
    const reason =
      fetched.outcome === 'login_required'
        ? 'login_required'
        : fetched.outcome === 'captcha'
          ? 'captcha'
          : fetched.outcome === 'blocked'
            ? 'anti_bot_blocked'
            : null;
    if (reason === null) return false;

    this.logger.info('routing to manual capture', { url: source.url, reason });
    if (!dryRun) {
      await this.db.manualCapture.insert({
        id: newId(),
        source_id: source.id,
        source_url: source.url,
        reason,
        created_at: this.clock.nowIso(),
        status: 'open',
        note: null,
      });
    }
    return true;
  }

  private async captureEvidence(fetched: FetchResult, dryRun: boolean): Promise<Evidence> {
    const contentHash = sha256(fetched.text);
    const capture = {
      sourceUrl: fetched.finalUrl,
      screenshot: fetched.screenshot,
      html: fetched.html,
      termsText: fetched.text,
      capturedAt: this.clock.nowIso(),
      contentHash,
    };
    const evidence = await this.evidenceStore.save(capture);
    if (!dryRun) await this.db.evidence.insert(evidence);
    return evidence;
  }

  private async persistCandidates(
    candidates: ExtractedCandidate[],
    evidence: Evidence,
  ): Promise<void> {
    for (const candidate of candidates) {
      const existing = await this.db.deals.findByDedupeKey(candidate.dedupeKey);
      const deal = this.toDealRecord(candidate, evidence);

      if (existing !== null) {
        this.logger.info('duplicate route — keeping existing, recording candidate evidence', {
          dedupeKey: candidate.dedupeKey,
          existingId: existing.id,
        });
        // v1: keep the existing record; still record proposals from this pass.
      } else {
        await this.db.deals.insert(deal);
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

  private toDealRecord(candidate: ExtractedCandidate, evidence: Evidence): DealRecord {
    return {
      ...candidate.deal,
      id: newId(),
      schema_version: candidate.schemaVersion,
      true_cost_monthly: candidate.trueCostMonthly,
      evidence_id: evidence.id,
      status: DealStatus.enum.candidate,
      verified_by: null,
      verified_at: null,
    };
  }

  private async finishRun(
    run: CrawlRun,
    source: Source,
    candidates: ExtractedCandidate[],
    evidence: Evidence | null,
    routedToManualCapture: boolean,
    dryRun: boolean,
  ): Promise<CrawlSourceResult> {
    run.status = routedToManualCapture ? 'skipped' : 'succeeded';
    run.finished_at = this.clock.nowIso();
    run.candidates_produced = candidates.length;

    if (!dryRun) {
      await this.db.crawlRuns.update(run);
      await this.updateSourceAfterCrawl(source, true);
    }
    return { run, candidates, evidence, routedToManualCapture };
  }

  private async failRun(
    run: CrawlRun,
    source: Source,
    err: unknown,
    dryRun: boolean,
  ): Promise<CrawlSourceResult> {
    run.status = 'failed';
    run.finished_at = this.clock.nowIso();
    run.error = err instanceof Error ? err.message : String(err);
    this.logger.error('crawl failed', { sourceId: source.id, error: run.error });

    if (!dryRun) {
      await this.db.crawlRuns.update(run);
      await this.updateSourceAfterCrawl(source, false);
    }
    return { run, candidates: [], evidence: null, routedToManualCapture: false };
  }

  private async updateSourceAfterCrawl(source: Source, success: boolean): Promise<void> {
    const updated: Source = {
      ...source,
      reliability_score: reliabilityAfter(source.reliability_score, success),
      last_seen: success ? this.clock.nowIso() : source.last_seen,
      next_due: nextDueIso(this.clock.now(), source.cadence_days),
    };
    await this.db.sources.update(updated);
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

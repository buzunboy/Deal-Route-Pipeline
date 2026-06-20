import { createHash } from 'node:crypto';
import {
  SourceStatus,
  type Source,
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
import { applyCrawlOutcome } from './source-policy.js';
import { CandidateSink } from './candidate-sink.js';

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
 * published; candidates are persisted in a pre-approval state (`candidate`, or
 * `in_review` when flagged) for human review. (The `Queue` port exists for the
 * job scheduler that invokes this use-case; this method writes candidates
 * directly — see the deferred follow-up to route crawl jobs through the queue.)
 */
export class CrawlSourceUseCase {
  private readonly sink: CandidateSink;

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
  ) {
    this.sink = new CandidateSink(db, clock, logger);
  }

  async execute(input: CrawlSourceInput): Promise<CrawlSourceResult> {
    const source = await this.db.sources.getById(input.sourceId);
    if (source === null) {
      throw new Error(`Source not found: ${input.sourceId}`);
    }

    // A source that hasn't been human-approved (proposed) or was explicitly
    // rejected must never be crawled — even via an explicit `crawl --source <id>`.
    // The only path to crawling such a domain is the source-promotion approval.
    // (The `--due`/`--subscription` selectors already filter to `active`.)
    if (
      source.status === SourceStatus.enum.pending_approval ||
      source.status === SourceStatus.enum.rejected
    ) {
      this.logger.warn('crawl: refusing a non-active source (needs approval first)', {
        sourceId: source.id,
        status: source.status,
      });
      const run = this.startRun(source);
      run.status = 'skipped';
      run.finished_at = this.clock.nowIso();
      run.error = `source status is "${source.status}" — not crawlable until approved`;
      if (!input.dryRun) await this.db.crawlRuns.insert(run);
      return { run, candidates: [], evidence: null, routedToManualCapture: false };
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

      // robots.txt told us not to fetch this source: skip without failing the run
      // or lowering reliability (it's a deliberate decline, not a fetch failure).
      if (fetched.outcome === 'robots_disallowed') {
        this.logger.info('crawl: skipped by robots.txt', { url: source.url });
        return await this.finishRun(run, source, [], null, true, input.dryRun ?? false);
      }

      // Only an OK fetch yields trustworthy evidence. A non-OK outcome that wasn't
      // routed to manual capture (i.e. `error`) is a contained failure: we never
      // capture empty/fake evidence or extract from empty text (evidence-required
      // invariant). Throw into the catch → run marked failed, reliability lowered.
      if (fetched.outcome !== 'ok') {
        throw new Error(
          `fetch outcome "${fetched.outcome}"${fetched.error ? `: ${fetched.error}` : ''}`,
        );
      }

      const evidence = await this.captureEvidence(fetched, input.dryRun ?? false);
      const extraction = await this.extract.execute({
        pageText: fetched.text,
        // Use the POST-REDIRECT final URL (what evidence pins as source_url), NOT the
        // configured source.url — so the extract-time dedupe key folds in the SAME
        // registrable domain the recompute-from-row sites use. A configured URL that
        // redirects cross-domain would otherwise produce a key that never matches its
        // own persisted row (silent duplicate every re-crawl). Matches the Lane B paths.
        sourceUrl: fetched.finalUrl,
        targetService: source.subscription_service,
        vocabulary: this.vocabulary,
      });
      run.cost_eur = extraction.costEur;

      if (!input.dryRun) {
        await this.sink.persist(extraction.candidates, evidence);
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
      run_kind: 'crawl',
      status: 'running',
      started_at: this.clock.nowIso(),
      finished_at: null,
      candidates_produced: 0,
      // Lane A doesn't propose sources and has no caps loop — these stay at their
      // base values for the whole run.
      proposals_produced: 0,
      cost_eur: 0,
      stopped_reason: null,
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
    // Reliability decides cadence (plan §7): a flaky source backs off so we stop
    // hammering an unreliable origin and wasting budget on it. The same shared
    // policy drives the monitor loop, so the two lanes can't diverge.
    const { source: updated, reliabilityLow } = applyCrawlOutcome(
      source,
      success,
      this.clock.now(),
    );

    // Surface a persistently-failing source so a human notices (ops signal). The
    // source keeps trying on the backed-off cadence — no auto status change in v1.
    if (reliabilityLow) {
      this.logger.warn('crawl: source reliability low — backing off cadence', {
        sourceId: source.id,
        url: source.url,
        reliability: updated.reliability_score,
        nextDue: updated.next_due,
      });
    }
    await this.db.sources.update(updated);
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

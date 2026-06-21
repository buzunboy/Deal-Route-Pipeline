import {
  extractLinks,
  hostOf,
  scoreCandidateUrl,
  normalizeUrl,
  type Vocabulary,
  type SuffixOracle,
} from '../../domain/index.js';
import type {
  Fetcher,
  EvidenceStore,
  Database,
  Clock,
  Logger,
  FetchResult,
  AgentBudget,
  ProposedSource,
} from '../ports/index.js';
import { ExtractUseCase, ExtractionFailedError } from '../extract/extract.js';
import { CandidateSink } from '../crawl/candidate-sink.js';
import { RunRecorder } from '../crawl/run-recorder.js';
import { LaneBSupport, type ProposedDomain } from './lane-b-support.js';

/**
 * How many links-ahead we keep in the frontier, as a multiple of `maxPages`. We
 * only ever fetch `maxPages`, so a few times that in queued candidates is ample
 * headroom for the best-scored pages to surface; beyond it, extra in-domain links
 * are dropped rather than growing the queue without bound on a huge site.
 */
const FRONTIER_HEADROOM = 5;

export interface DiscoverSiteInput {
  /** Seed URL to start discovery from (also defines the primary in-scope domain). */
  startUrl: string;
  /** Hard cap on pages fetched this run (alongside the €/time budget). */
  maxPages: number;
  budget: AgentBudget;
  /** When true, no DB/evidence writes — a discovery probe. */
  dryRun?: boolean;
  /**
   * True when `budget.maxCostEur` was clamped DOWN to the remaining daily-budget
   * headroom (not the configured per-run cap). Purely for the run ledger: if the
   * run then stops on that cap, it records `daily_budget_cap` rather than `cost_cap`
   * so an operator can tell the DAILY ceiling — not the per-run cap — was the binding
   * constraint. Set by the CLI from the `DailyBudgetGuard`.
   */
  dailyClamped?: boolean;
}

export interface DiscoverSiteResult {
  startUrl: string;
  pagesFetched: number;
  candidatesFound: number;
  /** Off-domain links surfaced for human approval (deduped by registrable domain). */
  proposedSources: ProposedSource[];
  routedToManualCapture: number;
  failedPages: number;
  costEur: number;
  stoppedReason: 'completed' | 'page_cap' | 'time_cap' | 'cost_cap';
}

/**
 * Lane B — bounded site discovery. Starting from one URL, crawl pages WITHIN the
 * start domain (and any already-approved/allowlisted domain), extract deal
 * candidates from each via the same path as Lane A, and surface links to NOVEL
 * domains as *proposed sources* a human must approve before they are ever crawled
 * (`docs/DealRoute_Crawl_Pipeline_Plan.md` §6 / guardrails). Never auto-publishes;
 * never follows a novel domain; respects the politeness/robots guardrails of the
 * injected `Fetcher` (a `PoliteFetcher` in production). Shared Lane-B edge logic
 * (evidence, manual capture, proposing sources) lives in `LaneBSupport`.
 *
 * The run is CAPPED three ways — max pages, max € (LLM cost), and max wall-clock —
 * and stops at the first cap hit, reporting which. Best-effort-read: captcha pages
 * route to the manual-capture queue; login/soft-block pages are read best-effort.
 */
export class DiscoverSiteUseCase {
  private readonly sink: CandidateSink;
  private readonly support: LaneBSupport;
  private readonly runs: RunRecorder;

  constructor(
    private readonly fetcher: Fetcher,
    evidenceStore: EvidenceStore,
    private readonly db: Database,
    private readonly extract: ExtractUseCase,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly vocabulary: Vocabulary,
    private readonly fetchUserAgent: string,
    private readonly fetchTimeoutMs: number,
    private readonly suffixOracle: SuffixOracle,
  ) {
    this.sink = new CandidateSink(db, clock, logger);
    this.support = new LaneBSupport(evidenceStore, db, clock, logger, suffixOracle);
    this.runs = new RunRecorder(db, clock, logger, 'discover');
  }

  async execute(input: DiscoverSiteInput): Promise<DiscoverSiteResult> {
    const dryRun = input.dryRun ?? false;
    // Lane-B run has no `sources` row (it crawls arbitrary URLs) → null source_id.
    const run = await this.runs.start(null, dryRun);

    // Declared before the try so the catch can record whatever cost/candidates
    // accrued before an aborting error (a `running` row must never dangle).
    let pagesFetched = 0;
    let candidatesFound = 0;
    let routedToManualCapture = 0;
    let failedPages = 0;
    let costEur = 0;
    let proposedCount = 0;
    let stoppedReason: DiscoverSiteResult['stoppedReason'] = 'completed';

    try {
      const allowDomains = await this.allowedDomains(input.startUrl);
      const deadlineMs = this.clock.now().getTime() + input.budget.maxSeconds * 1000;

      const queue: string[] = [normalizeUrl(input.startUrl)];
      const queued = new Set(queue);
      const visited = new Set<string>();
      const proposed = new Map<string, ProposedDomain>(); // keyed by registrable domain

      // Bound the frontier so a very large site can't grow `queue`/`queued`
      // without limit: we only ever fetch `maxPages`, so holding more than a small
      // multiple of that ahead is wasted memory. Excess in-domain links are dropped
      // (the best-scored survive the per-page sort below).
      const maxFrontier = input.maxPages * FRONTIER_HEADROOM;

      while (queue.length > 0) {
        if (pagesFetched >= input.maxPages) {
          stoppedReason = 'page_cap';
          break;
        }
        if (costEur >= input.budget.maxCostEur) {
          stoppedReason = 'cost_cap';
          break;
        }
        if (this.clock.now().getTime() >= deadlineMs) {
          stoppedReason = 'time_cap';
          break;
        }

        const url = queue.shift()!;
        if (visited.has(url)) continue;
        visited.add(url);

        let fetched: FetchResult;
        try {
          fetched = await this.fetcher.fetch(url, {
            timeoutMs: this.fetchTimeoutMs,
            userAgent: this.fetchUserAgent,
          });
        } catch (err) {
          // The Fetcher port resolves rather than throws, but contain anything that
          // slips through so one bad page never aborts the discovery run.
          failedPages++;
          this.logger.error('discovery: fetch threw, skipping page', {
            url,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        pagesFetched++;

        if (fetched.outcome === 'robots_disallowed') {
          // We chose not to fetch this (robots.txt) — skip silently, not a failure.
          this.logger.info('discovery: skipped by robots.txt', { url });
          continue;
        }
        if (this.support.isBlockedOutcome(fetched)) {
          routedToManualCapture++;
          await this.support.routeToManualCapture(url, fetched, dryRun);
          continue;
        }
        if (fetched.outcome !== 'ok' || fetched.text.trim() === '') {
          failedPages++;
          this.logger.warn('discovery: non-ok/empty page, skipping', {
            url,
            outcome: fetched.outcome,
          });
          continue;
        }

        // A redirect can land us on a DIFFERENT domain (tracker, partner microsite,
        // parked/typosquatted target). Re-check the FINAL url against the allowlist:
        // if it's off-allowlist, propose the domain for human approval and do NOT
        // extract/persist or seed its links — a human approves the source domain.
        if (!this.isAllowed(fetched.finalUrl, allowDomains)) {
          this.logger.warn('discovery: redirected off-allowlist — proposing, not extracting', {
            requested: url,
            finalUrl: fetched.finalUrl,
          });
          this.recordProposal(proposed, fetched.finalUrl, input.startUrl);
          continue;
        }

        // Re-check the €/time budget right before the (costly) extraction so a page
        // can't overshoot the cap by a full extraction after being dequeued (mirrors
        // the ingest mid-loop guard). The loop-top check alone overshoots by one.
        if (costEur >= input.budget.maxCostEur) {
          stoppedReason = 'cost_cap';
          break;
        }
        if (this.clock.now().getTime() >= deadlineMs) {
          stoppedReason = 'time_cap';
          break;
        }

        // Extract candidates from this page (same boundary-validated path as Lane A).
        try {
          const extraction = await this.extract.execute({
            pageText: fetched.text,
            sourceUrl: fetched.finalUrl,
            targetService: null,
            vocabulary: this.vocabulary,
          });
          // Cost is incurred regardless of whether the candidate persists.
          costEur += extraction.costEur;
          if (!dryRun) {
            // Evidence is captured BEFORE persisting the candidate (evidence-required
            // invariant). Dry-run writes nothing — not even evidence files.
            const evidence = await this.support.captureEvidence(fetched);
            await this.sink.persist(extraction.candidates, evidence);
          }
          // Count candidates only AFTER a successful persist (or in dry-run, where
          // there is no persist) — a failed write jumps to the catch below and the
          // page is booked as failed, so it must not also book phantom candidates.
          candidatesFound += extraction.candidates.length;
          if (extraction.candidates.length > 0) {
            this.logger.info('discovery: extracted candidates', {
              url: fetched.finalUrl,
              count: extraction.candidates.length,
            });
          }
        } catch (err) {
          failedPages++;
          // A failed extraction may still have cost money (the LLM call ran before
          // the boundary rejected its output). Credit that spend so the run's €-cap
          // and the daily guard account for it (otherwise malformed pages spend
          // budget the guard never sees).
          if (err instanceof ExtractionFailedError) costEur += err.costEur;
          this.logger.error('discovery: extraction failed, skipping page', {
            url,
            costEur: err instanceof ExtractionFailedError ? err.costEur : 0,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        // Frontier: enqueue same-site/allowlisted links; record novel domains as
        // proposed sources (never followed — human approval required).
        let added = false;
        // extractLinks already returns normalised, fragment-free absolute URLs.
        for (const link of extractLinks(fetched.html, fetched.finalUrl)) {
          if (this.isAllowed(link, allowDomains)) {
            if (!queued.has(link) && !visited.has(link) && queued.size < maxFrontier) {
              queued.add(link);
              queue.push(link);
              added = true;
            }
          } else {
            this.recordProposal(proposed, link, input.startUrl);
          }
        }
        // Keep the frontier ordered by likely-offer-page score (best first) so a
        // small page budget reaches deal pages before navigation chrome. Re-sorting
        // the frontier per page is O(n log n) but n is bounded by maxFrontier, so
        // this stays cheap; swap for a heap if budgets ever grow large.
        if (added) queue.sort((a, b) => scoreCandidateUrl(b) - scoreCandidateUrl(a));
      }

      const proposedSources = [...proposed.values()];
      proposedCount = proposedSources.length;
      if (!dryRun) await this.support.persistProposedSources(proposedSources);

      await this.runs.finish(
        run,
        {
          candidatesProduced: candidatesFound,
          proposalsProduced: proposedCount,
          costEur,
          // A cost_cap stop on a daily-clamped budget IS the daily ceiling biting —
          // record it distinctly so `stats --runs` shows why discovery stopped.
          stoppedReason:
            stoppedReason === 'cost_cap' && input.dailyClamped ? 'daily_budget_cap' : stoppedReason,
        },
        dryRun,
      );

      this.logger.info('discovery complete', {
        startUrl: input.startUrl,
        pagesFetched,
        candidatesFound,
        proposedSources: proposedCount,
        costEur,
        stoppedReason,
      });

      return {
        startUrl: input.startUrl,
        pagesFetched,
        candidatesFound,
        proposedSources,
        routedToManualCapture,
        failedPages,
        costEur,
        stoppedReason,
      };
    } catch (err) {
      // An error escaped the per-page containment (e.g. a DB read failed). Mark the
      // run failed so the `running` row never dangles, preserving accrued metrics,
      // then re-throw — the CLI surfaces the failure exactly as before.
      await this.runs.fail(
        run,
        err,
        { candidatesProduced: candidatesFound, proposalsProduced: proposedCount, costEur },
        dryRun,
      );
      throw err;
    }
  }

  /** The start domain plus every already-active registered source's domain. */
  private async allowedDomains(startUrl: string): Promise<Set<string>> {
    const allow = new Set<string>();
    const start = this.suffixOracle(startUrl);
    if (start !== null) allow.add(start);
    const active = await this.db.sources.listByStatus('active');
    for (const s of active) {
      const d = this.suffixOracle(s.url);
      if (d !== null) allow.add(d);
    }
    return allow;
  }

  private isAllowed(url: string, allowDomains: Set<string>): boolean {
    const d = this.suffixOracle(url);
    return d !== null && allowDomains.has(d);
  }

  private recordProposal(
    proposed: Map<string, ProposedDomain>,
    url: string,
    startUrl: string,
  ): void {
    const domain = this.suffixOracle(url);
    if (domain === null || proposed.has(domain)) return;
    proposed.set(domain, {
      url,
      rationale: `Linked from ${hostOf(startUrl) ?? startUrl} during discovery; novel domain requires human approval before crawling.`,
    });
  }
}

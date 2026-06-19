import {
  extractLinks,
  registrableDomain,
  hostOf,
  scoreCandidateUrl,
  normalizeUrl,
  type Vocabulary,
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
import { ExtractUseCase } from '../extract/extract.js';
import { CandidateSink } from '../crawl/candidate-sink.js';
import { LaneBSupport, type ProposedDomain } from './lane-b-support.js';

export interface DiscoverSiteInput {
  /** Seed URL to start discovery from (also defines the primary in-scope domain). */
  startUrl: string;
  /** Hard cap on pages fetched this run (alongside the €/time budget). */
  maxPages: number;
  budget: AgentBudget;
  /** When true, no DB/evidence writes — a discovery probe. */
  dryRun?: boolean;
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
 * and stops at the first cap hit, reporting which. login/captcha/anti-bot pages
 * route to the manual-capture queue (public-only v1).
 */
export class DiscoverSiteUseCase {
  private readonly sink: CandidateSink;
  private readonly support: LaneBSupport;

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
  ) {
    this.sink = new CandidateSink(db, clock, logger);
    this.support = new LaneBSupport(evidenceStore, db, clock, logger);
  }

  async execute(input: DiscoverSiteInput): Promise<DiscoverSiteResult> {
    const dryRun = input.dryRun ?? false;
    const allowDomains = await this.allowedDomains(input.startUrl);
    const deadlineMs = this.clock.now().getTime() + input.budget.maxSeconds * 1000;

    const queue: string[] = [normalizeUrl(input.startUrl)];
    const queued = new Set(queue);
    const visited = new Set<string>();
    const proposed = new Map<string, ProposedDomain>(); // keyed by registrable domain

    let pagesFetched = 0;
    let candidatesFound = 0;
    let routedToManualCapture = 0;
    let failedPages = 0;
    let costEur = 0;
    let stoppedReason: DiscoverSiteResult['stoppedReason'] = 'completed';

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

      // Extract candidates from this page (same boundary-validated path as Lane A).
      try {
        const extraction = await this.extract.execute({
          pageText: fetched.text,
          sourceUrl: fetched.finalUrl,
          targetService: null,
          vocabulary: this.vocabulary,
        });
        costEur += extraction.costEur;
        candidatesFound += extraction.candidates.length;
        if (!dryRun) {
          // Evidence is captured BEFORE persisting the candidate (evidence-required
          // invariant). Dry-run writes nothing — not even evidence files.
          const evidence = await this.support.captureEvidence(fetched);
          await this.sink.persist(extraction.candidates, evidence);
        }
        if (extraction.candidates.length > 0) {
          this.logger.info('discovery: extracted candidates', {
            url: fetched.finalUrl,
            count: extraction.candidates.length,
          });
        }
      } catch (err) {
        failedPages++;
        this.logger.error('discovery: extraction failed, skipping page', {
          url,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Frontier: enqueue same-site/allowlisted links; record novel domains as
      // proposed sources (never followed — human approval required).
      let added = false;
      // extractLinks already returns normalised, fragment-free absolute URLs.
      for (const link of extractLinks(fetched.html, fetched.finalUrl)) {
        if (this.isAllowed(link, allowDomains)) {
          if (!queued.has(link) && !visited.has(link)) {
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
      // the frontier per page is O(n log n) but n is bounded by the page budget,
      // so this stays cheap; swap for a heap if budgets ever grow large.
      if (added) queue.sort((a, b) => scoreCandidateUrl(b) - scoreCandidateUrl(a));
    }

    const proposedSources = [...proposed.values()];
    if (!dryRun) await this.support.persistProposedSources(proposedSources);

    this.logger.info('discovery complete', {
      startUrl: input.startUrl,
      pagesFetched,
      candidatesFound,
      proposedSources: proposedSources.length,
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
  }

  /** The start domain plus every already-active registered source's domain. */
  private async allowedDomains(startUrl: string): Promise<Set<string>> {
    const allow = new Set<string>();
    const start = registrableDomain(startUrl);
    if (start !== null) allow.add(start);
    const active = await this.db.sources.listByStatus('active');
    for (const s of active) {
      const d = registrableDomain(s.url);
      if (d !== null) allow.add(d);
    }
    return allow;
  }

  private isAllowed(url: string, allowDomains: Set<string>): boolean {
    const d = registrableDomain(url);
    return d !== null && allowDomains.has(d);
  }

  private recordProposal(
    proposed: Map<string, ProposedDomain>,
    url: string,
    startUrl: string,
  ): void {
    const domain = registrableDomain(url);
    if (domain === null || proposed.has(domain)) return;
    proposed.set(domain, {
      url,
      rationale: `Linked from ${hostOf(startUrl) ?? startUrl} during discovery; novel domain requires human approval before crawling.`,
    });
  }
}

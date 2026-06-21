import {
  buildBroadQueries,
  providerTokenFromUrl,
  DomainDenylist,
  InvariantViolation,
  type Vocabulary,
  type SuffixOracle,
} from '../../domain/index.js';
import type {
  EvidenceStore,
  Database,
  Clock,
  Logger,
  BrowserAgent,
  AgentBudget,
  ProposedSource,
  FetchedPage,
} from '../ports/index.js';
import { ExtractUseCase, ExtractionFailedError } from '../extract/extract.js';
import { CandidateSink } from '../crawl/candidate-sink.js';
import { RunRecorder } from '../crawl/run-recorder.js';
import { LaneBSupport, type ProposedDomain } from './lane-b-support.js';

export interface DiscoverBroadInput {
  /** Optional explicit query; when omitted, queries are built from the catalog. */
  query?: string;
  /** Hard cap on search queries this run (alongside the €/time/step budget). */
  maxQueries: number;
  budget: AgentBudget;
  dryRun?: boolean;
  /** See DiscoverSiteInput.dailyClamped — records `daily_budget_cap` distinctly. */
  dailyClamped?: boolean;
}

export interface DiscoverBroadResult {
  queriesRun: number;
  pagesFetched: number;
  candidatesFound: number;
  proposedSources: ProposedSource[];
  routedToManualCapture: number;
  failedPages: number;
  costEur: number;
  stoppedReason: 'completed' | 'step_cap' | 'time_cap' | 'cost_cap' | 'daily_budget_cap';
}

/**
 * Tier-4 — bounded agentic BROAD discovery (Phase C, C-1). Builds a query set from
 * the catalog (services) × registered provider/bundler domains, runs the injected
 * `BrowserAgent` per query within a shared `AgentBudget`, and turns the fetched
 * pages into candidates via the SAME boundary-validated path as every other lane
 * (`ExtractUseCase` + `CandidateSink`). Novel domains are surfaced as *proposed
 * sources* (`pending_approval`, never auto-crawled) via `LaneBSupport`. A
 * `crawl_runs` row (kind `discover_broad`) records candidates/proposals/cost/
 * stop-reason.
 *
 * Guardrails: bounded by `AgentBudget` (steps/seconds/€) AND the aggregate daily
 * guard (applied by the CLI); a domain DENY-LIST drops obvious noise before
 * fetching/proposing; fetches go through the agent's polite Fetcher (rate-limit always,
 * robots opt-in); captcha pages route to manual capture while login/soft-block are read
 * best-effort; the LLM does extraction only; nothing auto-publishes. Per-query/per-page
 * failures are contained so one
 * bad query never crashes the run, and the run row never dangles.
 */
export class DiscoverBroadUseCase {
  private readonly sink: CandidateSink;
  private readonly support: LaneBSupport;
  private readonly runs: RunRecorder;

  constructor(
    private readonly agent: BrowserAgent,
    evidenceStore: EvidenceStore,
    private readonly db: Database,
    private readonly extract: ExtractUseCase,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly vocabulary: Vocabulary,
    private readonly denylist: DomainDenylist,
    private readonly suffixOracle: SuffixOracle,
  ) {
    this.sink = new CandidateSink(db, clock, logger);
    this.support = new LaneBSupport(evidenceStore, db, clock, logger, suffixOracle);
    this.runs = new RunRecorder(db, clock, logger, 'discover_broad');
  }

  async execute(input: DiscoverBroadInput): Promise<DiscoverBroadResult> {
    const dryRun = input.dryRun ?? false;
    const run = await this.runs.start(null, dryRun);

    let queriesRun = 0;
    let pagesFetched = 0;
    let candidatesFound = 0;
    let routedToManualCapture = 0;
    let failedPages = 0;
    let costEur = 0;
    let proposedCount = 0;
    let stoppedReason: DiscoverBroadResult['stoppedReason'] = 'completed';

    try {
      const queries = await this.buildQueries(input);
      const deadlineMs = this.clock.now().getTime() + input.budget.maxSeconds * 1000;
      const proposed = new Map<string, ProposedDomain>(); // keyed by registrable domain
      // Domains already in the registry (any status) — excluded from proposals so
      // the returned/logged set matches what persistProposedSources actually keeps
      // (it dedups against the same registry). Loaded once up front.
      const known = await this.support.knownDomains();
      let stepsUsed = 0;

      for (const query of queries) {
        // Shared-budget guards BEFORE each query, so the run never overshoots by a
        // whole agent run after a cap is reached.
        if (stepsUsed >= input.budget.maxSteps) {
          stoppedReason = 'step_cap';
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

        // Give this query the budget headroom REMAINING for the whole run, so the
        // agent's own caps respect the shared run budget rather than a fresh one.
        const queryBudget: AgentBudget = {
          maxSteps: input.budget.maxSteps - stepsUsed,
          maxSeconds: Math.max(0, Math.ceil((deadlineMs - this.clock.now().getTime()) / 1000)),
          maxCostEur: input.budget.maxCostEur - costEur,
        };

        const result = await this.agent.run(query, queryBudget);
        queriesRun++;
        stepsUsed += result.stepsUsed;
        costEur += result.costEur;

        // Collect novel-domain proposals (deny-listed + already-known dropped here).
        for (const ps of result.proposedSources) {
          this.recordProposal(proposed, ps, known);
        }

        // Dispatch each fetched page on its outcome (the thin agent did no DB I/O).
        let pageStop: 'cost_cap' | 'time_cap' | undefined;
        for (const page of result.pages) {
          const handled = await this.handlePage(page, input, deadlineMs, costEur);
          pagesFetched += handled.pageCounted ? 1 : 0;
          candidatesFound += handled.candidates;
          routedToManualCapture += handled.routedToManual ? 1 : 0;
          failedPages += handled.failed ? 1 : 0;
          costEur += handled.extraCostEur;
          if (handled.stop) {
            pageStop = handled.stop;
            break;
          }
        }
        if (pageStop !== undefined) {
          stoppedReason = pageStop;
          break;
        }

        // Honour the agent's OWN cap: if it stopped on a budget cap (it consumed
        // the headroom we gave it), the run stopped on that cap too. An agent
        // `error` is contained — one bad query doesn't fail the whole run — but is
        // logged; the loop continues to the next query.
        if (
          result.stoppedReason === 'step_cap' ||
          result.stoppedReason === 'cost_cap' ||
          result.stoppedReason === 'time_cap'
        ) {
          stoppedReason = result.stoppedReason;
          break;
        }
        if (result.stoppedReason === 'error') {
          this.logger.warn('broad discovery: agent reported an error for a query; continuing', {
            query,
          });
        }
      }

      const proposedSources = [...proposed.values()];
      proposedCount = proposedSources.length;
      if (!dryRun) await this.support.persistProposedSources(proposedSources);

      // A cost_cap stop on a daily-clamped budget IS the daily ceiling biting (the
      // clamp only lowers maxCostEur). Map it once so the LEDGER and the RETURNED
      // result agree — the CLI prints the returned reason.
      const effectiveStop: DiscoverBroadResult['stoppedReason'] =
        stoppedReason === 'cost_cap' && input.dailyClamped ? 'daily_budget_cap' : stoppedReason;

      await this.runs.finish(
        run,
        {
          candidatesProduced: candidatesFound,
          proposalsProduced: proposedCount,
          costEur,
          stoppedReason: effectiveStop,
        },
        dryRun,
      );

      this.logger.info('broad discovery complete', {
        queriesRun,
        pagesFetched,
        candidatesFound,
        proposedSources: proposedCount,
        costEur,
        stoppedReason: effectiveStop,
      });

      return {
        queriesRun,
        pagesFetched,
        candidatesFound,
        proposedSources,
        routedToManualCapture,
        failedPages,
        costEur,
        stoppedReason: effectiveStop,
      };
    } catch (err) {
      await this.runs.fail(
        run,
        err,
        { candidatesProduced: candidatesFound, proposalsProduced: proposedCount, costEur },
        dryRun,
      );
      throw err;
    }
  }

  /**
   * Handle one fetched page: deny-listed → drop; blocked → manual capture;
   * robots/error/empty → skip; ok → extract (same boundary path) + capture
   * evidence + persist. Returns deltas + an optional stop signal (budget bit
   * before the costly extraction). Per-page failures are contained.
   */
  private async handlePage(
    page: FetchedPage,
    input: DiscoverBroadInput,
    deadlineMs: number,
    costSoFar: number,
  ): Promise<{
    pageCounted: boolean;
    candidates: number;
    routedToManual: boolean;
    failed: boolean;
    extraCostEur: number;
    stop?: 'cost_cap' | 'time_cap';
  }> {
    const dryRun = input.dryRun ?? false;
    const fetched = page.fetched;

    // Deny-listed final URL: never fetch deeper, never extract, never propose.
    if (this.denylist.isDenied(fetched.finalUrl)) {
      this.logger.info('broad discovery: dropping deny-listed page', { url: fetched.finalUrl });
      return {
        pageCounted: false,
        candidates: 0,
        routedToManual: false,
        failed: false,
        extraCostEur: 0,
      };
    }

    if (this.support.isBlockedOutcome(fetched)) {
      await this.support.routeToManualCapture(page.sourceUrl, fetched, dryRun);
      return {
        pageCounted: true,
        candidates: 0,
        routedToManual: true,
        failed: false,
        extraCostEur: 0,
      };
    }
    if (fetched.outcome !== 'ok' || fetched.text.trim() === '') {
      this.logger.warn('broad discovery: non-ok/empty page, skipping', {
        url: page.sourceUrl,
        outcome: fetched.outcome,
      });
      return {
        pageCounted: true,
        candidates: 0,
        routedToManual: false,
        failed: true,
        extraCostEur: 0,
      };
    }

    // Budget guard right before the costly extraction (mirror the discover/ingest
    // mid-loop guard) so a page can't overshoot the cap by a full extraction.
    if (costSoFar >= input.budget.maxCostEur) {
      return {
        pageCounted: true,
        candidates: 0,
        routedToManual: false,
        failed: false,
        extraCostEur: 0,
        stop: 'cost_cap',
      };
    }
    if (this.clock.now().getTime() >= deadlineMs) {
      return {
        pageCounted: true,
        candidates: 0,
        routedToManual: false,
        failed: false,
        extraCostEur: 0,
        stop: 'time_cap',
      };
    }

    try {
      const extraction = await this.extract.execute({
        pageText: fetched.text,
        sourceUrl: fetched.finalUrl,
        targetService: null,
        vocabulary: this.vocabulary,
      });
      if (!dryRun) {
        const evidence = await this.support.captureEvidence(fetched);
        await this.sink.persist(extraction.candidates, evidence);
      }
      if (extraction.candidates.length > 0) {
        this.logger.info('broad discovery: extracted candidates', {
          url: fetched.finalUrl,
          count: extraction.candidates.length,
        });
      }
      return {
        pageCounted: true,
        candidates: extraction.candidates.length,
        routedToManual: false,
        failed: false,
        extraCostEur: extraction.costEur,
      };
    } catch (err) {
      // A failed extraction may STILL have cost money (the LLM call ran before the
      // boundary rejected its output). ExtractionFailedError carries that spend so
      // the run/daily budget accounts for it — otherwise a stream of malformed
      // open-web pages would burn budget the guard never sees. Distinguish it, and
      // an incomplete-evidence skip, from a generic failure in the logs.
      const extraCostEur = err instanceof ExtractionFailedError ? err.costEur : 0;
      const isEvidenceGap = err instanceof InvariantViolation;
      this.logger.error(
        isEvidenceGap
          ? 'broad discovery: incomplete evidence, dropping page (evidence required)'
          : 'broad discovery: extraction failed, skipping page',
        {
          url: page.sourceUrl,
          costEur: extraCostEur,
          error: err instanceof Error ? err.message : String(err),
        },
      );
      return {
        pageCounted: true,
        candidates: 0,
        routedToManual: false,
        failed: true,
        extraCostEur,
      };
    }
  }

  /** Build the bounded query set: explicit query, or catalog services × providers. */
  private async buildQueries(input: DiscoverBroadInput): Promise<string[]> {
    const cap = Math.min(input.maxQueries, input.budget.maxSteps);
    if (input.query !== undefined && input.query.trim() !== '') {
      return [input.query.trim()];
    }
    const services = (await this.db.catalog.list()).map((c) => c.service);
    if (services.length === 0) {
      this.logger.warn('broad discovery: empty catalog, no queries to run');
      return [];
    }
    // Provider tokens from active provider/bundler sources' registrable domains.
    const active = await this.db.sources.listByStatus('active');
    const providerTokens = [
      ...new Set(
        active
          .filter((s) => s.type === 'provider' || s.type === 'bundler')
          .map((s) => providerTokenFromUrl(s.url, this.suffixOracle))
          .filter((t): t is string => t !== null),
      ),
    ];
    return buildBroadQueries({ services, providerTokens, maxQueries: cap });
  }

  /**
   * Record a novel-domain proposal, dropping deny-listed, already-known, and
   * within-run-duplicate domains — so the returned/logged set matches what
   * `persistProposedSources` will actually keep.
   */
  private recordProposal(
    proposed: Map<string, ProposedDomain>,
    ps: ProposedSource,
    known: Set<string>,
  ): void {
    if (this.denylist.isDenied(ps.url)) return;
    const domain = this.suffixOracle(ps.url);
    if (domain === null || known.has(domain) || proposed.has(domain)) return;
    proposed.set(domain, { url: ps.url, rationale: ps.rationale });
  }
}

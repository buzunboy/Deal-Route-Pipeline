import {
  looksRelevant,
  parseTriageResult,
  type Vocabulary,
  type Source,
  type SuffixOracle,
} from '../../domain/index.js';
import type {
  Fetcher,
  FeedReader,
  Llm,
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
import { RunRecorder } from '../crawl/run-recorder.js';
import { LaneBSupport, type ProposedDomain } from '../discover/lane-b-support.js';
import { buildTriagePrompt } from './triage-prompt.js';

export interface IngestCommunityInput {
  /** The community source (a Tier-3 registry row whose `url` is its feed URL). */
  sourceId: string;
  /** Max feed items to process this run (alongside the €/time budget). */
  maxItems: number;
  budget: AgentBudget;
  /** When true, no DB/evidence writes — an ingestion probe. */
  dryRun?: boolean;
  /**
   * True when `budget.maxCostEur` was clamped DOWN to the remaining daily-budget
   * headroom (not the configured per-run cap). If the run then stops on that cap it
   * records `daily_budget_cap` rather than `cost_cap` so the run ledger distinguishes
   * the DAILY ceiling from the per-run cap. Set by the CLI from the `DailyBudgetGuard`.
   */
  dailyClamped?: boolean;
}

export interface IngestCommunityResult {
  sourceId: string;
  feedUrl: string;
  itemsRead: number;
  itemsTriaged: number;
  itemsRelevant: number;
  candidatesFound: number;
  proposedSources: ProposedSource[];
  routedToManualCapture: number;
  failedItems: number;
  costEur: number;
  stoppedReason: 'completed' | 'item_cap' | 'time_cap' | 'cost_cap';
}

/**
 * Lane B — community ingestion (Tier 3). A community source's feed (RSS/Atom) is a
 * stream of LEADS, not offer pages. For each item we run a cheap LLM TRIAGE call
 * (is this plausibly a subscription deal for one of our catalog services?); only
 * the relevant ones get a fetch + extract via the SAME boundary-validated path as
 * Lane A. Candidates flow through the shared `CandidateSink` (dedupe / content
 * change / proposals); the underlying merchant domain is recorded as a
 * `pending_approval` source for human approval (the source-promotion loop).
 *
 * Bounded three ways — items, € (LLM cost), wall-clock — and stops at the first
 * cap. login/captcha/anti-bot pages route to manual capture; robots-disallowed are
 * skipped. Nothing auto-publishes. One bad item never aborts the run.
 */
export class IngestCommunityUseCase {
  private readonly sink: CandidateSink;
  private readonly support: LaneBSupport;
  private readonly runs: RunRecorder;

  constructor(
    private readonly fetcher: Fetcher,
    private readonly feeds: FeedReader,
    private readonly llm: Llm,
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
    this.runs = new RunRecorder(db, clock, logger, 'ingest');
  }

  async execute(input: IngestCommunityInput): Promise<IngestCommunityResult> {
    const dryRun = input.dryRun ?? false;
    const source = await this.requireSource(input.sourceId);
    // A community ingest IS scoped to a registered source row (its feed) — unlike
    // discover, which crawls arbitrary URLs — so the run is attributed to it.
    const run = await this.runs.start(source.id, dryRun);

    // Declared before the try so the catch can record whatever accrued before an
    // aborting error (a `running` row must never dangle — same as discover).
    let itemsRead = 0;
    let itemsTriaged = 0;
    let itemsRelevant = 0;
    let candidatesFound = 0;
    let routedToManualCapture = 0;
    let failedItems = 0;
    let costEur = 0;
    let proposedCount = 0;
    let stoppedReason: IngestCommunityResult['stoppedReason'] = 'completed';

    try {
      const services = (await this.db.catalog.list()).map((c) => c.service);
      const deadlineMs = this.clock.now().getTime() + input.budget.maxSeconds * 1000;

      const items = await this.feeds.read(source.url, {
        timeoutMs: this.fetchTimeoutMs,
        userAgent: this.fetchUserAgent,
      });
      itemsRead = items.length;
      this.logger.info('community feed read', { feedUrl: source.url, items: items.length });

      // Without a catalog there's nothing to match leads against — triaging the
      // whole firehose would just burn budget. Short-circuit (run `seed-import`).
      if (services.length === 0) {
        this.logger.warn('community ingestion skipped: catalog is empty (run seed-import)', {
          sourceId: source.id,
        });
        await this.runs.finish(
          run,
          { candidatesProduced: 0, proposalsProduced: 0, costEur: 0, stoppedReason: 'completed' },
          dryRun,
        );
        return {
          sourceId: source.id,
          feedUrl: source.url,
          itemsRead,
          itemsTriaged: 0,
          itemsRelevant: 0,
          candidatesFound: 0,
          proposedSources: [],
          routedToManualCapture: 0,
          failedItems: 0,
          costEur: 0,
          stoppedReason: 'completed',
        };
      }

      // Domains already in the registry → never re-propose (only NOVEL merchants
      // surface for approval, matching DiscoverSiteUseCase's guardrail).
      const knownDomains = await this.support.knownDomains();
      const proposed = new Map<string, ProposedDomain>();
      let processed = 0;

      for (const item of items) {
        if (processed >= input.maxItems) {
          stoppedReason = 'item_cap';
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
        processed++;

        // Cheap pre-filter (no LLM): obvious non-matches never cost a triage call.
        const haystack = `${item.title} ${item.summary}`;
        if (!looksRelevant(haystack, services)) continue;

        // Triage (LLM): is this plausibly a subscription deal for a catalog service?
        itemsTriaged++;
        let relevant: boolean;
        try {
          const { system, user } = buildTriagePrompt({ item, catalogServices: services });
          const resp = await this.llm.complete({
            role: 'discovery',
            system,
            user,
            jsonMode: true,
          });
          costEur += resp.usage.costEur;
          relevant = parseTriageResult(resp.text).relevant;
        } catch (err) {
          failedItems++;
          this.logger.warn('ingest: triage failed, skipping item', {
            link: item.link,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        if (!relevant) continue;
        itemsRelevant++;

        // Relevant lead → fetch the linked page and extract (Lane A path).
        const outcome = await this.processLead(
          item.link,
          dryRun,
          input.budget,
          costEur,
          deadlineMs,
        );
        candidatesFound += outcome.candidates;
        routedToManualCapture += outcome.manualCapture;
        failedItems += outcome.failed;
        costEur += outcome.costEur;

        // Propose the merchant domain for approval — only if it's genuinely novel
        // (not already a known/active/pending source). Matches Discover's guardrail.
        this.recordProposal(proposed, knownDomains, item.link, source.url);
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
          // record it distinctly so `stats --runs` shows the binding constraint.
          stoppedReason:
            stoppedReason === 'cost_cap' && input.dailyClamped ? 'daily_budget_cap' : stoppedReason,
        },
        dryRun,
      );

      this.logger.info('community ingestion complete', {
        sourceId: source.id,
        itemsRead,
        itemsRelevant,
        candidatesFound,
        proposedSources: proposedCount,
        costEur,
        stoppedReason,
      });

      return {
        sourceId: source.id,
        feedUrl: source.url,
        itemsRead,
        itemsTriaged,
        itemsRelevant,
        candidatesFound,
        proposedSources,
        routedToManualCapture,
        failedItems,
        costEur,
        stoppedReason,
      };
    } catch (err) {
      // An error escaped per-item containment (e.g. the feed read or a DB read
      // failed). Mark the run failed so the `running` row never dangles, preserving
      // accrued metrics, then re-throw — the CLI's per-source guard logs & continues.
      await this.runs.fail(
        run,
        err,
        { candidatesProduced: candidatesFound, proposalsProduced: proposedCount, costEur },
        dryRun,
      );
      throw err;
    }
  }

  private async processLead(
    link: string,
    dryRun: boolean,
    budget: AgentBudget,
    spentSoFar: number,
    deadlineMs: number,
  ): Promise<{ candidates: number; manualCapture: number; failed: number; costEur: number }> {
    let fetched: FetchResult;
    try {
      fetched = await this.fetcher.fetch(link, {
        timeoutMs: this.fetchTimeoutMs,
        userAgent: this.fetchUserAgent,
      });
    } catch (err) {
      this.logger.error('ingest: fetch threw, skipping lead', {
        link,
        error: err instanceof Error ? err.message : String(err),
      });
      return { candidates: 0, manualCapture: 0, failed: 1, costEur: 0 };
    }

    if (fetched.outcome === 'robots_disallowed') {
      this.logger.info('ingest: lead skipped by robots.txt', { link });
      return { candidates: 0, manualCapture: 0, failed: 0, costEur: 0 };
    }
    if (this.support.isBlockedOutcome(fetched)) {
      await this.support.routeToManualCapture(link, fetched, dryRun);
      return { candidates: 0, manualCapture: 1, failed: 0, costEur: 0 };
    }
    if (fetched.outcome !== 'ok' || fetched.text.trim() === '') {
      return { candidates: 0, manualCapture: 0, failed: 1, costEur: 0 };
    }

    // Re-check the budget right before the (costly) extraction so a relevant lead
    // can't overshoot the € / time cap by a full extraction after triage.
    if (spentSoFar >= budget.maxCostEur || this.clock.now().getTime() >= deadlineMs) {
      this.logger.info('ingest: budget reached, skipping extraction for lead', { link });
      return { candidates: 0, manualCapture: 0, failed: 0, costEur: 0 };
    }

    try {
      const extraction = await this.extract.execute({
        pageText: fetched.text,
        sourceUrl: fetched.finalUrl,
        targetService: null,
        vocabulary: this.vocabulary,
      });
      if (!dryRun) {
        // Evidence captured BEFORE persisting the candidate (evidence-required).
        const evidence = await this.support.captureEvidence(fetched);
        await this.sink.persist(extraction.candidates, evidence);
      }
      return {
        candidates: extraction.candidates.length,
        manualCapture: 0,
        failed: 0,
        costEur: extraction.costEur,
      };
    } catch (err) {
      this.logger.error('ingest: extraction failed, skipping lead', {
        link,
        error: err instanceof Error ? err.message : String(err),
      });
      return { candidates: 0, manualCapture: 0, failed: 1, costEur: 0 };
    }
  }

  /** Record a NOVEL merchant domain for human approval (skips already-known ones). */
  private recordProposal(
    proposed: Map<string, ProposedDomain>,
    knownDomains: Set<string>,
    url: string,
    feedUrl: string,
  ): void {
    const domain = this.suffixOracle(url);
    if (domain === null || proposed.has(domain) || knownDomains.has(domain)) return;
    proposed.set(domain, {
      url,
      rationale: `Surfaced via the community feed ${feedUrl}; novel merchant domain requires human approval before crawling.`,
    });
  }

  private async requireSource(sourceId: string): Promise<Source> {
    const source = await this.db.sources.getById(sourceId);
    if (source === null) throw new Error(`Source not found: ${sourceId}`);
    return source;
  }
}

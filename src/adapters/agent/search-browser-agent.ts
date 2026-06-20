import type {
  BrowserAgent,
  AgentBudget,
  AgentRunResult,
  FetchedPage,
  FetchResult,
  ProposedSource,
  SearchProvider,
  SearchResult,
  Fetcher,
  Logger,
  Clock,
} from '../../application/ports/index.js';
import type { SuffixOracle } from '../../domain/index.js';
import { resolveScreenshotBytes } from '../shared/screenshot-download.js';

/**
 * Search-API-first `BrowserAgent` (Phase C, stage C-1). Implements the bounded
 * agentic lane WITHOUT a heavy browser: for a query it runs one search via the
 * injected `SearchProvider`, then fetches the top results through the injected
 * (polite) `Fetcher` — public-only, robots-respecting, rate-limited. It returns
 * the fetched page material + the novel domains it saw, and consumes no LLM: it
 * is THIN (navigation only). Extraction stays in `ExtractUseCase` in the
 * use-case, so the same trust gate applies and nothing auto-publishes.
 *
 * Selected via `AGENT=search`; `AGENT=noop` (the default off-switch) keeps Tier-4
 * dark until explicitly enabled. Substitutable behind the `BrowserAgent` port so
 * a future real-browser agent (C-2) slots in without touching callers.
 *
 * Bounded by `AgentBudget`: `maxSteps` = result pages fetched, `maxSeconds` = a
 * wall-clock deadline, `maxCostEur` = the agent's OWN spend (the search call;
 * the dominant extraction cost is charged + capped in the use-case). Stops at the
 * first cap and reports which.
 */
export class SearchBrowserAgent implements BrowserAgent {
  constructor(
    private readonly search: SearchProvider,
    private readonly fetcher: Fetcher,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly suffixOracle: SuffixOracle,
    private readonly opts: {
      resultsPerQuery: number;
      country: string;
      searchTimeoutMs: number;
      fetchTimeoutMs: number;
      userAgent: string;
      /** Estimated € cost of a single search call (for the agent's own budget). */
      searchCostEur: number;
      /**
       * Ask the search provider for inline page content (Firecrawl v2 search-scrape)
       * and reuse it instead of a second full fetch — gated by OUR robots/rate-limit
       * via `fetcher.checkAccess` so the public-only invariant still holds. Off by
       * default; only providers that support it populate `SearchResult.content`.
       */
      inlineScrape?: boolean;
    },
  ) {}

  async run(query: string, budget: AgentBudget): Promise<AgentRunResult> {
    const deadline = this.clock.now().getTime() + budget.maxSeconds * 1000;
    const pages: FetchedPage[] = [];
    const proposedSources: ProposedSource[] = [];
    const proposedDomains = new Set<string>();
    let stepsUsed = 0;
    let costEur = 0;
    let stoppedReason: AgentRunResult['stoppedReason'] = 'completed';

    const recordProposal = (url: string): void => {
      const domain = this.suffixOracle(url);
      if (domain === null || proposedDomains.has(domain)) return;
      proposedDomains.add(domain);
      proposedSources.push({
        url,
        rationale: `Surfaced by Tier-4 broad-discovery search for "${query}".`,
      });
    };

    try {
      if (budget.maxSteps <= 0) {
        return { pages, proposedSources, stepsUsed, costEur, stoppedReason: 'step_cap' };
      }

      // Search for the full result set; the fetch loop below enforces maxSteps so
      // a binding step budget reports `step_cap` (more results existed than we
      // fetched), rather than a misleading `completed`.
      const results = await this.search.search(query, {
        limit: this.opts.resultsPerQuery,
        country: this.opts.country,
        timeoutMs: this.opts.searchTimeoutMs,
        scrape: this.opts.inlineScrape === true,
      });
      costEur += this.opts.searchCostEur;
      if (costEur > budget.maxCostEur) {
        return { pages, proposedSources, stepsUsed, costEur, stoppedReason: 'cost_cap' };
      }

      for (const result of results) {
        // Mid-loop caps: stop BEFORE the next fetch so we never overshoot by one.
        if (stepsUsed >= budget.maxSteps) {
          stoppedReason = 'step_cap';
          break;
        }
        if (this.clock.now().getTime() >= deadline) {
          stoppedReason = 'time_cap';
          break;
        }
        if (costEur >= budget.maxCostEur) {
          stoppedReason = 'cost_cap';
          break;
        }

        // Every result domain is novel-by-default — proposed for human approval,
        // never auto-crawled. (knownDomains dedupe happens in the use-case.)
        recordProposal(result.url);

        const fetched = await this.obtainPage(result);
        stepsUsed += 1;

        // Carry every fetched page (with its outcome) back; the use-case dispatches
        // on outcome (ok → extract+evidence; blocked → manual capture; else skip).
        // robots_disallowed pages carry no content and need no handling, so drop them.
        if (fetched.outcome !== 'robots_disallowed') {
          pages.push({ sourceUrl: fetched.finalUrl, fetched });
        }
      }
    } catch (err) {
      this.logger.error('search agent run failed', {
        query,
        error: err instanceof Error ? err.message : String(err),
      });
      return { pages, proposedSources, stepsUsed, costEur, stoppedReason: 'error' };
    }

    return { pages, proposedSources, stepsUsed, costEur, stoppedReason };
  }

  /**
   * Get page material for a search result, preferring the provider's inline scrape
   * when available (saves a second full fetch) and falling back to a real
   * `fetcher.fetch()` otherwise.
   *
   * TRUST-CRITICAL: inline content was fetched by the SEARCH PROVIDER, not our
   * PoliteFetcher — so before using it we apply OUR access gate via
   * `fetcher.checkAccess` (robots + rate-limit). If our robots policy forbids the
   * URL we return `robots_disallowed` and discard the inline content (the
   * public-only invariant holds regardless of who fetched). We also require a
   * resolvable screenshot → bytes, because evidence is required before any
   * candidate; if the inline screenshot can't be resolved we fall back to a normal
   * fetch (which captures its own screenshot) rather than emit an evidence-less ok page.
   */
  private async obtainPage(result: SearchResult): Promise<FetchResult> {
    const fetchOpts = { timeoutMs: this.opts.fetchTimeoutMs, userAgent: this.opts.userAgent };

    const inline = result.content;
    const canGate = typeof this.fetcher.checkAccess === 'function';
    if (this.opts.inlineScrape && inline && inline.text.trim() !== '' && canGate) {
      // Authoritative robots/rate-limit gate on the result URL (no body fetch).
      const access = await this.fetcher.checkAccess!(result.url);
      if (access === 'robots_disallowed') {
        return outcomeOnly('robots_disallowed', result.url);
      }
      // Evidence requires a real screenshot; resolve the inline ref to bytes.
      const screenshot = await resolveScreenshotBytes(
        inline.screenshotRef,
        this.opts.fetchTimeoutMs,
      );
      if (screenshot !== null) {
        this.logger.debug('search agent: using inline search-scrape content', { url: result.url });
        return {
          outcome: 'ok',
          url: result.url,
          finalUrl: result.url,
          text: inline.text,
          html: inline.html,
          screenshot,
        };
      }
      // No usable inline screenshot → fall through to a normal fetch (captures one).
      this.logger.debug('search agent: inline scrape lacked a usable screenshot; fetching', {
        url: result.url,
      });
    }

    return this.fetcher.fetch(result.url, fetchOpts);
  }
}

function outcomeOnly(outcome: FetchResult['outcome'], url: string): FetchResult {
  return { outcome, url, finalUrl: url, text: '', html: '', screenshot: new Uint8Array() };
}

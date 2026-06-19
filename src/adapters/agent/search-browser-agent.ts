import type {
  BrowserAgent,
  AgentBudget,
  AgentRunResult,
  FetchedPage,
  ProposedSource,
  SearchProvider,
  Fetcher,
  Logger,
  Clock,
} from '../../application/ports/index.js';
import { registrableDomain } from '../../domain/index.js';

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
    private readonly opts: {
      resultsPerQuery: number;
      country: string;
      searchTimeoutMs: number;
      fetchTimeoutMs: number;
      userAgent: string;
      /** Estimated € cost of a single search call (for the agent's own budget). */
      searchCostEur: number;
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
      const domain = registrableDomain(url);
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

        const fetched = await this.fetcher.fetch(result.url, {
          timeoutMs: this.opts.fetchTimeoutMs,
          userAgent: this.opts.userAgent,
        });
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
}

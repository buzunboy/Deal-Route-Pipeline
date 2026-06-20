import { Container } from '../../../composition/container.js';
import type { Config } from '../../../config/index.js';

/**
 * `discover --broad [query] [--max-steps N] [--max-queries N] [--dry-run]` —
 * Tier-4 agentic BROAD discovery (Phase C, C-1). Runs a bounded set of open-web
 * searches (built from the catalog, or one explicit query) through the configured
 * BrowserAgent, extracts candidates from the public pages it fetches, and proposes
 * novel domains for human approval. Capped by steps, € (LLM cost), and wall-clock
 * (AGENT_* env) AND the aggregate daily €-budget. Nothing auto-publishes; no
 * discovered domain is crawled without approval.
 *
 * Requires `AGENT=search` (the default `AGENT=noop` runs nothing — this surfaces
 * a clear hint rather than silently doing zero work).
 */
export interface DiscoverBroadArgs {
  query?: string;
  maxSteps?: number;
  maxQueries?: number;
  dryRun: boolean;
}

export async function discoverBroad(config: Config, args: DiscoverBroadArgs): Promise<void> {
  if (config.agent.kind === 'noop') {
    console.log(
      'Broad discovery is disabled (AGENT=noop). Set AGENT=search (and a search backend: ' +
        'SEARCH_API_KEY for Brave, or SEARCH_PROVIDER=firecrawl) to enable Tier-4 discovery.',
    );
    return;
  }

  const container = new Container(config, { usePersistence: !args.dryRun });
  try {
    const maxSteps = args.maxSteps ?? config.agent.maxSteps;
    const maxQueries = args.maxQueries ?? config.discovery.maxQueries;

    // Aggregate daily €-budget guard: refuse to start (and clamp this run's €-cap
    // to the budget left today). Dry-run logs no cost, so it's exempt.
    let runCostCap = config.agent.maxCostEur;
    if (!args.dryRun) {
      const budget = await container.dailyBudgetGuard.check();
      if (!budget.ok) {
        console.log(
          `Daily budget reached (€${budget.spentTodayEur.toFixed(2)} spent today, ` +
            `ceiling €${config.agent.dailyBudgetEur}) — not starting broad discovery.`,
        );
        return;
      }
      runCostCap = container.dailyBudgetGuard.effectiveCostCap(
        config.agent.maxCostEur,
        budget.spentTodayEur,
      );
    }

    console.log(
      `Broad discovery${args.query ? ` for "${args.query}"` : ' (catalog-driven)'}` +
        `${args.dryRun ? ' (dry-run)' : ''} — caps: ${maxQueries} queries, ${maxSteps} steps, ` +
        `€${runCostCap.toFixed(2)}, ${config.agent.maxSeconds}s`,
    );

    const result = await container.discoverBroad.execute({
      query: args.query,
      maxQueries,
      budget: {
        maxSteps,
        maxSeconds: config.agent.maxSeconds,
        maxCostEur: runCostCap,
      },
      dailyClamped: runCostCap < config.agent.maxCostEur,
      dryRun: args.dryRun,
    });

    console.log(
      `\nDone (${result.stoppedReason}). queries=${result.queriesRun} ` +
        `pages=${result.pagesFetched} candidates=${result.candidatesFound} ` +
        `manual-capture=${result.routedToManualCapture} failed=${result.failedPages} ` +
        `cost=€${result.costEur.toFixed(6)}`,
    );

    if (result.proposedSources.length > 0) {
      console.log(
        `\nProposed ${result.proposedSources.length} novel source domain(s) ` +
          `(pending human approval — NOT crawled):`,
      );
      for (const p of result.proposedSources) {
        console.log(`  - ${p.url}`);
      }
    }

    if (args.dryRun) {
      console.log('\nDry-run: nothing was written to the database or evidence store.');
    } else {
      console.log(
        '\nCandidates are in the review queue (in_review/candidate); approve via `review`/the API. ' +
          'Proposed sources await approval before any crawl.',
      );
    }
  } finally {
    await container.shutdown();
  }
}

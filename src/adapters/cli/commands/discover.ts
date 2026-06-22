import { Container } from '../../../composition/container.js';
import type { Config } from '../../../config/index.js';

/**
 * `discover <url> [--max-pages N] [--dry-run]` — Lane B bounded site discovery.
 *
 * Crawls within the start domain (and already-approved domains), extracts deal
 * candidates from each page, and surfaces links to NOVEL domains as proposed
 * sources for human approval. Capped by pages, € (LLM cost), and wall-clock
 * (AGENT_* env). `--dry-run` writes nothing. Nothing auto-publishes.
 */
export interface DiscoverArgs {
  startUrl?: string;
  maxPages?: number;
  dryRun: boolean;
}

export async function discover(config: Config, args: DiscoverArgs): Promise<void> {
  if (!args.startUrl) {
    console.error('discover requires a <url> to start from.');
    process.exitCode = 1;
    return;
  }

  // Dry-run uses in-memory adapters so it needs no Postgres.
  const container = new Container(config, { usePersistence: !args.dryRun });
  await container.init(); // adopt a queued daily budget on deploy (ACR-10 Settings)
  try {
    const maxPages = args.maxPages ?? config.agent.maxSteps;

    // Aggregate daily €-budget guard: refuse to start (and clamp this run's €-cap
    // to the budget left today) so a discovery run can't push past the daily
    // ceiling. Dry-run logs no cost, so it's exempt. Disabled when DAILY_BUDGET_EUR=0.
    let runCostCap = config.agent.maxCostEur;
    if (!args.dryRun) {
      const budget = await container.dailyBudgetGuard.check();
      if (!budget.ok) {
        console.log(
          `Daily budget reached (€${budget.spentTodayEur.toFixed(2)} spent today, ` +
            `ceiling €${config.agent.dailyBudgetEur}) — not starting discovery.`,
        );
        return;
      }
      runCostCap = container.dailyBudgetGuard.effectiveCostCap(
        config.agent.maxCostEur,
        budget.spentTodayEur,
      );
    }

    console.log(
      `Discovering from ${args.startUrl}${args.dryRun ? ' (dry-run)' : ''} ` +
        `— caps: ${maxPages} pages, €${runCostCap.toFixed(2)}, ${config.agent.maxSeconds}s`,
    );

    const result = await container.discoverSite.execute({
      startUrl: args.startUrl,
      maxPages,
      budget: {
        maxSteps: maxPages,
        maxSeconds: config.agent.maxSeconds,
        maxCostEur: runCostCap,
      },
      // Tell the run ledger when this run's €-cap was the daily headroom (not the
      // per-run cap), so a cost_cap stop records as daily_budget_cap.
      dailyClamped: runCostCap < config.agent.maxCostEur,
      dryRun: args.dryRun,
    });

    console.log(
      `\nDone (${result.stoppedReason}). pages=${result.pagesFetched} ` +
        `candidates=${result.candidatesFound} ` +
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
      if (result.proposedSources.length > 0) {
        console.log(
          'Note: dry-run uses an empty in-memory registry, so the allowlist is just the start ' +
            'domain — proposed domains are NOT deduped against your live sources and some may ' +
            'already be registered. Run without --dry-run for the accurate proposal set.',
        );
      }
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

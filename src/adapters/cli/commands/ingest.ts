import { Container } from '../../../composition/container.js';
import type { Config } from '../../../config/index.js';

/**
 * `ingest --source <id> | --community-due [--max-items N] [--dry-run]` — Lane B
 * Tier-3 community ingestion: read a community source's RSS feed, triage each
 * item (cheap LLM), fetch + extract the relevant leads, and propose the merchant
 * domains for approval. Capped by items/€/time; nothing auto-publishes.
 */
export interface IngestArgs {
  sourceId?: string;
  /** Run every community (tier-3) source currently due. */
  due?: boolean;
  maxItems?: number;
  dryRun: boolean;
}

export async function ingest(config: Config, args: IngestArgs): Promise<void> {
  const container = new Container(config, { usePersistence: !args.dryRun });
  try {
    const sourceIds = await resolveSourceIds(container, args);
    if (sourceIds.length === 0) {
      console.log('No community sources to ingest (use --source <id> or --community-due).');
      return;
    }
    const maxItems = args.maxItems ?? config.agent.maxSteps;
    console.log(
      `Ingesting ${sourceIds.length} community source(s)${args.dryRun ? ' (dry-run)' : ''} ` +
        `— caps: ${maxItems} items, €${config.agent.maxCostEur}, ${config.agent.maxSeconds}s each`,
    );

    let candidates = 0;
    let relevant = 0;
    let manual = 0;
    let proposed = 0;
    let budgetStopped = false;
    for (const id of sourceIds) {
      // Aggregate daily €-budget guard: stop the batch before starting a run once
      // today's total run cost has reached the ceiling (a runaway day can't blow
      // cost even if each run stays under its per-run cap). Dry-run skips it (no
      // cost is logged). Disabled when DAILY_BUDGET_EUR=0.
      let runCostCap = config.agent.maxCostEur;
      if (!args.dryRun) {
        const budget = await container.dailyBudgetGuard.check();
        if (!budget.ok) {
          budgetStopped = true;
          console.log(
            `\nStopped early: daily budget reached ` +
              `(€${budget.spentTodayEur.toFixed(2)} spent today, ceiling €${config.agent.dailyBudgetEur}).`,
          );
          break;
        }
        // Clamp this run's €-cap to the budget left today so a single source can't
        // overshoot the daily ceiling either.
        runCostCap = container.dailyBudgetGuard.effectiveCostCap(
          config.agent.maxCostEur,
          budget.spentTodayEur,
        );
      }
      // Per-source isolation: one bad feed never aborts the batch.
      try {
        const r = await container.ingestCommunity.execute({
          sourceId: id,
          maxItems,
          budget: {
            maxSteps: maxItems,
            maxSeconds: config.agent.maxSeconds,
            maxCostEur: runCostCap,
          },
          // Tell the run ledger when this run's €-cap was the daily headroom (not the
          // per-run cap), so a cost_cap stop records as daily_budget_cap.
          dailyClamped: runCostCap < config.agent.maxCostEur,
          dryRun: args.dryRun,
        });
        candidates += r.candidatesFound;
        relevant += r.itemsRelevant;
        manual += r.routedToManualCapture;
        proposed += r.proposedSources.length;
      } catch (err) {
        container.logger.error('ingest: source failed, continuing batch', {
          sourceId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    console.log(
      `\nDone${budgetStopped ? ' (budget-stopped)' : ''}. relevant-leads=${relevant} ` +
        `candidates=${candidates} manual-capture=${manual} proposed-sources=${proposed}`,
    );
    console.log(
      args.dryRun
        ? '\nDry-run: nothing was written.'
        : '\nCandidates are in the review queue; proposed sources await approval.',
    );
  } finally {
    await container.shutdown();
  }
}

async function resolveSourceIds(container: Container, args: IngestArgs): Promise<string[]> {
  if (args.sourceId) return [args.sourceId];
  if (args.due) {
    const due = await container.db.sources.listDue(container.clock.now(), 100);
    return due.filter((s) => s.type === 'community').map((s) => s.id);
  }
  return [];
}

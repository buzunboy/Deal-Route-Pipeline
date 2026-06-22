import { Container } from '../../../composition/container.js';
import type { Config } from '../../../config/index.js';

/**
 * `monitor --source <id>` / `monitor --due` — re-verify one source or every due
 * source: diff price/terms, re-queue on change (keeping old evidence), auto-expire
 * on disappearance.
 */
export interface MonitorArgs {
  sourceId?: string;
  due?: boolean;
}

export async function monitor(config: Config, args: MonitorArgs): Promise<void> {
  const container = new Container(config, { usePersistence: true });
  await container.init(); // adopt a queued daily budget on deploy (ACR-10 Settings)
  try {
    const ids = args.sourceId
      ? [args.sourceId]
      : (await container.db.sources.listDue(container.clock.now(), 100)).map((s) => s.id);

    if (ids.length === 0) {
      console.log('No sources to monitor.');
      return;
    }
    console.log(`Monitoring ${ids.length} source(s)...`);

    let changed = 0;
    let expired = 0;
    let blocked = 0;
    let failed = 0;
    let budgetStopped = false;
    for (const id of ids) {
      // Aggregate daily €-budget guard: a monitor pass makes no LLM call itself, but
      // a content_changed result re-crawls via CrawlSource — a paid Lane-A run that
      // logs cost on crawl_runs. So an unattended monitor batch can push past the
      // daily ceiling; stop before processing more sources once it's reached. (No
      // per-run €-cap to clamp here — the re-crawl respects its own caps; this is
      // just the batch-level stop, mirroring ingest/discover.) Disabled at 0.
      const budget = await container.dailyBudgetGuard.check();
      if (!budget.ok) {
        budgetStopped = true;
        console.log(
          `\nStopped early: daily budget reached (€${budget.spentTodayEur.toFixed(2)} spent today, ` +
            `ceiling €${config.agent.dailyBudgetEur}).`,
        );
        break;
      }

      // Per-source isolation: one bad source must never abort the batch
      // (`architecture.md`: a failed source is logged and never crashes the run).
      try {
        const result = await container.monitor.execute({ sourceId: id });
        if (result.change.kind === 'content_changed') changed++;
        if (result.routedToManualCapture) blocked++;
        expired += result.expired;
      } catch (err) {
        failed++;
        container.logger.error('monitor: source failed, continuing batch', {
          sourceId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    console.log(
      `\nDone${budgetStopped ? ' (budget-stopped)' : ''}. ` +
        `re-queued=${changed} expired=${expired} manual-capture=${blocked} failed=${failed}.`,
    );
  } finally {
    await container.shutdown();
  }
}

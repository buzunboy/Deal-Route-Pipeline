import { Container } from '../../../composition/container.js';
import type { Config } from '../../../config/index.js';

/**
 * `crawl --source <id>` / `crawl --subscription <name>` / `crawl --due` —
 * run the deterministic Lane-A pipeline for one source, all sources of a
 * subscription, or every source currently due. Persists candidates (unless
 * --dry-run). Each source failure is contained; the batch continues.
 */
export interface CrawlArgs {
  sourceId?: string;
  subscription?: string;
  due?: boolean;
  dryRun: boolean;
}

export async function crawl(config: Config, args: CrawlArgs): Promise<void> {
  const container = new Container(config, { usePersistence: !args.dryRun });
  try {
    const sourceIds = await resolveSourceIds(container, args);
    if (sourceIds.length === 0) {
      console.log('No matching sources to crawl.');
      return;
    }
    console.log(`Crawling ${sourceIds.length} source(s)${args.dryRun ? ' (dry-run)' : ''}...`);

    let candidates = 0;
    let manual = 0;
    let failed = 0;
    for (const id of sourceIds) {
      const result = await container.crawlSource.execute({ sourceId: id, dryRun: args.dryRun });
      candidates += result.candidates.length;
      if (result.routedToManualCapture) manual++;
      if (result.run.status === 'failed') failed++;
    }
    console.log(
      `\nDone. candidates=${candidates} manual-capture=${manual} failed=${failed} of ${sourceIds.length} sources.`,
    );
  } finally {
    await container.shutdown();
  }
}

async function resolveSourceIds(container: Container, args: CrawlArgs): Promise<string[]> {
  if (args.sourceId) return [args.sourceId];
  if (args.due) {
    const due = await container.db.sources.listDue(container.clock.now(), 100);
    return due.map((s) => s.id);
  }
  if (args.subscription) {
    const active = await container.db.sources.listByStatus('active');
    return active
      .filter((s) => s.subscription_service?.toLowerCase() === args.subscription!.toLowerCase())
      .map((s) => s.id);
  }
  return [];
}

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
    for (const id of ids) {
      const result = await container.monitor.execute({ sourceId: id });
      if (result.change.kind === 'content_changed') changed++;
      if (result.change.kind === 'disappeared') expired++;
    }
    console.log(`\nDone. changed/re-queued=${changed} disappeared/expired=${expired}.`);
  } finally {
    await container.shutdown();
  }
}

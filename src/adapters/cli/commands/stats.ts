import { Container } from '../../../composition/container.js';
import type { Config } from '../../../config/index.js';

/**
 * `stats [--since YYYY-MM-DD] [--until YYYY-MM-DD]` — aggregate the per-run
 * `crawl_runs.cost_eur` already logged by the pipeline into a cost summary (total,
 * per UTC day, per source). The window is half-open: `since` inclusive, `until`
 * exclusive (each is a UTC-midnight Date validated by main.ts before we get here).
 * Read-only; prints to the console.
 */
export async function stats(config: Config, args: { since?: Date; until?: Date }): Promise<void> {
  const container = new Container(config, { usePersistence: true });
  try {
    const s = await container.metrics.costSummary(args);

    const since = args.since ? args.since.toISOString().slice(0, 10) : '(all)';
    const until = args.until ? args.until.toISOString().slice(0, 10) : '(open)';
    console.log(`Cost window: ${since} .. ${until}  (since inclusive, until exclusive)`);
    console.log(`Total: €${s.total_eur.toFixed(2)} over ${s.run_count} run(s)\n`);

    console.log('Per day:');
    if (s.per_day.length === 0) {
      console.log('  (none)');
    } else {
      for (const d of s.per_day) {
        console.log(`  ${d.day}  €${d.cost_eur.toFixed(2)}  (${d.run_count} runs)`);
      }
    }

    console.log('\nPer source:');
    if (s.per_source.length === 0) {
      console.log('  (none)');
    } else {
      for (const src of s.per_source) {
        console.log(`  ${src.source_id}  €${src.cost_eur.toFixed(2)}  (${src.run_count} runs)`);
      }
    }
  } finally {
    await container.shutdown();
  }
}

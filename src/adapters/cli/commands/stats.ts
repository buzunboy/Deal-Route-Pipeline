import { Container } from '../../../composition/container.js';
import { DEFAULT_RUNS_LIMIT } from '../../../application/index.js';
import type { Config } from '../../../config/index.js';

/**
 * `stats [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--runs]` — aggregate the
 * per-run `crawl_runs.cost_eur` already logged by the pipeline into a cost summary
 * (total, per UTC day, per source), and with `--runs` also list recent runs
 * (kind/status/candidates/proposals/cost/stop-reason). The window is half-open:
 * `since` inclusive, `until` exclusive (each a UTC-midnight Date validated by
 * main.ts before we get here). Read-only; prints to the console.
 */
export async function stats(
  config: Config,
  args: { since?: Date; until?: Date; runs?: boolean },
): Promise<void> {
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

    if (args.runs) {
      const runs = await container.metrics.recentRuns(args);
      // The use-case caps at DEFAULT_RUNS_LIMIT (50); if we got exactly that many the
      // list may be truncated, so say so rather than implying it's the complete set.
      const truncated = runs.length === DEFAULT_RUNS_LIMIT ? ' — capped, may be more' : '';
      console.log(`\nRecent runs (newest first, ${runs.length}${truncated}):`);
      if (runs.length === 0) {
        console.log('  (none)');
      } else {
        for (const r of runs) {
          const when = r.started_at.slice(0, 19).replace('T', ' ');
          const stop = r.stopped_reason ?? (r.error ? `error: ${r.error}` : '-');
          console.log(
            `  ${when}  ${r.run_kind.padEnd(8)} ${r.status.padEnd(9)} ` +
              `cand=${r.candidates_produced} prop=${r.proposals_produced} ` +
              `€${r.cost_eur.toFixed(4)}  ${stop}`,
          );
        }
      }
    }
  } finally {
    await container.shutdown();
  }
}

import { existsSync } from 'node:fs';
import { loadConfig } from '../../config/index.js';
import { dryRunExtract } from './commands/dry-run-extract.js';
import { seedImport } from './commands/seed-import.js';
import { crawl } from './commands/crawl.js';
import { monitor } from './commands/monitor.js';
import { review } from './commands/review.js';
import { serve } from './commands/serve.js';
import { discover } from './commands/discover.js';
import { ingest } from './commands/ingest.js';
import { stats } from './commands/stats.js';

const DEFAULT_SEED_PATH = 'docs/DealRoute_Seed_List_DE.md';

const HELP = `DealRoute pipeline CLI

Usage: dealroute <command> [options]

Commands:
  dry-run-extract <url|file>          Fetch + extract one source, print candidates, NO writes
  seed-import [path] [--dry-run]      Import sources from the seed-list markdown (default: ${DEFAULT_SEED_PATH})
  crawl --source <id> [--dry-run]     Crawl one source (Lane A: fetch→evidence→extract→candidate)
  crawl --subscription <name>         Crawl all sources for a catalog subscription
  crawl --due                         Crawl every source currently due (cadence)
  monitor --source <id>               Re-verify one source (diff → re-queue / auto-expire)
  monitor --due                       Monitor every due source
  review list                         List candidates awaiting review (+ evidence)
  review approve <id> <approver>      Approve a candidate → published
  review reject <id> <approver>       Reject a candidate → archived
  review proposals                    List open field proposals
  review manual                       List open manual-capture tasks
  review sources                      List proposed (pending) sources awaiting approval
  review approve-source <id> <who>    Promote a proposed source → active (crawlable)
  review reject-source <id> <who>     Reject a proposed source (never crawled / re-proposed)
  stats [--since YYYY-MM-DD]          Aggregate logged crawl-run cost (per day + per source).
        [--until YYYY-MM-DD]          Window is half-open: since inclusive, until exclusive (UTC).
  serve                               Start the review API + thin test page (durable admin contract)
  discover <url> [--max-pages N]      Lane B: bounded same-site discovery → candidates + proposed
          [--dry-run]                 novel domains (capped by pages/€/time; nothing auto-publishes)
  ingest --source <id>                Lane B (Tier 3): read a community RSS feed → triage →
          | --community-due           extract relevant leads → candidates + proposed sources
          [--max-items N] [--dry-run]
  help                                Show this help

Configuration is read from the environment (.env). See .env.example.`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === 'help' || command === '--help') {
    console.log(HELP);
    return;
  }

  // Load .env (if present) before parsing config. Node 20.6+ built-in; no dep.
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }
  // Config is needed for every real command; parse once.
  const config = loadConfig();

  switch (command) {
    case 'dry-run-extract': {
      const target = rest[0];
      if (!target) return fail('dry-run-extract requires a <url|file> argument.');
      await dryRunExtract(config, target);
      break;
    }
    case 'seed-import': {
      const path = rest.find((a) => !a.startsWith('--')) ?? DEFAULT_SEED_PATH;
      await seedImport(config, path, rest.includes('--dry-run'));
      break;
    }
    case 'crawl': {
      await crawl(config, {
        sourceId: flag(rest, '--source'),
        subscription: flag(rest, '--subscription'),
        due: rest.includes('--due'),
        dryRun: rest.includes('--dry-run'),
      });
      break;
    }
    case 'monitor': {
      await monitor(config, { sourceId: flag(rest, '--source'), due: rest.includes('--due') });
      break;
    }
    case 'review': {
      await runReview(config, rest);
      break;
    }
    case 'serve': {
      await serve(config);
      break;
    }
    case 'discover': {
      const maxPagesRaw = flag(rest, '--max-pages');
      const maxPages = maxPagesRaw !== undefined ? Number(maxPagesRaw) : undefined;
      if (maxPages !== undefined && (!Number.isInteger(maxPages) || maxPages <= 0)) {
        return fail('--max-pages must be a positive integer.');
      }
      await discover(config, {
        startUrl: rest.find((a) => !a.startsWith('--')),
        maxPages,
        dryRun: rest.includes('--dry-run'),
      });
      break;
    }
    case 'ingest': {
      const maxItemsRaw = flag(rest, '--max-items');
      const maxItems = maxItemsRaw !== undefined ? Number(maxItemsRaw) : undefined;
      if (maxItems !== undefined && (!Number.isInteger(maxItems) || maxItems <= 0)) {
        return fail('--max-items must be a positive integer.');
      }
      await ingest(config, {
        sourceId: flag(rest, '--source'),
        due: rest.includes('--community-due'),
        maxItems,
        dryRun: rest.includes('--dry-run'),
      });
      break;
    }
    case 'stats': {
      const since = parseDateFlag(rest, '--since');
      const until = parseDateFlag(rest, '--until');
      // parseDateFlag returns `false` on a present-but-invalid value (already
      // reported via fail()). Bail before building the container in that case.
      if (since === false || until === false) return;
      // Guard a reversed window loudly rather than silently returning empty rows.
      if (since && until && since.getTime() >= until.getTime()) {
        return fail('--since must be strictly before --until.');
      }
      await stats(config, { since, until });
      break;
    }
    default:
      fail(`Unknown command: ${command}\n\n${HELP}`);
  }
}

async function runReview(config: Parameters<typeof review>[0], rest: string[]): Promise<void> {
  const action = rest[0];
  switch (action) {
    case 'list':
      return review(config, { action: 'list' });
    case 'proposals':
      return review(config, { action: 'proposals' });
    case 'manual':
      return review(config, { action: 'manual' });
    case 'approve':
    case 'reject': {
      const dealId = rest[1];
      const approver = rest[2];
      if (!dealId || !approver) return fail(`review ${action} requires <id> <approver>.`);
      return review(config, { action, dealId, approver });
    }
    case 'sources':
      return review(config, { action: 'sources' });
    case 'approve-source': {
      const sourceId = rest[1];
      const approver = rest[2];
      if (!sourceId || !approver) return fail('review approve-source requires <id> <approver>.');
      return review(config, { action: 'approve-source', sourceId, approver });
    }
    case 'reject-source': {
      const sourceId = rest[1];
      const approver = rest[2];
      if (!sourceId || !approver) return fail('review reject-source requires <id> <approver>.');
      return review(config, {
        action: 'reject-source',
        sourceId,
        approver,
        reason: rest.slice(3).join(' ') || undefined,
      });
    }
    default:
      return fail(
        'review requires: list | approve | reject | proposals | manual | sources | approve-source | reject-source',
      );
  }
}

/** Read `--flag value` from the arg list. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const DATE_FLAG_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse an optional `--since`/`--until` date flag into a UTC-midnight `Date`.
 * Returns `undefined` when the flag is absent, the validated `Date` when present
 * and a real `YYYY-MM-DD`, or `false` when present but malformed/impossible — in
 * which case it has already reported the error via `fail()` (the caller bails).
 * The round-trip check rejects normalized impossible dates (2026-02-30, 2026-13-01).
 */
function parseDateFlag(args: string[], name: string): Date | undefined | false {
  const raw = flag(args, name);
  if (raw === undefined) return undefined;
  if (!DATE_FLAG_RE.test(raw)) {
    fail(`${name} must be a real YYYY-MM-DD date (got: ${raw}).`);
    return false;
  }
  const d = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) {
    fail(`${name} must be a real YYYY-MM-DD date (got: ${raw}).`);
    return false;
  }
  return d;
}

function fail(message: string): void {
  console.error(message);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});

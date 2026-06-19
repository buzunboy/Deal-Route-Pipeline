import { existsSync } from 'node:fs';
import { loadConfig } from '../../config/index.js';
import { dryRunExtract } from './commands/dry-run-extract.js';
import { seedImport } from './commands/seed-import.js';
import { crawl } from './commands/crawl.js';
import { monitor } from './commands/monitor.js';
import { review } from './commands/review.js';
import { serve } from './commands/serve.js';

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
  serve                               Start the review API + thin test page (durable admin contract)
  discover [query]                    (Phase B/C) bounded agentic discovery — not enabled in Phase A
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
      console.log(
        'discover: the agentic discovery lane (Tiers 3–4) is scaffolded behind the BrowserAgent port ' +
          'but not enabled in Phase A. It slots in for Phase B/C with bounded caps and human source approval.',
      );
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
    default:
      return fail('review requires: list | approve | reject | proposals | manual');
  }
}

/** Read `--flag value` from the arg list. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function fail(message: string): void {
  console.error(message);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error('Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});

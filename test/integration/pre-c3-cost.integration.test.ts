import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { hasDb, applyMigrations, resetDb, makeContainer } from './harness.js';
import { ScriptedFetcher, RoleAwareFakeLlm, FakeFeedReader, FixedClock } from '../fakes/fakes.js';
import { makeLlmDeal } from '../factories/deal.js';
import { makeSource } from '../factories/source.js';
import { randomUUID } from 'node:crypto';
import { utcDayStart } from '../../src/domain/index.js';
import type { Container } from '../../src/composition/container.js';
import type { CrawlRun } from '../../src/domain/index.js';

/**
 * Pre-C-3 cost aggregation through the REAL Container + REAL Postgres: insert a
 * handful of crawl_runs across 2 UTC days + 2 sources, then assert
 * `container.metrics.costSummary` round-trips the rollup through Postgres —
 * UTC day bucketing, rounding to cents, sort order, and the half-open window
 * boundary. The fetcher/LLM edges are unused (no crawl runs here) but the harness
 * requires overrides. Self-skips locally without DATABASE_URL_TEST.
 */
const suite = hasDb ? describe : describe.skip;

function makeRun(sourceId: string, startedAt: string, costEur: number): CrawlRun {
  return {
    id: randomUUID(),
    source_id: sourceId,
    run_kind: 'crawl',
    status: 'succeeded',
    started_at: startedAt,
    finished_at: null,
    candidates_produced: 0,
    proposals_produced: 0,
    cost_eur: costEur,
    stopped_reason: null,
    error: null,
  };
}

suite('Pre-C-3 cost aggregation (Container + Postgres)', () => {
  beforeAll(applyMigrations);
  beforeEach(resetDb);

  let container: Container;
  afterEach(async () => {
    await container?.shutdown();
  });

  it('rolls up logged crawl-run cost across UTC days + sources, half-open window', async () => {
    container = makeContainer({
      fetcher: new ScriptedFetcher({}),
      llm: new RoleAwareFakeLlm({}),
    });
    const srcA = randomUUID();
    const srcB = randomUUID();
    // Day 1 (06-18): srcA 1.00 + 2.00, srcB 0.50  → day 3.50 / 3 runs
    // Day 2 (06-19): srcA 0.25, srcB 4.00         → day 4.25 / 2 runs
    await container.db.crawlRuns.insert(makeRun(srcA, '2026-06-18T06:00:00.000Z', 1.0));
    await container.db.crawlRuns.insert(makeRun(srcA, '2026-06-18T18:00:00.000Z', 2.0));
    await container.db.crawlRuns.insert(makeRun(srcB, '2026-06-18T09:00:00.000Z', 0.5));
    await container.db.crawlRuns.insert(makeRun(srcA, '2026-06-19T01:00:00.000Z', 0.25));
    await container.db.crawlRuns.insert(makeRun(srcB, '2026-06-19T23:00:00.000Z', 4.0));
    // Just outside the upper bound — must be excluded (until is exclusive).
    await container.db.crawlRuns.insert(makeRun(srcA, '2026-06-20T00:00:00.000Z', 99.0));

    const summary = await container.metrics.costSummary({
      since: new Date('2026-06-18T00:00:00.000Z'),
      until: new Date('2026-06-20T00:00:00.000Z'),
    });

    expect(summary.total_eur).toBe(7.75);
    expect(summary.run_count).toBe(5);
    expect(summary.per_day).toEqual([
      { day: '2026-06-18', cost_eur: 3.5, run_count: 3 },
      { day: '2026-06-19', cost_eur: 4.25, run_count: 2 },
    ]);
    // per_source descending by cost: srcB 4.50 > srcA 3.25.
    expect(summary.per_source).toEqual([
      { source_id: srcB, cost_eur: 4.5, run_count: 2 },
      { source_id: srcA, cost_eur: 3.25, run_count: 3 },
    ]);
  });

  it('rounds summed float costs to cents identically to the in-memory adapter', async () => {
    container = makeContainer({
      fetcher: new ScriptedFetcher({}),
      llm: new RoleAwareFakeLlm({}),
    });
    const src = randomUUID();
    for (let i = 0; i < 7; i++) {
      await container.db.crawlRuns.insert(makeRun(src, `2026-07-01T0${i}:00:00.000Z`, 0.001));
    }
    const summary = await container.metrics.costSummary({
      since: new Date('2026-07-01T00:00:00.000Z'),
      until: new Date('2026-07-02T00:00:00.000Z'),
    });
    expect(summary.total_eur).toBe(0.01);
    expect(summary.per_source).toEqual([{ source_id: src, cost_eur: 0.01, run_count: 7 }]);
    expect(summary.per_day).toEqual([{ day: '2026-07-01', cost_eur: 0.01, run_count: 7 }]);
  });

  it('empty window → zeros + empty arrays', async () => {
    container = makeContainer({
      fetcher: new ScriptedFetcher({}),
      llm: new RoleAwareFakeLlm({}),
    });
    const summary = await container.metrics.costSummary({
      since: new Date('2030-01-01T00:00:00.000Z'),
      until: new Date('2030-01-02T00:00:00.000Z'),
    });
    expect(summary).toEqual({ total_eur: 0, run_count: 0, per_day: [], per_source: [] });
  });

  // ---- Lane-B run-metrics: discover/ingest now write a crawl_runs row ----

  const FEED = 'https://www.mydealz.de/rss';
  const DEAL_PAGE = 'https://www.telekom.de/magenta-disney';
  const PAGE = 'Disney+ ist im Tarif MagentaTV SmartStream enthalten.';

  it('an ingest run persists an ingest crawl_runs row (cost/candidates/proposals/stop-reason)', async () => {
    container = makeContainer({
      clock: new FixedClock(new Date('2026-06-19T12:00:00.000Z')),
      feedReader: new FakeFeedReader({
        [FEED]: [
          {
            title: 'Disney+ gratis bei Telekom',
            link: DEAL_PAGE,
            summary: 'Disney+ inklusive gratis',
            publishedAt: null,
          },
        ],
      }),
      // €0.01/call so the run's total cost (triage + extract) survives the
      // cent-rounding in spentSince/costSummary — a sub-cent cost would round to
      // €0.00 and make the "cost is visible" assertions below vacuous.
      llm: new RoleAwareFakeLlm(
        {
          discovery: JSON.stringify({ relevant: true, service: 'Disney+', reason: 'bundle' }),
          extraction: JSON.stringify({ deals: [makeLlmDeal()] }),
        },
        0.01,
      ),
      fetcher: new ScriptedFetcher({ [DEAL_PAGE]: { text: PAGE, html: '<html></html>' } }),
    });
    const source = makeSource({ url: FEED, type: 'community', tier: 3 });
    await container.db.sources.upsert(source);
    await container.db.catalog.upsert({
      service: 'Disney+',
      category: 'streaming',
      provider_url: 'https://www.disneyplus.com/de-de',
      country: 'DE',
    });

    await container.ingestCommunity.execute({
      sourceId: source.id,
      maxItems: 20,
      budget: { maxSteps: 20, maxSeconds: 300, maxCostEur: 1 },
    });

    // The run is now in the ledger — readable via recentRuns, attributed to the
    // community source, with the Lane-B kind + a clean stop-reason.
    const runs = await container.metrics.recentRuns({});
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.run_kind).toBe('ingest');
    expect(run.source_id).toBe(source.id);
    expect(run.status).toBe('succeeded');
    expect(run.candidates_produced).toBe(1);
    expect(run.proposals_produced).toBe(1);
    expect(run.stopped_reason).toBe('completed');
    expect(run.cost_eur).toBeGreaterThan(0);

    // And its cost is now visible to BOTH the daily-guard sum and stats — the lane
    // that was invisible before this change.
    const spent = await container.db.crawlRuns.spentSince(
      utcDayStart(new Date('2026-06-19T12:00:00.000Z')),
    );
    expect(spent).toBe(run.cost_eur);
    const summary = await container.metrics.costSummary({});
    expect(summary.run_count).toBe(1);
    expect(summary.total_eur).toBe(run.cost_eur);
  });

  it('a discover run persists a null-source discover row that recentRuns round-trips', async () => {
    const START = 'https://www.telekom.de/start';
    container = makeContainer({
      clock: new FixedClock(new Date('2026-06-19T08:00:00.000Z')),
      // A page whose only link is OFF the start domain → one proposed source, no
      // further fetches. Extraction yields one candidate.
      fetcher: new ScriptedFetcher({
        [START]: {
          text: PAGE,
          html: '<a href="https://novel-merchant.de/offer">deal</a>',
        },
      }),
      llm: new RoleAwareFakeLlm({ extraction: JSON.stringify({ deals: [makeLlmDeal()] }) }),
    });

    await container.discoverSite.execute({
      startUrl: START,
      maxPages: 5,
      budget: { maxSteps: 5, maxSeconds: 300, maxCostEur: 1 },
    });

    const runs = await container.metrics.recentRuns({});
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.run_kind).toBe('discover');
    expect(run.source_id).toBeNull(); // Lane B has no source row
    expect(run.proposals_produced).toBe(1);
    expect(run.candidates_produced).toBe(1);

    // The null-source run folds under the sentinel bucket in costSummary.
    const summary = await container.metrics.costSummary({});
    expect(summary.per_source).toHaveLength(1);
    expect(summary.per_source[0]!.source_id).toBe('(sourceless)');
  });

  it('the daily-budget guard reports exhausted once prior runs reach the ceiling', async () => {
    // Ceiling €5/day; pre-load €6 of runs earlier today → guard must report not-ok.
    container = makeContainer(
      { fetcher: new ScriptedFetcher({}), llm: new RoleAwareFakeLlm({}) },
      { DAILY_BUDGET_EUR: '5.00' },
    );
    const today = utcDayStart(new Date());
    const at = new Date(today.getTime() + 3600_000).toISOString();
    await container.db.crawlRuns.insert(makeRun(randomUUID(), at, 6.0));

    const check = await container.dailyBudgetGuard.check();
    expect(check.ok).toBe(false);
    expect(check.remainingEur).toBe(0);
    expect(check.spentTodayEur).toBe(6.0);
  });
});

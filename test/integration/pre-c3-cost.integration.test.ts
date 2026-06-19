import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { hasDb, applyMigrations, resetDb, makeContainer } from './harness.js';
import { ScriptedFetcher, RoleAwareFakeLlm } from '../fakes/fakes.js';
import { randomUUID } from 'node:crypto';
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
    status: 'succeeded',
    started_at: startedAt,
    finished_at: null,
    candidates_produced: 0,
    cost_eur: costEur,
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
});

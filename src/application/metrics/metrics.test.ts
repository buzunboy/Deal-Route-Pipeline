import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MetricsUseCase } from './metrics.js';
import { InMemoryDb } from '../../../test/fakes/in-memory-db.js';
import { FakeLogger } from '../../../test/fakes/fakes.js';
import type { CrawlRun } from '../../domain/index.js';

function run(sourceId: string, startedAt: string, costEur: number): CrawlRun {
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

describe('MetricsUseCase', () => {
  it('delegates to the repository and returns the rolled-up CostSummary', async () => {
    const db = new InMemoryDb();
    const useCase = new MetricsUseCase(db, new FakeLogger());
    const srcA = randomUUID();
    const srcB = randomUUID();
    await db.crawlRuns.insert(run(srcA, '2026-06-18T06:00:00.000Z', 1.0));
    await db.crawlRuns.insert(run(srcA, '2026-06-19T06:00:00.000Z', 2.0));
    await db.crawlRuns.insert(run(srcB, '2026-06-19T07:00:00.000Z', 0.5));

    const summary = await useCase.costSummary({});

    expect(summary.total_eur).toBe(3.5);
    expect(summary.run_count).toBe(3);
    expect(summary.per_day).toEqual([
      { day: '2026-06-18', cost_eur: 1.0, run_count: 1 },
      { day: '2026-06-19', cost_eur: 2.5, run_count: 2 },
    ]);
    expect(summary.per_source).toEqual([
      { source_id: srcA, cost_eur: 3.0, run_count: 2 },
      { source_id: srcB, cost_eur: 0.5, run_count: 1 },
    ]);
  });

  it('forwards the half-open window filter to the repository', async () => {
    const db = new InMemoryDb();
    const useCase = new MetricsUseCase(db, new FakeLogger());
    const src = randomUUID();
    await db.crawlRuns.insert(run(src, '2026-06-18T23:00:00.000Z', 5.0)); // before since → excluded
    await db.crawlRuns.insert(run(src, '2026-06-19T00:00:00.000Z', 1.0)); // == since → included
    await db.crawlRuns.insert(run(src, '2026-06-20T00:00:00.000Z', 9.0)); // == until → excluded

    const summary = await useCase.costSummary({
      since: new Date('2026-06-19T00:00:00.000Z'),
      until: new Date('2026-06-20T00:00:00.000Z'),
    });

    expect(summary.total_eur).toBe(1.0);
    expect(summary.run_count).toBe(1);
    expect(summary.per_source).toEqual([{ source_id: src, cost_eur: 1.0, run_count: 1 }]);
  });
});

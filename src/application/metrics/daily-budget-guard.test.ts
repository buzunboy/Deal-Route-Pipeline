import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DailyBudgetGuard } from './daily-budget-guard.js';
import { InMemoryDb } from '../../../test/fakes/in-memory-db.js';
import { FixedClock, FakeLogger } from '../../../test/fakes/fakes.js';
import type { CrawlRun } from '../../domain/index.js';

const NOW = new Date('2026-06-19T15:00:00.000Z');

function run(startedAt: string, costEur: number): CrawlRun {
  return {
    id: randomUUID(),
    source_id: null,
    run_kind: 'discover',
    status: 'succeeded',
    started_at: startedAt,
    finished_at: null,
    candidates_produced: 0,
    proposals_produced: 0,
    cost_eur: costEur,
    stopped_reason: 'completed',
    error: null,
  };
}

function makeGuard(
  ceilingEur: number,
  db = new InMemoryDb(),
): { guard: DailyBudgetGuard; db: InMemoryDb } {
  const guard = new DailyBudgetGuard(db, new FixedClock(NOW), new FakeLogger(), ceilingEur);
  return { guard, db };
}

describe('DailyBudgetGuard', () => {
  it('is disabled (always ok, Infinity remaining) when the ceiling is 0', async () => {
    const { guard, db } = makeGuard(0);
    // Even with spend logged today, a disabled guard never trips.
    await db.crawlRuns.insert(run('2026-06-19T10:00:00.000Z', 999));
    expect(guard.enabled).toBe(false);
    const check = await guard.check();
    expect(check).toEqual({ ok: true, remainingEur: Infinity, spentTodayEur: 0 });
  });

  it('sums only TODAY (UTC) spend and reports headroom', async () => {
    const { guard, db } = makeGuard(10);
    await db.crawlRuns.insert(run('2026-06-18T23:00:00.000Z', 4.0)); // yesterday → excluded
    await db.crawlRuns.insert(run('2026-06-19T00:00:00.000Z', 1.0)); // today, at midnight
    await db.crawlRuns.insert(run('2026-06-19T09:00:00.000Z', 2.5)); // today

    const check = await guard.check();
    expect(check.ok).toBe(true);
    expect(check.spentTodayEur).toBe(3.5); // 1.0 + 2.5, NOT yesterday's 4.0
    expect(check.remainingEur).toBe(6.5);
  });

  it('reports not-ok once today reaches the ceiling', async () => {
    const { guard, db } = makeGuard(5);
    await db.crawlRuns.insert(run('2026-06-19T08:00:00.000Z', 5.0));
    const check = await guard.check();
    expect(check.ok).toBe(false);
    expect(check.remainingEur).toBe(0);
  });

  describe('effectiveCostCap', () => {
    it('passes the per-run cap through when the guard is disabled', () => {
      const { guard } = makeGuard(0);
      expect(guard.effectiveCostCap(1.0, 0)).toBe(1.0);
    });
    it('clamps the per-run cap to the remaining daily headroom', () => {
      const { guard } = makeGuard(10);
      expect(guard.effectiveCostCap(1.0, 9.7)).toBe(0.3);
    });
    it('leaves the per-run cap intact when there is ample headroom', () => {
      const { guard } = makeGuard(10);
      expect(guard.effectiveCostCap(1.0, 2.0)).toBe(1.0);
    });
  });
});

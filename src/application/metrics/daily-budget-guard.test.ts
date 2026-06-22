import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DailyBudgetGuard } from './daily-budget-guard.js';
import { InMemoryDb } from '../../../test/fakes/in-memory-db.js';
import { FixedClock, FakeLogger, FakeAlerter } from '../../../test/fakes/fakes.js';
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
): { guard: DailyBudgetGuard; db: InMemoryDb; alerter: FakeAlerter } {
  const alerter = new FakeAlerter();
  const guard = new DailyBudgetGuard(
    db,
    new FixedClock(NOW),
    new FakeLogger(),
    ceilingEur,
    alerter,
  );
  return { guard, db, alerter };
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

  it('reports not-ok once today reaches the ceiling, and emits a daily_budget_reached alert', async () => {
    const { guard, db, alerter } = makeGuard(5);
    await db.crawlRuns.insert(run('2026-06-19T08:00:00.000Z', 5.0));
    const check = await guard.check();
    expect(check.ok).toBe(false);
    expect(check.remainingEur).toBe(0);
    // Step 5: the budget-reached stop also fires an alert (best-effort, never throws).
    expect(alerter.events).toHaveLength(1);
    expect(alerter.events[0]!.kind).toBe('daily_budget_reached');
    expect(alerter.events[0]!.dedupe_key).toBe('daily_budget_reached:2026-06-19');
  });

  it('does NOT alert while there is headroom (only on the stop)', async () => {
    const { guard, db, alerter } = makeGuard(10);
    await db.crawlRuns.insert(run('2026-06-19T08:00:00.000Z', 2.0));
    await guard.check();
    expect(alerter.events).toHaveLength(0);
  });

  it('setCeiling adopts a new ceiling (a queued daily budget consumed at boot)', async () => {
    const { guard, db } = makeGuard(5);
    expect(guard.ceiling).toBe(5);
    await db.crawlRuns.insert(run('2026-06-19T08:00:00.000Z', 6.0)); // over the OLD ceiling
    expect((await guard.check()).ok).toBe(false);
    // Adopt a higher queued budget → the same spend now fits under the new ceiling.
    guard.setCeiling(10);
    expect(guard.ceiling).toBe(10);
    const check = await guard.check();
    expect(check.ok).toBe(true);
    expect(check.remainingEur).toBe(4); // 10 − 6
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

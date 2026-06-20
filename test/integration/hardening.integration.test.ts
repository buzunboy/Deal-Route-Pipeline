import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hasDb, applyMigrations, resetDb, DB_URL } from './harness.js';
import { loadConfig } from '../../src/config/index.js';
import { Container } from '../../src/composition/container.js';
import { monitor } from '../../src/adapters/cli/commands/monitor.js';
import { makeSource } from '../factories/source.js';
import { utcDayStart } from '../../src/domain/index.js';
import type { CrawlRun } from '../../src/domain/index.js';

/**
 * Hardening gaps (post Phase C C-1) end-to-end through the REAL composition root +
 * REAL Postgres. Self-skips locally without DATABASE_URL_TEST.
 */
const suite = hasDb ? describe : describe.skip;

function makeRun(sourceId: string | null, startedAt: string, costEur: number): CrawlRun {
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

/** A config pointing at the test Postgres, with a per-test env overlay. */
function testConfig(env: Record<string, string>) {
  return loadConfig({
    ...process.env,
    LLM_PROVIDER: 'stub',
    FETCHER: 'playwright',
    EVIDENCE_STORE: 'local',
    EVIDENCE_LOCAL_DIR: './.evidence-it',
    DATABASE_URL: DB_URL,
    QUEUE_DATABASE_URL: DB_URL,
    LOG_LEVEL: 'error',
    ...env,
  });
}

suite('Hardening — monitor batch daily-budget guard (Container + Postgres)', () => {
  beforeAll(applyMigrations);
  beforeEach(resetDb);

  let setup: Container | undefined;
  afterEach(async () => {
    await setup?.shutdown();
  });

  // The deterministic signal that monitor.execute NEVER ran is the source row: a
  // monitor pass ALWAYS reschedules it (every disposition advances reliability +
  // next_due — see monitor-source.ts). So an UNCHANGED next_due proves the guard
  // broke the loop before execute — independent of network (the real fetcher is
  // never reached). This distinguishes "guard stopped it" from "fetch failed"
  // (a failed fetch would still back off + rewrite next_due).
  const SENTINEL_DUE = new Date('2000-01-01T00:00:00.000Z').toISOString();

  it('monitor --due stops before processing any source once the daily budget is exhausted', async () => {
    setup = new Container(testConfig({ DAILY_BUDGET_EUR: '1.00' }), { usePersistence: true });
    const due = makeSource({
      url: 'https://www.telekom.de/magenta-tv',
      status: 'active',
      next_due: SENTINEL_DUE, // long overdue → would be picked by listDue
      reliability_score: 0.5,
    });
    await setup.db.sources.upsert(due);
    const todayAt = new Date(utcDayStart(setup.clock.now()).getTime() + 3_600_000).toISOString();
    await setup.db.crawlRuns.insert(makeRun(randomUUID(), todayAt, 2.0)); // €2 > €1 ceiling
    await setup.shutdown();
    setup = undefined;

    // Budget exhausted → the loop breaks before monitor.execute (no fetch, no row).
    await monitor(testConfig({ DAILY_BUDGET_EUR: '1.00' }), { due: true });

    const verify = new Container(testConfig({ DAILY_BUDGET_EUR: '1.00' }), {
      usePersistence: true,
    });
    try {
      const after = await verify.db.sources.getById(due.id);
      // Untouched next_due ⇒ monitor.execute never ran ⇒ the guard stopped the batch.
      expect(after?.next_due).toBe(SENTINEL_DUE);
      expect(after?.reliability_score).toBe(0.5);
    } finally {
      await verify.shutdown();
    }
  });

  it('NEGATIVE CONTROL: with budget available, monitor --due DOES process the source', async () => {
    // Same setup but the guard is disabled (DAILY_BUDGET_EUR=0) → monitor.execute
    // runs. The real fetcher fails (no network in CI) → a failure disposition →
    // reliability lowered + next_due backed off. Either way next_due CHANGES,
    // proving the previous test's "unchanged" is a real signal, not a constant.
    setup = new Container(testConfig({ DAILY_BUDGET_EUR: '0' }), { usePersistence: true });
    const due = makeSource({
      url: 'https://nonexistent.invalid/x', // resolves to a failure, deterministically offline
      status: 'active',
      next_due: SENTINEL_DUE,
      reliability_score: 0.5,
    });
    await setup.db.sources.upsert(due);
    await setup.shutdown();
    setup = undefined;

    await monitor(testConfig({ DAILY_BUDGET_EUR: '0' }), { due: true });

    const verify = new Container(testConfig({ DAILY_BUDGET_EUR: '0' }), { usePersistence: true });
    try {
      const after = await verify.db.sources.getById(due.id);
      expect(after?.next_due).not.toBe(SENTINEL_DUE); // monitor.execute ran (rescheduled)
    } finally {
      await verify.shutdown();
    }
  });
});

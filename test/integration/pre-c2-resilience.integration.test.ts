import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import pg from 'pg';
import { hasDb, DB_URL, applyMigrations, resetDb, makeContainer } from './harness.js';
import { ScriptedFetcher, RoleAwareFakeLlm } from '../fakes/fakes.js';
import { makeLlmDeal } from '../factories/deal.js';
import { makeSource } from '../factories/source.js';
import type { Container } from '../../src/composition/container.js';

/**
 * Pre-C-2 ops-hardening, verified against REAL Postgres (the unit tier proves the
 * pure pieces; this proves the wiring against the actual server):
 *   1. the pool's statement_timeout actually cancels a wedged query (no leaked,
 *      forever-held connection under unattended running);
 *   2. reliability-driven cadence persists a stretched next_due end-to-end through
 *      the real adapter + crawl use-case (a flaky source backs off in the DB);
 *   3. the DB-op retry path behaves against real SQLSTATEs: a first-attempt
 *      duplicate-PK insert surfaces (not swallowed), and an idempotent conflict-safe
 *      insert tolerates a duplicate. (The retry-time PK swallow needs a transient
 *      first failure, which only a fake can inject — that branch is unit-tested.)
 */
const suite = hasDb ? describe : describe.skip;

suite('Pre-C-2 DB resilience (Postgres)', () => {
  beforeAll(applyMigrations);
  beforeEach(resetDb);

  it('statement_timeout cancels a query that exceeds it (frees the connection)', async () => {
    // The adapter sets `statement_timeout` on its pool (postgres-db.ts:connect).
    // This proves the guarantee it relies on holds against the real server: a pool
    // configured with a tiny cap aborts a wedged query (57014 query_canceled)
    // instead of pinning the connection forever — the whole point of the knob.
    const pool = new pg.Pool({ connectionString: DB_URL, statement_timeout: 100 });
    try {
      await expect(pool.query('SELECT pg_sleep(1)')).rejects.toMatchObject({ code: '57014' });
    } finally {
      await pool.end();
    }
  });

  it('a failing crawl persists a stretched next_due (reliability backs the source off)', async () => {
    const url = 'https://www.telekom.de/magenta-flaky';
    // reliability 0.5 → one failure drops it to 0.3 → multiplier 4 → 4x base cadence.
    const source = makeSource({ url, reliability_score: 0.5, cadence_days: 3, next_due: null });
    const container: Container = makeContainer({
      // An error outcome → failed run → reliability lowered → back-off applied.
      fetcher: new ScriptedFetcher({ [url]: { outcome: 'error', error: 'boom', text: '' } }),
      llm: new RoleAwareFakeLlm({ extraction: JSON.stringify({ deals: [makeLlmDeal()] }) }),
    });
    try {
      await container.db.sources.upsert(source);
      const result = await container.crawlSource.execute({ sourceId: source.id });
      expect(result.run.status).toBe('failed');

      const stored = await container.db.sources.getById(source.id);
      expect(stored).not.toBeNull();
      // Reliability dropped and next_due is set further out than a single base cadence.
      expect(stored!.reliability_score).toBeLessThan(0.5);
      expect(stored!.next_due).not.toBeNull();
      const dueMs = new Date(stored!.next_due!).getTime();
      const oneCadenceMs = new Date(result.run.finished_at!).getTime() + 3 * 24 * 3600 * 1000;
      expect(dueMs).toBeGreaterThan(oneCadenceMs); // backed off beyond 1x cadence
    } finally {
      await container!.shutdown();
    }
  });

  it('a first-attempt duplicate-PK insert surfaces (not swallowed by the retrier)', async () => {
    const container = makeContainer({
      fetcher: new ScriptedFetcher({}),
      llm: new RoleAwareFakeLlm({ extraction: JSON.stringify({ deals: [makeLlmDeal()] }) }),
    });
    try {
      const run = {
        id: '11111111-1111-1111-1111-111111111111',
        source_id: '22222222-2222-2222-2222-222222222222',
        status: 'running' as const,
        started_at: '2026-06-19T00:00:00.000Z',
        finished_at: null,
        candidates_produced: 0,
        cost_eur: 0,
        error: null,
      };
      await container.db.crawlRuns.insert(run);
      // Same PK again on the FIRST attempt → a genuine duplicate, must throw 23505
      // (the retrier only swallows a PK violation that appears AFTER a retry).
      await expect(container.db.crawlRuns.insert(run)).rejects.toMatchObject({ code: '23505' });
    } finally {
      await container.shutdown();
    }
  });

  it('a re-crawl of identical content through the retry-wrapped repo stays single-candidate', async () => {
    const url = 'https://www.telekom.de/magenta-idem';
    const container = makeContainer({
      fetcher: new ScriptedFetcher({ [url]: { text: 'Disney+ inklusive', html: '<html></html>' } }),
      llm: new RoleAwareFakeLlm({ extraction: JSON.stringify({ deals: [makeLlmDeal()] }) }),
    });
    try {
      const source = makeSource({ url });
      await container.db.sources.upsert(source);
      // Crawl twice with identical content. The sink's content-hash pre-check skips
      // the duplicate, and the deal insert is conflict-safe (onConflictDoNothing) as
      // a backstop — neither throws nor double-inserts through the retry-wrapped repo.
      await container.crawlSource.execute({ sourceId: source.id });
      await container.crawlSource.execute({ sourceId: source.id });
      const candidates = await container.db.deals.listByStatus('candidate', 10);
      expect(candidates).toHaveLength(1);
    } finally {
      await container.shutdown();
    }
  });
});

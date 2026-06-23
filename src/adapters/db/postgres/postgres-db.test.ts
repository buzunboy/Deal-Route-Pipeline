import { describe, it, afterAll } from 'vitest';
import pg from 'pg';
import { databaseContract } from '../../../../test/contracts/database-contract.js';
import { PostgresDb } from './postgres-db.js';

/**
 * Runs the shared Database contract against real Postgres — but ONLY when
 * DATABASE_URL_TEST is set (so dev without a DB stays green). CI provides a
 * Postgres service container + applies migrations, so this runs as the
 * substitutability (LSP) gate alongside the in-memory adapter. Point it at a
 * throwaway test database with migrations already applied.
 *
 * One PostgresDb (one pool) is shared across every case; a `beforeEach` TRUNCATE
 * gives each case a clean slate (the contract mutates rows, and count/global-list
 * cases would otherwise pollute each other when the file runs as a whole). A
 * separate pool runs the truncate so the adapter under test is never reached for
 * the reset.
 */
const url = process.env.DATABASE_URL_TEST;

if (url) {
  const db = PostgresDb.connect(url);
  const resetPool = new pg.Pool({ connectionString: url });

  // Every domain table the contract touches, truncated together (CASCADE + RESTART
  // IDENTITY) so each case starts empty. Keep in sync with the schema's table set
  // (mirrors test/integration/harness.ts resetDb).
  const reset = async (): Promise<void> => {
    await resetPool.query(
      `TRUNCATE TABLE reviews, source_reviews, changes, deals, evidence,
         manual_capture_tasks, crawl_runs, field_proposals, sources,
         subscription_catalog, condition_vocabulary, team_members, alert_events,
         settings
       RESTART IDENTITY CASCADE`,
    );
  };

  afterAll(async () => {
    await resetPool.end();
    await db.close();
  });

  databaseContract('PostgresDb', () => db, reset);
} else {
  describe.skip('Database contract: PostgresDb (set DATABASE_URL_TEST to run)', () => {
    it('skipped', () => {});
  });
}

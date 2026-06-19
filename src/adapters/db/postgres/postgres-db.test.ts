import { describe, it } from 'vitest';
import { databaseContract } from '../../../../test/contracts/database-contract.js';
import { PostgresDb } from './postgres-db.js';

/**
 * Runs the shared Database contract against real Postgres — but ONLY when
 * DATABASE_URL_TEST is set (so CI/dev without a DB stays green). Point it at a
 * throwaway test database with migrations already applied.
 */
const url = process.env.DATABASE_URL_TEST;

if (url) {
  databaseContract('PostgresDb', () => PostgresDb.connect(url));
} else {
  describe.skip('Database contract: PostgresDb (set DATABASE_URL_TEST to run)', () => {
    it('skipped', () => {});
  });
}

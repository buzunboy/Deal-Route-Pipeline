import { defineConfig } from 'vitest/config';

/**
 * Integration suite: real composition root + real Postgres, deterministic edges.
 * Run via `npm run test:integration` with `DATABASE_URL_TEST` pointing at a
 * throwaway database (the tests self-skip if it's unset). Single-threaded so
 * shared-DB resets don't race.
 */
export default defineConfig({
  test: {
    include: [
      'test/integration/**/*.test.ts',
      // The Postgres adapter contract (the LSP substitutability gate) — needs the
      // real DB, so it runs HERE, not in the unit tier (where it self-skips). One
      // shared connection + a per-case TRUNCATE keeps the count/global-list cases
      // isolated (singleFork below means the resets don't race other files).
      'src/adapters/db/postgres/postgres-db.test.ts',
    ],
    environment: 'node',
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
  },
});

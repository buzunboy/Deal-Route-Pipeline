import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Default (`npm test`) = fast, hermetic UNIT/component tests. The integration
    // suite (real Postgres) and live suite (real network/LLM) have their own
    // scripts + globs so the PR gate stays fast and deterministic.
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      'test/integration/**',
      'test/live/**',
      // The Postgres adapter CONTRACT runs in the integration tier (it needs the real
      // DB); excluded here so it isn't double-run when a dev has DATABASE_URL_TEST set.
      'src/adapters/db/postgres/postgres-db.test.ts',
    ],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/domain/**', 'src/application/**'],
      reporter: ['text', 'html'],
    },
  },
});

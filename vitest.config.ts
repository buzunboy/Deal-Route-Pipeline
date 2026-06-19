import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Default (`npm test`) = fast, hermetic UNIT/component tests. The integration
    // suite (real Postgres) and live suite (real network/LLM) have their own
    // scripts + globs so the PR gate stays fast and deterministic.
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'test/integration/**', 'test/live/**'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/domain/**', 'src/application/**'],
      reporter: ['text', 'html'],
    },
  },
});

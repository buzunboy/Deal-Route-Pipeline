import { defineConfig } from 'vitest/config';

/**
 * Live smoke suite: real network (Playwright) + real LLM. Run via
 * `npm run test:live` with `RUN_LIVE_TESTS=1` and a provider key set (the tests
 * self-skip otherwise). Scheduled / label-gated only — never the PR gate. Long
 * timeouts for real round-trips; no retries (a flake should be visible, not hidden).
 */
export default defineConfig({
  test: {
    include: ['test/live/**/*.test.ts'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});

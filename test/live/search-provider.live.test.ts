import { describe, it, expect } from 'vitest';
import { BraveSearchProvider } from '../../src/adapters/search/brave-search-provider.js';
import { FirecrawlSearchProvider } from '../../src/adapters/search/firecrawl-search-provider.js';

/**
 * LIVE smoke for the real SearchProvider adapters — hits the actual search API.
 * Catches "the vendor changed its response shape" drift. NON-deterministic, costs
 * money, needs a key, so self-skips unless `RUN_LIVE_TESTS=1` AND the relevant key
 * is set. Scheduled / `live-test` label only; never the PR gate.
 */
const MINUTE = 60_000;
const opts = { limit: 5, country: 'DE', timeoutMs: 15_000 };
const INTENT_QUERY = 'Disney+ im Bundle';

const braveEnabled = process.env.RUN_LIVE_TESTS === '1' && Boolean(process.env.SEARCH_API_KEY);
const firecrawlEnabled =
  process.env.RUN_LIVE_TESTS === '1' && Boolean(process.env.FIRECRAWL_API_KEY);

const braveSuite = braveEnabled ? describe : describe.skip;
const firecrawlSuite = firecrawlEnabled ? describe : describe.skip;

braveSuite('live Brave search smoke', () => {
  it(
    'returns DE results for an intent query',
    async () => {
      const provider = new BraveSearchProvider(process.env.SEARCH_API_KEY!);
      const results = await provider.search(INTENT_QUERY, opts);
      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThanOrEqual(opts.limit);
      for (const r of results) {
        expect(r.url).toMatch(/^https?:\/\//);
      }
    },
    MINUTE,
  );
});

firecrawlSuite('live Firecrawl search smoke', () => {
  it(
    'returns DE results for an intent query',
    async () => {
      const provider = new FirecrawlSearchProvider(process.env.FIRECRAWL_API_KEY!);
      const results = await provider.search(INTENT_QUERY, opts);
      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThanOrEqual(opts.limit);
      for (const r of results) {
        expect(r.url).toMatch(/^https?:\/\//);
      }
    },
    MINUTE,
  );
});

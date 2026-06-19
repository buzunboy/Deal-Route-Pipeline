import { describe, it, expect } from 'vitest';
import type { SearchProvider, SearchResult } from '../../src/application/ports/index.js';

/**
 * Shared contract suite for the SearchProvider port. Every adapter (stub, Brave,
 * Firecrawl) must satisfy it so any implementation is substitutable behind the
 * port (LSP, `testing.md`: adapter contract tests).
 *
 * The factory yields a provider pre-loaded to answer `richQuery` with at least
 * `seededCount` results, and `emptyQuery` with none — so the same behavioral
 * assertions run against the stub here and (gated) against real adapters that
 * fake the network at their own seam.
 */
export interface SearchProviderFixture {
  provider: SearchProvider;
  richQuery: string;
  emptyQuery: string;
  seededCount: number;
}

export function searchProviderContract(
  name: string,
  makeFixture: () => SearchProviderFixture | Promise<SearchProviderFixture>,
): void {
  describe(`SearchProvider contract: ${name}`, () => {
    const opts = { limit: 10, country: 'DE', timeoutMs: 5000 };

    it('returns well-shaped results (url + title + snippet strings)', async () => {
      const { provider, richQuery } = await makeFixture();
      const results = await provider.search(richQuery, opts);
      expect(Array.isArray(results)).toBe(true);
      for (const r of results) {
        expect(typeof r.url).toBe('string');
        expect(r.url.length).toBeGreaterThan(0);
        expect(typeof r.title).toBe('string');
        expect(typeof r.snippet).toBe('string');
      }
    });

    it('honours the limit (never returns more than asked)', async () => {
      const { provider, richQuery, seededCount } = await makeFixture();
      const limit = Math.max(1, seededCount - 1);
      const results = await provider.search(richQuery, { ...opts, limit });
      expect(results.length).toBeLessThanOrEqual(limit);
    });

    it('returns no results for a query with no matches', async () => {
      const { provider, emptyQuery } = await makeFixture();
      const results = await provider.search(emptyQuery, opts);
      expect(results).toEqual([]);
    });

    it('handles an empty query without throwing', async () => {
      const { provider } = await makeFixture();
      const results = await provider.search('', opts);
      expect(Array.isArray(results)).toBe(true);
    });
  });
}

/** A small helper so adapters can build a canned result set for the fixture. */
export function sampleResults(n: number): SearchResult[] {
  return Array.from({ length: n }, (_, i) => ({
    url: `https://example-${i}.de/angebot`,
    title: `Angebot ${i}`,
    snippet: `Disney+ im Bundle, Variante ${i}`,
  }));
}

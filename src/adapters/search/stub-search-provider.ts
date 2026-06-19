import type { SearchProvider, SearchOptions, SearchResult } from '../../application/ports/index.js';

/**
 * Deterministic, no-network SearchProvider — the DEFAULT off-switch for Tier-4
 * broad discovery, mirroring `NoopBrowserAgent`/`StubLlm`. Returns canned results
 * keyed by query (empty for unknown queries) so the broad-discovery loop can be
 * exercised offline in tests/dry-runs with zero external dependency or cost.
 *
 * Selected when `SEARCH_PROVIDER=stub` (the default when no `SEARCH_API_KEY` is
 * configured), so nothing reaches the open web until a real provider is enabled.
 */
export class StubSearchProvider implements SearchProvider {
  constructor(private readonly canned: Record<string, SearchResult[]> = {}) {}

  async search(query: string, opts: SearchOptions): Promise<SearchResult[]> {
    const hits = this.canned[query] ?? [];
    return hits.slice(0, opts.limit);
  }
}

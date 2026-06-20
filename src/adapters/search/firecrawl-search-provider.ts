import { z } from 'zod';
import type { SearchProvider, SearchOptions, SearchResult } from '../../application/ports/index.js';
import { withRetry, withAbortableTimeout } from '../shared/retry.js';
import { SearchProviderError, isRetryableSearchError } from './search-provider-error.js';

/**
 * Firecrawl `/v1/search` adapter — an alternative real SearchProvider that
 * reuses the existing `FIRECRAWL_API_KEY` (one less vendor/key). Enabled via
 * `SEARCH_PROVIDER=firecrawl`. NB: the existing `FirecrawlFetcher` only calls
 * `/v1/scrape`; this is a distinct endpoint. Substitutable behind the port (LSP).
 *
 * Raw JSON is boundary-validated (zod) into `SearchResult` before use. We request
 * search results only (no scrape) to stay cheap — fetching is the PoliteFetcher's
 * job in the use-case. Timeout-bounded + retried on transient failures.
 */
export class FirecrawlSearchProvider implements SearchProvider {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.firecrawl.dev',
  ) {}

  async search(query: string, opts: SearchOptions): Promise<SearchResult[]> {
    if (query.trim() === '') return [];

    const res = await withRetry(
      async () => {
        const r = await withAbortableTimeout(
          (signal) =>
            fetch(`${this.baseUrl}/v1/search`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                query,
                limit: opts.limit,
                country: opts.country.toLowerCase(),
              }),
              signal,
            }),
          opts.timeoutMs,
        );
        // Check status INSIDE the retried unit so 429/5xx back off (architecture.md).
        if (!r.ok) {
          throw new SearchProviderError(`Firecrawl Search HTTP ${r.status}`, { status: r.status });
        }
        return r;
      },
      { retries: 2, baseDelayMs: 500, isRetryable: isRetryableSearchError },
    );

    const parsed = FirecrawlSearchResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      throw new SearchProviderError(
        `Firecrawl Search response failed validation: ${parsed.error.message}`,
      );
    }

    const data = parsed.data.data ?? [];
    return data.slice(0, opts.limit).map((r) => ({
      url: r.url,
      title: r.title ?? '',
      snippet: r.description ?? '',
    }));
  }
}

/** Only the fields we consume. Malformed entries (no url) are dropped. */
const FirecrawlSearchResultSchema = z.object({
  url: z.string().url(),
  title: z.string().optional(),
  description: z.string().optional(),
});
const FirecrawlSearchResponseSchema = z.object({
  data: z
    .array(FirecrawlSearchResultSchema.nullable().catch(null))
    .transform((rs) =>
      rs.filter((r): r is z.infer<typeof FirecrawlSearchResultSchema> => r !== null),
    )
    .optional(),
});

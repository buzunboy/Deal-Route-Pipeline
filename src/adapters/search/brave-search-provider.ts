import { z } from 'zod';
import type { SearchProvider, SearchOptions, SearchResult } from '../../application/ports/index.js';
import { withRetry, withAbortableTimeout, TimeoutError } from '../shared/retry.js';
import { SearchProviderError } from './search-provider-error.js';

/**
 * Brave Search API adapter — the recommended real SearchProvider for Tier-4
 * broad discovery (good DE coverage, cheap, simple REST, no SDK). Enabled via
 * `SEARCH_PROVIDER=api` + `SEARCH_API_KEY`. Substitutable behind the port (LSP).
 *
 * Implemented against the documented `/res/v1/web/search` shape. The raw JSON is
 * boundary-validated (zod) into `SearchResult` before use — never trust raw API
 * data. Timeout-bounded + retried on transient failures via `shared/retry`.
 */
export class BraveSearchProvider implements SearchProvider {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.search.brave.com',
  ) {}

  async search(query: string, opts: SearchOptions): Promise<SearchResult[]> {
    if (query.trim() === '') return [];

    const params = new URLSearchParams({
      q: query,
      count: String(opts.limit),
      country: opts.country,
    });
    const res = await withRetry(
      () =>
        withAbortableTimeout(
          (signal) =>
            fetch(`${this.baseUrl}/res/v1/web/search?${params.toString()}`, {
              method: 'GET',
              headers: {
                Accept: 'application/json',
                'Accept-Encoding': 'gzip',
                'X-Subscription-Token': this.apiKey,
              },
              signal,
            }),
          opts.timeoutMs,
        ),
      { retries: 2, baseDelayMs: 500, isRetryable: isTransientFetchError },
    );

    if (!res.ok) {
      throw new SearchProviderError(`Brave Search HTTP ${res.status}`);
    }

    const parsed = BraveResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      throw new SearchProviderError(
        `Brave Search response failed validation: ${parsed.error.message}`,
      );
    }

    const results = parsed.data.web?.results ?? [];
    return results.slice(0, opts.limit).map((r) => ({
      url: r.url,
      title: r.title ?? '',
      snippet: r.description ?? '',
    }));
  }
}

/**
 * Only the fields we consume. Extra keys are ignored (zod strips them); a result
 * missing `url` is dropped rather than crashing the whole search.
 */
const BraveResultSchema = z.object({
  url: z.string().url(),
  title: z.string().optional(),
  description: z.string().optional(),
});
const BraveResponseSchema = z.object({
  web: z
    .object({
      // Drop malformed entries (no url) instead of failing the call.
      results: z
        .array(BraveResultSchema.nullable().catch(null))
        .transform((rs) => rs.filter((r): r is z.infer<typeof BraveResultSchema> => r !== null)),
    })
    .optional(),
});

function isTransientFetchError(err: unknown): boolean {
  if (err instanceof TimeoutError) return true;
  if (err instanceof Error) {
    if (err.name === 'AbortError') return true;
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN';
  }
  return false;
}

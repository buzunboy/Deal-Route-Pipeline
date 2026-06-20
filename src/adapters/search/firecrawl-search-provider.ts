import { z } from 'zod';
import type { SearchProvider, SearchOptions, SearchResult } from '../../application/ports/index.js';
import { withRetry, withAbortableTimeout } from '../shared/retry.js';
import { SearchProviderError, isRetryableSearchError } from './search-provider-error.js';

/**
 * Firecrawl `/v2/search` adapter — a real SearchProvider that reuses the existing
 * `FIRECRAWL_API_KEY` (one less vendor/key). Enabled via `SEARCH_PROVIDER=firecrawl`.
 * Substitutable behind the port (LSP).
 *
 * v2 response shape (verified live 2026-06-20): `data.web[]`, each
 * `{url, title, description, position}` (v1 was a flat `data[]`). Raw JSON is
 * boundary-validated (zod) into `SearchResult` before use — open-web search output
 * is untrusted like any other.
 *
 * INLINE SCRAPE (`opts.scrape`): v2 can return page content (markdown + html +
 * screenshot) per result via `scrapeOptions`, so the Tier-4 lane can reuse the
 * search-time scrape instead of a second full fetch. We expose it on
 * `SearchResult.content`, but the CALLER must still apply its own robots/rate-limit
 * gate before using it — Firecrawl's server-side fetch is NOT our PoliteFetcher.
 * Default (no `scrape`) stays results-only + cheap.
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
            fetch(`${this.baseUrl}/v2/search`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                query,
                limit: opts.limit,
                // v2 takes ISO-3166-1 alpha-2 lowercased; same as v1.
                location: opts.country.toLowerCase(),
                // Request inline page content only when asked (markdown for extraction,
                // html for evidence parity, screenshot for the evidence bundle).
                ...(opts.scrape
                  ? { scrapeOptions: { formats: ['markdown', 'html', 'screenshot'] } }
                  : {}),
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

    const web = parsed.data.data?.web ?? [];
    return web.slice(0, opts.limit).map((r) => {
      const result: SearchResult = {
        url: r.url,
        title: r.title ?? '',
        snippet: r.description ?? '',
        ...(r.position !== undefined ? { position: r.position } : {}),
      };
      // Carry inline content only when the page actually scraped (markdown present).
      if (opts.scrape && (r.markdown ?? '') !== '') {
        result.content = {
          text: r.markdown ?? '',
          html: r.html ?? '',
          ...(r.screenshot ? { screenshotRef: r.screenshot } : {}),
        };
      }
      return result;
    });
  }
}

/** Only the fields we consume. Malformed entries (no url) are dropped. */
const FirecrawlSearchResultSchema = z.object({
  url: z.string().url(),
  title: z.string().optional(),
  description: z.string().optional(),
  position: z.number().int().positive().optional(),
  // Inline-scrape fields (present only when scrapeOptions was sent).
  markdown: z.string().optional(),
  html: z.string().optional(),
  screenshot: z.string().optional(),
});
/** v2 nests results under `data.web` (v1 was a flat `data[]`). */
const FirecrawlSearchResponseSchema = z.object({
  data: z
    .object({
      web: z
        .array(FirecrawlSearchResultSchema.nullable().catch(null))
        .transform((rs) =>
          rs.filter((r): r is z.infer<typeof FirecrawlSearchResultSchema> => r !== null),
        )
        .optional(),
    })
    .optional(),
});

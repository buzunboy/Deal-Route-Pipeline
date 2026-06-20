/**
 * SearchProvider port — the open-web search seam for Tier-4 broad discovery
 * (Phase C, stage C-1). The agentic lane turns a query into a handful of public
 * result URLs to fetch + extract. Defined as a port so the backend is swappable
 * from config (DIP/OCP), exactly like `Fetcher` and `Llm`: a deterministic stub
 * (the default off-switch), a real search API, or Firecrawl's search endpoint.
 *
 * Adapters MUST boundary-validate raw provider JSON into `SearchResult` (zod)
 * before returning it — open-web search responses are untrusted input like any
 * other (`code-style.md`: never trust raw data).
 */
export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
  /** 1-based rank of this result in the provider's ordering, when reported. */
  position?: number;
  /**
   * Inline page content, present ONLY when `opts.scrape` was requested AND the
   * provider supports search-time scraping (Firecrawl v2). Lets the Tier-4 lane
   * reuse the search-time scrape instead of a second full fetch — but the caller
   * MUST still apply its own robots/rate-limit gate before using this (the
   * provider's fetch is not our PoliteFetcher). `screenshotRef` is a URL or
   * data-URI to be resolved to bytes for the evidence bundle.
   */
  content?: {
    text: string;
    html: string;
    screenshotRef?: string;
  };
}

export interface SearchOptions {
  /** Max results to return (the adapter may return fewer). */
  limit: number;
  /** ISO-3166-1 alpha-2 country bias, e.g. "DE". */
  country: string;
  /** Per-call timeout; the adapter bounds the network call by this. */
  timeoutMs: number;
  /**
   * Request inline page content (markdown + html + screenshot) per result when the
   * provider supports it (Firecrawl v2 `scrapeOptions`). Default false (results
   * only — the historical behaviour). When true, the provider MAY populate
   * `SearchResult.content`; callers must not assume it is present.
   */
  scrape?: boolean;
}

export interface SearchProvider {
  /** Run one web search. Returns at most `opts.limit` validated results. */
  search(query: string, opts: SearchOptions): Promise<SearchResult[]>;
}

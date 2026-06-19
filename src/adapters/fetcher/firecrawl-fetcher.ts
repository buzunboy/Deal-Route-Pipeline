import type { Fetcher, FetchOptions, FetchResult } from '../../application/ports/index.js';
import { withRetry, withTimeout } from '../shared/retry.js';
import { classifyPage } from './page-classifier.js';

/**
 * Firecrawl fetcher — an alternative to Playwright (off by default; enabled via
 * `FETCHER=firecrawl`). Substitutable behind the `Fetcher` port (LSP). Uses the
 * Firecrawl HTTP API to return markdown + HTML + a screenshot.
 *
 * Implemented against the documented `/v1/scrape` shape; no Firecrawl SDK
 * dependency so the adapter stays swappable. Confirm the exact response shape
 * against the current API at integration time.
 */
export class FirecrawlFetcher implements Fetcher {
  constructor(
    private readonly apiKey: string,
    private readonly defaultTimeoutMs: number,
    private readonly baseUrl = 'https://api.firecrawl.dev',
  ) {}

  async fetch(url: string, options: FetchOptions = {}): Promise<FetchResult> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const empty = emptyResult(url);
    try {
      const res = await withRetry(
        () =>
          withTimeout(
            fetch(`${this.baseUrl}/v1/scrape`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${this.apiKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                url,
                formats: ['markdown', 'html', 'screenshot'],
              }),
            }),
            timeoutMs,
          ),
        { retries: 2, baseDelayMs: 500, isRetryable: () => true },
      );

      if (!res.ok) {
        const outcome = res.status === 401 || res.status === 403 ? 'blocked' : 'error';
        return { ...empty, outcome, error: `Firecrawl HTTP ${res.status}` };
      }

      const body = (await res.json()) as FirecrawlResponse;
      const data = body.data ?? {};
      const text = data.markdown ?? '';
      const html = data.html ?? '';
      const screenshot = data.screenshot ? await downloadBytes(data.screenshot, timeoutMs) : new Uint8Array();

      const outcome = classifyPage({ httpStatus: 200, text, hasPasswordField: false });
      if (outcome !== 'ok') return { ...empty, outcome, finalUrl: data.url ?? url };

      return { outcome: 'ok', url, finalUrl: data.url ?? url, text, html, screenshot };
    } catch (err) {
      return { ...empty, outcome: 'error', error: err instanceof Error ? err.message : String(err) };
    }
  }
}

interface FirecrawlResponse {
  data?: {
    markdown?: string;
    html?: string;
    /** Either a URL to the screenshot or a data URI, depending on API version. */
    screenshot?: string;
    url?: string;
  };
}

async function downloadBytes(ref: string, timeoutMs: number): Promise<Uint8Array> {
  if (ref.startsWith('data:')) {
    const base64 = ref.slice(ref.indexOf(',') + 1);
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  const res = await withTimeout(fetch(ref), timeoutMs);
  return new Uint8Array(await res.arrayBuffer());
}

function emptyResult(url: string): FetchResult {
  return { outcome: 'error', url, finalUrl: url, text: '', html: '', screenshot: new Uint8Array() };
}

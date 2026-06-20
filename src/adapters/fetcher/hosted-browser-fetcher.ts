import type { Fetcher, FetchOptions, FetchResult } from '../../application/ports/index.js';

/**
 * Hosted-browser Fetcher (Phase C, stage C-2 — hosted cut) — SCAFFOLD.
 *
 * A cloud browser API (Browserbase / Steel / Hyperbrowser / …) renders JS-heavy
 * pages from dedicated IPs with stealth, for sites where the local-Playwright
 * `BrowserRenderFetcher` is bot-blocked or won't scale. It sits behind the SAME
 * `Fetcher` port, so the composition root still wraps it in `PoliteFetcher`
 * (robots + rate-limit + evidence size caps all keep applying) and the agent loop
 * is unchanged — switching to it is config-only (`FETCHER=hosted-browser`).
 *
 * The vendor is NOT chosen yet, so `fetch()` throws a clear, typed error rather
 * than silently returning bad data. Filling it in is a LOCALIZED change: implement
 * the vendor's "render this URL → HTML + text + screenshot" REST call and map the
 * response into a `FetchResult` (mirror `firecrawl-fetcher.ts` — timeout-bound +
 * retry transient/5xx, bound the body + screenshot bytes, classify the outcome).
 * Until then, selecting `FETCHER=hosted-browser` fails loudly at first use.
 */
export class HostedBrowserFetcher implements Fetcher {
  constructor(
    private readonly apiKey: string,
    private readonly defaultTimeoutMs: number,
    private readonly baseUrl = 'https://api.example-hosted-browser.dev',
  ) {}

  async fetch(url: string, _options: FetchOptions = {}): Promise<FetchResult> {
    // TODO(c2-hosted): implement the chosen vendor's render call here. Expected shape:
    //   1. POST {baseUrl}/render { url, formats: ['html','text','screenshot'] }
    //      with Authorization: Bearer {this.apiKey}, timeout-bound + retried on 5xx;
    //   2. boundary-validate the JSON (zod) — never trust raw vendor data;
    //   3. bound the body + screenshot bytes (see firecrawl-fetcher size caps);
    //   4. map → FetchResult { outcome, url, finalUrl, text, html, screenshot };
    //   5. classify login/captcha/block via page-classifier; on a missing/empty
    //      screenshot return `error` (evidence is required — never ok-with-empty).
    throw new HostedBrowserNotConfiguredError(url);
  }

  async close(): Promise<void> {
    // No persistent resource yet; present so the composition root can treat every
    // browser fetcher as closable uniformly.
  }
}

/** Thrown when the hosted-browser fetcher is selected but not yet implemented. */
export class HostedBrowserNotConfiguredError extends Error {
  constructor(url: string) {
    super(
      `FETCHER=hosted-browser is a scaffold and not yet implemented (requested ${url}). ` +
        `Implement HostedBrowserFetcher.fetch for the chosen vendor, or use ` +
        `FETCHER=browser (local Playwright JS-render) / FETCHER=playwright.`,
    );
    this.name = 'HostedBrowserNotConfiguredError';
  }
}

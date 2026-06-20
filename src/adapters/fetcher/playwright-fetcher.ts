import { chromium, type Browser } from 'playwright';
import type { Fetcher, FetchOptions, FetchResult } from '../../application/ports/index.js';
import { withTimeout } from '../shared/retry.js';
import { capturePage } from './playwright-capture.js';

/**
 * Playwright fetcher — the local dev default. Loads a public page in a headless
 * browser (wait: `domcontentloaded` — the cheap, server-rendered path), then
 * captures HTML + markdown text + a bounded screenshot and classifies
 * login/captcha/block outcomes (never logs in: public-only v1). For JS-heavy SPAs
 * whose offers only appear after client-side render, use the `BrowserRenderFetcher`
 * (`FETCHER=browser`), which shares the same capture path but waits for the network
 * to settle.
 *
 * The browser is launched lazily and reused; call `close()` at shutdown. A fetch
 * never throws on a reachable failure — it returns an `error`/`blocked` outcome the
 * caller routes appropriately (resilience).
 */
export class PlaywrightFetcher implements Fetcher {
  private browser: Browser | null = null;

  constructor(private readonly defaultTimeoutMs: number) {}

  async fetch(url: string, options: FetchOptions = {}): Promise<FetchResult> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    try {
      const browser = await this.ensureBrowser();
      const context = await browser.newContext({ userAgent: options.userAgent });
      const page = await context.newPage();
      // Bound EVERY subsequent operation (content/locator/evaluate), not just goto —
      // a page that finishes domcontentloaded but then hangs (infinite scroll, stuck
      // render) must not block the serialised per-domain fetch.
      page.setDefaultTimeout(timeoutMs);
      try {
        const response = await withTimeout(
          page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }),
          timeoutMs + 1000,
        );
        return await capturePage(page, url, response?.status() ?? 0, timeoutMs);
      } finally {
        await context.close();
      }
    } catch (err) {
      return {
        outcome: 'error',
        url,
        finalUrl: url,
        text: '',
        html: '',
        screenshot: new Uint8Array(),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser === null) {
      this.browser = await chromium.launch({ headless: true });
    }
    return this.browser;
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
  }
}

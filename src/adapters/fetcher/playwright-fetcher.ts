import { chromium, type Browser } from 'playwright';
import TurndownService from 'turndown';
import type { Fetcher, FetchOptions, FetchResult } from '../../application/ports/index.js';
import { withTimeout } from '../shared/retry.js';
import { classifyPage } from './page-classifier.js';

/**
 * Playwright fetcher — the local dev default. Loads a public page in a headless
 * browser, captures a full-page screenshot + raw HTML + markdown text, and
 * classifies login/captcha/block outcomes (never logs in: public-only v1).
 *
 * The browser is launched lazily and reused; call `close()` at shutdown. A
 * fetch never throws on a reachable failure — it returns an `error`/`blocked`
 * outcome the caller routes appropriately (resilience).
 */
export class PlaywrightFetcher implements Fetcher {
  private browser: Browser | null = null;
  private readonly turndown = new TurndownService();

  constructor(private readonly defaultTimeoutMs: number) {}

  async fetch(url: string, options: FetchOptions = {}): Promise<FetchResult> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const empty = emptyResult(url);
    try {
      const browser = await this.ensureBrowser();
      const context = await browser.newContext({
        userAgent: options.userAgent,
      });
      const page = await context.newPage();
      try {
        const response = await withTimeout(
          page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }),
          timeoutMs + 1000,
        );
        const httpStatus = response?.status() ?? 0;
        const html = await page.content();
        const hasPasswordField = (await page.locator('input[type="password"]').count()) > 0;
        const screenshot = await page.screenshot({ fullPage: true });
        // `document` runs in the browser context, not Node — typed loosely here
        // to avoid pulling the DOM lib into the whole server build.
        const bodyText = await page.evaluate(
          () => (globalThis as { document?: { body?: { innerText?: string } } }).document?.body?.innerText ?? '',
        );
        const text = this.turndown.turndown(html);

        const outcome = classifyPage({ httpStatus, text: bodyText, hasPasswordField });
        if (outcome !== 'ok') {
          return { ...empty, outcome, finalUrl: page.url() };
        }
        return {
          outcome: 'ok',
          url,
          finalUrl: page.url(),
          text,
          html,
          screenshot: new Uint8Array(screenshot),
        };
      } finally {
        await context.close();
      }
    } catch (err) {
      return { ...empty, outcome: 'error', error: err instanceof Error ? err.message : String(err) };
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

function emptyResult(url: string): FetchResult {
  return {
    outcome: 'error',
    url,
    finalUrl: url,
    text: '',
    html: '',
    screenshot: new Uint8Array(),
  };
}

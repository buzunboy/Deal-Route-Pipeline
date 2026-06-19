import { chromium, type Browser, type Page } from 'playwright';
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
/** Hard cap on captured HTML — a huge/infinite-scroll page must not OOM the worker. */
const MAX_HTML_BYTES = 8 * 1024 * 1024; // 8 MB
/** Max full-page screenshot height (px); taller pages are clipped, not unbounded. */
const MAX_SCREENSHOT_HEIGHT = 20000;

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
      // Bound EVERY subsequent operation (content/locator/evaluate), not just
      // goto — a page that finishes domcontentloaded but then hangs (infinite
      // scroll, stuck render) must not block the serialised per-domain fetch.
      page.setDefaultTimeout(timeoutMs);
      try {
        const response = await withTimeout(
          page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }),
          timeoutMs + 1000,
        );
        const httpStatus = response?.status() ?? 0;
        const html = await page.content();
        // Size guard: an enormous page (infinite scroll, multi-MB listing) would
        // OOM the worker via content()+turndown()+screenshot held at once. Bail to
        // a contained `error` rather than risk crashing the whole batch.
        if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
          return {
            ...empty,
            outcome: 'error',
            finalUrl: page.url(),
            error: `page HTML exceeds ${MAX_HTML_BYTES} bytes`,
          };
        }
        const hasPasswordField = (await page.locator('input[type="password"]').count()) > 0;
        const screenshot = await this.boundedScreenshot(page, timeoutMs);
        // `document` runs in the browser context, not Node — typed loosely here
        // to avoid pulling the DOM lib into the whole server build. Bounded too,
        // so a wedged JS context can't hang the fetch indefinitely.
        const bodyText = await withTimeout(
          page.evaluate(
            () =>
              (globalThis as { document?: { body?: { innerText?: string } } }).document?.body
                ?.innerText ?? '',
          ),
          timeoutMs,
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
      return {
        ...empty,
        outcome: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Full-page screenshot bounded to a max height — a fullPage shot of an
   * infinite/very tall page produces a giant, useless PNG (and can OOM). Clip to
   * MAX_SCREENSHOT_HEIGHT when the page is taller; otherwise capture fullPage.
   */
  private async boundedScreenshot(page: Page, timeoutMs: number): Promise<Buffer> {
    const height = await page
      .evaluate(
        () =>
          (globalThis as { document?: { body?: { scrollHeight?: number } } }).document?.body
            ?.scrollHeight ?? 0,
      )
      .catch(() => 0);
    if (height > MAX_SCREENSHOT_HEIGHT) {
      const width = await page
        .evaluate(
          () => (globalThis as { window?: { innerWidth?: number } }).window?.innerWidth ?? 1280,
        )
        .catch(() => 1280);
      return page.screenshot({
        clip: { x: 0, y: 0, width, height: MAX_SCREENSHOT_HEIGHT },
        timeout: timeoutMs,
      });
    }
    return page.screenshot({ fullPage: true, timeout: timeoutMs });
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

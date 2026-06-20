import { chromium, type Browser } from 'playwright';
import type { Fetcher, FetchOptions, FetchResult } from '../../application/ports/index.js';
import { withTimeout } from '../shared/retry.js';
import { capturePage } from './playwright-capture.js';

/**
 * JS-render fetcher (Phase C, stage C-2 — local-Playwright cut). Same Fetcher port
 * as `PlaywrightFetcher`, but tuned for JS-HEAVY / SPA pages whose offers only
 * appear AFTER client-side render: it waits for the network to settle
 * (`networkidle`) and does a bounded auto-scroll to trigger lazy-loaded content,
 * then hands off to the SHARED `capturePage` (identical HTML/screenshot size caps +
 * login/captcha/block classification as the plain fetcher — no drift).
 *
 * Selected via `FETCHER=browser`. Because it sits behind the `Fetcher` port, the
 * composition root still wraps it in `PoliteFetcher`, so robots + per-domain
 * rate-limit + evidence size caps all keep applying — this is C-2 WITHOUT bypassing
 * any public-only guardrail. A future hosted-browser vendor (Browserbase/Steel)
 * slots in as another Fetcher behind the same port (see HostedBrowserFetcher).
 *
 * Browser launched lazily + reused; `close()` at shutdown. Never throws on a
 * reachable failure — returns an `error`/`blocked` outcome the caller routes.
 */
const SCROLL_STEPS = 8;
const SCROLL_PAUSE_MS = 250;
/** Whole-phase wall-clock budget for auto-scroll (NOT per-step) so total render time
 *  stays goto + scrollBudget + capture, never a multiple of the fetch timeout. */
const SCROLL_BUDGET_MS = 5000;

export class BrowserRenderFetcher implements Fetcher {
  private browser: Browser | null = null;

  constructor(private readonly defaultTimeoutMs: number) {}

  async fetch(url: string, options: FetchOptions = {}): Promise<FetchResult> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    try {
      const browser = await this.ensureBrowser();
      const context = await browser.newContext({ userAgent: options.userAgent });
      const page = await context.newPage();
      page.setDefaultTimeout(timeoutMs);
      try {
        // Wait for the network to settle so client-rendered content is present.
        // `networkidle` can occasionally never fire on a page with long-polling /
        // websockets, so it's wrapped in withTimeout: on timeout we proceed with
        // whatever rendered (better a partial render than a failed fetch).
        const response = await withTimeout(
          page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs }),
          timeoutMs + 1000,
        ).catch(() => null);

        // Nudge lazy-loaded / infinite-scroll content into the DOM. Bounded by BOTH
        // a step count AND a whole-phase wall-clock budget, so total render time is
        // goto + scrollBudget + capture (never a multiple of timeoutMs). Best-effort:
        // a scroll failure/timeout never fails the fetch (the HTML size cap in
        // capturePage is the backstop for a truly-infinite page).
        await withTimeout(this.autoScroll(page), SCROLL_BUDGET_MS).catch(() => {});

        const httpStatus = response?.status() ?? 0;
        return await capturePage(page, url, httpStatus, timeoutMs);
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

  /** Scroll to the bottom in bounded steps to trigger lazy-loaded content. The
   *  caller wraps this in a whole-phase timeout (SCROLL_BUDGET_MS). */
  private async autoScroll(page: import('playwright').Page): Promise<void> {
    for (let i = 0; i < SCROLL_STEPS; i++) {
      await page.evaluate(() => {
        const w = globalThis as { scrollBy?: (x: number, y: number) => void; innerHeight?: number };
        w.scrollBy?.(0, w.innerHeight ?? 800);
      });
      await page.waitForTimeout(SCROLL_PAUSE_MS);
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

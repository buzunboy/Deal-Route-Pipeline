import { type Page } from 'playwright';
import TurndownService from 'turndown';
import type { FetchResult } from '../../application/ports/index.js';
import { withTimeout } from '../shared/retry.js';
import { classifyPage } from './page-classifier.js';

/**
 * Shared page-capture logic for the Playwright-backed Fetchers (the plain
 * `PlaywrightFetcher` and the JS-render `BrowserRenderFetcher`). They differ ONLY
 * in how they LOAD the page (wait strategy); once a page is loaded, capturing
 * HTML + text + a bounded screenshot and classifying the outcome is identical —
 * and the bounded-evidence guarantees (HTML/screenshot size caps) are
 * trust-critical, so they live in ONE place and can't drift between adapters.
 */

/** Hard cap on captured HTML — a huge/infinite-scroll page must not OOM the worker. */
export const MAX_HTML_BYTES = 8 * 1024 * 1024; // 8 MB
/** Max full-page screenshot height (px); taller pages are clipped, not unbounded. */
export const MAX_SCREENSHOT_HEIGHT = 20000;

const turndown = new TurndownService();

/**
 * Capture a loaded page into a `FetchResult`: size-guard the HTML, classify the
 * outcome (login/captcha/block via the page text + password-field heuristic), take
 * a bounded screenshot, and convert HTML → markdown. Every operation is timeout-
 * bounded so a wedged render/JS context can't hang the serialised per-domain fetch.
 * Returns an `error` result (never throws) on an over-cap page.
 */
export async function capturePage(
  page: Page,
  requestedUrl: string,
  httpStatus: number,
  timeoutMs: number,
): Promise<FetchResult> {
  const finalUrl = page.url();
  const empty: FetchResult = {
    outcome: 'error',
    url: requestedUrl,
    finalUrl,
    text: '',
    html: '',
    screenshot: new Uint8Array(),
  };

  const html = await page.content();
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    return { ...empty, error: `page HTML exceeds ${MAX_HTML_BYTES} bytes` };
  }

  const hasPasswordField = (await page.locator('input[type="password"]').count()) > 0;
  const screenshot = await boundedScreenshot(page, timeoutMs);
  // `document` runs in the browser context, not Node — typed loosely to avoid
  // pulling the DOM lib into the whole server build. Bounded so a wedged JS
  // context can't hang the fetch indefinitely.
  const bodyText = await withTimeout(
    page.evaluate(
      () =>
        (globalThis as { document?: { body?: { innerText?: string } } }).document?.body
          ?.innerText ?? '',
    ),
    timeoutMs,
  );
  const text = turndown.turndown(html);

  const { outcome, signal } = classifyPage({ httpStatus, text: bodyText, hasPasswordField });
  // Non-`ok` (captcha / soft-404 / 5xx) carries no usable body — return empty so no
  // candidate or evidence is built from it. A login-wall / soft-block now classifies
  // `ok` with a `signal` under best-effort-read, so its body flows through normally.
  if (outcome !== 'ok') return { ...empty, outcome };

  return {
    outcome: 'ok',
    url: requestedUrl,
    finalUrl,
    text,
    html,
    screenshot: new Uint8Array(screenshot),
    ...(signal ? { fetchSignal: signal } : {}),
  };
}

/**
 * Full-page screenshot bounded to a max height — a fullPage shot of an
 * infinite/very tall page produces a giant, useless PNG (and can OOM). Clip to
 * MAX_SCREENSHOT_HEIGHT when the page is taller; otherwise capture fullPage.
 */
export async function boundedScreenshot(page: Page, timeoutMs: number): Promise<Buffer> {
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

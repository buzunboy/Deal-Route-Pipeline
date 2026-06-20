import { describe, it, expect, vi } from 'vitest';
import type { Page } from 'playwright';
import { capturePage, MAX_HTML_BYTES, MAX_SCREENSHOT_HEIGHT } from './playwright-capture.js';

/**
 * Hermetic tests for the SHARED page-capture logic (used by both PlaywrightFetcher
 * and BrowserRenderFetcher). The trust-critical bits are the bounded-evidence size
 * caps — an over-cap page must yield a contained `error`, never an OOM. We drive a
 * minimal stub `Page` (no real browser) so these run in the fast unit tier, unlike
 * the browser fetchers themselves (which are live-tier).
 */
interface StubPageOpts {
  html?: string;
  bodyText?: string;
  scrollHeight?: number;
  innerWidth?: number;
  passwordFields?: number;
  finalUrl?: string;
}

function stubPage(opts: StubPageOpts = {}): { page: Page; screenshotCalls: unknown[] } {
  const screenshotCalls: unknown[] = [];
  // Route each page.evaluate by the SOURCE of the passed fn (robust to call order):
  // the body-text reader mentions `innerText`, the height reader `scrollHeight`,
  // the width reader `innerWidth`. We can't execute the fn (no DOM), so inspect it.
  const evaluate = vi.fn(async (fn: unknown) => {
    const src = String(fn);
    if (src.includes('scrollHeight')) return opts.scrollHeight ?? 100;
    if (src.includes('innerWidth')) return opts.innerWidth ?? 1280;
    if (src.includes('innerText')) return opts.bodyText ?? 'ok body text';
    return undefined;
  });
  const page = {
    url: () => opts.finalUrl ?? 'https://t.de/x',
    content: async () => opts.html ?? '<html><body>ok</body></html>',
    locator: () => ({ count: async () => opts.passwordFields ?? 0 }),
    evaluate,
    screenshot: async (arg: unknown) => {
      screenshotCalls.push(arg);
      return Buffer.from([137, 80, 78, 71]);
    },
  } as unknown as Page;
  return { page, screenshotCalls };
}

describe('capturePage — bounded evidence', () => {
  it('returns ok with html+text+screenshot for a normal page', async () => {
    const { page } = stubPage({ html: '<html><body>Disney+ im Bundle</body></html>' });
    const r = await capturePage(page, 'https://t.de/x', 200, 5000);
    expect(r.outcome).toBe('ok');
    expect(r.html).toContain('Disney+');
    expect(r.text.length).toBeGreaterThan(0);
    expect(r.screenshot.byteLength).toBeGreaterThan(0);
    expect(r.finalUrl).toBe('https://t.de/x');
  });

  it('rejects an over-cap page as a contained error (no OOM, no screenshot taken)', async () => {
    const huge = '<html><body>' + 'x'.repeat(MAX_HTML_BYTES + 1) + '</body></html>';
    const { page, screenshotCalls } = stubPage({ html: huge });
    const r = await capturePage(page, 'https://t.de/x', 200, 5000);
    expect(r.outcome).toBe('error');
    expect(r.error).toMatch(/exceeds/);
    expect(r.screenshot.byteLength).toBe(0);
    expect(screenshotCalls).toHaveLength(0); // bailed before screenshotting
  });

  it('clips the screenshot when the page is taller than the cap', async () => {
    const { page, screenshotCalls } = stubPage({ scrollHeight: MAX_SCREENSHOT_HEIGHT + 5000 });
    await capturePage(page, 'https://t.de/x', 200, 5000);
    expect(screenshotCalls).toHaveLength(1);
    expect(screenshotCalls[0]).toMatchObject({ clip: { height: MAX_SCREENSHOT_HEIGHT } });
  });

  it('takes a fullPage screenshot when the page is within the height cap', async () => {
    const { page, screenshotCalls } = stubPage({ scrollHeight: 500 });
    await capturePage(page, 'https://t.de/x', 200, 5000);
    expect(screenshotCalls[0]).toMatchObject({ fullPage: true });
  });

  it('returns a non-ok outcome (empty evidence) when the page classifies as a login wall', async () => {
    // A password field + login-ish text → classifyPage returns login_required.
    const { page } = stubPage({
      passwordFields: 1,
      bodyText: 'Bitte einloggen / Passwort vergessen? Anmelden',
      html: '<html><body>login</body></html>',
    });
    const r = await capturePage(page, 'https://t.de/login', 200, 5000);
    expect(r.outcome).not.toBe('ok');
    expect(r.text).toBe('');
    expect(r.html).toBe('');
  });
});

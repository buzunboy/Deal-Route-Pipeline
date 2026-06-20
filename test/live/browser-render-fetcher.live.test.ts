import { describe, it, expect, afterEach } from 'vitest';
import { BrowserRenderFetcher } from '../../src/adapters/fetcher/browser-render-fetcher.js';

/**
 * LIVE smoke for the C-2 JS-render fetcher — drives REAL Chromium against a real
 * site to confirm it renders client-side content and returns a complete, bounded
 * bundle (text + html + non-empty screenshot). NON-deterministic + needs a browser,
 * so self-skips unless RUN_LIVE_TESTS=1. Scheduled / live-test label only.
 *
 * We assert the CONTRACT shape (ok → non-empty html+text+screenshot, or a clean
 * routing outcome), not exact page content — the live world changes.
 */
const MINUTE = 60_000;
const enabled = process.env.RUN_LIVE_TESTS === '1';
const suite = enabled ? describe : describe.skip;

suite('live BrowserRenderFetcher smoke', () => {
  let fetcher: BrowserRenderFetcher | undefined;
  afterEach(async () => {
    await fetcher?.close();
    fetcher = undefined;
  });

  it(
    'renders a real page into a complete bounded bundle (or a clean routing outcome)',
    async () => {
      fetcher = new BrowserRenderFetcher(30_000);
      const r = await fetcher.fetch('https://www.spotify.com/de/premium/', {
        timeoutMs: 30_000,
        userAgent: 'DealRouteBot/0.1',
      });

      // A bot-wall/login is a legitimate routing outcome, not a code failure.
      if (r.outcome !== 'ok') {
        console.warn(`render fetch outcome: ${r.outcome} — skipping content assert`);
        return;
      }
      // An ok render must be complete evidence: non-empty html, text, screenshot.
      expect(r.html.length).toBeGreaterThan(0);
      expect(r.text.length).toBeGreaterThan(0);
      expect(r.screenshot.byteLength).toBeGreaterThan(0);
      expect(r.finalUrl).toMatch(/^https?:\/\//);
    },
    2 * MINUTE,
  );
});

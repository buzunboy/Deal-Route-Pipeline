import { describe, it, expect, afterEach } from 'vitest';
import { Container } from './container.js';
import { loadConfig } from '../config/index.js';
import { PoliteFetcher } from '../adapters/fetcher/polite-fetcher.js';

/**
 * Container wiring tests for the fetcher backend selection (incl. the C-2 browser
 * adapters). Hermetic: usePersistence:false → in-memory DB, no Postgres; the
 * Playwright/browser fetchers launch Chromium LAZILY (only on fetch()), so merely
 * constructing the container touches no browser or network. We assert the
 * composition root's selection + fail-loud-on-missing-key behavior, then shut down.
 */
function cfg(overrides: Record<string, string> = {}) {
  return loadConfig({ LLM_PROVIDER: 'stub', ...overrides });
}

describe('Container — fetcher selection', () => {
  let container: Container | undefined;
  afterEach(async () => {
    await container?.shutdown();
    container = undefined;
  });

  it('wraps the default playwright fetcher in PoliteFetcher (robots/rate-limit applied)', () => {
    container = new Container(cfg(), { usePersistence: false });
    // The trust guarantee of "Option A": EVERY fetcher backend is wrapped, so no
    // lane bypasses robots/rate-limit/size caps. Assert the wrap, not just defined.
    expect(container.fetcher).toBeInstanceOf(PoliteFetcher);
  });

  it('wraps FETCHER=browser (C-2 JS-render) in PoliteFetcher too', () => {
    container = new Container(cfg({ FETCHER: 'browser' }), { usePersistence: false });
    expect(container.fetcher).toBeInstanceOf(PoliteFetcher);
  });

  it('wraps FETCHER=hosted-browser (C-2 scaffold) in PoliteFetcher too', () => {
    container = new Container(cfg({ FETCHER: 'hosted-browser', BROWSER_API_KEY: 'k' }), {
      usePersistence: false,
    });
    expect(container.fetcher).toBeInstanceOf(PoliteFetcher);
  });

  it('fails loudly when FETCHER=hosted-browser has no BROWSER_API_KEY', () => {
    expect(
      () => new Container(cfg({ FETCHER: 'hosted-browser' }), { usePersistence: false }),
    ).toThrow(/BROWSER_API_KEY/);
  });

  it('fails loudly when FETCHER=firecrawl has no FIRECRAWL_API_KEY', () => {
    expect(() => new Container(cfg({ FETCHER: 'firecrawl' }), { usePersistence: false })).toThrow(
      /FIRECRAWL_API_KEY/,
    );
  });
});

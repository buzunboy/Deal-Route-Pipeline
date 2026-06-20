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

describe('Container — evidence store selection', () => {
  let container: Container | undefined;
  afterEach(async () => {
    await container?.shutdown();
    container = undefined;
  });

  it('builds the local-fs evidence store by default', () => {
    container = new Container(cfg(), { usePersistence: false });
    expect(container.evidenceStore).toBeDefined();
  });

  it('fails loudly when EVIDENCE_STORE=s3 but the S3 block is missing (no S3_BUCKET)', () => {
    // Config loads (kind=s3, s3=undefined); the composition root must fail loud.
    expect(() => new Container(cfg({ EVIDENCE_STORE: 's3' }), { usePersistence: false })).toThrow(
      /S3/,
    );
  });

  it('builds the S3 evidence store (+ registers it for shutdown) with a full S3 block', async () => {
    container = new Container(
      cfg({
        EVIDENCE_STORE: 's3',
        S3_BUCKET: 'b',
        S3_REGION: 'eu-central-1',
        S3_ACCESS_KEY_ID: 'AK',
        S3_SECRET_ACCESS_KEY: 'SK',
      }),
      { usePersistence: false },
    );
    expect(container.evidenceStore).toBeDefined();
    // shutdown() must close the S3 client without throwing (closable registered).
    await expect(container.shutdown()).resolves.toBeUndefined();
    container = undefined; // already shut down
  });
});

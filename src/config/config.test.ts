import { describe, it, expect } from 'vitest';
import { loadConfig } from './config.js';

/**
 * Config is the boundary where env → typed config; the search-backend selection
 * has real trust weight (the wrong default could reach the open web), so pin it.
 * We pass an explicit env record rather than mutating process.env.
 */
function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { LLM_PROVIDER: 'stub', ...overrides };
}

describe('loadConfig — fetcher backend selection', () => {
  it('defaults the fetcher to playwright', () => {
    expect(loadConfig(env()).fetcher.kind).toBe('playwright');
  });

  it('accepts the C-2 browser + hosted-browser kinds', () => {
    expect(loadConfig(env({ FETCHER: 'browser' })).fetcher.kind).toBe('browser');
    expect(loadConfig(env({ FETCHER: 'hosted-browser' })).fetcher.kind).toBe('hosted-browser');
  });

  it('rejects an unknown FETCHER value', () => {
    expect(() => loadConfig(env({ FETCHER: 'selenium' }))).toThrow();
  });

  it('reads BROWSER_API_KEY (empty → undefined)', () => {
    expect(loadConfig(env({ BROWSER_API_KEY: 'k' })).fetcher.browserApiKey).toBe('k');
    expect(loadConfig(env({ BROWSER_API_KEY: '  ' })).fetcher.browserApiKey).toBeUndefined();
  });
});

describe('loadConfig — search backend selection', () => {
  it('defaults to the offline stub when no SEARCH_API_KEY is set', () => {
    const cfg = loadConfig(env());
    expect(cfg.search.provider).toBe('stub');
    expect(cfg.search.resultsPerQuery).toBe(10);
  });

  it('defaults to the real api when SEARCH_API_KEY is configured', () => {
    const cfg = loadConfig(env({ SEARCH_API_KEY: 'brave-key' }));
    expect(cfg.search.provider).toBe('api');
    expect(cfg.search.apiKey).toBe('brave-key');
  });

  it('honours an explicit SEARCH_PROVIDER override', () => {
    const cfg = loadConfig(env({ SEARCH_PROVIDER: 'firecrawl', FIRECRAWL_API_KEY: 'fc' }));
    expect(cfg.search.provider).toBe('firecrawl');
  });

  it('treats an empty SEARCH_API_KEY as unset (stays on stub)', () => {
    const cfg = loadConfig(env({ SEARCH_API_KEY: '   ' }));
    expect(cfg.search.provider).toBe('stub');
    expect(cfg.search.apiKey).toBeUndefined();
  });

  it('parses a custom SEARCH_RESULTS_PER_QUERY', () => {
    const cfg = loadConfig(env({ SEARCH_RESULTS_PER_QUERY: '5' }));
    expect(cfg.search.resultsPerQuery).toBe(5);
  });

  it('rejects a non-positive SEARCH_RESULTS_PER_QUERY', () => {
    expect(() => loadConfig(env({ SEARCH_RESULTS_PER_QUERY: '0' }))).toThrow();
  });
});

describe('loadConfig — browser agent selection', () => {
  it('defaults the agent to noop (Tier-4 stays dark)', () => {
    const cfg = loadConfig(env());
    expect(cfg.agent.kind).toBe('noop');
  });

  it('stays noop even when a search key is configured (explicit opt-in required)', () => {
    const cfg = loadConfig(env({ SEARCH_API_KEY: 'k' }));
    expect(cfg.agent.kind).toBe('noop');
  });

  it('honours AGENT=search', () => {
    const cfg = loadConfig(env({ AGENT: 'search' }));
    expect(cfg.agent.kind).toBe('search');
  });

  it('rejects an unknown AGENT value', () => {
    expect(() => loadConfig(env({ AGENT: 'browseruse' }))).toThrow();
  });
});

describe('loadConfig — S3 evidence store block', () => {
  it('defaults the evidence store to local with no S3 block', () => {
    const cfg = loadConfig(env());
    expect(cfg.evidence.kind).toBe('local');
    expect(cfg.evidence.s3).toBeUndefined();
  });

  it('builds the S3 block when S3_BUCKET is set', () => {
    const cfg = loadConfig(
      env({
        EVIDENCE_STORE: 's3',
        S3_BUCKET: 'dealroute-evidence',
        S3_REGION: 'eu-central-1',
        S3_ACCESS_KEY_ID: 'AK',
        S3_SECRET_ACCESS_KEY: 'SK',
      }),
    );
    expect(cfg.evidence.kind).toBe('s3');
    expect(cfg.evidence.s3).toMatchObject({ bucket: 'dealroute-evidence', region: 'eu-central-1' });
  });

  it('rejects a partial S3 block (bucket set, creds missing) — fail loud at config load', () => {
    expect(() =>
      loadConfig(env({ EVIDENCE_STORE: 's3', S3_BUCKET: 'b', S3_REGION: 'r' })),
    ).toThrow();
  });

  it('rejects a non-URL S3_CDN_BASE_URL', () => {
    expect(() =>
      loadConfig(
        env({
          S3_BUCKET: 'b',
          S3_REGION: 'r',
          S3_ACCESS_KEY_ID: 'AK',
          S3_SECRET_ACCESS_KEY: 'SK',
          S3_CDN_BASE_URL: 'not-a-url',
        }),
      ),
    ).toThrow();
  });

  it('accepts a valid S3_CDN_BASE_URL', () => {
    const cfg = loadConfig(
      env({
        S3_BUCKET: 'b',
        S3_REGION: 'r',
        S3_ACCESS_KEY_ID: 'AK',
        S3_SECRET_ACCESS_KEY: 'SK',
        S3_CDN_BASE_URL: 'https://cdn.dealroute.example',
      }),
    );
    expect(cfg.evidence.s3?.cdnBaseUrl).toBe('https://cdn.dealroute.example');
  });
});

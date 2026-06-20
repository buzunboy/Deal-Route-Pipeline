import { describe, it, expect, vi, afterEach } from 'vitest';
import { FirecrawlSearchProvider } from './firecrawl-search-provider.js';
import { SearchProviderError } from './search-provider-error.js';
import {
  searchProviderContract,
  sampleResults,
} from '../../../test/contracts/search-provider-contract.js';

const opts = { limit: 10, country: 'DE', timeoutMs: 2000 };

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

/** v2 nests results under data.web; build that shape from plain result objects. */
function v2(web: unknown[]): { success: boolean; data: { web: unknown[] } } {
  return { success: true, data: { web } };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// The real adapter must pass the SAME SearchProvider contract as the stub (LSP).
// The query is in the POST body, so the stub keys off that.
const RICH = 'Disney+ im Bundle';
const EMPTY = 'no such query';
searchProviderContract('FirecrawlSearchProvider', () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const q = JSON.parse(init.body as string).query as string;
      const web = q.includes('Disney')
        ? sampleResults(5).map((r) => ({ url: r.url, title: r.title, description: r.snippet }))
        : [];
      return jsonResponse(v2(web));
    }),
  );
  return {
    provider: new FirecrawlSearchProvider('key'),
    richQuery: RICH,
    emptyQuery: EMPTY,
    seededCount: 5,
  };
});

describe('FirecrawlSearchProvider (v2)', () => {
  it('maps a well-formed v2 response (data.web[]) into SearchResult[], hits /v2/search', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        v2([
          {
            url: 'https://telekom.de/disney',
            title: 'Disney+ Telekom',
            description: 'inkl.',
            position: 1,
          },
          { url: 'https://o2.de/disney', title: 'Disney+ O2', description: 'Bundle', position: 2 },
        ]),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new FirecrawlSearchProvider('key');
    const results = await provider.search('Disney+ im Bundle', opts);

    expect(results).toEqual([
      { url: 'https://telekom.de/disney', title: 'Disney+ Telekom', snippet: 'inkl.', position: 1 },
      { url: 'https://o2.de/disney', title: 'Disney+ O2', snippet: 'Bundle', position: 2 },
    ]);
    const [calledUrl, init] = fetchMock.mock.calls[0]!;
    expect(String(calledUrl)).toContain('/v2/search');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ query: 'Disney+ im Bundle', limit: 10, location: 'de' });
    // results-only by default → no scrapeOptions sent.
    expect(body.scrapeOptions).toBeUndefined();
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer key' });
  });

  it('requests scrapeOptions and carries inline content when opts.scrape is set', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        v2([
          {
            url: 'https://telekom.de/disney',
            title: 'Disney+ Telekom',
            description: 'inkl.',
            position: 1,
            markdown: '# Disney+ bei Telekom\n6 Monate gratis',
            html: '<h1>Disney+</h1>',
            screenshot: 'https://cdn.firecrawl/shot.png',
          },
        ]),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new FirecrawlSearchProvider('key');
    const results = await provider.search('Disney+ im Bundle', { ...opts, scrape: true });

    expect(results[0]!.content).toEqual({
      text: '# Disney+ bei Telekom\n6 Monate gratis',
      html: '<h1>Disney+</h1>',
      screenshotRef: 'https://cdn.firecrawl/shot.png',
    });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.scrapeOptions).toMatchObject({ formats: ['markdown', 'html', 'screenshot'] });
  });

  it('omits content when scrape requested but the result did not scrape (no markdown)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(v2([{ url: 'https://e.de', title: 't', description: 'd' }]))),
    );
    const provider = new FirecrawlSearchProvider('key');
    const results = await provider.search('q', { ...opts, scrape: true });
    expect(results[0]!.content).toBeUndefined();
  });

  it('drops malformed entries and honours the limit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          v2([
            { title: 'no url' },
            ...Array.from({ length: 5 }, (_, i) => ({ url: `https://e${i}.de`, title: `t${i}` })),
          ]),
        ),
      ),
    );
    const provider = new FirecrawlSearchProvider('key');
    const results = await provider.search('q', { ...opts, limit: 3 });
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.url.startsWith('https://e'))).toBe(true);
  });

  it('returns [] for a missing data block', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ success: true })),
    );
    const provider = new FirecrawlSearchProvider('key');
    expect(await provider.search('q', opts)).toEqual([]);
  });

  it('returns [] for an empty data.web', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(v2([]))),
    );
    const provider = new FirecrawlSearchProvider('key');
    expect(await provider.search('q', opts)).toEqual([]);
  });

  it('throws SearchProviderError on a non-retryable HTTP status (no retry)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, false, 400));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new FirecrawlSearchProvider('key');
    await expect(provider.search('q', opts)).rejects.toBeInstanceOf(SearchProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 400 is not retried
  });

  it('retries a 503 then succeeds (transient server-error backoff)', async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      if (call === 1) return jsonResponse({}, false, 503);
      return jsonResponse(v2([{ url: 'https://ok.de', title: 't' }]));
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new FirecrawlSearchProvider('key');
    const results = await provider.search('q', { ...opts, timeoutMs: 5000 });
    expect(results).toEqual([{ url: 'https://ok.de', title: 't', snippet: '' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws SearchProviderError on an unparseable response shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ data: { web: 'nope' } })),
    );
    const provider = new FirecrawlSearchProvider('key');
    await expect(provider.search('q', opts)).rejects.toBeInstanceOf(SearchProviderError);
  });

  it('short-circuits an empty query without touching the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = new FirecrawlSearchProvider('key');
    expect(await provider.search('', opts)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

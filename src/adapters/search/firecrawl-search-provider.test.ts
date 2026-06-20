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
      const data = q.includes('Disney')
        ? sampleResults(5).map((r) => ({ url: r.url, title: r.title, description: r.snippet }))
        : [];
      return jsonResponse({ data });
    }),
  );
  return {
    provider: new FirecrawlSearchProvider('key'),
    richQuery: RICH,
    emptyQuery: EMPTY,
    seededCount: 5,
  };
});

describe('FirecrawlSearchProvider', () => {
  it('maps a well-formed response into SearchResult[]', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        success: true,
        data: [
          { url: 'https://telekom.de/disney', title: 'Disney+ Telekom', description: 'inkl.' },
          { url: 'https://o2.de/disney', title: 'Disney+ O2', description: 'Bundle' },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new FirecrawlSearchProvider('key');
    const results = await provider.search('Disney+ im Bundle', opts);

    expect(results).toEqual([
      { url: 'https://telekom.de/disney', title: 'Disney+ Telekom', snippet: 'inkl.' },
      { url: 'https://o2.de/disney', title: 'Disney+ O2', snippet: 'Bundle' },
    ]);
    const [calledUrl, init] = fetchMock.mock.calls[0]!;
    expect(String(calledUrl)).toContain('/v1/search');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ query: 'Disney+ im Bundle', limit: 10, country: 'de' });
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer key' });
  });

  it('drops malformed entries and honours the limit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          data: [
            { title: 'no url' },
            ...Array.from({ length: 5 }, (_, i) => ({ url: `https://e${i}.de`, title: `t${i}` })),
          ],
        }),
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
      return jsonResponse({ data: [{ url: 'https://ok.de', title: 't' }] });
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
      vi.fn(async () => jsonResponse({ data: 'nope' })),
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

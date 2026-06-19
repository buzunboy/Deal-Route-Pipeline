import { describe, it, expect, vi, afterEach } from 'vitest';
import { FirecrawlSearchProvider } from './firecrawl-search-provider.js';
import { SearchProviderError } from './search-provider-error.js';

const opts = { limit: 10, country: 'DE', timeoutMs: 2000 };

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
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

  it('throws SearchProviderError on a non-ok HTTP status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, false, 500)),
    );
    const provider = new FirecrawlSearchProvider('key');
    await expect(provider.search('q', opts)).rejects.toBeInstanceOf(SearchProviderError);
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

import { describe, it, expect, vi, afterEach } from 'vitest';
import { BraveSearchProvider } from './brave-search-provider.js';
import { SearchProviderError } from './search-provider-error.js';
import {
  searchProviderContract,
  sampleResults,
} from '../../../test/contracts/search-provider-contract.js';

const opts = { limit: 10, country: 'DE', timeoutMs: 2000 };

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// The real adapter must pass the SAME SearchProvider contract as the stub (LSP).
// We stub `fetch` to answer the contract's rich query with results and its empty
// query with none, keyed off the `q=` param so one provider serves both.
const RICH = 'Disney+ im Bundle';
const EMPTY = 'no such query';
searchProviderContract('BraveSearchProvider', () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const q = new URL(url).searchParams.get('q') ?? '';
      const results = q.includes('Disney')
        ? sampleResults(5).map((r) => ({ url: r.url, title: r.title, description: r.snippet }))
        : [];
      return jsonResponse({ web: { results } });
    }),
  );
  return {
    provider: new BraveSearchProvider('key'),
    richQuery: RICH,
    emptyQuery: EMPTY,
    seededCount: 5,
  };
});

describe('BraveSearchProvider', () => {
  it('maps a well-formed response into SearchResult[]', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        web: {
          results: [
            {
              url: 'https://telekom.de/disney',
              title: 'Disney+ bei Telekom',
              description: 'inkl.',
            },
            { url: 'https://o2.de/disney', title: 'Disney+ bei O2', description: 'Bundle' },
          ],
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new BraveSearchProvider('key');
    const results = await provider.search('Disney+ im Bundle', opts);

    expect(results).toEqual([
      { url: 'https://telekom.de/disney', title: 'Disney+ bei Telekom', snippet: 'inkl.' },
      { url: 'https://o2.de/disney', title: 'Disney+ bei O2', snippet: 'Bundle' },
    ]);
    // Sends the subscription token + the query/country/count params.
    const [calledUrl, init] = fetchMock.mock.calls[0]!;
    expect(String(calledUrl)).toContain('q=Disney');
    expect(String(calledUrl)).toContain('country=DE');
    expect((init as RequestInit).headers).toMatchObject({ 'X-Subscription-Token': 'key' });
  });

  it('drops malformed result entries (missing url) without failing the call', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          web: { results: [{ title: 'no url here' }, { url: 'https://good.de', title: 'ok' }] },
        }),
      ),
    );
    const provider = new BraveSearchProvider('key');
    const results = await provider.search('q', opts);
    expect(results).toEqual([{ url: 'https://good.de', title: 'ok', snippet: '' }]);
  });

  it('honours the limit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          web: {
            results: Array.from({ length: 10 }, (_, i) => ({
              url: `https://e${i}.de`,
              title: `t${i}`,
              description: `d${i}`,
            })),
          },
        }),
      ),
    );
    const provider = new BraveSearchProvider('key');
    const results = await provider.search('q', { ...opts, limit: 3 });
    expect(results).toHaveLength(3);
  });

  it('returns [] for a missing web block', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({})),
    );
    const provider = new BraveSearchProvider('key');
    expect(await provider.search('q', opts)).toEqual([]);
  });

  it('throws SearchProviderError on a non-retryable HTTP status (no retry)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, false, 400));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new BraveSearchProvider('key');
    await expect(provider.search('q', opts)).rejects.toBeInstanceOf(SearchProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 400 is not retried
  });

  it('retries a 429 then succeeds (rate-limit backoff)', async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      if (call === 1) return jsonResponse({}, false, 429);
      return jsonResponse({ web: { results: [{ url: 'https://ok.de', title: 't' }] } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new BraveSearchProvider('key');
    const results = await provider.search('q', { ...opts, timeoutMs: 5000 });
    expect(results).toEqual([{ url: 'https://ok.de', title: 't', snippet: '' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2); // retried once after the 429
  });

  it('throws SearchProviderError on an unparseable response shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ web: { results: 'not-an-array' } })),
    );
    const provider = new BraveSearchProvider('key');
    await expect(provider.search('q', opts)).rejects.toBeInstanceOf(SearchProviderError);
  });

  it('short-circuits an empty query without touching the network', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const provider = new BraveSearchProvider('key');
    expect(await provider.search('   ', opts)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

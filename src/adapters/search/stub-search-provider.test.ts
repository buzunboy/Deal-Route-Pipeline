import { describe, it, expect } from 'vitest';
import { StubSearchProvider } from './stub-search-provider.js';
import {
  searchProviderContract,
  sampleResults,
} from '../../../test/contracts/search-provider-contract.js';

const RICH = 'Disney+ im Bundle';
const EMPTY = 'no such query';

searchProviderContract('StubSearchProvider', () => ({
  provider: new StubSearchProvider({ [RICH]: sampleResults(5) }),
  richQuery: RICH,
  emptyQuery: EMPTY,
  seededCount: 5,
}));

describe('StubSearchProvider', () => {
  const opts = { limit: 10, country: 'DE', timeoutMs: 1000 };

  it('returns canned results for a known query', async () => {
    const provider = new StubSearchProvider({ [RICH]: sampleResults(3) });
    const results = await provider.search(RICH, opts);
    expect(results).toHaveLength(3);
    expect(results[0]!.url).toContain('example-0.de');
  });

  it('returns nothing for an unknown query (off-switch default)', async () => {
    const provider = new StubSearchProvider();
    expect(await provider.search('anything', opts)).toEqual([]);
  });

  it('clamps to the requested limit', async () => {
    const provider = new StubSearchProvider({ [RICH]: sampleResults(10) });
    const results = await provider.search(RICH, { ...opts, limit: 4 });
    expect(results).toHaveLength(4);
  });
});

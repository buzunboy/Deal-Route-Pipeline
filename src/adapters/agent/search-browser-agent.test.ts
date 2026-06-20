import { describe, it, expect } from 'vitest';
import { SearchBrowserAgent } from './search-browser-agent.js';
import { StubSearchProvider } from '../search/stub-search-provider.js';
import { ScriptedFetcher, FixedClock, FakeLogger } from '../../../test/fakes/fakes.js';
import { sampleResults } from '../../../test/contracts/search-provider-contract.js';
import { browserAgentContract } from '../../../test/contracts/browser-agent-contract.js';
import type { Clock, SearchResult } from '../../application/ports/index.js';

const QUERY = 'Disney+ im Bundle';

const OPTS = {
  resultsPerQuery: 10,
  country: 'DE',
  searchTimeoutMs: 5000,
  fetchTimeoutMs: 5000,
  userAgent: 'DealRouteBot/0.1',
  searchCostEur: 0.005,
};

/** A clock the test can advance, to exercise the time cap. */
class AdvanceableClock implements Clock {
  constructor(private ms = 0) {}
  advance(by: number): void {
    this.ms += by;
  }
  now(): Date {
    return new Date(this.ms);
  }
  nowIso(): string {
    return this.now().toISOString();
  }
}

function agentWith(
  results: SearchResult[],
  fetcher: ScriptedFetcher,
  clock: Clock = new FixedClock(),
) {
  const search = new StubSearchProvider({ [QUERY]: results });
  return new SearchBrowserAgent(search, fetcher, clock, new FakeLogger(), OPTS);
}

// Contract: substitutable behind the BrowserAgent port (same as NoopBrowserAgent).
browserAgentContract('SearchBrowserAgent', () => {
  const results = sampleResults(3);
  const pages = Object.fromEntries(
    results.map((r) => [r.url, { text: 'deal page text', html: '<html>deal</html>' }]),
  );
  return agentWith(results, new ScriptedFetcher(pages));
});

describe('SearchBrowserAgent', () => {
  const budget = { maxSteps: 10, maxSeconds: 300, maxCostEur: 1 };

  it('searches then fetches each result, returning page material + proposed domains', async () => {
    const results = [
      { url: 'https://telekom.de/disney', title: 't', snippet: 's' },
      { url: 'https://o2.de/disney', title: 't', snippet: 's' },
    ];
    const fetcher = new ScriptedFetcher({
      'https://telekom.de/disney': { text: 'Disney+ im MagentaTV', html: '<html>1</html>' },
      'https://o2.de/disney': { text: 'Disney+ bei O2', html: '<html>2</html>' },
    });
    const result = await agentWith(results, fetcher).run(QUERY, budget);

    expect(result.stepsUsed).toBe(2);
    expect(result.pages.map((p) => p.sourceUrl).sort()).toEqual([
      'https://o2.de/disney',
      'https://telekom.de/disney',
    ]);
    expect(result.pages[0]!.fetched.text).toContain('Disney+');
    // Each result domain proposed for human approval (never auto-crawled).
    expect(result.proposedSources.map((p) => p.url).sort()).toEqual([
      'https://o2.de/disney',
      'https://telekom.de/disney',
    ]);
    expect(result.stoppedReason).toBe('completed');
  });

  it('returns no pages for a query with no search results', async () => {
    const result = await agentWith([], new ScriptedFetcher({})).run('unknown', budget);
    expect(result.pages).toEqual([]);
    expect(result.proposedSources).toEqual([]);
    expect(result.stoppedReason).toBe('completed');
  });

  it('stops at the step cap without overshooting', async () => {
    const results = sampleResults(5);
    const fetcher = new ScriptedFetcher(
      Object.fromEntries(results.map((r) => [r.url, { text: 'x', html: '<html>x</html>' }])),
    );
    const result = await agentWith(results, fetcher).run(QUERY, { ...budget, maxSteps: 2 });
    expect(result.stepsUsed).toBe(2);
    expect(result.pages).toHaveLength(2);
    expect(result.stoppedReason).toBe('step_cap');
    expect(fetcher.fetched).toHaveLength(2); // never fetched the 3rd
  });

  it('stops at the time cap', async () => {
    const results = sampleResults(5);
    const clock = new AdvanceableClock();
    // Each fetch advances the clock; with a 1s deadline the run stops mid-loop.
    const advancing = new ScriptedFetcher(
      Object.fromEntries(results.map((r) => [r.url, { text: 'x', html: '<html>x</html>' }])),
    );
    const origFetch = advancing.fetch.bind(advancing);
    advancing.fetch = async (url: string) => {
      clock.advance(800);
      return origFetch(url);
    };
    const result = await agentWith(results, advancing, clock).run(QUERY, {
      ...budget,
      maxSeconds: 1,
    });
    expect(result.stoppedReason).toBe('time_cap');
    expect(result.stepsUsed).toBeLessThan(5);
  });

  it('surfaces a blocked page (does not drop it) for the use-case to route', async () => {
    const results = [{ url: 'https://wall.de/login', title: 't', snippet: 's' }];
    const fetcher = new ScriptedFetcher({
      'https://wall.de/login': { outcome: 'login_required' },
    });
    const result = await agentWith(results, fetcher).run(QUERY, budget);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]!.fetched.outcome).toBe('login_required');
  });

  it('drops a robots_disallowed page (no content to act on)', async () => {
    const results = [{ url: 'https://no.de/x', title: 't', snippet: 's' }];
    const fetcher = new ScriptedFetcher({ 'https://no.de/x': { outcome: 'robots_disallowed' } });
    const result = await agentWith(results, fetcher).run(QUERY, budget);
    expect(result.pages).toEqual([]);
    expect(result.stepsUsed).toBe(1); // it counted as a step (we did attempt it)
  });

  it('honours resultsPerQuery as an upper bound on fetches', async () => {
    const results = sampleResults(10);
    const fetcher = new ScriptedFetcher(
      Object.fromEntries(results.map((r) => [r.url, { text: 'x', html: '<html>x</html>' }])),
    );
    const search = new StubSearchProvider({ [QUERY]: results });
    const agent = new SearchBrowserAgent(search, fetcher, new FixedClock(), new FakeLogger(), {
      ...OPTS,
      resultsPerQuery: 3,
    });
    const result = await agent.run(QUERY, budget);
    expect(result.stepsUsed).toBe(3);
  });

  it('returns a clean error result if the search provider throws', async () => {
    const throwing = {
      async search(): Promise<SearchResult[]> {
        throw new Error('search down');
      },
    };
    const agent = new SearchBrowserAgent(
      throwing,
      new ScriptedFetcher({}),
      new FixedClock(),
      new FakeLogger(),
      OPTS,
    );
    const result = await agent.run(QUERY, budget);
    expect(result.stoppedReason).toBe('error');
    expect(result.pages).toEqual([]);
  });
});

// A tiny valid PNG as a data: URI — resolveScreenshotBytes decodes it offline (no network).
const PNG_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

/**
 * A Fetcher that supports the access gate (checkAccess) and records whether the
 * full fetch() was called — to prove the inline path skips it. Robots verdict is
 * scriptable per URL so we can test the robots-disallowed inline case.
 */
class InlineAwareFetcher {
  fetchedUrls: string[] = [];
  constructor(private readonly robotsBlock: Set<string> = new Set()) {}
  async checkAccess(url: string): Promise<'ok' | 'robots_disallowed'> {
    return this.robotsBlock.has(url) ? 'robots_disallowed' : 'ok';
  }
  async fetch(url: string): Promise<import('../../application/ports/index.js').FetchResult> {
    this.fetchedUrls.push(url);
    return {
      outcome: 'ok',
      url,
      finalUrl: url,
      text: 'FELL BACK TO FETCH',
      html: '<html>fetch</html>',
      screenshot: new Uint8Array([1, 2, 3]),
    };
  }
}

describe('SearchBrowserAgent — inline scrape (Tier-4 v2 search-scrape)', () => {
  const budget = { maxSteps: 10, maxSeconds: 300, maxCostEur: 1 };
  const INLINE_OPTS = { ...OPTS, inlineScrape: true };

  function inlineResult(url: string): SearchResult {
    return {
      url,
      title: 't',
      snippet: 's',
      content: {
        text: 'INLINE deal text',
        html: '<html>inline</html>',
        screenshotRef: PNG_DATA_URI,
      },
    };
  }

  it('uses inline content WITHOUT a second fetch when robots allows + screenshot resolves', async () => {
    const url = 'https://telekom.de/inline';
    const fetcher = new InlineAwareFetcher();
    const search = new StubSearchProvider({ [QUERY]: [inlineResult(url)] });
    const agent = new SearchBrowserAgent(
      search,
      fetcher,
      new FixedClock(),
      new FakeLogger(),
      INLINE_OPTS,
    );

    const result = await agent.run(QUERY, budget);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]!.fetched.text).toBe('INLINE deal text'); // inline content used
    expect(result.pages[0]!.fetched.screenshot.byteLength).toBeGreaterThan(0); // evidence present
    expect(fetcher.fetchedUrls).toEqual([]); // the full fetch was skipped
  });

  it('TRUST: a robots-disallowed URL discards the inline content (our gate is authoritative)', async () => {
    const url = 'https://blocked.de/inline';
    const fetcher = new InlineAwareFetcher(new Set([url]));
    const search = new StubSearchProvider({ [QUERY]: [inlineResult(url)] });
    const agent = new SearchBrowserAgent(
      search,
      fetcher,
      new FixedClock(),
      new FakeLogger(),
      INLINE_OPTS,
    );

    const result = await agent.run(QUERY, budget);
    expect(result.pages).toEqual([]); // robots_disallowed → dropped, inline content NOT used
    expect(fetcher.fetchedUrls).toEqual([]); // and we did not fetch it either
  });

  it('falls back to a real fetch when the inline screenshot cannot be resolved (evidence required)', async () => {
    const url = 'https://telekom.de/noshot';
    const fetcher = new InlineAwareFetcher();
    const search = new StubSearchProvider({
      [QUERY]: [
        {
          url,
          title: 't',
          snippet: 's',
          content: { text: 'INLINE', html: '<i>', screenshotRef: undefined },
        },
      ],
    });
    const agent = new SearchBrowserAgent(
      search,
      fetcher,
      new FixedClock(),
      new FakeLogger(),
      INLINE_OPTS,
    );

    const result = await agent.run(QUERY, budget);
    expect(fetcher.fetchedUrls).toEqual([url]); // fell back to fetch (which captures a screenshot)
    expect(result.pages[0]!.fetched.text).toBe('FELL BACK TO FETCH');
  });

  it('ignores inline content entirely when inlineScrape is OFF (default)', async () => {
    const url = 'https://telekom.de/inline';
    const fetcher = new InlineAwareFetcher();
    const search = new StubSearchProvider({ [QUERY]: [inlineResult(url)] });
    // OPTS has no inlineScrape → off.
    const agent = new SearchBrowserAgent(search, fetcher, new FixedClock(), new FakeLogger(), OPTS);

    const result = await agent.run(QUERY, budget);
    expect(fetcher.fetchedUrls).toEqual([url]); // always the polite fetch
    expect(result.pages[0]!.fetched.text).toBe('FELL BACK TO FETCH');
  });
});

import { describe, it, expect } from 'vitest';
import { parseRobots, PoliteFetcher } from './polite-fetcher.js';
import type { RobotsClient, RobotsResponse } from './polite-fetcher.js';
import type { Fetcher, FetchResult } from '../../application/ports/index.js';
import { FakeLogger } from '../../../test/fakes/fakes.js';

const UA = 'DealRouteBot/0.1';

/** Inner fetcher that records every URL it is asked to fetch. */
function countingInner(result: Partial<FetchResult> = {}): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async fetch(url: string): Promise<FetchResult> {
      calls.push(url);
      return {
        outcome: 'ok',
        url,
        finalUrl: url,
        text: 'ok',
        html: '<html></html>',
        screenshot: new Uint8Array([1]),
        ...result,
      };
    },
  };
}

/**
 * Scripted RobotsClient: map of `${origin}/robots.txt` → a body string (200), or a
 * richer entry: `{notFound}` (404), `{status}` (e.g. 503), `{body, finalUrl}` (a
 * redirect's final URL). Records the URLs fetched.
 */
type RobotsEntry =
  | string
  | { notFound: true }
  | { status: number }
  | { body: string; finalUrl: string };

function scriptedRobots(byUrl: Record<string, RobotsEntry>): RobotsClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async fetch(url: string): Promise<RobotsResponse> {
      calls.push(url);
      const entry = byUrl[url];
      if (entry === undefined || (typeof entry === 'object' && 'notFound' in entry)) {
        return { ok: false, status: 404, url, text: async () => '' };
      }
      if (typeof entry === 'object' && 'status' in entry) {
        return { ok: entry.status < 400, status: entry.status, url, text: async () => '' };
      }
      if (typeof entry === 'object' && 'finalUrl' in entry) {
        return { ok: true, status: 200, url: entry.finalUrl, text: async () => entry.body };
      }
      return { ok: true, status: 200, url, text: async () => entry };
    },
  };
}

describe('parseRobots', () => {
  it('applies wildcard Disallow rules to our agent', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /private\nDisallow: /admin', UA);
    expect(rules.isAllowed('/public/page')).toBe(true);
    expect(rules.isAllowed('/private/x')).toBe(false);
    expect(rules.isAllowed('/admin')).toBe(false);
  });

  it('prefers a group that names our agent over the wildcard', () => {
    const txt = [
      'User-agent: *',
      'Disallow: /',
      '',
      'User-agent: DealRouteBot',
      'Disallow: /secret',
    ].join('\n');
    const rules = parseRobots(txt, UA);
    expect(rules.isAllowed('/anything')).toBe(true);
    expect(rules.isAllowed('/secret/x')).toBe(false);
  });

  it('treats an empty Disallow as allow-all', () => {
    const rules = parseRobots('User-agent: *\nDisallow:', UA);
    expect(rules.isAllowed('/anything')).toBe(true);
  });

  it('ignores comments and blank lines', () => {
    const rules = parseRobots('# comment\nUser-agent: *\n\nDisallow: /x # inline', UA);
    expect(rules.isAllowed('/x/y')).toBe(false);
    expect(rules.isAllowed('/y')).toBe(true);
  });

  it('honours Allow with longest-match precedence over a broad Disallow', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /\nAllow: /angebote', UA);
    expect(rules.isAllowed('/angebote/disney')).toBe(true); // Allow is more specific
    expect(rules.isAllowed('/konto')).toBe(false); // only the Disallow:/ matches
  });

  it('does not match a robots group whose token is merely a substring of our UA', () => {
    // A `User-agent: bot` group must NOT capture `dealroutebot`.
    const rules = parseRobots('User-agent: bot\nDisallow: /\n', UA);
    expect(rules.isAllowed('/anything')).toBe(true);
  });
});

/** Inner fetcher returning a scripted result (with a redirect finalUrl). */
function innerWith(result: Partial<FetchResult>): Fetcher {
  return {
    async fetch(url: string): Promise<FetchResult> {
      return {
        outcome: 'ok',
        url,
        finalUrl: url,
        text: 'ok',
        html: '<html></html>',
        screenshot: new Uint8Array(),
        ...result,
      };
    },
  };
}

describe('PoliteFetcher redirect handling', () => {
  const opts = (respect: boolean) => ({
    respectRobotsTxt: respect,
    minIntervalMs: 0,
    userAgent: UA,
    logger: new FakeLogger(),
  });

  it('passes a redirect through unchanged when robots is disabled', async () => {
    const inner = innerWith({ finalUrl: 'https://host.de/elsewhere' });
    const pf = new PoliteFetcher(inner, opts(false));
    const res = await pf.fetch('https://host.de/start');
    expect(res.outcome).toBe('ok');
    expect(res.finalUrl).toBe('https://host.de/elsewhere');
  });

  it('does not re-check robots when finalUrl equals the requested url', async () => {
    // No redirect → inner result returned verbatim (no second robots fetch path).
    const inner = innerWith({});
    const pf = new PoliteFetcher(inner, opts(false));
    const res = await pf.fetch('https://host.de/start');
    expect(res.outcome).toBe('ok');
    expect(res.finalUrl).toBe('https://host.de/start');
  });
});

describe('PoliteFetcher robots.txt runtime (injected RobotsClient)', () => {
  const base = (robots: RobotsClient) => ({
    respectRobotsTxt: true,
    minIntervalMs: 0,
    userAgent: UA,
    logger: new FakeLogger(),
    robotsClient: robots,
  });

  it('a Disallow short-circuits without ever calling inner.fetch', async () => {
    const robots = scriptedRobots({ 'https://host.de/robots.txt': 'User-agent: *\nDisallow: /' });
    const inner = countingInner();
    const pf = new PoliteFetcher(inner, base(robots));
    const res = await pf.fetch('https://host.de/secret');
    expect(res.outcome).toBe('robots_disallowed');
    expect(inner.calls).toEqual([]); // never fetched the disallowed page
  });

  it('an Allow lets the request through to inner.fetch', async () => {
    const robots = scriptedRobots({
      'https://host.de/robots.txt': 'User-agent: *\nDisallow: /admin',
    });
    const inner = countingInner();
    const pf = new PoliteFetcher(inner, base(robots));
    const res = await pf.fetch('https://host.de/angebote');
    expect(res.outcome).toBe('ok');
    expect(inner.calls).toEqual(['https://host.de/angebote']);
  });

  // checkAccess() is the body-less gate used by the Tier-4 inline-scrape path:
  // it applies OUR access policy (rate-limit always + robots when enabled) without
  // fetching the page, so a caller holding page content from elsewhere is gated the
  // same way a real fetch would be. (Constructed here with respectRobotsTxt: true.)
  it('checkAccess returns robots_disallowed for a forbidden path, never calling inner.fetch', async () => {
    const robots = scriptedRobots({ 'https://host.de/robots.txt': 'User-agent: *\nDisallow: /' });
    const inner = countingInner();
    const pf = new PoliteFetcher(inner, base(robots));
    expect(await pf.checkAccess('https://host.de/secret')).toBe('robots_disallowed');
    expect(inner.calls).toEqual([]); // never fetched the page body
  });

  it('checkAccess returns ok for an allowed path (still no body fetch)', async () => {
    const robots = scriptedRobots({
      'https://host.de/robots.txt': 'User-agent: *\nDisallow: /admin',
    });
    const inner = countingInner();
    const pf = new PoliteFetcher(inner, base(robots));
    expect(await pf.checkAccess('https://host.de/angebote')).toBe('ok');
    expect(inner.calls).toEqual([]);
  });

  it('missing robots.txt fails open (allowed) and still hits inner.fetch', async () => {
    const robots = scriptedRobots({ 'https://host.de/robots.txt': { notFound: true } });
    const inner = countingInner();
    const pf = new PoliteFetcher(inner, base(robots));
    const res = await pf.fetch('https://host.de/anything');
    expect(res.outcome).toBe('ok');
    expect(inner.calls).toEqual(['https://host.de/anything']);
  });

  it('caches robots.txt per origin (one fetch for repeated hits to the same host)', async () => {
    const robots = scriptedRobots({
      'https://host.de/robots.txt': 'User-agent: *\nDisallow: /admin',
    });
    const inner = countingInner();
    const pf = new PoliteFetcher(inner, base(robots));
    await pf.fetch('https://host.de/a');
    await pf.fetch('https://host.de/b');
    expect(robots.calls).toEqual(['https://host.de/robots.txt']); // fetched once, cached
  });

  it('a redirect to a disallowed final URL discards the fetched content', async () => {
    const robots = scriptedRobots({
      // The requested origin allows everything…
      'https://good.de/robots.txt': 'User-agent: *\nDisallow:',
      // …but the redirect destination disallows the landing path.
      'https://tracker.de/robots.txt': 'User-agent: *\nDisallow: /landing',
    });
    const inner = countingInner({ finalUrl: 'https://tracker.de/landing' });
    const pf = new PoliteFetcher(inner, base(robots));
    const res = await pf.fetch('https://good.de/start');
    // We did fetch (the redirect was only known after), but robots forbids the
    // destination, so the content is discarded and reported as disallowed.
    expect(inner.calls).toEqual(['https://good.de/start']);
    expect(res.outcome).toBe('robots_disallowed');
    expect(res.finalUrl).toBe('https://tracker.de/landing');
    expect(res.html).toBe('');
  });

  it('fails CLOSED on a 5xx robots.txt (does not grant crawl-all)', async () => {
    const robots = scriptedRobots({ 'https://host.de/robots.txt': { status: 503 } });
    const inner = countingInner();
    const pf = new PoliteFetcher(inner, base(robots));
    const res = await pf.fetch('https://host.de/anything');
    expect(res.outcome).toBe('robots_disallowed'); // disallow-all while the server errors
    expect(inner.calls).toEqual([]); // never fetched the page
  });

  it('still allows on a 404 robots.txt (no rules = crawl freely)', async () => {
    const robots = scriptedRobots({ 'https://host.de/robots.txt': { notFound: true } });
    const inner = countingInner();
    const pf = new PoliteFetcher(inner, base(robots));
    const res = await pf.fetch('https://host.de/anything');
    expect(res.outcome).toBe('ok');
    expect(inner.calls).toEqual(['https://host.de/anything']);
  });

  it('ignores a robots.txt that redirects cross-origin (not authoritative → allowed)', async () => {
    const robots = scriptedRobots({
      // host.de's robots.txt redirects to a DIFFERENT origin that disallows all.
      'https://host.de/robots.txt': {
        body: 'User-agent: *\nDisallow: /',
        finalUrl: 'https://cdn-other.de/robots.txt',
      },
    });
    const inner = countingInner();
    const pf = new PoliteFetcher(inner, base(robots));
    const res = await pf.fetch('https://host.de/anything');
    // The foreign Disallow:/ is ignored; host.de is treated as no-robots = allowed.
    expect(res.outcome).toBe('ok');
    expect(inner.calls).toEqual(['https://host.de/anything']);
  });

  it('ignores an oversized robots.txt rather than parsing it', async () => {
    const huge = 'User-agent: *\nDisallow: /\n' + '#'.repeat(600 * 1024); // > 512 KB cap
    const robots = scriptedRobots({ 'https://host.de/robots.txt': huge });
    const inner = countingInner();
    const pf = new PoliteFetcher(inner, base(robots));
    const res = await pf.fetch('https://host.de/anything');
    // Over the cap → treated as no-robots = allowed (not parsed as Disallow:/).
    expect(res.outcome).toBe('ok');
    expect(inner.calls).toEqual(['https://host.de/anything']);
  });
});

describe('PoliteFetcher per-host throttle', () => {
  const base = () => ({
    respectRobotsTxt: false,
    minIntervalMs: 50,
    userAgent: UA,
    logger: new FakeLogger(),
  });

  it('throttles a second hit to the SAME host but not a different host', async () => {
    const inner = countingInner();
    const pf = new PoliteFetcher(inner, base());

    const t0 = Date.now();
    await pf.fetch('https://host-a.de/1'); // first hit, no wait
    await pf.fetch('https://host-b.de/1'); // different host, no wait
    const afterCrossHost = Date.now() - t0;
    expect(afterCrossHost).toBeLessThan(50); // cross-host pair did not throttle

    const t1 = Date.now();
    await pf.fetch('https://host-a.de/2'); // same host as the first → must wait
    const sameHostWait = Date.now() - t1;
    expect(sameHostWait).toBeGreaterThanOrEqual(40); // ~minIntervalMs (allow scheduler slack)
  });
});

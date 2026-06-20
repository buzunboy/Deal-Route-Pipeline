import { describe, it, expect } from 'vitest';
import { extractLinks, scoreCandidateUrl } from './links.js';

const BASE = 'https://www.mydealz.de/gruppe/spotify';

describe('extractLinks', () => {
  it('resolves relative + absolute hrefs to absolute http(s) URLs, deduped', () => {
    const html = `
      <a href="/deals/abc-123">deal</a>
      <a href="/deals/abc-123">dup</a>
      <a href="https://www.spotify.com/de/premium/">spotify</a>
      <a href="https://www.mydealz.de/deals/xyz">other</a>`;
    const links = extractLinks(html, BASE).sort();
    expect(links).toEqual(
      [
        'https://www.mydealz.de/deals/abc-123',
        'https://www.mydealz.de/deals/xyz',
        'https://www.spotify.com/de/premium/',
      ].sort(),
    );
  });

  it('drops fragments, mailto/tel/javascript, and strips #hash', () => {
    const html = `
      <a href="#top">anchor</a>
      <a href="mailto:x@y.de">mail</a>
      <a href="tel:+49">call</a>
      <a href="javascript:void(0)">js</a>
      <a href="/deals/keep#section">keep</a>`;
    expect(extractLinks(html, BASE)).toEqual(['https://www.mydealz.de/deals/keep']);
  });

  it('only follows <a> links, not <link>/asset hrefs', () => {
    const html = `
      <link rel="stylesheet" href="/assets/base.css">
      <link rel="icon" href="/favicon.svg">
      <a href="/deals/real">real page</a>
      <a href="/assets/app.js">js disguised as a link</a>
      <a href="/img/banner.png">image</a>`;
    // <link> hrefs ignored; <a> links to .js/.png skipped as assets.
    expect(extractLinks(html, BASE)).toEqual(['https://www.mydealz.de/deals/real']);
  });

  it('returns nothing for an unparseable base', () => {
    expect(extractLinks('<a href="/x">y</a>', 'not a url')).toEqual([]);
  });
});

// NB: registrable-domain resolution moved to the real PSL behind `SuffixOracle`
// (Step 6); its DE-equivalence + multi-label correctness is covered by
// test/golden/suffix-equivalence.golden.test.ts. The old last-two-labels helpers
// were removed from links.ts, so their tests live there now, not here.

describe('scoreCandidateUrl (frontier prioritisation)', () => {
  const deal =
    'https://www.mydealz.de/deals/jugend-bahncard-25-ab-juni-gratis-fur-alle-unter-18-2787651';

  it('ranks an offer page above navigation chrome and the root', () => {
    expect(scoreCandidateUrl(deal)).toBeGreaterThan(
      scoreCandidateUrl('https://www.mydealz.de/gutscheine'),
    );
    expect(scoreCandidateUrl(deal)).toBeGreaterThan(scoreCandidateUrl('https://www.mydealz.de/'));
  });

  it('penalises known nav/utility sections', () => {
    expect(scoreCandidateUrl('https://www.mydealz.de/login')).toBeLessThan(0);
    expect(scoreCandidateUrl('https://www.mydealz.de/gruppe/freebies')).toBeLessThan(
      scoreCandidateUrl(deal),
    );
  });
});

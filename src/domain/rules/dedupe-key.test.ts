import { describe, it, expect } from 'vitest';
import { dedupeKey, normalizeName } from './dedupe-key.js';

describe('normalizeName', () => {
  const cases: [string, string][] = [
    ['Disney+', 'disney plus'],
    ['disney +', 'disney plus'],
    ['Disney Plus', 'disney plus'],
    ['  Telekom   MagentaTV  ', 'telekom magentatv'],
    ['AT&T', 'at and t'],
    ['Spotify Premium', 'spotify premium'],
  ];
  for (const [input, expected] of cases) {
    it(`normalizes "${input}"`, () => {
      expect(normalizeName(input)).toBe(expected);
    });
  }
});

describe('dedupeKey', () => {
  const base = {
    service: 'Disney+',
    provider: 'Telekom MagentaTV',
    route_type: 'bundle' as const,
    country: 'DE' as const,
  };
  const SOURCE = 'https://www.telekom.de/magenta-tv';

  it('is stable for the same logical route + same source', () => {
    const a = dedupeKey(base, SOURCE);
    const b = dedupeKey({ ...base, service: 'disney +', provider: 'Telekom  MagentaTV' }, SOURCE);
    expect(a).toBe(b);
  });

  it('differs when route_type differs', () => {
    expect(dedupeKey(base, SOURCE)).not.toBe(
      dedupeKey({ ...base, route_type: 'standalone' }, SOURCE),
    );
  });

  it('differs when provider differs', () => {
    expect(dedupeKey(base, SOURCE)).not.toBe(dedupeKey({ ...base, provider: 'Vodafone' }, SOURCE));
  });

  it('folds the source origin in after country (5 segments)', () => {
    expect(dedupeKey(base, SOURCE).split('|')).toEqual([
      'disney plus',
      'telekom magentatv',
      'bundle',
      'DE',
      'telekom.de',
    ]);
  });

  // The core new behaviour: split-by-source. Identical route fields, DIFFERENT
  // source domains → DIFFERENT keys, so each source's report is its own record.
  it('produces DIFFERENT keys for the same route from DIFFERENT source domains', () => {
    const fromTelekom = dedupeKey(base, 'https://www.telekom.de/magenta-tv');
    const fromMydealz = dedupeKey(base, 'https://www.mydealz.de/deals/disney-magentatv-123');
    expect(fromTelekom).not.toBe(fromMydealz);
  });

  // Same registrable domain must collapse: www-vs-bare host, trailing slash, and a
  // different path on the same site are the SAME source (idempotency on re-crawl).
  it('produces the SAME key for the same route + same source domain (host/path/slash variants)', () => {
    const canonical = dedupeKey(base, 'https://www.telekom.de/magenta-tv');
    const variants = [
      'https://telekom.de/magenta-tv', // bare host
      'https://www.telekom.de/magenta-tv/', // trailing slash
      'https://www.telekom.de/angebote/disney-plus?ref=banner', // different path + query
      'http://shop.telekom.de/magenta-tv', // subdomain + scheme
    ];
    for (const url of variants) {
      expect(dedupeKey(base, url)).toBe(canonical);
    }
  });

  it('uses a stable sentinel for an unparseable source URL (no throw, well-formed key)', () => {
    expect(() => dedupeKey(base, 'not a url')).not.toThrow();
    const key = dedupeKey(base, 'not a url');
    expect(key.endsWith('|unknown-source')).toBe(true);
    // Two unparseable URLs for the same route collapse to one key (stable sentinel).
    expect(dedupeKey(base, 'not a url')).toBe(dedupeKey(base, '::::garbage::::'));
  });
});

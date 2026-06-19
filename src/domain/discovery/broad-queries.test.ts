import { describe, it, expect } from 'vitest';
import {
  buildBroadQueries,
  providerTokenFromUrl,
  SERVICE_QUERY_TEMPLATES,
  PROVIDER_QUERY_TEMPLATES,
} from './broad-queries.js';

const PER_SERVICE = SERVICE_QUERY_TEMPLATES.length;
const PER_PROVIDER = PROVIDER_QUERY_TEMPLATES.length;

describe('buildBroadQueries', () => {
  it('builds service × template queries for each catalog service', () => {
    const qs = buildBroadQueries({ services: ['Disney+'], providerTokens: [], maxQueries: 100 });
    expect(qs).toEqual(['Disney+ im Bundle', 'Disney+ inklusive', 'Disney+ gratis Aktion']);
  });

  it('appends provider queries after service queries', () => {
    const qs = buildBroadQueries({
      services: ['Spotify'],
      providerTokens: ['telekom'],
      maxQueries: 100,
    });
    expect(qs).toHaveLength(PER_SERVICE + PER_PROVIDER);
    expect(qs.slice(0, PER_SERVICE).every((q) => q.startsWith('Spotify'))).toBe(true);
    expect(qs.slice(PER_SERVICE).every((q) => q.startsWith('telekom'))).toBe(true);
  });

  it('returns nothing for an empty catalog and no providers', () => {
    expect(buildBroadQueries({ services: [], providerTokens: [], maxQueries: 100 })).toEqual([]);
  });

  it('caps the set at maxQueries (a big catalog cannot explode the batch)', () => {
    const services = Array.from({ length: 50 }, (_, i) => `svc${i}`);
    const qs = buildBroadQueries({ services, providerTokens: ['p1', 'p2'], maxQueries: 10 });
    expect(qs).toHaveLength(10);
  });

  it('clamps mid-service without emitting a partial then overflow', () => {
    // maxQueries=4 with 3 templates/service → service A (3) + first of service B (1).
    const qs = buildBroadQueries({ services: ['A', 'B'], providerTokens: [], maxQueries: 4 });
    expect(qs).toHaveLength(4);
    expect(qs[3]).toBe('B im Bundle');
  });

  it('returns [] when maxQueries is 0 or negative', () => {
    expect(buildBroadQueries({ services: ['X'], providerTokens: [], maxQueries: 0 })).toEqual([]);
    expect(buildBroadQueries({ services: ['X'], providerTokens: [], maxQueries: -3 })).toEqual([]);
  });

  it('skips blank service/provider entries (no bare-template queries)', () => {
    const qs = buildBroadQueries({
      services: ['', '   '],
      providerTokens: ['', ' '],
      maxQueries: 100,
    });
    expect(qs).toEqual([]);
  });

  it('deduplicates case-insensitively', () => {
    const qs = buildBroadQueries({
      services: ['Disney+', 'disney+'],
      providerTokens: [],
      maxQueries: 100,
    });
    // Both services produce the same lowercased queries → only one set kept.
    expect(qs).toHaveLength(PER_SERVICE);
  });
});

describe('providerTokenFromUrl', () => {
  it.each([
    ['https://www.telekom.de/magenta-tv', 'telekom'],
    ['https://o2online.de/angebote', 'o2online'],
    ['http://vodafone.de', 'vodafone'],
    ['https://shop.sub.example.de/x', 'example'], // registrable domain = example.de
  ])('%s → %s', (url, expected) => {
    expect(providerTokenFromUrl(url)).toBe(expected);
  });

  it('returns null for an unparseable url', () => {
    expect(providerTokenFromUrl('not a url')).toBeNull();
  });
});

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

  it('is stable for the same logical route', () => {
    const a = dedupeKey(base);
    const b = dedupeKey({ ...base, service: 'disney +', provider: 'Telekom  MagentaTV' });
    expect(a).toBe(b);
  });

  it('differs when route_type differs', () => {
    expect(dedupeKey(base)).not.toBe(dedupeKey({ ...base, route_type: 'standalone' }));
  });

  it('differs when provider differs', () => {
    expect(dedupeKey(base)).not.toBe(dedupeKey({ ...base, provider: 'Vodafone' }));
  });
});

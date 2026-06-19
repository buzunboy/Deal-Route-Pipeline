import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseSeeds } from './seed-parser.js';

const here = dirname(fileURLToPath(import.meta.url));
const SEED_DOC = join(here, '../../../docs/DealRoute_Seed_List_DE.md');

describe('parseSeeds against the real seed doc', () => {
  const markdown = readFileSync(SEED_DOC, 'utf8');
  const { catalog, sources } = parseSeeds(markdown, 3);

  it('parses the 25 catalog services', () => {
    expect(catalog.length).toBe(25);
    expect(catalog.map((c) => c.service)).toContain('Netflix');
    expect(catalog.map((c) => c.service)).toContain('PlayStation Plus');
  });

  it('creates Tier-1 provider sources for catalog entries', () => {
    const providers = sources.filter((s) => s.tier === 1 && s.type === 'provider');
    expect(providers.length).toBeGreaterThanOrEqual(25);
    expect(providers.every((s) => s.url.startsWith('https://'))).toBe(true);
    expect(providers.every((s) => s.country === 'DE')).toBe(true);
  });

  it('creates Tier-2 bundler/aggregator sources', () => {
    const bundlers = sources.filter((s) => s.tier === 2);
    expect(bundlers.some((s) => s.url.includes('telekom.de'))).toBe(true);
    expect(bundlers.some((s) => s.url.includes('check24.de'))).toBe(true);
  });

  it('creates Tier-3 community sources with a shorter cadence', () => {
    const community = sources.filter((s) => s.tier === 3);
    expect(community.some((s) => s.url.includes('mydealz.de'))).toBe(true);
    expect(community.every((s) => s.cadence_days <= 1)).toBe(true);
  });

  it('produces valid, deduplicated URLs only', () => {
    const urls = sources.map((s) => s.url);
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls.every((u) => /^https:\/\/.+\.[a-z]{2,}/i.test(u))).toBe(true);
  });
});

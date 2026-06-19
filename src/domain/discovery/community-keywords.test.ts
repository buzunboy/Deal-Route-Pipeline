import { describe, it, expect } from 'vitest';
import { looksRelevant } from './community-keywords.js';

const CATALOG = ['Spotify', 'Disney+', 'Netflix', 'DAZN'];

describe('looksRelevant (cheap pre-filter)', () => {
  it('keeps text that mentions a catalog service AND a deal-intent term', () => {
    expect(looksRelevant('Disney+ 3 Monate gratis bei Telekom', CATALOG)).toBe(true);
    expect(looksRelevant('Spotify Premium inklusive im Tarif', CATALOG)).toBe(true);
  });

  it('drops a service mention with no deal-intent term', () => {
    expect(looksRelevant('Disney+ launches a new show today', CATALOG)).toBe(false);
  });

  it('drops a deal-intent term with no catalog service', () => {
    expect(looksRelevant('Großer Rabatt auf Fernseher — 50% Aktion', CATALOG)).toBe(false);
  });

  it('is case-insensitive on both service and intent', () => {
    expect(looksRelevant('NETFLIX GRATIS testen', CATALOG)).toBe(true);
  });

  it('returns false when the catalog is empty (no services to match)', () => {
    expect(looksRelevant('Spotify gratis', [])).toBe(false);
  });

  it('ignores blank service names in the catalog', () => {
    expect(looksRelevant('anything gratis', ['', '   '])).toBe(false);
  });
});

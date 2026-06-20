import { describe, it, expect } from 'vitest';
import {
  MARKETS,
  MARKET_COUNTRIES,
  MARKET_CURRENCIES,
  isCurrencyAllowedForCountry,
} from './markets.js';
import { Country, Currency } from '../deal-record/enums.js';

describe('market registry (Step 6)', () => {
  it('ships DE-only in v1 (EUR)', () => {
    expect(MARKET_COUNTRIES).toEqual(['DE']);
    expect(MARKET_CURRENCIES).toEqual(['EUR']);
    expect(MARKETS.DE.currencies).toEqual(['EUR']);
  });

  it('the Country/Currency schema enums are DERIVED from the registry (still closed)', () => {
    // In-scope values parse…
    expect(Country.parse('DE')).toBe('DE');
    expect(Currency.parse('EUR')).toBe('EUR');
    // …and an OUT-OF-SCOPE country/currency is REJECTED at the boundary (the enum is
    // a closed allow-list, not an open shape check — a typo'd or pre-launch country
    // can't persist).
    expect(() => Country.parse('FR')).toThrow();
    expect(() => Country.parse('de')).toThrow(); // case-sensitive
    expect(() => Currency.parse('GBP')).toThrow();
  });
});

describe('isCurrencyAllowedForCountry — the currency-sanity trust input', () => {
  it('allows a market’s declared currency', () => {
    expect(isCurrencyAllowedForCountry('DE', 'EUR')).toBe(true);
  });

  it('rejects a currency not declared for the country (→ must-review downstream)', () => {
    expect(isCurrencyAllowedForCountry('DE', 'USD')).toBe(false);
    expect(isCurrencyAllowedForCountry('DE', 'GBP')).toBe(false);
  });

  it('rejects an out-of-scope country (belt-and-suspenders; schema also gates it)', () => {
    expect(isCurrencyAllowedForCountry('FR', 'EUR')).toBe(false);
  });
});

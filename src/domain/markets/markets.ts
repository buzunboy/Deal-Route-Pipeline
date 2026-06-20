/**
 * The market registry (Step 6 — multi-country). A "market" is a country in scope
 * plus the currency(ies) a deal there may legitimately be priced in. This is the
 * ONE place the in-scope countries + their currencies are declared; the
 * `Country`/`Currency` schema enums are BUILT from it, and the currency-sanity
 * trust rule reads it. So "add a country" is a DATA change to this table — one row
 * — never an edit to schema or validation LOGIC (OCP).
 *
 * It lives in the DOMAIN (not config): the set of in-scope markets governs the
 * deal-record schema and a trust rule, so it's a domain concept, not a runtime
 * knob. v1 ships DE only; the commented rows show how a second market is added.
 *
 * Pure data + pure derivations — no I/O, no vendor.
 */

/** A market: a country (ISO-3166-1 alpha-2) and the currency(ies) deals there allow. */
export interface Market {
  /** ISO-4217 currencies a deal in this country may be priced in (non-empty). */
  readonly currencies: readonly string[];
}

/**
 * The in-scope markets. **Germany v1 only.** Adding a market = one row here (its
 * country code → allowed currencies); the enums + the currency trust rule pick it
 * up automatically. Most countries are single-currency, but `currencies` is a set
 * so a market that legitimately accepts more than one (e.g. a future EUR-or-local
 * country) can widen without a schema change.
 */
export const MARKETS: Readonly<Record<string, Market>> = {
  DE: { currencies: ['EUR'] },
  // To enable a second country, uncomment + supply its currencies, then add its
  // seed sources / catalog vocab / deny-list / Tier-4 queries (data, see the
  // post-C "multi-country enablement" follow-up). NO logic change is needed.
  // AT: { currencies: ['EUR'] },
  // CH: { currencies: ['CHF'] },
} as const;

/**
 * Validate the registry at module load: every market must declare at least one
 * non-empty currency. A misconfigured market (no currency) would make the
 * currency-sanity trust rule silently no-op, so fail LOUDLY here instead.
 */
for (const [country, market] of Object.entries(MARKETS)) {
  const valid = market.currencies.length > 0 && market.currencies.every((c) => c.trim().length > 0);
  if (!valid) {
    throw new Error(`Market "${country}" must declare at least one non-empty currency.`);
  }
}

/** The in-scope country codes (the `Country` enum is built from these). */
export const MARKET_COUNTRIES: readonly string[] = Object.keys(MARKETS);

/** Every currency any in-scope market allows (the `Currency` enum is built from these). */
export const MARKET_CURRENCIES: readonly string[] = [
  ...new Set(Object.values(MARKETS).flatMap((m) => m.currencies)),
];

/**
 * True when `currency` is allowed for `country`. Used by the currency-sanity trust
 * rule. An out-of-scope country returns false (its deals can't pass the rule) —
 * belt-and-suspenders, since the schema enum already rejects an unknown country.
 */
export function isCurrencyAllowedForCountry(country: string, currency: string): boolean {
  return MARKETS[country]?.currencies.includes(currency) ?? false;
}

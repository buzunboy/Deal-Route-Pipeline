import { z } from 'zod';
import { MARKET_COUNTRIES, MARKET_CURRENCIES } from '../markets/index.js';

/**
 * Closed enumerations for the deal record's typed core.
 *
 * These are the values we filter / rank / canonicalize on, so they are fixed.
 * Anything outside these sets must NOT be invented by the LLM — it belongs in
 * `conditions[]` / `attributes`, and unknown conditions become `field_proposals`
 * (see `.claude/rules/extraction-and-schema.md`).
 */

/** A z.enum from a readonly string[] (the market registry drives Country/Currency). */
function enumFrom(values: readonly string[]): z.ZodEnum<[string, ...string[]]> {
  return z.enum(values as [string, ...string[]]);
}

export const RouteType = z.enum(['bundle', 'standalone', 'promo', 'regional']);
export type RouteType = z.infer<typeof RouteType>;

// `prepaid` = a single up-front payment covering a FIXED number of months that the
// page states (e.g. "2 Jahre für 49,19 €" = 24 months). Distinct from `one_time`
// (a genuine one-off with no monthly equivalent) — true-cost amortises a `prepaid`
// price over its stated term (`price.prepaid_months`), never a guessed length.
export const Billing = z.enum(['monthly', 'annual', 'one_time', 'prepaid', 'unknown']);
export type Billing = z.infer<typeof Billing>;

/**
 * Candidate lifecycle. Nothing reaches `published` without a human review (v1
 * invariant: LLM proposes, humans approve). `candidate` and `in_review` are the
 * pre-approval states; `expired`/`rejected` are terminal.
 */
export const DealStatus = z.enum(['candidate', 'in_review', 'published', 'expired', 'rejected']);
export type DealStatus = z.infer<typeof DealStatus>;

/**
 * ISO-4217 currencies in scope, derived from the market registry
 * (`domain/markets`). Germany v1 ⇒ `['EUR']`. STILL a CLOSED enum (an out-of-scope
 * currency is rejected at the schema boundary) — adding a currency is a market-
 * registry data change, never a schema-logic edit.
 */
export const Currency = enumFrom(MARKET_CURRENCIES);
export type Currency = z.infer<typeof Currency>;

/**
 * ISO-3166-1 alpha-2 countries in scope, derived from the market registry. Germany
 * v1 ⇒ `['DE']`. STILL a CLOSED enum (an out-of-scope country is rejected at the
 * boundary, e.g. `'FR'` before France launches) — adding a country is a one-row
 * market-registry change, the enum picks it up automatically.
 */
export const Country = enumFrom(MARKET_COUNTRIES);
export type Country = z.infer<typeof Country>;

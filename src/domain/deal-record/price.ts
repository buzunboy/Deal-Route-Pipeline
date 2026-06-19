import { z } from 'zod';
import { Billing, Currency } from './enums.js';

/**
 * Price value object — part of the typed core (we rank/filter on it).
 *
 * `amount` is a non-negative number in major currency units (e.g. EUR, not
 * cents). `0` is valid and meaningful (a free/included route). Currency is a
 * closed enum (EUR for DE v1); sanity validation enforces currency-vs-country.
 */
export const PriceSchema = z.object({
  amount: z.number().nonnegative(),
  currency: Currency,
  billing: Billing,
});
export type Price = z.infer<typeof PriceSchema>;

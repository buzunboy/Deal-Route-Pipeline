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
  /**
   * For `billing: 'prepaid'` ONLY: the number of months the single up-front
   * `amount` covers, as STATED on the page (e.g. "2 Jahre" ⇒ 24). Lets true-cost
   * amortise a prepaid price over its real term instead of mis-ranking the lump
   * sum as a monthly figure — grounded in the page, never a guessed length. The
   * LLM may send null/absent for other billing modes (normalised away); a
   * `prepaid` price WITHOUT it can't be normalised and is forced to must-review.
   */
  prepaid_months: z
    .number()
    .int()
    .positive()
    .nullish()
    .transform((v) => v ?? undefined),
});
export type Price = z.infer<typeof PriceSchema>;

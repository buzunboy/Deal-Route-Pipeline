import { z } from 'zod';
import { ConditionSchema } from './condition.js';

/**
 * An ISO-8601 date (YYYY-MM-DD) or full datetime. Kept as a string at the domain
 * boundary; sanity validation checks it parses to a real date and that
 * start <= end. null `end` means open-ended ("while customer", "until further
 * notice").
 */
const IsoDateString = z.string().min(1);

/**
 * Validity window + recheck cadence. `recheck_days` defaults to the pipeline's
 * 3-day cadence; promos/community sources may shorten it.
 */
export const ValiditySchema = z.object({
  start: IsoDateString.nullable(),
  end: IsoDateString.nullable(),
  /** Days until this deal should be re-crawled/re-verified. */
  recheck_days: z.number().int().positive(),
  /** Long-tail validity conditions mapped to the vocabulary. */
  conditions: z.array(ConditionSchema).default([]),
});
export type Validity = z.infer<typeof ValiditySchema>;

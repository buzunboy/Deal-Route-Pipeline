import { z } from 'zod';
import { ConditionSchema } from './condition.js';

/**
 * Eligibility — typed core flags + open `conditions[]`.
 *
 * The flags are the ones we filter/rank on. Each is **nullable**: when the page
 * does not make a flag clear, the extractor MUST leave it `null` and add a
 * condition rather than guess (`.claude/rules/extraction-and-schema.md`). `null`
 * means "unknown", not "false".
 */
export const EligibilitySchema = z.object({
  /** Offer restricted to new customers. null = not stated / unclear. */
  new_customer_only: z.boolean().nullable(),
  /** Requires residency or KYC verification. null = unclear. */
  residency_kyc: z.boolean().nullable(),
  /** Required plan tier of the bundler (e.g. "MagentaTV"). null = none/unclear. */
  plan_tier_required: z.string().nullable(),
  /** Minimum spend to qualify, in major currency units. null = none/unclear. */
  min_spend: z.number().nonnegative().nullable(),
  /** Whether the offer stacks with other promos. null = unclear. */
  stackable: z.boolean().nullable(),
  /** Long-tail eligibility conditions mapped to the vocabulary. */
  conditions: z
    .array(ConditionSchema)
    .nullish()
    .transform((v) => v ?? []),
});
export type Eligibility = z.infer<typeof EligibilitySchema>;

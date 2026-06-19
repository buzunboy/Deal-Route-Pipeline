import { z } from 'zod';
import { Country, DealStatus, RouteType } from './enums.js';
import { PriceSchema } from './price.js';
import { EligibilitySchema } from './eligibility.js';
import { ValiditySchema } from './validity.js';
import { GroundingSchema, FieldProposalSchema } from './grounding.js';

export const CURRENT_SCHEMA_VERSION = 1 as const;

/**
 * The fields the LLM is allowed to PROPOSE for a single deal record.
 *
 * Deliberately excludes anything the LLM must not own: `id`, `schema_version`,
 * `evidence_id`, `status`, `true_cost_monthly` (derived), `verified_by/at`.
 * Raw LLM JSON is parsed through this schema at the boundary before it is
 * trusted (`.claude/rules/code-style.md`: never trust raw LLM data).
 */
export const LlmExtractedDealSchema = z.object({
  service: z.string().min(1),
  route_type: RouteType,
  provider: z.string().min(1),
  headline: z.string().min(1),
  price: PriceSchema,
  country: Country,
  eligibility: EligibilitySchema,
  validity: ValiditySchema,
  included_items: z.array(z.string()).default([]),
  /** Free-form structured extras that don't fit the typed core. Never dropped. */
  attributes: z.record(z.unknown()).default({}),
  /** Verbatim terms text from the page. Kept exactly as found. */
  raw_conditions_text: z.string().default(''),
  source_url: z.string().url(),
  /** 0..1 model confidence. Sanity rules may downgrade this; never upgrade. */
  confidence: z.number().min(0).max(1),
  grounding: z.array(GroundingSchema).default([]),
  /** True when at least one condition could not be mapped to the vocabulary. */
  unmapped_conditions: z.boolean().default(false),
  /** Proposed new vocabulary keys for unmapped conditions. */
  field_proposals: z.array(FieldProposalSchema).default([]),
});
export type LlmExtractedDeal = z.infer<typeof LlmExtractedDealSchema>;

/**
 * The full persisted deal record: the LLM-proposed core plus the fields the
 * pipeline owns (identity, evidence link, derived true cost, lifecycle status,
 * verification audit).
 */
export const DealRecordSchema = LlmExtractedDealSchema.extend({
  id: z.string().uuid(),
  schema_version: z.number().int().positive(),
  /** Normalised monthly cost derived deterministically from price (pure rule). */
  true_cost_monthly: z.number().nonnegative(),
  /** Link to the immutable evidence bundle captured at crawl time. */
  evidence_id: z.string().uuid(),
  status: DealStatus,
  verified_by: z.string().nullable().default(null),
  /** ISO-8601 timestamp of human verification, or null. */
  verified_at: z.string().nullable().default(null),
});
export type DealRecord = z.infer<typeof DealRecordSchema>;

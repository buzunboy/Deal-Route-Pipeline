import { z } from 'zod';

/**
 * Closed enumerations for the deal record's typed core.
 *
 * These are the values we filter / rank / canonicalize on, so they are fixed.
 * Anything outside these sets must NOT be invented by the LLM — it belongs in
 * `conditions[]` / `attributes`, and unknown conditions become `field_proposals`
 * (see `.claude/rules/extraction-and-schema.md`).
 */

export const RouteType = z.enum(['bundle', 'standalone', 'promo', 'regional']);
export type RouteType = z.infer<typeof RouteType>;

export const Billing = z.enum(['monthly', 'annual', 'one_time', 'unknown']);
export type Billing = z.infer<typeof Billing>;

/**
 * Candidate lifecycle. Nothing reaches `published` without a human review (v1
 * invariant: LLM proposes, humans approve). `candidate` and `in_review` are the
 * pre-approval states; `expired`/`rejected` are terminal.
 */
export const DealStatus = z.enum([
  'candidate',
  'in_review',
  'published',
  'expired',
  'rejected',
]);
export type DealStatus = z.infer<typeof DealStatus>;

/** ISO-4217 currencies we support in v1. Germany v1 ⇒ EUR; widen as we expand. */
export const Currency = z.enum(['EUR']);
export type Currency = z.infer<typeof Currency>;

/** ISO-3166-1 alpha-2 countries in scope. Germany v1. */
export const Country = z.enum(['DE']);
export type Country = z.infer<typeof Country>;

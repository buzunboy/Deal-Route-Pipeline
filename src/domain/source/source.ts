import { z } from 'zod';
import { Country } from '../deal-record/enums.js';

/**
 * Source tier (see `docs/DealRoute_Seed_List_DE.md`):
 *  1 provider · 2 bundler · 3 community · 4 discovered (agentic).
 * Noise and required verification weight rise with tier.
 */
export const SourceTier = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export type SourceTier = z.infer<typeof SourceTier>;

export const SourceType = z.enum(['provider', 'bundler', 'community', 'discovered', 'aggregator']);
export type SourceType = z.infer<typeof SourceType>;

export const SourceStatus = z.enum([
  'active',
  /** Tier-4 domain awaiting human approval before it joins the deterministic crawl. */
  'pending_approval',
  /** Repeated failures or manual disable (may be re-activated). */
  'disabled',
  /** A reviewer explicitly rejected this proposed source — never crawled, never re-proposed. */
  'rejected',
]);
export type SourceStatus = z.infer<typeof SourceStatus>;

/**
 * A crawl source in the registry. Sources are data, not code: adding one is a
 * registry/config change, never an edit to crawl logic (`architecture.md`, OCP).
 */
export const SourceSchema = z.object({
  id: z.string().uuid(),
  url: z.string().url(),
  type: SourceType,
  tier: SourceTier,
  country: Country,
  /** Optional catalog service this source targets (null for broad bundler pages). */
  subscription_service: z.string().nullable().default(null),
  /** Days between re-crawls; default 3 (promos/community shorter). */
  cadence_days: z.number().int().positive(),
  /** 0..1 trust signal; repeated failures lower it (monitoring). */
  reliability_score: z.number().min(0).max(1).default(0.5),
  status: SourceStatus,
  /** ISO-8601 timestamp of the last successful crawl, or null. */
  last_seen: z.string().nullable().default(null),
  /** ISO-8601 timestamp of the next due crawl. */
  next_due: z.string().nullable().default(null),
});
export type Source = z.infer<typeof SourceSchema>;

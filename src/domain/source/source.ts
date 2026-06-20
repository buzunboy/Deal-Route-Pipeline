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
  /**
   * The POST-REDIRECT final URL this source actually resolves to, captured on the
   * first successful crawl/monitor pass (= `fetched.finalUrl`). Null until first
   * seen. Deals pin `source_url = fetched.finalUrl`, so MONITOR matches its
   * source-scoped expiry/diff-baseline lookups on `resolved_url ?? url` — without
   * it, a source whose `url` redirects to a different URL never matches its own
   * deals (every pass looks like a first sight; published deals never auto-expire).
   * Additive + nullable so existing rows parse unchanged and self-heal on next crawl.
   */
  resolved_url: z.string().url().nullable().default(null),
  /**
   * The registrable domain (eTLD+1) of this source's `url`, resolved via a real
   * Public Suffix List and pinned when the source is created/promoted (Step 6). A
   * deal copies THIS onto its `source_registrable_domain` when its fetched URL maps
   * to this source — so the deal→source reliability join matches by an identical,
   * non-recomputed string and the two pins can't drift. Nullable/additive — a
   * pre-Step-6 row reads back null and self-heals (re-pins) on its next successful
   * crawl; there is NO data backfill (migration 0012 only adds the column).
   */
  registrable_domain: z.string().nullable().default(null),
});
export type Source = z.infer<typeof SourceSchema>;

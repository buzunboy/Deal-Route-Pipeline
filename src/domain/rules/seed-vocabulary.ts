import type { Vocabulary } from './vocab-mapping.js';

/**
 * Initial controlled vocabulary for eligibility/validity conditions.
 *
 * This is the v1 starting set; it grows by promoting recurring `field_proposals`
 * (governed loop), not by editing extraction logic. Adapters may load the live
 * vocabulary from the `condition_vocabulary` table; this seed is the fallback
 * and the source for the first migration.
 */
export const SEED_VOCABULARY: Vocabulary = [
  {
    key: 'requires_other_product',
    label: 'Requires another product/subscription',
    aliases: ['requires_product', 'bundle_required', 'requires_contract'],
    version: 1,
  },
  {
    key: 'new_customer_only',
    label: 'New customers only',
    aliases: ['neukunden', 'new_customers', 'first_time_only'],
    version: 1,
  },
  {
    key: 'while_customer',
    label: 'Valid while you remain a customer',
    aliases: ['for_contract_duration', 'as_long_as_subscribed'],
    version: 1,
  },
  {
    key: 'intro_period',
    label: 'Discounted introductory period',
    aliases: ['promo_months', 'free_months', 'einfuehrungspreis'],
    version: 1,
  },
  {
    key: 'min_contract_term',
    label: 'Minimum contract term',
    aliases: ['mindestlaufzeit', 'minimum_term', 'commitment'],
    version: 1,
  },
  {
    key: 'cancellable_anytime',
    label: 'Cancellable any time',
    aliases: ['monatlich_kuendbar', 'no_commitment'],
    version: 1,
  },
  {
    key: 'with_ads',
    label: 'Ad-supported tier',
    aliases: ['ad_supported', 'mit_werbung'],
    version: 1,
  },
  {
    key: 'student_discount',
    label: 'Student eligibility required',
    aliases: ['student', 'studenten', 'edu'],
    version: 1,
  },
  {
    key: 'regional_restriction',
    label: 'Restricted to a region',
    aliases: ['region_locked', 'geo_restricted'],
    version: 1,
  },
  {
    key: 'app_only',
    label: 'Available only via app',
    aliases: ['app_exclusive', 'nur_app'],
    version: 1,
  },
];

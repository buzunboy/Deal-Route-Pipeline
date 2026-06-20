import { evidenceScreenshotRef, type Condition, type DealRecord } from '../../domain/index.js';

/**
 * The PUBLIC projection of a deal — the load-bearing trust contract of the public
 * read API. It is a DELIBERATE allow-list: only the fields below are exposed.
 * Internal / LLM-audit fields (`status`, `confidence`, `grounding`, `attributes`,
 * `raw_conditions_text`, `unmapped_conditions`, `field_proposals`, `schema_version`,
 * `evidence_id`, `verified_by`, `source_quote` on conditions) MUST NEVER appear
 * here. A contract test (`public-dto.test.ts`) feeds a fully-populated DealRecord
 * and asserts none of those keys leak — change this shape only with that test green.
 */
export interface PublicDeal {
  id: string;
  service: string;
  provider: string;
  headline: string;
  route_type: DealRecord['route_type'];
  country: DealRecord['country'];
  price: {
    amount: number;
    currency: DealRecord['price']['currency'];
    billing: DealRecord['price']['billing'];
  };
  true_cost_monthly: number;
  eligibility: {
    new_customer_only: boolean | null;
    residency_kyc: boolean | null;
    plan_tier_required: string | null;
    min_spend: number | null;
    stackable: boolean | null;
    conditions: PublicCondition[];
  };
  validity: {
    start: string | null;
    end: string | null;
    recheck_days: number;
    conditions: PublicCondition[];
  };
  included_items: string[];
  source_url: string;
  verified_at: string | null;
  /** Coarse freshness band (never the raw reliability/confidence score). */
  trust: TrustBadge;
  /**
   * Resolved public CDN URL of the evidence screenshot, or null when no CDN base
   * URL is configured (e.g. local-fs evidence). Derived purely from `evidence_id`
   * — never the raw `evidence_id` itself.
   */
  evidence_screenshot_url: string | null;
}

/**
 * A condition in public shape: the vocabulary `key`, the human `label`, and the
 * optional structured `value`. The verbatim `source_quote` is DROPPED — it is a
 * raw page excerpt (copyright + leak surface), not for public display.
 */
export interface PublicCondition {
  key: string;
  label: string;
  value?: Record<string, unknown>;
}

/**
 * Internal/audit key names that must NEVER surface in a public response. The DTO
 * is an allow-list at the top level, but `condition.value` is an OPEN object
 * (`z.record(z.unknown())`) populated from LLM/source output — so a condition could
 * nest a key named `source_quote`/`status`/`verified_by`/raw terms here. We strip
 * any reserved name out of `value` before exposing it, so the no-leak contract
 * ("no internal field name appears in a /v1/ response") holds even for nested data
 * we don't control. Kept in sync with the public-dto no-leak contract test.
 */
const FORBIDDEN_VALUE_KEYS = new Set<string>([
  'status',
  'confidence',
  'grounding',
  'attributes',
  'raw_conditions_text',
  'unmapped_conditions',
  'field_proposals',
  'schema_version',
  'evidence_id',
  'verified_by',
  'source_quote',
  'dedupe_key',
]);

/**
 * Coarse trust badge — a freshness band derived from `verified_at`, never the raw
 * `reliability_score`/`confidence`. v1 is freshness-only (reliability-blended
 * ranking is a later step). Bands:
 *  - `recent`   verified within RECENT_DAYS
 *  - `verified` verified within STALE_DAYS
 *  - `stale`    verified longer ago than STALE_DAYS, OR never verified (null)
 */
export type TrustBadge = 'recent' | 'verified' | 'stale';

export const TRUST_RECENT_DAYS = 7;
export const TRUST_STALE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Pure freshness-band computation from a verification timestamp + the current time. */
export function trustBadge(verifiedAt: string | null, now: Date): TrustBadge {
  if (verifiedAt === null) return 'stale';
  const verified = Date.parse(verifiedAt);
  if (Number.isNaN(verified)) return 'stale';
  const ageDays = (now.getTime() - verified) / MS_PER_DAY;
  if (ageDays <= TRUST_RECENT_DAYS) return 'recent';
  if (ageDays <= TRUST_STALE_DAYS) return 'verified';
  return 'stale';
}

export interface PublicDealOptions {
  /** Public CDN base URL for evidence (config.evidence.s3.cdnBaseUrl). Unset ⇒ no URL. */
  cdnBaseUrl?: string;
  /** Current time, for the freshness badge. Injected so the projection stays pure. */
  now: Date;
}

/**
 * Project a stored {@link DealRecord} into its {@link PublicDeal} view. PURE — no
 * I/O, no DB/evidence-store lookup. The screenshot URL is derived from the
 * deterministic evidence layout (`<evidence_id>/screenshot.png`) so no per-row
 * lookup is needed; the trust badge is derived from `verified_at` freshness.
 *
 * IMPORTANT: this is an explicit allow-list, NOT a `delete`-the-bad-keys filter —
 * a new internal field added to DealRecord is excluded by default (it simply isn't
 * copied), which is the safe failure mode for a trust boundary.
 */
export function toPublicDeal(deal: DealRecord, opts: PublicDealOptions): PublicDeal {
  return {
    id: deal.id,
    service: deal.service,
    provider: deal.provider,
    headline: deal.headline,
    route_type: deal.route_type,
    country: deal.country,
    price: {
      amount: deal.price.amount,
      currency: deal.price.currency,
      billing: deal.price.billing,
    },
    true_cost_monthly: deal.true_cost_monthly,
    eligibility: {
      new_customer_only: deal.eligibility.new_customer_only,
      residency_kyc: deal.eligibility.residency_kyc,
      plan_tier_required: deal.eligibility.plan_tier_required,
      min_spend: deal.eligibility.min_spend,
      stackable: deal.eligibility.stackable,
      conditions: deal.eligibility.conditions.map(toPublicCondition),
    },
    validity: {
      start: deal.validity.start,
      end: deal.validity.end,
      recheck_days: deal.validity.recheck_days,
      conditions: deal.validity.conditions.map(toPublicCondition),
    },
    included_items: deal.included_items,
    source_url: deal.source_url,
    verified_at: deal.verified_at,
    trust: trustBadge(deal.verified_at, opts.now),
    evidence_screenshot_url: resolveScreenshotUrl(deal.evidence_id, opts.cdnBaseUrl),
  };
}

/**
 * Project one condition to its public shape — drop the verbatim `source_quote`,
 * and strip any reserved/internal key name out of the open `value` object so a
 * condition can't smuggle a forbidden field onto the public wire (see
 * {@link FORBIDDEN_VALUE_KEYS}).
 */
function toPublicCondition(c: Condition): PublicCondition {
  const out: PublicCondition = { key: c.key, label: c.label };
  if (c.value !== undefined) out.value = sanitizeValue(c.value);
  return out;
}

/** Drop any reserved/internal key from a condition's open `value` object. */
function sanitizeValue(value: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (!FORBIDDEN_VALUE_KEYS.has(k)) safe[k] = v;
  }
  return safe;
}

/**
 * Build the public screenshot URL from the deal's `evidence_id` and the configured
 * CDN base. Returns null when no CDN base is set (local-fs evidence has no public
 * URL — never leak a relative/broken path). Joins without doubling slashes.
 *
 * The URL is derived, not verified: it assumes a screenshot object exists at the
 * deterministic layout path. That holds because `assertCaptureComplete` rejects a
 * hollow capture (empty screenshot) at save time in BOTH evidence stores, so every
 * persisted bundle has a non-empty `screenshot.png`.
 */
function resolveScreenshotUrl(evidenceId: string, cdnBaseUrl?: string): string | null {
  if (cdnBaseUrl === undefined) return null;
  const base = cdnBaseUrl.replace(/\/+$/, '');
  return `${base}/${evidenceScreenshotRef(evidenceId)}`;
}

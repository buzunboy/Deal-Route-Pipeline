import {
  DealRecordSchema,
  dedupeKey,
  type DealRecord,
  type Condition,
  type Grounding,
  type FieldProposal,
} from '../../../domain/index.js';
import type { deals } from './schema.js';

type DealRow = typeof deals.$inferInsert;
type DealSelect = typeof deals.$inferSelect;

/** Domain DealRecord → Postgres row (flatten typed core, JSONB for open areas). */
export function dealToRow(d: DealRecord): DealRow {
  return {
    id: d.id,
    schemaVersion: d.schema_version,
    service: d.service,
    routeType: d.route_type,
    provider: d.provider,
    headline: d.headline,
    priceAmount: d.price.amount,
    priceCurrency: d.price.currency,
    priceBilling: d.price.billing,
    trueCostMonthly: d.true_cost_monthly,
    country: d.country,
    newCustomerOnly: d.eligibility.new_customer_only,
    residencyKyc: d.eligibility.residency_kyc,
    planTierRequired: d.eligibility.plan_tier_required,
    minSpend: d.eligibility.min_spend,
    stackable: d.eligibility.stackable,
    validityStart: d.validity.start,
    validityEnd: d.validity.end,
    recheckDays: d.validity.recheck_days,
    eligibilityConditions: d.eligibility.conditions,
    validityConditions: d.validity.conditions,
    includedItems: d.included_items,
    attributes: d.attributes,
    rawConditionsText: d.raw_conditions_text,
    grounding: d.grounding,
    fieldProposals: d.field_proposals,
    unmappedConditions: d.unmapped_conditions,
    sourceUrl: d.source_url,
    evidenceId: d.evidence_id,
    confidence: d.confidence,
    dedupeKey: dedupeKey(d),
    status: d.status,
    verifiedBy: d.verified_by,
    verifiedAt: d.verified_at,
  };
}

/**
 * Postgres row → domain DealRecord, RE-VALIDATED through the schema. We never
 * trust stored data blindly either: a row that no longer parses (e.g. after a bad
 * manual edit) fails loudly rather than leaking a malformed record.
 */
/**
 * Canonical ISO-8601 (UTC, 'Z') for a Postgres `timestamptz` text value.
 *
 * node-postgres returns a `timestamptz` (mode:'string') column in libpq text form
 * ('2026-06-19 00:00:00+00' — space separator, '+00', no millis/'Z'), NOT the
 * canonical ISO-Z string the caller wrote. Every read mapper normalizes through
 * this so the Postgres adapter emits byte-identical timestamps to the in-memory
 * adapter (LSP) — domain objects and their consumers (CLI/ledger/scheduler) only
 * ever see ISO-Z. Round-trip-safe: all writers persist ISO already.
 */
export function isoTimestamp(ts: string): string {
  return new Date(ts).toISOString();
}

/** As {@link isoTimestamp}, but passes a null `timestamptz` through unchanged. */
export function isoTimestampOrNull(ts: string | null): string | null {
  return ts === null ? null : isoTimestamp(ts);
}

export function rowToDeal(r: DealSelect): DealRecord {
  const candidate = {
    id: r.id,
    schema_version: r.schemaVersion,
    service: r.service,
    route_type: r.routeType,
    provider: r.provider,
    headline: r.headline,
    price: { amount: r.priceAmount, currency: r.priceCurrency, billing: r.priceBilling },
    true_cost_monthly: r.trueCostMonthly,
    country: r.country,
    eligibility: {
      new_customer_only: r.newCustomerOnly,
      residency_kyc: r.residencyKyc,
      plan_tier_required: r.planTierRequired,
      min_spend: r.minSpend,
      stackable: r.stackable,
      conditions: r.eligibilityConditions as Condition[],
    },
    validity: {
      start: r.validityStart,
      end: r.validityEnd,
      recheck_days: r.recheckDays,
      conditions: r.validityConditions as Condition[],
    },
    included_items: r.includedItems as string[],
    attributes: r.attributes as Record<string, unknown>,
    raw_conditions_text: r.rawConditionsText,
    grounding: r.grounding as Grounding[],
    field_proposals: r.fieldProposals as FieldProposal[],
    unmapped_conditions: r.unmappedConditions,
    source_url: r.sourceUrl,
    evidence_id: r.evidenceId,
    confidence: r.confidence,
    status: r.status,
    verified_by: r.verifiedBy,
    verified_at: isoTimestampOrNull(r.verifiedAt),
  };
  return DealRecordSchema.parse(candidate);
}

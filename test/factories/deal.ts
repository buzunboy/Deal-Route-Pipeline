import { randomUUID } from 'node:crypto';
import { DealStatus, type DealRecord, type LlmExtractedDeal } from '../../src/domain/index.js';
import { tldtsSuffixOracle } from '../../src/adapters/suffix/tldts-suffix-oracle.js';

/**
 * Build a valid baseline LlmExtractedDeal for tests. Override any field via the
 * partial. Keeps test cases focused on the one property under test.
 */
export function makeLlmDeal(overrides: Partial<LlmExtractedDeal> = {}): LlmExtractedDeal {
  return {
    service: 'Disney+',
    route_type: 'bundle',
    provider: 'Telekom MagentaTV',
    headline: 'Disney+ included in MagentaTV SmartStream',
    price: { amount: 10, currency: 'EUR', billing: 'monthly' },
    country: 'DE',
    eligibility: {
      new_customer_only: false,
      residency_kyc: false,
      plan_tier_required: 'MagentaTV',
      min_spend: null,
      stackable: true,
      conditions: [],
    },
    validity: {
      start: '2026-01-01',
      end: null,
      recheck_days: 3,
      conditions: [],
    },
    included_items: ['Disney+ Standard'],
    attributes: {},
    raw_conditions_text: 'Disney+ ist im Tarif MagentaTV SmartStream enthalten.',
    source_url: 'https://www.telekom.de/magenta-tv',
    confidence: 0.9,
    grounding: [
      { field: 'price', quote: 'Disney+ ist im Tarif MagentaTV SmartStream enthalten.' },
      { field: 'eligibility', quote: 'Disney+ ist im Tarif MagentaTV SmartStream enthalten.' },
      { field: 'validity', quote: 'Disney+ ist im Tarif MagentaTV SmartStream enthalten.' },
    ],
    unmapped_conditions: false,
    field_proposals: [],
    ...overrides,
  };
}

/**
 * Build a valid full DealRecord (the persisted shape) for tests — the LLM core plus
 * the pipeline-owned fields. `source_registrable_domain` is pinned from `source_url`
 * via the real PSL (exactly as extract pins it) unless explicitly overridden, so the
 * dedupe-key recompute + reliability join key off a consistent value. Shared by the
 * DB contract suite, the review use-case tests, and the integration tier.
 */
export function makeDealRecord(overrides: Partial<DealRecord> = {}): DealRecord {
  const record: DealRecord = {
    ...makeLlmDeal(),
    id: randomUUID(),
    schema_version: 1,
    true_cost_monthly: 10,
    evidence_id: randomUUID(),
    source_registrable_domain: null,
    status: DealStatus.enum.candidate,
    verified_by: null,
    verified_at: null,
    affiliate_disclosure: true,
    published_at: null,
    human_edited: [],
    ...overrides,
  };
  if (!('source_registrable_domain' in overrides)) {
    record.source_registrable_domain = tldtsSuffixOracle(record.source_url);
  }
  return record;
}

import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { toPublicDeal, trustBadge, TRUST_RECENT_DAYS, TRUST_STALE_DAYS } from './public-dto.js';
import { DealStatus, type DealRecord } from '../../domain/index.js';
import { makeLlmDeal } from '../../../test/factories/deal.js';

/**
 * A DealRecord with EVERY internal/audit field populated — conditions carrying a
 * verbatim `source_quote` + structured `value`, non-empty grounding /
 * field_proposals / attributes, a real evidence_id, confidence, verified_by. The
 * no-leak contract is only meaningful if the input actually HAS the forbidden data.
 */
function fullyPopulatedDeal(overrides: Partial<DealRecord> = {}): DealRecord {
  return {
    ...makeLlmDeal({
      eligibility: {
        new_customer_only: true,
        residency_kyc: false,
        plan_tier_required: 'MagentaTV',
        min_spend: 9.99,
        stackable: false,
        conditions: [
          {
            key: 'requires_other_product',
            label: 'Requires an active MagentaTV plan',
            // `value` is an OPEN object populated from LLM/source output. Nest
            // reserved key names here so the no-leak contract proves they are
            // stripped from the public wire (a real leak vector, not hypothetical).
            value: {
              product: 'MagentaTV',
              source_quote: 'SECRET-INTERNAL-QUOTE',
              status: 'SECRET-INTERNAL-QUOTE',
              verified_by: 'reviewer-LEAK-CANARY',
              confidence: 'LEAK-CANARY-GROUNDING',
            },
            source_quote: 'Nur mit aktivem MagentaTV-Tarif. SECRET-INTERNAL-QUOTE',
          },
        ],
      },
      validity: {
        start: '2026-01-01',
        end: '2026-12-31',
        recheck_days: 3,
        conditions: [
          {
            key: 'while_customer',
            label: 'While you remain a customer',
            source_quote: 'Solange Sie Kunde sind. SECRET-INTERNAL-QUOTE',
          },
        ],
      },
      attributes: { internal_note: 'LEAK-CANARY-ATTRIBUTE' },
      raw_conditions_text: 'LEAK-CANARY-RAW-TERMS verbatim copyrighted T&C text',
      confidence: 0.42,
      grounding: [{ field: 'price', quote: 'LEAK-CANARY-GROUNDING' }],
      unmapped_conditions: true,
      field_proposals: [
        {
          suggested_key: 'requires_pet',
          label: 'Pet required',
          rationale: 'LEAK-CANARY-PROPOSAL',
          example_quote: 'q',
        },
      ],
    }),
    id: randomUUID(),
    schema_version: 1,
    true_cost_monthly: 9.99,
    evidence_id: randomUUID(),
    status: DealStatus.enum.published,
    verified_by: 'reviewer-LEAK-CANARY',
    verified_at: '2026-06-19T00:00:00.000Z',
    ...overrides,
  };
}

/** Every internal field name + every canary value that MUST NOT appear in the DTO. */
const FORBIDDEN_KEYS = [
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
];
const FORBIDDEN_VALUES = [
  'SECRET-INTERNAL-QUOTE',
  'LEAK-CANARY-ATTRIBUTE',
  'LEAK-CANARY-RAW-TERMS',
  'LEAK-CANARY-GROUNDING',
  'LEAK-CANARY-PROPOSAL',
  'reviewer-LEAK-CANARY',
];

/** Recursively collect every object key + every string value reachable in a value. */
function walk(value: unknown, keys: string[], strings: string[]): void {
  if (typeof value === 'string') {
    strings.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) walk(v, keys, strings);
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      keys.push(k);
      walk(v, keys, strings);
    }
  }
}

describe('toPublicDeal — the no-leak trust contract', () => {
  it('exposes NONE of the internal/audit keys for a fully-populated record', () => {
    const dto = toPublicDeal(fullyPopulatedDeal(), { now: new Date('2026-06-20T00:00:00.000Z') });
    const keys: string[] = [];
    const strings: string[] = [];
    walk(dto, keys, strings);

    for (const forbidden of FORBIDDEN_KEYS) {
      expect(keys, `internal key "${forbidden}" leaked into the public DTO`).not.toContain(
        forbidden,
      );
    }
    // Also prove no internal *value* sneaks through under a renamed/nested key.
    for (const canary of FORBIDDEN_VALUES) {
      expect(
        strings.some((s) => s.includes(canary)),
        `internal value "${canary}" leaked into the public DTO`,
      ).toBe(false);
    }
  });

  it('exposes exactly the curated public field set (allow-list, no extras)', () => {
    const dto = toPublicDeal(fullyPopulatedDeal(), { now: new Date('2026-06-20T00:00:00.000Z') });
    expect(Object.keys(dto).sort()).toEqual(
      [
        'country',
        'eligibility',
        'evidence_screenshot_url',
        'headline',
        'id',
        'included_items',
        'price',
        'provider',
        'route_type',
        'service',
        'source_url',
        'true_cost_monthly',
        'trust',
        'validity',
        'verified_at',
      ].sort(),
    );
  });

  it('projects conditions to { key, label, value }, drops source_quote, strips reserved value keys', () => {
    const dto = toPublicDeal(fullyPopulatedDeal(), { now: new Date('2026-06-20T00:00:00.000Z') });
    // Only the legitimate `product` key survives; the reserved names nested in the
    // condition value (source_quote/status/verified_by/confidence) are stripped.
    expect(dto.eligibility.conditions).toEqual([
      {
        key: 'requires_other_product',
        label: 'Requires an active MagentaTV plan',
        value: { product: 'MagentaTV' },
      },
    ]);
    // The validity condition has no `value` → the key is absent (not value:undefined).
    expect(dto.validity.conditions).toEqual([
      { key: 'while_customer', label: 'While you remain a customer' },
    ]);
    expect('value' in dto.validity.conditions[0]!).toBe(false);
  });

  describe('evidence_screenshot_url', () => {
    it('resolves a CDN URL from evidence_id when cdnBaseUrl is set', () => {
      const deal = fullyPopulatedDeal();
      const dto = toPublicDeal(deal, {
        cdnBaseUrl: 'https://cdn.example.com',
        now: new Date('2026-06-20T00:00:00.000Z'),
      });
      expect(dto.evidence_screenshot_url).toBe(
        `https://cdn.example.com/${deal.evidence_id}/screenshot.png`,
      );
    });

    it('strips a trailing slash on the base so the URL never doubles up', () => {
      const deal = fullyPopulatedDeal();
      const dto = toPublicDeal(deal, {
        cdnBaseUrl: 'https://cdn.example.com/',
        now: new Date('2026-06-20T00:00:00.000Z'),
      });
      expect(dto.evidence_screenshot_url).toBe(
        `https://cdn.example.com/${deal.evidence_id}/screenshot.png`,
      );
    });

    it('is null when no cdnBaseUrl is configured (local-fs evidence)', () => {
      const dto = toPublicDeal(fullyPopulatedDeal(), {
        now: new Date('2026-06-20T00:00:00.000Z'),
      });
      expect(dto.evidence_screenshot_url).toBeNull();
      // and never the raw evidence_id.
      const strings: string[] = [];
      walk(dto, [], strings);
      expect(strings).not.toContain(fullyPopulatedDeal().evidence_id);
    });
  });

  describe('trustBadge — freshness bands', () => {
    const now = new Date('2026-06-20T00:00:00.000Z');
    it('recent when verified within RECENT_DAYS', () => {
      const d = new Date(now.getTime() - (TRUST_RECENT_DAYS - 1) * 86400000).toISOString();
      expect(trustBadge(d, now)).toBe('recent');
    });
    it('verified when within STALE_DAYS but older than RECENT_DAYS', () => {
      const d = new Date(now.getTime() - (TRUST_RECENT_DAYS + 1) * 86400000).toISOString();
      expect(trustBadge(d, now)).toBe('verified');
    });
    it('stale when older than STALE_DAYS', () => {
      const d = new Date(now.getTime() - (TRUST_STALE_DAYS + 1) * 86400000).toISOString();
      expect(trustBadge(d, now)).toBe('stale');
    });
    it('stale when never verified (null) or unparseable', () => {
      expect(trustBadge(null, now)).toBe('stale');
      expect(trustBadge('not-a-date', now)).toBe('stale');
    });
    it('the DTO carries the computed badge, never a raw confidence/reliability number', () => {
      const dto = toPublicDeal(fullyPopulatedDeal({ verified_at: now.toISOString() }), { now });
      expect(dto.trust).toBe('recent');
      // confidence on the source record was 0.42 — it must not appear anywhere.
      const strings: string[] = [];
      walk(dto, [], strings);
      expect(strings).not.toContain('0.42');
      expect(strings).not.toContain(0.42 as unknown as string);
    });
  });
});

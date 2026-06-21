import { z } from 'zod';
import { PriceSchema } from '../deal-record/price.js';
import { EligibilitySchema } from '../deal-record/eligibility.js';
import { ValiditySchema } from '../deal-record/validity.js';
import { RouteType, Country } from '../deal-record/enums.js';
import { trueCostMonthly } from './true-cost.js';
import { InvalidPatchError } from '../errors/index.js';
import type { DealRecord } from '../deal-record/deal-record.js';

/**
 * Reviewer-editable fields of a candidate deal record (PATCH /api/candidates/:id).
 *
 * A human may correct what the extractor read off the page — price, true cost,
 * country, route type, headline, eligibility (core flags + conditions), validity,
 * included items, attributes. They may NEVER rewrite provenance/identity/lifecycle
 * (`id`, `evidence_id`, `source_url`, `status`, `schema_version`, the verification
 * audit fields): those are owned by the pipeline + the audited approve/reject path,
 * not a free-form edit. A patch touching anything outside this set is rejected
 * ({@link InvalidPatchError} → HTTP 400) so the allowlist is enforced in ONE pure,
 * unit-tested place rather than per-caller.
 *
 * `true_cost_monthly` is editable but is ALSO re-derived from `price` whenever price
 * changes (see {@link applyCandidatePatch}); an explicit value only takes effect
 * when price is left untouched (a manual override the reviewer can still make).
 */
export const PatchableDealSchema = z
  .object({
    price: PriceSchema,
    true_cost_monthly: z.number().nonnegative(),
    country: Country,
    route_type: RouteType,
    headline: z.string().min(1),
    eligibility: EligibilitySchema,
    validity: ValiditySchema,
    included_items: z.array(z.string()),
    attributes: z.record(z.unknown()),
  })
  .partial();
export type PatchableDeal = z.infer<typeof PatchableDealSchema>;

/** The keys a reviewer may patch — the single source of truth for the allowlist. */
export const PATCHABLE_FIELDS = Object.freeze([
  'price',
  'true_cost_monthly',
  'country',
  'route_type',
  'headline',
  'eligibility',
  'validity',
  'included_items',
  'attributes',
] as const);

const PATCHABLE_SET: ReadonlySet<string> = new Set<string>(PATCHABLE_FIELDS);

export interface AppliedPatch {
  /** The candidate with the patch merged in (a fresh object; input untouched). */
  deal: DealRecord;
  /**
   * Top-level field paths the patch actually CHANGED (deep-equal compared against
   * the prior value), e.g. `['price', 'eligibility']`. Drives the `human_edited`
   * trail — a no-op patch leaves it empty. `true_cost_monthly` re-derived as a
   * side effect of a price change is reported under `price`, not on its own.
   */
  changed: string[];
}

/**
 * Apply a validated reviewer patch to a candidate, purely. Rejects any key outside
 * {@link PATCHABLE_FIELDS} (caller passes the RAW patch body so the allowlist check
 * sees forbidden keys before they are silently dropped), validates the supplied
 * sub-objects through their own schemas (never trust raw input), merges immutably,
 * recomputes `true_cost_monthly` from price when price changed, and reports which
 * top-level fields actually changed. Does NOT touch status, grounding, or
 * `human_edited` — the caller owns the audit + trust tagging.
 */
export function applyCandidatePatch(deal: DealRecord, rawPatch: unknown): AppliedPatch {
  if (rawPatch === null || typeof rawPatch !== 'object' || Array.isArray(rawPatch)) {
    throw new InvalidPatchError('Patch must be a JSON object of reviewer-editable fields.');
  }

  // Enforce the allowlist on the RAW keys first: a forbidden key (id, source_url,
  // status, …) is a 400, not a silently-ignored field. This is the trust boundary.
  const forbidden = Object.keys(rawPatch).filter((k) => !PATCHABLE_SET.has(k));
  if (forbidden.length > 0) {
    throw new InvalidPatchError(
      `Patch contains non-editable field(s): ${forbidden.join(', ')}. ` +
        `Editable: ${PATCHABLE_FIELDS.join(', ')}.`,
      forbidden,
    );
  }

  // Boundary-validate the editable subset; a malformed sub-object (bad enum,
  // negative price, …) is a 400 before it can reach the record.
  const parsed = PatchableDealSchema.safeParse(rawPatch);
  if (!parsed.success) {
    throw new InvalidPatchError(
      `Patch failed validation: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
      parsed.error.issues.map((i) => i.path.join('.')),
    );
  }
  const patch = parsed.data;

  const changed: string[] = [];
  const next: DealRecord = { ...deal };

  for (const key of PATCHABLE_FIELDS) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === undefined) continue; // partial() lets an explicit `undefined` through
    if (deepEqual(deal[key], value)) continue; // a no-op edit isn't a change
    changed.push(key);
    // The patch schema validated each field; assign through `unknown` because the
    // per-key union of PatchableDeal isn't expressible as a single DealRecord key.
    (next as Record<string, unknown>)[key] = value;
  }

  // Price drives the derived true cost: a reviewer who fixes the price must not have
  // to also recompute the monthly figure (and must not be able to leave them
  // inconsistent). Recompute deterministically; report it under `price`, and if an
  // explicit true_cost edit was redundant with the recompute, don't double-count.
  if (changed.includes('price')) {
    const derived = trueCostMonthly(next.price);
    next.true_cost_monthly = derived;
    const i = changed.indexOf('true_cost_monthly');
    if (i !== -1) changed.splice(i, 1);
  }

  return { deal: next, changed };
}

/** Structural equality for patch comparison (values are JSON-shaped domain data). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}

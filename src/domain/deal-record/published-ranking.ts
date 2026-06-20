import type { DealRecord } from './deal-record.js';
import type { PublishedQuery, PublishedSort } from './published-query.js';
import { PUBLISHED_MAX_LIMIT, PUBLISHED_MAX_OFFSET } from './published-query.js';

/**
 * Reliability-blended ranking for the public published-deals feed (Step 3).
 *
 * A source's `reliability_score` (cadence/back-off trust signal) becomes a SORT
 * TIEBREAKER for the public feed: within a group of deals that tie on the primary
 * key (cost, or freshness), the more reliable source ranks first. The raw score is
 * NEVER exposed — it influences ORDER only; the public DTO's freshness `trust`
 * badge stays the sole public trust signal (see `adapters/http/public-dto.ts`).
 *
 * This is the ONE place the ranking formula + the deal→source reliability
 * resolution live, so both DB adapters (in-memory + Postgres) order identically by
 * construction (LSP) — neither reimplements `registrableDomain` or the comparator.
 * Pure: no I/O, no clock; the caller supplies the resolved reliability index and
 * the (already verified_at-normalised) deal rows.
 */

/**
 * Reliability assumed for a deal whose source can't be resolved (unparseable
 * `source_url`, or no active source on its registrable domain). The source
 * schema's own default is 0.5, so an unresolved deal is neither penalised nor
 * boosted — it ranks as a neutral source would, never sinking purely for lacking
 * a source row.
 */
export const NEUTRAL_RELIABILITY = 0.5;

/**
 * The bounded candidate set a `listPublished` fetch may consider, BEFORE the
 * final reliability tiebreak + paginate. The deepest reachable page is
 * `[offset = PUBLISHED_MAX_OFFSET, limit = PUBLISHED_MAX_LIMIT)` (the HTTP
 * boundary 400s anything past the offset cap — never a silent clamp), so a fetch
 * of this many rows, taken in a DETERMINISTIC primary-key order, always contains
 * every row any reachable page could surface. Both adapters MUST cap at exactly
 * this many rows (in the same primary order) so a >cap published corpus is treated
 * identically — the reliability tiebreak only permutes rows WITHIN equal-primary
 * groups, so it can never move a row across this boundary.
 */
export const PUBLISHED_FETCH_CAP = PUBLISHED_MAX_OFFSET + PUBLISHED_MAX_LIMIT;

/**
 * Resolve a deal's reliability from a `registrableDomain → score` index, keyed by
 * the deal's PINNED `source_registrable_domain` (Step 6 — resolved once at extract
 * via a real PSL, never recomputed here, so no PSL call enters a sort comparator).
 *
 * Uses `??` (never `&&`/`||`) on purpose: a real source score of `0` (a
 * deliberately-distrusted domain) is a meaningful value in [0,1] and must be
 * PRESERVED — only an unpinned domain (null) or an absent source falls back to
 * neutral. Folding `0` up to neutral would silently rescue a distrusted source.
 */
export function resolveReliability(
  sourceRegistrableDomain: string | null,
  byDomain: ReadonlyMap<string, number>,
): number {
  const score =
    sourceRegistrableDomain === null ? undefined : byDomain.get(sourceRegistrableDomain);
  return score ?? NEUTRAL_RELIABILITY;
}

/**
 * Fold active sources into a `registrableDomain → reliability_score` index, keyed by
 * each source's PINNED `registrable_domain` (Step 6). The join is by registrable
 * domain: a deal's `source_url` is the post-redirect `finalUrl` while a source's
 * `url` is its canonical/configured URL — but BOTH are folded to the same eTLD+1 by
 * the real PSL at their pin sites (extract for the deal, source-create for the
 * source), so a deal resolves to its source's reliability by matching pinned strings.
 *
 * A source whose `registrable_domain` is null (a pre-Step-6 row not yet backfilled)
 * is skipped — it simply contributes no reliability, folding its deals to neutral.
 * Collision (two active sources sharing a registrable domain) resolves to the MAX
 * score — fixed once here so both adapters agree.
 */
export function buildReliabilityIndex(
  sources: ReadonlyArray<{ registrable_domain: string | null; reliability_score: number }>,
): Map<string, number> {
  const byDomain = new Map<string, number>();
  for (const s of sources) {
    if (s.registrable_domain === null) continue;
    const prev = byDomain.get(s.registrable_domain);
    if (prev === undefined || s.reliability_score > prev) {
      byDomain.set(s.registrable_domain, s.reliability_score);
    }
  }
  return byDomain;
}

/**
 * The primary-key-only comparator (NO reliability): `cost_asc` →
 * `true_cost_monthly` ASC then `id` ASC; `verified_desc` → `verified_at` DESC
 * NULLS LAST then `id` ASC. This is the order in which a deterministic bounded
 * fetch takes its top {@link PUBLISHED_FETCH_CAP} rows, so the capped candidate
 * set is identical across adapters regardless of corpus size.
 *
 * `verified_at` is canonical ISO-Z in both adapters (the Postgres mapper
 * normalises timestamptz → ISO-Z), so `localeCompare` is chronological. The `id`
 * tiebreaker assumes canonical lowercase-hyphenated UUIDs (the schema enforces
 * them), so JS `localeCompare` on the text matches Postgres's byte ordering of the
 * `uuid` column — the two adapters pick the SAME rows at the fetch-cap boundary.
 */
export function comparePublishedPrimary(
  sort: PublishedSort,
): (a: DealRecord, b: DealRecord) => number {
  return (a, b) => comparePrimary(sort, a, b) || a.id.localeCompare(b.id);
}

/**
 * The FULL public-feed comparator: primary key, then reliability DESC (the
 * tiebreak), then `id` ASC as the final, total tiebreaker. `id` is unique, so the
 * order is a strict total order with no residual ties — `offset` pagination never
 * skips or repeats a row. Both adapters call THIS; there is no parallel SQL ORDER
 * BY producing the final order.
 */
export function comparePublished(
  sort: PublishedSort,
  byDomain: ReadonlyMap<string, number>,
): (a: DealRecord, b: DealRecord) => number {
  return (a, b) => {
    const primary = comparePrimary(sort, a, b);
    if (primary !== 0) return primary;
    const ra = resolveReliability(a.source_registrable_domain, byDomain);
    const rb = resolveReliability(b.source_registrable_domain, byDomain);
    if (ra !== rb) return rb - ra; // reliability DESC (more reliable first)
    return a.id.localeCompare(b.id);
  };
}

/** Primary-key comparison only (shared by the primary-only + full comparators). */
function comparePrimary(sort: PublishedSort, a: DealRecord, b: DealRecord): number {
  if (sort === 'verified_desc') {
    const av = a.verified_at;
    const bv = b.verified_at;
    if (av === bv) return 0;
    if (av === null) return 1; // nulls last
    if (bv === null) return -1;
    return bv.localeCompare(av); // descending
  }
  return a.true_cost_monthly - b.true_cost_monthly; // cost_asc
}

/**
 * Rank a set of published deals into the final public-feed page: full-comparator
 * sort (primary → reliability → id), then `slice(offset, offset + limit)`. PURE —
 * clones each returned deal so callers can't mutate stored state (and so reliability
 * is never annotated onto a returned deal — it stays order-only).
 *
 * For correctness the input need only be the `published` + filtered rows; for the
 * cross-adapter EQUIVALENCE the caller SHOULD also have applied the deterministic
 * primary-ordered {@link PUBLISHED_FETCH_CAP} (see {@link capByPrimary}) so a >cap
 * corpus yields the same bounded candidate set on both adapters. Slicing a sorted
 * superset is correct either way; the cap is the LSP/perf precondition, not a
 * correctness one.
 */
export function rankPublished(
  deals: ReadonlyArray<DealRecord>,
  byDomain: ReadonlyMap<string, number>,
  query: PublishedQuery,
): DealRecord[] {
  return [...deals]
    .sort(comparePublished(query.sort, byDomain))
    .slice(query.offset, query.offset + query.limit)
    .map((d) => ({ ...d }));
}

/**
 * Take the top {@link PUBLISHED_FETCH_CAP} rows in deterministic primary order —
 * the in-memory adapter's mirror of the Postgres `ORDER BY <primary>, id LIMIT
 * CAP` fetch. Coding the cap on BOTH sides (not assuming the in-memory store is
 * always small) is what keeps a >cap corpus byte-identical across adapters.
 */
export function capByPrimary(deals: ReadonlyArray<DealRecord>, sort: PublishedSort): DealRecord[] {
  return [...deals].sort(comparePublishedPrimary(sort)).slice(0, PUBLISHED_FETCH_CAP);
}

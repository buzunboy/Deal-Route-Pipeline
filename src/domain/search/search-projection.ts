import type { DealRecord } from '../deal-record/deal-record.js';
import type { Source } from '../source/source.js';
import type { ManualCaptureTask } from '../crawl/crawl-run.js';
import type { User } from '../auth/user.js';

/**
 * The five resources unified search can span (the frozen /api/search contract).
 */
export type SearchResource = 'candidates' | 'sources' | 'captures' | 'published' | 'users';

/** Every resource, in a stable order — the contract's `resource` enum. */
export const SEARCH_RESOURCES: readonly SearchResource[] = [
  'candidates',
  'sources',
  'captures',
  'published',
  'users',
] as const;

/** Default + hard-cap on the per-category result count (frozen contract). */
export const SEARCH_DEFAULT_LIMIT = 5;
export const SEARCH_MAX_LIMIT = 20;

/** Below this trimmed length, search short-circuits to no results with NO DB hit. */
export const SEARCH_MIN_QUERY_LENGTH = 2;

/** The permission a caller must hold for the `users` category to be searched at all. */
export const SEARCH_USERS_PERMISSION = 'team:manage' as const;

export function isSearchResource(value: string): value is SearchResource {
  return (SEARCH_RESOURCES as readonly string[]).includes(value);
}

/** One unified-search hit: the row's primary key + two display strings (contract-frozen). */
export interface SearchResultItem {
  id: string;
  title: string;
  subtitle: string;
}

/** Per-resource hit lists. A category the caller didn't request is simply absent. */
export type SearchResults = Partial<Record<SearchResource, SearchResultItem[]>>;

/**
 * Pure row → `{ id, title, subtitle }` projectors for unified search. SHARED by both
 * Database adapters so the in-memory fake and Postgres produce byte-identical hit shapes
 * (LSP). Keeping the title/subtitle rules in one place means the contract can't drift
 * between adapters.
 *
 * Surprise the contract didn't anticipate: a manual-capture task row carries NO
 * provider/service/country (only `source_url`/`reason`/`status`), so `captures` can't
 * render the contract's "service · country" subtitle — it falls back to "reason · status"
 * and searches `source_url`. Recorded in the task report.
 */

/** candidates + published share the deal projection: title=service, subtitle="provider · country". */
export function dealToSearchItem(d: DealRecord): SearchResultItem {
  return { id: d.id, title: d.service, subtitle: `${d.provider} · ${d.country}` };
}

export function sourceToSearchItem(s: Source): SearchResultItem {
  return {
    id: s.id,
    title: s.registrable_domain ?? s.url,
    subtitle: `Tier ${s.tier} · ${s.status}`,
  };
}

export function captureToSearchItem(t: ManualCaptureTask): SearchResultItem {
  return { id: t.id, title: t.source_url, subtitle: `${t.reason} · ${t.status}` };
}

export function userToSearchItem(u: User): SearchResultItem {
  return { id: u.id, title: u.name, subtitle: u.email };
}

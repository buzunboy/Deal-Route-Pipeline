/**
 * Pure query-building for Tier-4 broad discovery (Phase C, C-1). Domain logic, no
 * I/O — the use-case loads the catalog services and the registered provider/
 * bundler domains, then this turns them into the bounded open-web search query
 * set per the seed-list spec ("your services × Bundle / inklusive / gratis /
 * Aktion", "[provider] Vorteil / Partner").
 *
 * The set is BOUNDED: a big catalog must not explode the batch (each query is a
 * paid search + N fetches + N extractions). The use-case clamps to `maxQueries`.
 */
import { registrableDomain } from './links.js';

/** Service-oriented templates: how a service appears in a deal/bundle context. */
export const SERVICE_QUERY_TEMPLATES = [
  (s: string) => `${s} im Bundle`,
  (s: string) => `${s} inklusive`,
  (s: string) => `${s} gratis Aktion`,
] as const;

/** Provider-oriented templates: a provider's perk/partner pages. */
export const PROVIDER_QUERY_TEMPLATES = [
  (p: string) => `${p} Vorteil Aktion`,
  (p: string) => `${p} Partner inklusive`,
] as const;

export interface BroadQueryInput {
  /** Catalog service names (e.g. "Disney+", "Spotify Premium"). */
  services: readonly string[];
  /** Provider tokens derived from registered provider/bundler sources (e.g. "telekom"). */
  providerTokens: readonly string[];
  /** Hard cap on the number of queries a single run may issue. */
  maxQueries: number;
}

/**
 * Build the deduplicated, bounded Tier-4 query set. Service queries come first
 * (the primary discovery signal); provider queries fill remaining headroom. An
 * empty catalog yields no queries (the use-case short-circuits the run). Blank
 * service/provider entries are skipped, never producing a bare-template query.
 */
export function buildBroadQueries(input: BroadQueryInput): string[] {
  if (input.maxQueries <= 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (q: string): boolean => {
    const trimmed = q.trim();
    const key = trimmed.toLowerCase();
    if (trimmed === '' || seen.has(key)) return out.length < input.maxQueries;
    seen.add(key);
    out.push(trimmed);
    return out.length < input.maxQueries;
  };

  for (const service of input.services) {
    const s = service.trim();
    if (s === '') continue;
    for (const template of SERVICE_QUERY_TEMPLATES) {
      if (!push(template(s))) return out;
    }
  }

  for (const token of input.providerTokens) {
    const p = token.trim();
    if (p === '') continue;
    for (const template of PROVIDER_QUERY_TEMPLATES) {
      if (!push(template(p))) return out;
    }
  }

  return out;
}

/**
 * Derive a human-ish provider token from a source URL — the leading label of its
 * registrable domain (e.g. `https://www.telekom.de/...` → `telekom`). The Source
 * entity has a URL but no marketing name, so the domain is the deterministic,
 * testable signal. Returns null for an unparseable URL or a bare-eTLD domain.
 */
export function providerTokenFromUrl(url: string): string | null {
  const domain = registrableDomain(url);
  if (domain === null) return null;
  const label = domain.split('.')[0] ?? '';
  return label.length > 0 ? label : null;
}

import type { LlmExtractedDeal } from '../deal-record/index.js';
import { registrableDomain } from '../discovery/links.js';

/** Stable key segment used when a source URL can't be parsed into a domain. */
const UNKNOWN_SOURCE = 'unknown-source';

/**
 * Canonical dedupe key = service + provider + route_type + country + source origin.
 *
 * **Split-by-source.** Each *source's* report of a route becomes its own record
 * rather than collapsing across sources. Two sites describing the same Disney+ /
 * MagentaTV bundle now yield two records — we keep each source's own evidence,
 * confidence, and terms, so provenance is preserved and a reviewer compares
 * like-for-like instead of one source's claim silently masking another's.
 *
 * The discriminator is the **registrable domain** of the source URL, NOT the full
 * URL. Path/query/fragment, `www.`/bare host, and trailing-slash differences all
 * point at the *same* source and must collapse — so the same source re-crawling
 * the same route (idempotency on re-crawl / flapping URLs) stays one record. An
 * unparseable URL folds to a stable sentinel (`unknown-source`) so the key is
 * always well-formed and never throws. NB: on a *persisted* record the sentinel is
 * effectively unreachable — `deal.source_url` is pinned to `evidence.source_url`,
 * which only exists because a real HTTP fetch resolved a parseable URL; the
 * sentinel just guards the function's totality, it is not a real collapse hazard.
 *
 * Normalisation of service/provider is intentionally aggressive but pure:
 * lowercased, trimmed, internal whitespace collapsed, and common punctuation /
 * diacritics folded — so "Disney+" / "disney +" / "Disney Plus" do not split
 * into different routes by accident.
 */
export function dedupeKey(
  deal: Pick<LlmExtractedDeal, 'service' | 'provider' | 'route_type' | 'country'>,
  sourceUrl: string,
): string {
  return [
    normalizeName(deal.service),
    normalizeName(deal.provider),
    deal.route_type,
    deal.country,
    registrableDomain(sourceUrl) ?? UNKNOWN_SOURCE,
  ].join('|');
}

/** Pure name normaliser used for the dedupe key. Not for display. */
export function normalizeName(raw: string): string {
  return (
    raw
      .normalize('NFKD')
      // Strip combining diacritics (ä→a etc. after NFKD).
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/\+/g, ' plus ')
      .replace(/&/g, ' and ')
      // Collapse any non-alphanumeric run to a single space.
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ')
  );
}

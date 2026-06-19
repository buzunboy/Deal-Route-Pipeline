import type { LlmExtractedDeal } from '../deal-record/index.js';

/**
 * Canonical dedupe key = service + provider + route_type + country.
 *
 * Two candidates with the same key describe the same route; the pipeline keeps
 * the one with the best evidence/confidence and merges the rest (handled in the
 * dedupe use-case). Normalisation here is intentionally aggressive but pure:
 * lowercased, trimmed, internal whitespace collapsed, and common punctuation /
 * diacritics folded — so "Disney+" / "disney +" / "Disney Plus" do not split
 * into different routes by accident.
 */
export function dedupeKey(
  deal: Pick<LlmExtractedDeal, 'service' | 'provider' | 'route_type' | 'country'>,
): string {
  return [
    normalizeName(deal.service),
    normalizeName(deal.provider),
    deal.route_type,
    deal.country,
  ].join('|');
}

/** Pure name normaliser used for the dedupe key. Not for display. */
export function normalizeName(raw: string): string {
  return raw
    .normalize('NFKD')
    // Strip combining diacritics (ä→a etc. after NFKD).
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\+/g, ' plus ')
    .replace(/&/g, ' and ')
    // Collapse any non-alphanumeric run to a single space.
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

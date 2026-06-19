/**
 * Pure keyword helpers for Tier-3 community ingestion. The seed list specifies
 * matching "your 25 services × Bundle / inklusive / gratis / Aktion"; this builds
 * that intent vocabulary and provides a cheap pre-filter so obviously-irrelevant
 * feed items are dropped before they cost an LLM triage call.
 */

/** German + English deal-intent terms that suggest a subscription offer. */
export const DEAL_INTENT_TERMS = [
  'bundle',
  'inklusive',
  'inkl',
  'gratis',
  'kostenlos',
  'aktion',
  'deal',
  'angebot',
  'rabatt',
  'sparen',
  'abo',
  'tarif',
  'free',
  'monate',
] as const;

/**
 * Cheap relevance pre-filter: keep an item only if its text mentions one of our
 * catalog services AND a deal-intent term. Catches the firehose's obvious misses
 * (a TV deal, a phone deal) before triage, without trying to be the final judge —
 * the LLM triage call makes the real relevance decision on what survives.
 */
export function looksRelevant(text: string, catalogServices: readonly string[]): boolean {
  const hay = text.toLowerCase();
  const hasService = catalogServices.some((s) => {
    const name = s.trim().toLowerCase();
    return name.length > 0 && hay.includes(name);
  });
  if (!hasService) return false;
  return DEAL_INTENT_TERMS.some((t) => hay.includes(t));
}

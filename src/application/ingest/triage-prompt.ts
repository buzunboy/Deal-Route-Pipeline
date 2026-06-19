import { frameUntrusted } from '../../domain/index.js';
import type { FeedItem } from '../ports/index.js';

/**
 * Build the triage prompt for a community feed item (Lane B, Tier 3). Triage is a
 * cheap relevance gate BEFORE we spend a fetch+extract on the linked page: is this
 * lead plausibly a *subscription* deal for one of our catalog services? The model
 * decides keep/drop and names the matched service — it does NOT extract here.
 */
export interface TriagePromptInput {
  item: FeedItem;
  catalogServices: readonly string[];
}

const SYSTEM = `You triage deal-community feed items for DealRoute (Germany v1).

DealRoute tracks SUBSCRIPTION deals (streaming, music, telco/mobile, banking/fintech,
software subscriptions) — recurring services, bundles, and promos — for a fixed catalog
of services. You decide whether a feed item is worth fetching + extracting.

Return STRICT JSON only, no prose, no markdown fences:
{ "relevant": boolean, "service": string|null, "reason": string }

- "relevant": true ONLY if the item is plausibly a subscription/bundle/promo offer for
  one of the catalog services listed in the user message. A one-off product deal (a phone,
  a TV, groceries, hardware) is NOT relevant even if sold by a telco.
- "service": the matched catalog service name (verbatim from the list) when relevant, else null.
- "reason": one short sentence.
When unsure, prefer relevant=false — a missed lead is cheaper than a wasted extraction.`;

export function buildTriagePrompt(input: TriagePromptInput): { system: string; user: string } {
  const services = input.catalogServices.map((s) => `- ${s}`).join('\n');
  const feedItem = `Title: ${input.item.title}\nSummary: ${input.item.summary}\nLink: ${input.item.link}`;
  const user = `Catalog services (match against these):
${services}

${frameUntrusted('FEED ITEM', feedItem)}

Return STRICT JSON: { "relevant": boolean, "service": string|null, "reason": string }`;
  return { system: SYSTEM, user };
}

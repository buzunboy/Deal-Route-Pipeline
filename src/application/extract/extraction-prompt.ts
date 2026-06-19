import type { Vocabulary } from '../../domain/index.js';

/**
 * Build the system + user prompt for the extraction LLM. The prompt is data: it
 * encodes the schema contract and the trust rules so the model PROPOSES and never
 * invents. Adapters pass the result to the `Llm` port.
 */
export interface ExtractionPromptInput {
  pageText: string;
  sourceUrl: string;
  /** Optional catalog service this page is expected to cover. */
  targetService: string | null;
  vocabulary: Vocabulary;
}

const SYSTEM = `You extract subscription "deal records" from a web page for DealRoute (Germany v1).

Hard rules — follow exactly:
- You PROPOSE candidates. You never decide what gets published.
- Return STRICT JSON only: an object { "deals": [ ... ] }. Zero or more deals (a page may hold several offers, or none).
- Currency for Germany is EUR. Country is "DE".
- route_type is one of: bundle | standalone | promo | regional.
- price.billing is one of: monthly | annual | one_time | unknown. If you cannot tell, use "unknown" — do NOT guess.
- Eligibility flags (new_customer_only, residency_kyc, plan_tier_required, min_spend, stackable) are nullable. If the page does not clearly state a flag, set it to null and add a condition. NEVER guess a flag.
- Long-tail eligibility/validity conditions go into the respective "conditions" arrays. Map each to a known vocabulary key when one fits; otherwise use key "other", set unmapped_conditions=true on the deal, and add a field_proposals entry. NEVER invent a new top-level field/column.
- raw_conditions_text: copy the verbatim terms text you saw. Do not summarise it. Never drop information.
- grounding: for each key field (price, eligibility, validity) include the EXACT sentence from the page text that supports it. Quotes must be copied verbatim from the provided page text. Do not fabricate quotes.
- confidence: 0..1, your honest calibrated confidence.

If the page is a login wall, paywall, or has no offer, return { "deals": [] }.`;

export function buildExtractionPrompt(input: ExtractionPromptInput): {
  system: string;
  user: string;
} {
  const vocabList = input.vocabulary
    .map((v) => `- ${v.key}: ${v.label}`)
    .join('\n');

  const target =
    input.targetService !== null
      ? `Target subscription for this page (verify it actually appears): ${input.targetService}\n`
      : 'No specific target subscription; extract any subscription offers present.\n';

  const user = `Source URL: ${input.sourceUrl}
${target}
Known condition vocabulary keys (map conditions to these when they fit):
${vocabList}

PAGE TEXT (extract only from this; quotes must be verbatim substrings of it):
"""
${input.pageText}
"""

Return STRICT JSON: { "deals": [ <deal>, ... ] } following the DealRoute schema.`;

  return { system: SYSTEM, user };
}

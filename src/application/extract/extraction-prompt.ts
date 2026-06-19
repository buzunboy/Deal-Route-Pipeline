import { frameUntrusted, type Vocabulary } from '../../domain/index.js';

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

You PROPOSE candidates; you never decide what gets published.
Return STRICT JSON ONLY — a single object { "deals": [ ... ] } — with NO markdown fences and NO prose before or after. Zero or more deals (a page may hold several offers, or none).

Each deal MUST use EXACTLY these field names and shapes (do not rename, omit, or add top-level fields):
{
  "service": string,                      // the subscription service, e.g. "Spotify Premium"
  "route_type": "bundle" | "standalone" | "promo" | "regional",
  "provider": string,                     // who offers it, e.g. "Spotify"
  "headline": string,                     // a short human title for the offer
  "price": { "amount": number, "currency": "EUR", "billing": "monthly" | "annual" | "one_time" | "unknown" },
  "country": "DE",
  "eligibility": {
    "new_customer_only": boolean | null,
    "residency_kyc": boolean | null,
    "plan_tier_required": string | null,
    "min_spend": number | null,
    "stackable": boolean | null,
    "conditions": [ { "key": string, "label": string, "source_quote": string, "value"?: object } ]
  },
  "validity": {
    "start": string | null,               // ISO-8601 date "YYYY-MM-DD" or null if not stated
    "end": string | null,                 // ISO-8601 date or null for open-ended
    "recheck_days": number,               // how often to re-verify; default 3
    "conditions": [ { "key": string, "label": string, "source_quote": string, "value"?: object } ]
  },
  "included_items": [ string ],
  "attributes": { },                      // free-form extras that don't fit above; never drop info
  "raw_conditions_text": string,          // verbatim terms text, not summarised
  "source_url": string,                   // the source URL given below
  "confidence": number,                   // 0..1, honestly calibrated
  "grounding": [ { "field": "price" | "eligibility" | "validity" | string, "quote": string } ],
  "unmapped_conditions": boolean,
  "field_proposals": [ { "suggested_key": string, "label": string, "rationale": string, "example_quote": string } ]
}

Hard rules — follow exactly:
- Currency for Germany is EUR; country is "DE".
- price.billing: if you cannot tell, use "unknown" — do NOT guess.
- Eligibility flags are nullable: if the page doesn't clearly state one, set it to null and add a condition. NEVER guess a flag.
- "grounding" is an ARRAY of { "field", "quote" } objects (NOT an object keyed by field name). Include one entry each for price, eligibility, and validity, with the EXACT verbatim sentence from the page text. Quotes must be verbatim substrings of the page text — never fabricated.
- Long-tail conditions go in the eligibility/validity "conditions" arrays. Map each to a known vocabulary key when one fits; otherwise use key "other", set unmapped_conditions=true, and add a "field_proposals" entry with EXACTLY { "suggested_key", "label", "rationale", "example_quote" }. NEVER invent a new top-level field/column.
- "raw_conditions_text": copy the verbatim terms text. Do not summarise. Never drop information.

If the page is a login wall, paywall, error page, or has no offer, return { "deals": [] } and nothing else.`;

export function buildExtractionPrompt(input: ExtractionPromptInput): {
  system: string;
  user: string;
} {
  const vocabList = input.vocabulary.map((v) => `- ${v.key}: ${v.label}`).join('\n');

  const target =
    input.targetService !== null
      ? `Target subscription for this page (verify it actually appears): ${input.targetService}\n`
      : 'No specific target subscription; extract any subscription offers present.\n';

  const user = `Source URL: ${input.sourceUrl}
${target}
Known condition vocabulary keys (map conditions to these when they fit):
${vocabList}

Extract only from the PAGE TEXT below; quotes must be verbatim substrings of it.
${frameUntrusted('PAGE TEXT', input.pageText)}

Return STRICT JSON: { "deals": [ <deal>, ... ] } following the DealRoute schema.`;

  return { system: SYSTEM, user };
}

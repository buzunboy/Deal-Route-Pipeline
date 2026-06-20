/**
 * Bound the page text sent to the extraction LLM so a huge page can't exceed the
 * model's context window and crash the call.
 *
 * The fetcher caps the response in BYTES (16 MB), but that's far larger than a
 * model context: a 16 MB page is ~4M chars ≈ ~1M tokens, well past the ~200k-token
 * limit — a live test hit exactly this on a very large aggregator page (the LLM
 * rejected the request with `prompt is too long`). So we additionally cap the page
 * text in CHARACTERS here, before it becomes the prompt.
 *
 * Budget: the model context (~200k tokens) must hold the system prompt + vocab +
 * JSON instructions + the page text + room for the JSON output. ~30k tokens of
 * page text (≈ MAX_EXTRACTION_INPUT_CHARS / ~4 chars-per-token) leaves generous
 * headroom while still covering any real offer page we've seen (the richest real
 * bundler page was an order of magnitude under this). Deliberately conservative:
 * over-trimming a giant page is safe (extraction still runs + is flagged), whereas
 * over-shooting the context is a hard crash.
 *
 * When the text is trimmed the caller MUST treat the extraction as lower-trust
 * (force must-review): a record extracted from a partial page may miss conditions
 * or the real price further down. We never silently trust a truncated page.
 */
export const MAX_EXTRACTION_INPUT_CHARS = 120_000;

export interface BoundedExtractionInput {
  /** The page text, trimmed to the cap if it was over-long. */
  text: string;
  /** True when the input was over the cap and got trimmed (→ force review). */
  truncated: boolean;
}

/**
 * Trim page text to {@link MAX_EXTRACTION_INPUT_CHARS}. Pure + deterministic. Cuts
 * at the cap and appends a visible marker so the model knows the page was cut (it
 * won't treat the truncation point as the end of the offer). Returns `truncated`
 * so the use-case can force review on a partial page.
 */
export function boundExtractionInput(pageText: string): BoundedExtractionInput {
  if (pageText.length <= MAX_EXTRACTION_INPUT_CHARS) {
    return { text: pageText, truncated: false };
  }
  const head = pageText.slice(0, MAX_EXTRACTION_INPUT_CHARS);
  return {
    text: `${head}\n\n[…PAGE TEXT TRUNCATED — exceeded the extraction input limit…]`,
    truncated: true,
  };
}

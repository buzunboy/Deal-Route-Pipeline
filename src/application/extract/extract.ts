import {
  parseLlmDeals,
  mapConditions,
  validateRecord,
  adjustConfidence,
  mustReview,
  trueCostMonthly,
  dedupeKey,
  CURRENT_SCHEMA_VERSION,
  boundExtractionInput,
  MAX_EXTRACTION_INPUT_CHARS,
  type BoundedExtractionInput,
  type LlmExtractedDeal,
  type Vocabulary,
  type RuleFailure,
  type FieldProposal,
  type SuffixOracle,
} from '../../domain/index.js';
import type { Llm, Logger } from '../ports/index.js';
import { buildExtractionPrompt } from './extraction-prompt.js';

/**
 * Corrective suffix appended to the prompt on the single re-ask after a first
 * reply failed to parse/validate. Keeps the same task + schema (no new freedom for
 * the model) — it only insists on a complete, valid JSON object and warns against
 * the common truncation cause (over-long verbatim text). The retry is still parsed
 * through the same boundary, so this can only help the model comply, never relax it.
 */
const RETRY_CORRECTION =
  'IMPORTANT: your previous reply could not be parsed as valid JSON matching the required schema. ' +
  'Return ONLY a single complete, valid JSON object exactly matching the schema above — no prose, ' +
  'no markdown fences, no trailing commentary. Ensure it is not truncated: keep verbatim quotes ' +
  '(grounding, raw_conditions_text, source_quote) concise enough that the whole object fits.';

export interface ExtractInput {
  pageText: string;
  sourceUrl: string;
  targetService: string | null;
  vocabulary: Vocabulary;
}

/**
 * One extracted candidate before persistence: the validated deal plus the
 * derived pipeline metadata (true cost, dedupe key, review decision, the
 * failures behind that decision, and the proposals to record).
 */
export interface ExtractedCandidate {
  deal: LlmExtractedDeal;
  trueCostMonthly: number;
  dedupeKey: string;
  schemaVersion: number;
  /**
   * The registrable domain (eTLD+1) of the trusted fetched source URL, resolved
   * once here via the real PSL (Step 6) and pinned onto the persisted deal. The
   * dedupe key was built from THIS exact value, so the recompute-from-row key
   * matches. Null when the host has no registrable domain.
   */
  sourceRegistrableDomain: string | null;
  adjustedConfidence: number;
  mustReview: boolean;
  failures: RuleFailure[];
  fieldProposals: FieldProposal[];
}

export interface ExtractResult {
  candidates: ExtractedCandidate[];
  costEur: number;
}

/**
 * Thrown when extraction fails AFTER the (paid) LLM call — e.g. the boundary
 * rejects malformed/injected output. Carries the cost ALREADY INCURRED so the
 * caller can still charge it against the run/daily budget; otherwise a stream of
 * failed extractions on attacker-influenceable open-web pages would spend real
 * money the budget never sees (Tier-4 broad discovery especially). The `cause`
 * is the original boundary/processing error.
 */
export class ExtractionFailedError extends Error {
  constructor(
    readonly costEur: number,
    options?: { cause?: unknown },
  ) {
    const causeMsg =
      options?.cause instanceof Error ? options.cause.message : String(options?.cause ?? 'unknown');
    super(`Extraction failed after the LLM call (cost €${costEur} still incurred): ${causeMsg}`, {
      cause: options?.cause,
    });
    this.name = 'ExtractionFailedError';
  }
}

/**
 * The LLM extraction core (Lane A): page text → validated candidate deal records.
 *
 * Pure orchestration over the `Llm` port + domain rules. It NEVER trusts raw LLM
 * output: it parses through the boundary schema, maps conditions to the
 * controlled vocabulary (unknown → proposal, never a new column), runs sanity +
 * grounding validation against the page text, then deterministically downgrades
 * confidence and decides must-review. Persistence and evidence are the caller's.
 */
export class ExtractUseCase {
  constructor(
    private readonly llm: Llm,
    private readonly logger: Logger,
    private readonly suffixOracle: SuffixOracle,
  ) {}

  async execute(input: ExtractInput): Promise<ExtractResult> {
    // Bound the page text BEFORE it becomes the prompt: a page can be huge (the
    // fetcher only caps bytes), and an over-long prompt exceeds the model context
    // and hard-fails the call (seen live on a giant aggregator page). A trimmed
    // page is extracted but flagged lower-trust (forces must-review) — never
    // silently trusted, since the real price/conditions might be past the cut.
    const bounded = boundExtractionInput(input.pageText);
    if (bounded.truncated) {
      this.logger.warn('extraction input exceeded the size cap; page text trimmed', {
        sourceUrl: input.sourceUrl,
        originalChars: input.pageText.length,
        cappedChars: MAX_EXTRACTION_INPUT_CHARS,
      });
    }
    const { system, user } = buildExtractionPrompt({
      pageText: bounded.text,
      sourceUrl: input.sourceUrl,
      targetService: input.targetService,
      vocabulary: input.vocabulary,
    });

    const first = await this.llm.complete({ role: 'extraction', system, user, jsonMode: true });
    // Cost is incurred the moment the LLM call returns — accumulate it NOW so a later
    // boundary/processing throw (or a retry) still surfaces the full spend to the
    // caller (budget accounting). The LLM adapter already runs the reply through
    // json-recovery, so `parseLlmDeals` failing here means the JSON was unrecoverable
    // (severe truncation) or the SHAPE was wrong — neither of which local repair fixes.
    let costEur = first.usage.costEur;

    if (first.truncated) {
      this.logger.warn('extraction LLM reply was truncated at the token limit', {
        sourceUrl: input.sourceUrl,
        outputTokens: first.usage.outputTokens,
      });
    }

    const firstParse = this.tryParse(first.text);
    if (firstParse.ok) {
      return this.finish(firstParse.deals, input, bounded, costEur);
    }

    // The first reply was unparseable/wrong-shape (truncation past recovery, or a
    // schema mismatch). Re-ask ONCE with a corrective nudge before giving up — one
    // bad reply shouldn't discard a whole page. The retry's output goes through the
    // SAME boundary (parseLlmDeals/zod): repair/retry never weakens trust validation.
    this.logger.warn('extraction parse failed; re-asking the model once', {
      sourceUrl: input.sourceUrl,
      reason: firstParse.error.message,
      truncated: first.truncated,
    });
    const retry = await this.llm.complete({
      role: 'extraction',
      system,
      user: `${user}\n\n${RETRY_CORRECTION}`,
      jsonMode: true,
    });
    costEur += retry.usage.costEur; // both calls are billed — charge the full spend.

    const retryParse = this.tryParse(retry.text);
    if (!retryParse.ok) {
      // Both attempts failed: throw carrying the TOTAL spent cost so the run/daily
      // budget sees every paid call (not just the first).
      throw new ExtractionFailedError(costEur, { cause: retryParse.error });
    }
    this.logger.info('extraction recovered on re-ask', { sourceUrl: input.sourceUrl });
    return this.finish(retryParse.deals, input, bounded, costEur);
  }

  /** Parse raw model text through the trust boundary; never throws (returns a result). */
  private tryParse(
    text: string,
  ): { ok: true; deals: LlmExtractedDeal[] } | { ok: false; error: Error } {
    try {
      return { ok: true, deals: parseLlmDeals(text) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
    }
  }

  /** Map validated deals → candidates, log, and return. Shared by the first/retry paths. */
  private finish(
    rawDeals: LlmExtractedDeal[],
    input: ExtractInput,
    bounded: BoundedExtractionInput,
    costEur: number,
  ): ExtractResult {
    const candidates = rawDeals.map((deal) =>
      // Validate grounding against the SAME (bounded) text the LLM saw — a quote
      // from a trimmed tail must not falsely fail; the truncation itself is flagged.
      this.processDeal(deal, bounded, input.vocabulary, input.sourceUrl),
    );
    this.logger.info('extraction complete', {
      sourceUrl: input.sourceUrl,
      deals: candidates.length,
      mustReview: candidates.filter((c) => c.mustReview).length,
      costEur,
    });
    return { candidates, costEur };
  }

  private processDeal(
    rawDeal: LlmExtractedDeal,
    bounded: BoundedExtractionInput,
    vocabulary: Vocabulary,
    sourceUrl: string,
  ): ExtractedCandidate {
    // Canonicalise long-tail conditions; collect proposals for unknown ones.
    const eligibilityMapped = mapConditions(rawDeal.eligibility.conditions, vocabulary);
    const validityMapped = mapConditions(rawDeal.validity.conditions, vocabulary);

    const mergedProposals = dedupeProposals([
      ...rawDeal.field_proposals,
      ...eligibilityMapped.fieldProposals,
      ...validityMapped.fieldProposals,
    ]);

    const deal: LlmExtractedDeal = {
      ...rawDeal,
      eligibility: { ...rawDeal.eligibility, conditions: eligibilityMapped.conditions },
      validity: { ...rawDeal.validity, conditions: validityMapped.conditions },
      unmapped_conditions:
        rawDeal.unmapped_conditions ||
        eligibilityMapped.unmappedConditions ||
        validityMapped.unmappedConditions,
      field_proposals: mergedProposals,
    };

    // Sanity + grounding validation against the (bounded) text the LLM actually saw.
    const validation = validateRecord(deal, bounded.text);
    // A trimmed page is lower-trust: add a rule failure so it flows through the
    // SAME confidence-downgrade + must-review machinery (the price/conditions past
    // the cut may be missing). Never silently trust a record from a partial page.
    const failures = bounded.truncated
      ? [
          ...validation.failures,
          {
            rule: 'extraction_input_truncated',
            message:
              'Page text exceeded the extraction input cap and was trimmed; the offer may be incomplete. ' +
              'A human must confirm against the full page before this deal can rank or publish.',
          },
        ]
      : validation.failures;
    const adjusted = adjustConfidence(deal, failures.length);
    const review = mustReview(adjusted, failures.length);

    // Resolve the registrable domain ONCE, from the TRUSTED fetched source URL
    // (input.sourceUrl), via the real PSL (Step 6). Pin it onto the candidate and
    // build the dedupe key from it — the key's source-origin segment must come from
    // provenance we control, not the LLM-supplied deal.source_url. CandidateSink
    // pins the persisted deal.source_url + source_registrable_domain to this same
    // fetched URL, so the recompute-from-row key matches this extract-time key.
    const sourceRegistrableDomain = this.suffixOracle(sourceUrl);
    return {
      deal: { ...deal, confidence: adjusted },
      trueCostMonthly: trueCostMonthly(deal.price),
      dedupeKey: dedupeKey(deal, sourceRegistrableDomain),
      sourceRegistrableDomain,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      adjustedConfidence: adjusted,
      mustReview: review,
      failures,
      fieldProposals: mergedProposals,
    };
  }
}

function dedupeProposals(proposals: FieldProposal[]): FieldProposal[] {
  const byKey = new Map<string, FieldProposal>();
  for (const p of proposals) {
    if (!byKey.has(p.suggested_key)) byKey.set(p.suggested_key, p);
  }
  return [...byKey.values()];
}

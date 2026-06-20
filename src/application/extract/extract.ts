import {
  parseLlmDeals,
  mapConditions,
  validateRecord,
  adjustConfidence,
  mustReview,
  trueCostMonthly,
  dedupeKey,
  CURRENT_SCHEMA_VERSION,
  type LlmExtractedDeal,
  type Vocabulary,
  type RuleFailure,
  type FieldProposal,
} from '../../domain/index.js';
import type { Llm, Logger } from '../ports/index.js';
import { buildExtractionPrompt } from './extraction-prompt.js';

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
  ) {}

  async execute(input: ExtractInput): Promise<ExtractResult> {
    const { system, user } = buildExtractionPrompt({
      pageText: input.pageText,
      sourceUrl: input.sourceUrl,
      targetService: input.targetService,
      vocabulary: input.vocabulary,
    });

    const response = await this.llm.complete({ role: 'extraction', system, user, jsonMode: true });
    // Cost is incurred the moment the LLM call returns — capture it NOW so a later
    // boundary/processing throw still surfaces it to the caller (budget accounting).
    const costEur = response.usage.costEur;

    // A reply truncated at the output-token cap is usually invalid JSON that the
    // boundary then rejects — which would otherwise look like a silent "this page
    // had no offers". Surface it loudly so the zero/partial-candidate outcome is
    // attributable to truncation (raise LLM_MAX_OUTPUT_TOKENS), not a real miss.
    if (response.truncated) {
      this.logger.warn('extraction LLM reply was truncated at the token limit', {
        sourceUrl: input.sourceUrl,
        outputTokens: response.usage.outputTokens,
      });
    }

    let candidates: ExtractedCandidate[];
    try {
      // Boundary: raw model text → typed deals (throws BoundaryValidationError on bad shape).
      const rawDeals = parseLlmDeals(response.text);
      candidates = rawDeals.map((deal) => this.processDeal(deal, input.pageText, input.vocabulary));
    } catch (err) {
      // Re-throw carrying the already-spent cost so the run/daily budget still sees it.
      throw new ExtractionFailedError(costEur, { cause: err });
    }

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
    pageText: string,
    vocabulary: Vocabulary,
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

    // Sanity + grounding validation against the actual page text (hallucination guard).
    const validation = validateRecord(deal, pageText);
    const adjusted = adjustConfidence(deal, validation.failures.length);
    const review = mustReview(adjusted, validation.failures.length);

    return {
      deal: { ...deal, confidence: adjusted },
      trueCostMonthly: trueCostMonthly(deal.price),
      dedupeKey: dedupeKey(deal),
      schemaVersion: CURRENT_SCHEMA_VERSION,
      adjustedConfidence: adjusted,
      mustReview: review,
      failures: validation.failures,
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

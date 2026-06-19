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

    // Boundary: raw model text → typed deals (throws BoundaryValidationError on bad shape).
    const rawDeals = parseLlmDeals(response.text);

    const candidates = rawDeals.map((deal) =>
      this.processDeal(deal, input.pageText, input.vocabulary),
    );

    this.logger.info('extraction complete', {
      sourceUrl: input.sourceUrl,
      deals: candidates.length,
      mustReview: candidates.filter((c) => c.mustReview).length,
      costEur: response.usage.costEur,
    });

    return { candidates, costEur: response.usage.costEur };
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

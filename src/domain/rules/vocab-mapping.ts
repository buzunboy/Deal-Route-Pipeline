import { z } from 'zod';
import { OTHER_CONDITION_KEY, type Condition } from '../deal-record/condition.js';
import type { FieldProposal } from '../deal-record/grounding.js';

/**
 * A controlled-vocabulary entry for a condition key. The vocabulary is data, not
 * code: new keys are added by promoting recurring `field_proposals` (see the
 * `promote-field-proposal` skill), never by editing this logic. `version` lets a
 * promoted key be re-parsed from `raw_conditions_text` later.
 */
export const VocabularyEntrySchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  /** Optional aliases the LLM might emit that should map to this key. */
  aliases: z.array(z.string()).default([]),
  version: z.number().int().positive().default(1),
});
export type VocabularyEntry = z.infer<typeof VocabularyEntrySchema>;

export type Vocabulary = readonly VocabularyEntry[];

export interface MappedConditions {
  /** Conditions with their `key`/`label` normalised to canonical vocabulary. */
  conditions: Condition[];
  /** True if any condition could not be mapped (became `key: "other"`). */
  unmappedConditions: boolean;
  /** One proposal per genuinely-unmapped condition (deduped by suggested_key). */
  fieldProposals: FieldProposal[];
}

/**
 * Map a list of raw conditions against the vocabulary.
 *
 * Pure. For each condition:
 *  - if its key (or an alias) matches a vocabulary entry → canonicalise key+label;
 *  - otherwise → set `key: "other"`, mark `unmappedConditions`, and emit a
 *    `field_proposal`. The LLM never invents a column; ingestion is never blocked.
 *
 * Matching is case-insensitive on a normalised key form. The original
 * `source_quote` and `value` are always preserved — information is never dropped.
 */
export function mapConditions(raw: readonly Condition[], vocabulary: Vocabulary): MappedConditions {
  const index = buildIndex(vocabulary);
  const conditions: Condition[] = [];
  const proposalsByKey = new Map<string, FieldProposal>();
  let unmapped = false;

  for (const condition of raw) {
    const entry = index.get(normalizeKey(condition.key));
    if (entry) {
      conditions.push({ ...condition, key: entry.key, label: entry.label });
      continue;
    }

    unmapped = true;
    const suggestedKey = normalizeKey(condition.key) || OTHER_CONDITION_KEY;
    conditions.push({ ...condition, key: OTHER_CONDITION_KEY });

    if (!proposalsByKey.has(suggestedKey)) {
      proposalsByKey.set(suggestedKey, {
        suggested_key: suggestedKey,
        label: condition.label,
        rationale: 'Condition emitted by extractor has no matching vocabulary key.',
        example_quote: condition.source_quote,
      });
    }
  }

  return {
    conditions,
    unmappedConditions: unmapped,
    fieldProposals: [...proposalsByKey.values()],
  };
}

function buildIndex(vocabulary: Vocabulary): Map<string, VocabularyEntry> {
  const index = new Map<string, VocabularyEntry>();
  for (const entry of vocabulary) {
    index.set(normalizeKey(entry.key), entry);
    for (const alias of entry.aliases) {
      index.set(normalizeKey(alias), entry);
    }
  }
  return index;
}

/** Normalise a key/alias for matching: lowercase, non-alphanumerics → underscore. */
export function normalizeKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

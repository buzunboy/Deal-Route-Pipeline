---
name: promote-field-proposal
description: Promote a recurring LLM field_proposal into a canonical condition_vocabulary key (or a first-class field) and migrate safely.
---

# Promote a field proposal

Use when a `field_proposals` entry has recurred past the threshold and should become canonical.

1. **Review** the proposal's frequency and example quotes in `field_proposals`.
2. **Decide the canonical form:** a new **`condition_vocabulary`** key (most cases) or — only if you filter/rank on it — a typed core field.
3. **Add it:** the vocabulary key (label + version) or the core column (with a migration). Bump `schema_version`.
4. **Update the extractor** mapping/prompt so future extractions use the new key instead of `key:"other"`.
5. **Backfill / re-parse** existing records from `raw_conditions_text` / `conditions[]` where they match — don't lose data.
6. **Add/adjust golden fixtures + tests** so the new mapping is covered.
7. **Mark** the `field_proposals` entries resolved.

Never silently change the meaning of an existing key — prefer a new key + migration.

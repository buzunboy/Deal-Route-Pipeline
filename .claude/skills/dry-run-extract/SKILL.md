---
name: dry-run-extract
description: Fetch a single URL and run extraction in dry-run (no writes) to inspect the candidate deal record(s) — fields, conditions, grounding, evidence, confidence.
---

# Dry-run extract

Use to test extraction on a URL without touching the database.

1. Run the dry-run command (see `CLAUDE.md` → Commands; e.g. `<run> dry-run-extract <URL>`).
2. It should fetch (text + screenshot + HTML), run the extractor, and print the candidate deal record(s) + captured evidence references — **no DB writes**.
3. Check against `.claude/rules/extraction-and-schema.md`: typed-core fields correct; long-tail in `conditions[]` / `attributes`; `raw_conditions_text` kept; a **grounding** quote per key field that actually supports it; unknown conditions emitted as `field_proposals` (not invented fields); confidence sensible.
4. If a real page breaks extraction, **save it as a golden fixture** with the corrected expected output (so it's covered by tests).

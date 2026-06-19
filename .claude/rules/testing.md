# Testing (always applies)

- **Pure logic = unit tested.** Extraction mapping, validation, dedupe key, true-cost, vocabulary mapping, confidence — table-driven tests.
- **Adapter contract tests.** Each adapter must pass a shared contract suite for its port, so any implementation is substitutable.
- **Golden-file extraction tests.** Saved HTML fixtures → expected deal records; assert fields, grounding presence, and **no hallucinated values**. Add a fixture whenever a real page breaks extraction.
- **Deterministic dry-run.** A no-write path that fetches + extracts + prints the candidate record; used in tests and by the `dry-run-extract` skill.
- **Coverage philosophy:** cover the domain and the trust-critical paths, not a vanity %. The worst-case bug is one that lets a *wrong* deal publish — test explicitly against it.
- **CI:** tests + lint + type-check must pass before merge.

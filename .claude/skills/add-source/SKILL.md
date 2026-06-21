---
name: add-source
description: Add a new crawl source to the DealRoute pipeline (provider, bundler, community, or discovered domain) with the right tier, cadence, and a golden fixture.
---

# Add a source

Use when adding a new website/source to crawl.

1. **Register it** in the sources registry/seed config (tiers are in `docs/DealRoute_Seed_List_DE.md`): set `url`, `type`, `tier` (1 provider · 2 bundler · 3 community · 4 discovered), default `cadence` (3 days unless promo/community), and an initial `reliability_score`.
2. **Confirm the fetcher handles it** — static vs JS/anti-bot (→ stealth / real-browser adapter). Best-effort-read (2026-06-21): a robots-disallowed or login-walled source is fine — it's read best-effort (login/soft-block → `ok`+`fetchSignal`, candidate stays must-review). Only a pure `captcha`-gated source belongs in the **manual-capture** flow instead.
3. **Add a golden fixture**: save a representative HTML snapshot under the test fixtures plus the expected deal record(s), per `.claude/rules/extraction-and-schema.md`.
4. **Dry-run** the source (see the `dry-run-extract` skill) and confirm the candidate(s) look right — fields, grounding, evidence.
5. **Tier-4 (discovered) domains** must pass the human-approval step before joining the deterministic crawl.
6. Per-domain rate limits ALWAYS apply. `robots.txt` is OPT-IN (`RESPECT_ROBOTS_TXT=true`); under the default best-effort-read policy it's ignored — mind the ToS/legal exposure that implies.

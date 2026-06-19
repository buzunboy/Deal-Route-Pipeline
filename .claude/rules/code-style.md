# Code style & quality (always applies)

- **Strong typing everywhere.** TS `strict` or Python type hints + a type checker. No `any`/untyped escapes in business logic.
- **Boundary validation.** Parse all external input (LLM output, scraped data, API requests) through a schema (zod/pydantic) into typed objects **before use**. Never trust raw data.
- **Small, single-purpose functions**; intention-revealing names; no dead code; no magic numbers (named constants / config).
- **Errors:** typed/domain errors, fail loudly with context, no empty catches. Wrap external calls with timeouts + retries.
- **No hidden state.** Dependencies are passed in (DI), not reached for via globals/singletons.
- **Comments earn their place** — document public interfaces and non-obvious decisions; make the code self-explanatory instead of narrating it.
- **Formatting + linting + type-checking** run in CI and a pre-commit hook (e.g. eslint+prettier+tsc, or ruff+black+mypy). CI must be green to merge.
- **Commits:** small, reviewable, conventional messages.
- **Config & secrets** via env only; never commit secrets. This service has its own `.env` (separate from the landing/admin repos).

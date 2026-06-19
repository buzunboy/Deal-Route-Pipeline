# Architecture & SOLID (always applies)

Long-lived, trust-critical service. Favour clear over clever.

## Layering (clean architecture)
- **domain** — deal records, conditions, pure rules (true-cost, dedupe key, vocab mapping, validation). No framework or vendor imports.
- **application** — use-cases orchestrating domain + ports: crawl, extract, validate, dedupe, capture-evidence, monitor, review.
- **adapters/infrastructure** — concrete implementations of ports: fetcher, browser-agent, LLM, DB, evidence store, queue, HTTP/CLI.
- Dependencies point **inward** only. The domain knows nothing about adapters or vendors.

## Ports & adapters (DIP)
- Define **interfaces (ports)** in application/domain: `Fetcher`, `BrowserAgent`, `Llm`, `EvidenceStore`, `Database`, `Queue`.
- Concrete vendors (Firecrawl, Crawl4AI, Playwright, Browser Use, Stagehand, model providers, S3/R2, Postgres) are **adapters** behind those ports, injected from **one composition root** built from config. No `new VendorClient()` in business logic; no hidden singletons.

## SOLID, concretely
- **SRP** — one reason to change per module; no god-objects or `utils` dumping grounds.
- **OCP** — add a new source type, model, or condition rule **without editing existing logic** (strategy/registry, not `if vendor == …`).
- **LSP** — every adapter is fully substitutable behind its port.
- **ISP** — small, focused interfaces (don't force a scraper to implement agent methods).
- **DIP** — depend on ports, not concretions.

## Purity & resilience
- Business rules are **pure, unit-tested functions**; all I/O lives in adapters.
- Every external call is **timeout-bounded**, **retried with backoff**, and **idempotent**. A failed source/run is logged with context and never crashes the batch.
- Typed/domain errors; no silent catches.

## Adding things must NOT require editing existing code
- New source → registry/config (+ a fetch strategy if needed).
- New model/vendor → a new adapter implementing the port + its contract tests.
- New condition → a vocabulary entry; never a new column without promotion (see `extraction-and-schema.md`).

Keep a root **`ARCHITECTURE.md`** explaining the layers, the ports/adapters, and exactly how to add a source/model/condition.

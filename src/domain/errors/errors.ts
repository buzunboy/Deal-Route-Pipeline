/**
 * Typed domain errors. Business code fails loudly with context — no silent
 * catches, no bare `throw new Error('...')` in the domain (`code-style.md`).
 */

/** Base class so callers can `instanceof DomainError` to distinguish ours. */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(
    message: string,
    readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Raw external data (LLM output, scraped page, API request) failed schema
 * parsing at the boundary. Carries the offending issues for logging/review.
 */
export class BoundaryValidationError extends DomainError {
  readonly code = 'BOUNDARY_VALIDATION';

  constructor(
    message: string,
    readonly issues: readonly { path: string; message: string }[],
    context?: Record<string, unknown>,
  ) {
    super(message, context);
  }
}

/**
 * A record parsed structurally but failed a domain sanity rule (bad currency for
 * country, impossible price, invalid date range, ungrounded field, …). These do
 * NOT crash the batch — they downgrade the record to must-review.
 */
export class SanityRuleError extends DomainError {
  readonly code = 'SANITY_RULE';

  constructor(
    readonly rule: string,
    message: string,
    context?: Record<string, unknown>,
  ) {
    super(message, context);
  }
}

/** A value object was constructed with an invalid invariant. */
export class InvariantViolation extends DomainError {
  readonly code = 'INVARIANT_VIOLATION';
}

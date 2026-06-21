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

/** The requested deal does not exist. Maps to HTTP 404 at the API boundary. */
export class DealNotFoundError extends DomainError {
  readonly code = 'DEAL_NOT_FOUND';

  constructor(readonly dealId: string) {
    super(`Deal not found: ${dealId}`);
  }
}

/**
 * A review action was attempted on a deal that is not in a reviewable state
 * (already published/expired/rejected). Maps to HTTP 409 (conflict) — re-deciding
 * a terminal deal is a client error, not a server fault.
 */
export class NotReviewableError extends DomainError {
  readonly code = 'NOT_REVIEWABLE';

  constructor(
    readonly dealId: string,
    readonly status: string,
  ) {
    super(`Deal ${dealId} is not reviewable (status: ${status}).`);
  }
}

/** A required actor identity (e.g. approver) was missing or empty. Maps to 400. */
export class MissingApproverError extends DomainError {
  readonly code = 'MISSING_APPROVER';

  constructor(action: string) {
    super(`${action} requires a non-empty approver identity.`);
  }
}

/** The requested source does not exist. Maps to HTTP 404. */
export class SourceNotFoundError extends DomainError {
  readonly code = 'SOURCE_NOT_FOUND';

  constructor(readonly sourceId: string) {
    super(`Source not found: ${sourceId}`);
  }
}

/**
 * A source-promotion action was attempted on a source that isn't awaiting review
 * (not `pending_approval`). Maps to HTTP 409 (conflict).
 */
export class SourceNotReviewableError extends DomainError {
  readonly code = 'SOURCE_NOT_REVIEWABLE';

  constructor(
    readonly sourceId: string,
    readonly status: string,
  ) {
    super(`Source ${sourceId} is not awaiting approval (status: ${status}).`);
  }
}

/**
 * A reviewer patch tried to change a field that is NOT reviewer-correctable
 * (identity/provenance/lifecycle: `id`, `evidence_id`, `source_url`, `status`,
 * `schema_version`, …) or supplied a structurally invalid patch. Maps to HTTP 400 —
 * the human may correct extracted values, never rewrite provenance or force a
 * lifecycle transition outside the audited approve/reject path.
 */
export class InvalidPatchError extends DomainError {
  readonly code = 'INVALID_PATCH';

  constructor(
    message: string,
    readonly fields: readonly string[] = [],
  ) {
    super(message, { fields });
  }
}

/** The requested field proposal (by `suggested_key`) does not exist. Maps to 404. */
export class FieldProposalNotFoundError extends DomainError {
  readonly code = 'FIELD_PROPOSAL_NOT_FOUND';

  constructor(readonly suggestedKey: string) {
    super(`Field proposal not found: ${suggestedKey}`);
  }
}

/**
 * Field-proposal promotion to a first-class typed COLUMN (`target: "field"`) was
 * requested. v1 supports promotion to the `condition_vocabulary` only; a new column
 * needs a schema migration (deferred — see KNOWN_ISSUES). Maps to HTTP 400.
 */
export class PromotionTargetNotSupportedError extends DomainError {
  readonly code = 'PROMOTION_TARGET_NOT_SUPPORTED';

  constructor(readonly target: string) {
    super(
      `Promotion target "${target}" is not supported in v1 (only "vocabulary"). ` +
        `Promoting a proposal to a first-class column requires a schema migration.`,
    );
  }
}

/** The requested manual-capture task does not exist. Maps to HTTP 404. */
export class ManualCaptureTaskNotFoundError extends DomainError {
  readonly code = 'MANUAL_CAPTURE_TASK_NOT_FOUND';

  constructor(readonly taskId: string) {
    super(`Manual-capture task not found: ${taskId}`);
  }
}

/**
 * A complete/close action was attempted on a manual-capture task that is no longer
 * open (already `done`/`skipped`). Maps to HTTP 409 (conflict) — completing a task
 * twice would mint a second candidate from one capture.
 */
export class ManualCaptureTaskNotOpenError extends DomainError {
  readonly code = 'MANUAL_CAPTURE_TASK_NOT_OPEN';

  constructor(
    readonly taskId: string,
    readonly status: string,
  ) {
    super(`Manual-capture task ${taskId} is not open (status: ${status}).`);
  }
}

/**
 * A manual capture was submitted without complete evidence — a missing or empty
 * screenshot reference / HTML / terms text / source URL. Maps to HTTP 400. The
 * evidence-required invariant has no exception for hand-captured deals: no
 * candidate exists without a loadable evidence bundle behind it.
 */
export class EvidenceIncompleteError extends DomainError {
  readonly code = 'EVIDENCE_INCOMPLETE';

  constructor(readonly missing: readonly string[]) {
    super(`Manual capture is missing required evidence: ${missing.join(', ')}.`, { missing });
  }
}

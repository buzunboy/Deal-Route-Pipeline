import type { ReviewRecord, ReviewAction } from './review-record.js';

/**
 * A review audit row enriched with the decided deal's human-readable label fields
 * ({@link toAuditEntry} turns these into the panel's `detail`). The label fields are
 * nullable: the deal may have been hard-deleted, so the join/lookup can miss (the
 * decision still counts — we just fall back to the row's own `reason`).
 */
export type AuditReviewRow = ReviewRecord & {
  /** The decided deal's `service`, or null if the deal can't be resolved. */
  deal_service: string | null;
  /** The decided deal's `provider`, or null if the deal can't be resolved. */
  deal_provider: string | null;
};

/** Default page size for the audit feed when the caller doesn't specify one. */
export const AUDIT_DEFAULT_LIMIT = 50;
/** Hard ceiling on a single audit-feed page (bound the gated read's work). */
export const AUDIT_MAX_LIMIT = 200;

/**
 * One entry in the cross-deal audit feed (ACR-7) — the projection of a
 * {@link ReviewRecord} into the shape the admin panel's Dashboard "recent activity"
 * card and Audit-log screen render. PURE presentation: `initials` + `detail` are
 * derived from the audit row, no I/O.
 *
 * The panel's action vocabulary is `approve|reject|edit|promote|extract`, but the
 * pipeline's `reviews` audit table only records the human review decisions
 * `approve|reject|edit` — those are the rows that exist, so those are what the feed
 * serves. (Persisting `promote`/`extract` as audit rows is deferred; see
 * `docs/KNOWN_ISSUES.md`.) The panel's adapter already tolerates this subset.
 */
export interface AuditEntry {
  /** The audit row id. */
  id: string;
  /** 1–2 letter initials derived from the actor, for the panel's avatar chip. */
  initials: string;
  /** The reviewer identity that took the action. */
  actor: string;
  action: ReviewAction;
  /** Human-readable detail (the review reason / edit summary), or null. */
  detail: string | null;
  /** The entity the action was on — the deal id. */
  entity_id: string;
  /** ISO-8601 timestamp of the decision. */
  at: string;
}

/** Project a review audit row into a panel audit-feed entry (pure). */
export function toAuditEntry(review: AuditReviewRow): AuditEntry {
  return {
    id: review.id,
    initials: initialsOf(review.approver),
    actor: review.approver,
    action: review.action,
    // ACR-7: `detail` is the human-readable deal label ("<service> · <provider>")
    // for EVERY action — approvals (which carry no reason) included. The reason is
    // only the fallback when the deal can't be resolved (hard-deleted).
    detail: dealLabel(review.deal_service, review.deal_provider) ?? review.reason,
    entity_id: review.deal_id,
    at: review.decided_at,
  };
}

/**
 * Build the panel's deal label from the decided deal's service/provider:
 * `"<service> · <provider>"` when both exist, `service` alone when only it does,
 * else null (no deal resolved → the caller falls back to the row's `reason`).
 */
function dealLabel(service: string | null, provider: string | null): string | null {
  if (service && provider) return `${service} · ${provider}`;
  return service || null;
}

/**
 * Derive up-to-2-letter uppercase initials from an actor string. Splits on spaces
 * and the local part of an email; falls back to the first two characters. Always
 * returns at least one character for a non-empty actor (approver is `min(1)`).
 */
export function initialsOf(actor: string): string {
  const trimmed = actor.trim();
  if (trimmed === '') return '?';
  // Prefer the email local part (before @) so "alice@dealroute" → "AL", not "A@".
  const base = trimmed.includes('@') ? trimmed.slice(0, trimmed.indexOf('@')) : trimmed;
  const words = base.split(/[\s._-]+/).filter((w) => w.length > 0);
  if (words.length >= 2) {
    return (words[0]![0]! + words[1]![0]!).toUpperCase();
  }
  return base.slice(0, 2).toUpperCase();
}

import { resolveEvidenceUrl, type Evidence } from '../../domain/index.js';

/**
 * The admin (gated) projection of an evidence bundle, returned inside each
 * `GET /api/candidates` item. Unlike the PUBLIC DTO (`public-dto.ts`) this is NOT a
 * trust allow-list — the review console is for reviewers, so the raw store
 * pointers (`screenshot_ref` / `html_ref` / `terms_ref`) stay on the wire. It only
 * ADDS resolved CDN URLs so the panel's evidence frame can render the captured
 * screenshot (and link the archived HTML) directly, instead of holding an opaque
 * object key it cannot fetch (ACR-13).
 *
 * The URLs are `null` when no CDN base is configured (e.g. local-fs evidence has no
 * public URL) — the panel then shows its "no screenshot" placeholder, exactly as
 * the public DTO does. Derived purely from the deterministic evidence layout, so
 * there is no per-row store lookup.
 */
export interface AdminEvidence {
  id: string;
  source_url: string;
  screenshot_ref: string;
  html_ref: string;
  terms_ref: string;
  captured_at: string;
  content_hash: string;
  /** Resolved CDN URL of the screenshot artifact, or null when no CDN base is set. */
  evidence_screenshot_url: string | null;
  /** Resolved CDN URL of the archived HTML artifact, or null when no CDN base is set. */
  evidence_html_url: string | null;
}

/**
 * Project a stored {@link Evidence} bundle into its admin view, resolving the
 * artifact CDN URLs from the stored refs + the configured base. PURE — no I/O. A
 * `null` evidence (the candidate has no bundle yet) passes through as `null`.
 */
export function toAdminEvidence(
  evidence: Evidence | null,
  cdnBaseUrl: string | undefined,
): AdminEvidence | null {
  if (evidence === null) return null;
  return {
    id: evidence.id,
    source_url: evidence.source_url,
    screenshot_ref: evidence.screenshot_ref,
    html_ref: evidence.html_ref,
    terms_ref: evidence.terms_ref,
    captured_at: evidence.captured_at,
    content_hash: evidence.content_hash,
    evidence_screenshot_url: resolveEvidenceUrl(evidence.screenshot_ref, cdnBaseUrl),
    evidence_html_url: resolveEvidenceUrl(evidence.html_ref, cdnBaseUrl),
  };
}

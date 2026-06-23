import type { Evidence } from '../../domain/index.js';

/**
 * The admin (gated) projection of an evidence bundle, returned inside each
 * `GET /api/candidates` item. Unlike the PUBLIC DTO (`public-dto.ts`) this is NOT a
 * trust allow-list — the review console is for reviewers, so the raw store
 * pointers (`screenshot_ref` / `html_ref` / `terms_ref`) stay on the wire. It ADDS
 * resolved URLs pointing at the gated, authed evidence-fetch endpoint
 * (`GET /api/evidence/:id/:artifact`) so the panel can render the captured
 * screenshot and link the archived HTML/terms directly (ACR-13).
 *
 * These URLs point at the AUTHED path, NOT the public CDN: the public CloudFront CDN
 * is screenshot-only (it 403s html/terms), so html/terms could never resolve there.
 * Pointing all three at the gated endpoint means the panel works fully even when no
 * public CDN is configured (local-fs / `S3_CDN_BASE_URL` unset). The panel fetches
 * each with its `Authorization: Bearer` header and renders the bytes via a blob URL
 * (an `<img src>`/`<iframe src>` can't carry the header itself).
 *
 * The URLs are RELATIVE (`/api/evidence/<id>/<kind>`) — the panel already knows the
 * API origin (its configured base URL), so the DTO need not (and should not) re-plumb
 * the app's own public URL. They are non-null whenever a bundle exists (the authed
 * path always resolves for an authorized reviewer); a `null` evidence (no bundle yet)
 * passes through as `null`.
 */
export interface AdminEvidence {
  id: string;
  source_url: string;
  screenshot_ref: string;
  html_ref: string;
  terms_ref: string;
  captured_at: string;
  content_hash: string;
  /** Authed-path URL of the screenshot artifact (`/api/evidence/:id/screenshot`). */
  evidence_screenshot_url: string;
  /** Authed-path URL of the archived HTML artifact (`/api/evidence/:id/html`). */
  evidence_html_url: string;
  /** Authed-path URL of the terms-text artifact (`/api/evidence/:id/terms`). */
  evidence_terms_url: string;
}

/** Build the gated authed-path URL for one artifact kind of a bundle. */
function evidenceArtifactUrl(id: string, kind: 'screenshot' | 'html' | 'terms'): string {
  return `/api/evidence/${id}/${kind}`;
}

/**
 * Project a stored {@link Evidence} bundle into its admin view, attaching the gated
 * authed-path artifact URLs. PURE — no I/O. A `null` evidence (the candidate has no
 * bundle yet) passes through as `null`.
 */
export function toAdminEvidence(evidence: Evidence | null): AdminEvidence | null {
  if (evidence === null) return null;
  return {
    id: evidence.id,
    source_url: evidence.source_url,
    screenshot_ref: evidence.screenshot_ref,
    html_ref: evidence.html_ref,
    terms_ref: evidence.terms_ref,
    captured_at: evidence.captured_at,
    content_hash: evidence.content_hash,
    evidence_screenshot_url: evidenceArtifactUrl(evidence.id, 'screenshot'),
    evidence_html_url: evidenceArtifactUrl(evidence.id, 'html'),
    evidence_terms_url: evidenceArtifactUrl(evidence.id, 'terms'),
  };
}

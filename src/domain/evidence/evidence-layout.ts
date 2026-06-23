/**
 * The on-store layout of an evidence bundle — the ONE place the object/file names
 * inside a `<bundle-id>/` directory are defined. Both EvidenceStore adapters
 * (local-fs + S3/R2) build their `*_ref` pointers from these, and the public read
 * API derives a deal's screenshot URL from them, so the convention can never drift
 * between "where it's written" and "where it's read".
 *
 * A bundle lives under `<id>/` and holds:
 *   <id>/screenshot.png   the full-page screenshot
 *   <id>/page.html        the raw HTML snapshot
 *   <id>/terms.txt        the extracted terms/offer text
 *   <id>/evidence.json    the bundle metadata `get()` reads back
 */

export const EVIDENCE_SCREENSHOT_FILE = 'screenshot.png';
export const EVIDENCE_HTML_FILE = 'page.html';
export const EVIDENCE_TERMS_FILE = 'terms.txt';
export const EVIDENCE_META_FILE = 'evidence.json';

/** Content-type for each stored body object. The ONE place these are defined — both
 *  EvidenceStore adapters tag their writes with these AND the authed reviewer
 *  evidence-fetch endpoint streams them back under the same type, so "what it was
 *  written as" and "what it's served as" can never drift. */
export const EVIDENCE_SCREENSHOT_CONTENT_TYPE = 'image/png';
export const EVIDENCE_HTML_CONTENT_TYPE = 'text/html; charset=utf-8';
export const EVIDENCE_TERMS_CONTENT_TYPE = 'text/plain; charset=utf-8';
export const EVIDENCE_META_CONTENT_TYPE = 'application/json';

/**
 * The reviewer-facing artifact kinds the authed evidence-fetch endpoint can stream
 * (`GET /api/evidence/:id/:kind`). Deliberately EXCLUDES the metadata object
 * (`evidence.json`) — it duplicates what `GET /api/candidates` already returns. A
 * closed union so the HTTP route + the store map only over a fixed, safe set (a
 * caller can never coerce an arbitrary path through it).
 */
export type EvidenceArtifactKind = 'screenshot' | 'html' | 'terms';

/**
 * Map an artifact kind to its in-bundle file name + content-type — the single lookup
 * shared by both EvidenceStore adapters (`getArtifact`) and the HTTP layer, so the
 * `(id, kind)` URL never has to know the storage layout. Keyed by the closed
 * {@link EvidenceArtifactKind} union, so adding a kind is a compile-time-checked edit.
 */
export const EVIDENCE_ARTIFACTS: Record<
  EvidenceArtifactKind,
  { file: string; contentType: string }
> = {
  screenshot: { file: EVIDENCE_SCREENSHOT_FILE, contentType: EVIDENCE_SCREENSHOT_CONTENT_TYPE },
  html: { file: EVIDENCE_HTML_FILE, contentType: EVIDENCE_HTML_CONTENT_TYPE },
  terms: { file: EVIDENCE_TERMS_FILE, contentType: EVIDENCE_TERMS_CONTENT_TYPE },
};

/**
 * The stored `screenshot_ref` for a bundle id: the id-prefixed object key/relative
 * path the EvidenceStore persists. Pure + deterministic so the public API can
 * resolve a deal's screenshot URL from its `evidence_id` alone — no store lookup.
 */
export function evidenceScreenshotRef(bundleId: string): string {
  return `${bundleId}/${EVIDENCE_SCREENSHOT_FILE}`;
}

/**
 * The stored `html_ref` for a bundle id (the archived raw HTML snapshot). Same
 * deterministic-layout contract as {@link evidenceScreenshotRef}.
 */
export function evidenceHtmlRef(bundleId: string): string {
  return `${bundleId}/${EVIDENCE_HTML_FILE}`;
}

/**
 * Resolve a public/CDN URL for a stored evidence artifact `ref` (a store key like
 * `<id>/screenshot.png`) against a CDN base, or `null` when no base is configured
 * (e.g. local-fs evidence has no public URL — never leak a relative/broken path).
 * Pure + deterministic; joins without doubling slashes. Shared by the public read
 * DTO and the gated admin evidence projection so the screenshot a reviewer sees and
 * the one a consumer sees resolve through one rule.
 */
export function resolveEvidenceUrl(ref: string, cdnBaseUrl: string | undefined): string | null {
  if (cdnBaseUrl === undefined || cdnBaseUrl === '') return null;
  const base = cdnBaseUrl.replace(/\/+$/, '');
  const path = ref.replace(/^\/+/, '');
  return `${base}/${path}`;
}

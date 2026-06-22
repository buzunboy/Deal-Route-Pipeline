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

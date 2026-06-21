import { z } from 'zod';
import { InvariantViolation } from '../errors/index.js';

/**
 * An immutable evidence bundle captured at crawl time for a single fetched page.
 *
 * Evidence is REQUIRED before any candidate exists (trust invariant): every deal
 * record links an `evidence_id`. We store our own screenshot + the raw HTML + the
 * extracted terms text + the source URL + a timestamp — not a republished copy of
 * copyrighted T&C. The `*_ref` fields are opaque pointers into the EvidenceStore
 * (a local path or an object key), resolved by the adapter.
 */
export const EvidenceSchema = z.object({
  id: z.string().uuid(),
  source_url: z.string().url(),
  /** Pointer to the full-page screenshot (PNG). */
  screenshot_ref: z.string().min(1),
  /** Pointer to the raw HTML snapshot. */
  html_ref: z.string().min(1),
  /** Pointer to the extracted terms/offer text. */
  terms_ref: z.string().min(1),
  /** ISO-8601 capture timestamp. */
  captured_at: z.string().min(1),
  /** SHA-256 of the price/terms region, for cheap change-diffing in monitoring. */
  content_hash: z.string().min(1),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

/** The raw material an EvidenceStore persists into an Evidence bundle. */
export interface EvidenceCapture {
  sourceUrl: string;
  screenshot: Uint8Array;
  html: string;
  termsText: string;
  capturedAt: string;
  contentHash: string;
}

/**
 * Reject a hollow capture before any EvidenceStore persists it. The trust
 * invariant is "evidence required before any candidate" — a bundle missing its
 * screenshot/HTML/terms bytes is not evidence. A fetcher can return an ok-fetch
 * with an empty screenshot (e.g. Firecrawl omits the field), which would persist
 * a candidate pinned to a bundle that `get()`/`verifyBundleComplete` later reject
 * as unloadable. Validating at `save()` instead means the failure surfaces at
 * capture time, not at review time. Pure + store-agnostic so every EvidenceStore
 * adapter enforces it identically (substitutability).
 */
export function assertCaptureComplete(capture: EvidenceCapture): void {
  const empties: string[] = [];
  if (capture.screenshot.byteLength === 0) empties.push('screenshot');
  if (capture.html.length === 0) empties.push('html');
  if (capture.termsText.length === 0) empties.push('termsText');
  if (empties.length > 0) {
    throw new InvariantViolation(
      `Evidence capture is hollow: empty ${empties.join(', ')}. Refusing to persist evidence that cannot be loaded back.`,
      { sourceUrl: capture.sourceUrl, empty: empties },
    );
  }
}

/**
 * The fields a human supplies when completing a manual-capture task, where the
 * artifacts were uploaded out-of-band and are passed by REFERENCE (store keys /
 * URLs) rather than as bytes. Distinct from {@link EvidenceCapture} (which carries
 * the screenshot bytes for the automated capture path): here the bytes never reach
 * the server, so the bundle is persisted as metadata directly via the evidence
 * repository, not minted by an EvidenceStore. (The out-of-band upload channel that
 * produces these refs is deferred — see KNOWN_ISSUES.)
 *
 * `termsText` is carried INLINE (not just by ref) because the server needs it to
 * compute the `content_hash` and to verify grounding quotes against — the same
 * trust checks the automated path runs on the page text. The refs are the durable
 * pointers stored on the {@link Evidence} bundle.
 */
export interface ReferencedEvidenceInput {
  sourceUrl: string;
  /** Opaque pointer to the already-uploaded full-page screenshot (PNG). */
  screenshotRef: string;
  /** Opaque pointer to the already-uploaded raw HTML snapshot. */
  htmlRef: string;
  /** Opaque pointer to the already-uploaded terms/offer text artifact. */
  termsRef: string;
  /** The terms text itself — for hashing + grounding verification. */
  termsText: string;
  capturedAt: string;
}

/**
 * Reject a hollow REFERENCED capture (manual-capture-task completion). Same trust
 * invariant as {@link assertCaptureComplete} — evidence required before any
 * candidate — but checks the artifact *references* (no bytes to weigh) plus the
 * inline terms text and source URL. Returns the list of missing fields so the
 * caller can raise a typed `EvidenceIncompleteError` (HTTP 400) instead of
 * persisting a candidate behind an unloadable bundle.
 */
export function missingReferencedEvidence(input: ReferencedEvidenceInput): string[] {
  const missing: string[] = [];
  if (input.sourceUrl.trim() === '') missing.push('source_url');
  if (input.screenshotRef.trim() === '') missing.push('screenshot_ref');
  if (input.htmlRef.trim() === '') missing.push('html_ref');
  if (input.termsRef.trim() === '') missing.push('terms_ref');
  if (input.termsText.trim() === '') missing.push('terms_text');
  if (input.capturedAt.trim() === '') missing.push('captured_at');
  return missing;
}

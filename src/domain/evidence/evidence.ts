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

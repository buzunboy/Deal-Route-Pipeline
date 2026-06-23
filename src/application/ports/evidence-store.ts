import type { Evidence, EvidenceCapture, EvidenceArtifactKind } from '../../domain/index.js';

/**
 * One stored artifact's raw bytes plus the content-type it was written as. Returned by
 * {@link EvidenceStore.getArtifact} so the HTTP layer can stream it back verbatim — the
 * content-type is the domain one the store tagged the write with (see
 * `EVIDENCE_ARTIFACTS`), never re-sniffed.
 */
export interface EvidenceArtifact {
  bytes: Uint8Array;
  contentType: string;
}

/**
 * EvidenceStore port — persists immutable evidence bundles (screenshot + HTML +
 * terms + url + timestamp). Local filesystem (dev default) and S3/R2 adapters
 * implement it. Bundles are write-once; monitoring keeps old evidence rather than
 * overwriting it.
 */
export interface EvidenceStore {
  /** Persist a capture and return the stored Evidence (with resolved refs + id). */
  save(capture: EvidenceCapture): Promise<Evidence>;
  /** Fetch a previously stored bundle's metadata by id. */
  get(id: string): Promise<Evidence | null>;
  /**
   * Read ONE artifact's bytes + content-type for a bundle, addressed by (id, kind)
   * rather than a raw ref — the adapter maps the kind to its own storage layout, so
   * the caller never needs to know it (refs stay opaque, and the kind is a closed
   * union so no arbitrary path can be coerced through). Returns null when the bundle
   * or that artifact is absent (the HTTP layer maps null → 404). Backs the gated
   * reviewer evidence-fetch endpoint; read-only, never mutates a write-once bundle.
   */
  getArtifact(id: string, kind: EvidenceArtifactKind): Promise<EvidenceArtifact | null>;
}

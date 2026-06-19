import type { Evidence, EvidenceCapture } from '../../domain/index.js';

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
}

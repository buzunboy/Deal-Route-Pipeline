/**
 * Infrastructure failure talking to a search backend. Local to the search adapter
 * layer (the application/domain must not know about a concrete vendor), carrying
 * the underlying cause for diagnostics — mirrors `EvidenceStoreError`/`TimeoutError`.
 */
export class SearchProviderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SearchProviderError';
  }
}

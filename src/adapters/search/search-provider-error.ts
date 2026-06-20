/**
 * Infrastructure failure talking to a search backend. Local to the search adapter
 * layer (the application/domain must not know about a concrete vendor), carrying
 * the underlying cause for diagnostics — mirrors `EvidenceStoreError`/`TimeoutError`.
 */
export class SearchProviderError extends Error {
  readonly status?: number;
  constructor(message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options);
    this.name = 'SearchProviderError';
    this.status = options?.status;
  }
}

/**
 * HTTP statuses worth retrying with backoff: 429 (rate-limited) and 5xx (transient
 * server errors). A 4xx other than 429 (bad request / auth) is not retryable —
 * retrying would just burn budget.
 */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Shared retry predicate for the search adapters: retry transient network/timeout
 * failures (timeout, abort, connection reset) AND a `SearchProviderError` whose
 * HTTP status is retryable (429/5xx). A non-retryable status or a programming
 * error is not retried (it would only burn budget).
 */
export function isRetryableSearchError(err: unknown): boolean {
  if (err instanceof SearchProviderError) {
    return err.status !== undefined && isRetryableHttpStatus(err.status);
  }
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN';
  }
  return false;
}

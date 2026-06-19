/**
 * Timeout + retry-with-backoff helpers shared by I/O adapters. Every external
 * call is timeout-bounded and retried with backoff (`architecture.md`:
 * resilience). Retries are only for transient failures the caller marks retryable.
 */

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Operation timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/** Reject if `promise` does not settle within `ms`. */
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  /** Decide whether a thrown error is worth retrying (default: always). */
  isRetryable?: (err: unknown) => boolean;
}

/** Run `fn` with exponential backoff. Throws the last error if all attempts fail. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const isRetryable = opts.isRetryable ?? (() => true);
  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === opts.retries || !isRetryable(err)) break;
      await sleep(opts.baseDelayMs * 2 ** attempt);
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

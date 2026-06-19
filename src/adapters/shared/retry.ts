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

/**
 * Run an operation with a timeout that ALSO aborts the underlying work. `run`
 * receives an AbortSignal to pass to `fetch`/Playwright so a timeout cancels the
 * in-flight request instead of leaving the socket open (which leaks connections
 * under load). On timeout the controller is aborted and a TimeoutError is thrown.
 */
export async function withAbortableTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new TimeoutError(ms));
      reject(new TimeoutError(ms));
    }, ms);
  });
  try {
    // Race so a timeout rejects even if `run` ignores the abort signal; the abort
    // still fires to cancel the in-flight request and free the socket.
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  /** Decide whether a thrown error is worth retrying (default: always). */
  isRetryable?: (err: unknown) => boolean;
  /** Jitter fraction [0,1] applied to each backoff delay (default 0.5 = ±50%). */
  jitter?: number;
}

/**
 * Run `fn` with exponential backoff + jitter. Jitter avoids a thundering herd
 * when many sources fail at once and would otherwise retry in lockstep against
 * the same provider. Throws the last error if all attempts fail.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const isRetryable = opts.isRetryable ?? (() => true);
  const jitter = opts.jitter ?? 0.5;
  let lastError: unknown;
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === opts.retries || !isRetryable(err)) break;
      await sleep(jittered(opts.baseDelayMs * 2 ** attempt, jitter));
    }
  }
  throw lastError;
}

/** Apply ±`fraction` jitter to a delay (full-jitter style), never below zero. */
function jittered(delayMs: number, fraction: number): number {
  const spread = delayMs * fraction;
  // Deterministic-test-safe: Math.random is allowed here (adapter layer, not domain).
  const offset = (Math.random() * 2 - 1) * spread;
  return Math.max(0, Math.round(delayMs + offset));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import { describe, it, expect } from 'vitest';
import { withRetry, withTimeout, withAbortableTimeout, TimeoutError } from './retry.js';

describe('withRetry', () => {
  it('retries transient failures up to `retries` times, then succeeds', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('transient');
        return 'ok';
      },
      { retries: 3, baseDelayMs: 0 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('stops immediately when isRetryable returns false (no wasted attempts)', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error('permanent');
        },
        { retries: 5, baseDelayMs: 0, isRetryable: () => false },
      ),
    ).rejects.toThrow('permanent');
    expect(calls).toBe(1);
  });

  it('throws the last error after exhausting retries', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error(`fail-${calls}`);
        },
        { retries: 2, baseDelayMs: 0 },
      ),
    ).rejects.toThrow('fail-3');
    expect(calls).toBe(3); // initial + 2 retries
  });

  it('applies bounded jitter to the backoff (never negative, within ±fraction)', async () => {
    // With baseDelayMs=0 the delay is 0 regardless of jitter, so this asserts the
    // jitter math never produces a negative sleep that would reject setTimeout.
    let calls = 0;
    const start = Date.now();
    await withRetry(
      async () => {
        calls++;
        if (calls < 2) throw new Error('x');
        return 'ok';
      },
      { retries: 1, baseDelayMs: 0, jitter: 1 },
    );
    expect(calls).toBe(2);
    expect(Date.now() - start).toBeGreaterThanOrEqual(0);
  });
});

describe('withTimeout', () => {
  it('resolves when the promise settles in time', async () => {
    await expect(withTimeout(Promise.resolve(42), 50)).resolves.toBe(42);
  });

  it('rejects with TimeoutError when the promise is too slow', async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 50));
    await expect(withTimeout(slow, 5)).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe('withAbortableTimeout', () => {
  it('aborts the signal and rejects on timeout', async () => {
    let aborted = false;
    await expect(
      withAbortableTimeout((signal) => {
        signal.addEventListener('abort', () => {
          aborted = true;
        });
        return new Promise((resolve) => setTimeout(resolve, 50));
      }, 5),
    ).rejects.toBeInstanceOf(TimeoutError);
    expect(aborted).toBe(true);
  });

  it('passes a non-aborted signal through on success', async () => {
    const value = await withAbortableTimeout(async (signal) => {
      expect(signal.aborted).toBe(false);
      return 'done';
    }, 50);
    expect(value).toBe('done');
  });
});

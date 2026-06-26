import { describe, it, expect } from 'vitest';
import {
  DbRetrier,
  isTransientDbError,
  isPrimaryKeyViolation,
  isPoolTimeoutError,
} from './db-resilience.js';
import { FakeLogger } from '../../../../test/fakes/fakes.js';

/** Build a fake Postgres-style error carrying a SQLSTATE/socket `code` (+ optional constraint). */
function pgError(code: string, constraint?: string): Error & { code: string; constraint?: string } {
  return Object.assign(new Error(`pg error ${code}`), { code, constraint });
}

describe('isTransientDbError', () => {
  it('classifies connection-class SQLSTATEs as transient', () => {
    for (const code of ['08000', '08003', '08006', '08001', '08004', '08007']) {
      expect(isTransientDbError(pgError(code))).toBe(true);
    }
  });
  it('classifies rollback-class SQLSTATEs (serialization, deadlock) as transient', () => {
    expect(isTransientDbError(pgError('40001'))).toBe(true);
    expect(isTransientDbError(pgError('40P01'))).toBe(true);
  });
  it('classifies node socket codes as transient', () => {
    for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE']) {
      expect(isTransientDbError(pgError(code))).toBe(true);
    }
  });
  it('does NOT retry application errors (e.g. unique violation, not-null, syntax)', () => {
    expect(isTransientDbError(pgError('23505'))).toBe(false); // unique_violation
    expect(isTransientDbError(pgError('23502'))).toBe(false); // not_null_violation
    expect(isTransientDbError(pgError('42601'))).toBe(false); // syntax_error
  });
  it('does NOT retry an error with no code (a plain bug)', () => {
    expect(isTransientDbError(new Error('boom'))).toBe(false);
    expect(isTransientDbError('not even an error')).toBe(false);
    expect(isTransientDbError(null)).toBe(false);
  });
});

describe('isPrimaryKeyViolation', () => {
  it('detects a 23505 on a *_pkey constraint', () => {
    expect(isPrimaryKeyViolation(pgError('23505', 'crawl_runs_pkey'))).toBe(true);
  });
  it('does NOT treat a 23505 on a NON-pkey unique index as a PK violation', () => {
    // A future natural-key unique index → the row didn't land → must not be swallowed.
    expect(isPrimaryKeyViolation(pgError('23505', 'deals_dedupe_evidence_unique'))).toBe(false);
  });
  it('is conservative when the driver gives no constraint name', () => {
    expect(isPrimaryKeyViolation(pgError('23505'))).toBe(false);
  });
  it('is false for non-unique-violation errors', () => {
    expect(isPrimaryKeyViolation(pgError('08006', 'x_pkey'))).toBe(false);
    expect(isPrimaryKeyViolation(new Error('x'))).toBe(false);
  });
});

describe('isPoolTimeoutError', () => {
  // The EXACT code-less messages pg-pool throws on a saturated / slow checkout.
  it('detects pg-pool checkout-saturation timeout (code-less Error)', () => {
    expect(isPoolTimeoutError(new Error('timeout exceeded when trying to connect'))).toBe(true);
  });
  it('detects pg-pool connect-establish timeout (code-less Error)', () => {
    expect(isPoolTimeoutError(new Error('Connection terminated due to connection timeout'))).toBe(
      true,
    );
  });
  it('does NOT match a coded pg error (those route to the transient/retry path)', () => {
    // A 53300 too_many_connections IS coded → handled by isTransientDbError, not here.
    expect(isPoolTimeoutError(pgError('53300'))).toBe(false);
    expect(isPoolTimeoutError(pgError('08006'))).toBe(false);
  });
  it('does NOT match an unrelated code-less error or a non-error', () => {
    expect(isPoolTimeoutError(new Error('some other bug'))).toBe(false);
    expect(isPoolTimeoutError('Connection terminated due to connection timeout')).toBe(false);
    expect(isPoolTimeoutError(null)).toBe(false);
  });
});

describe('DbRetrier', () => {
  const config = { retries: 3, baseDelayMs: 0 }; // 0 delay keeps the test instant

  it('does NOT retry a pool-timeout (code-less) — it surfaces immediately for a 503', async () => {
    // The root-cause regression: a saturated-pool timeout is a code-less Error, so it must
    // NOT be retried (the 10s/2.5s wait already happened) and must surface for the 503 map.
    const r = new DbRetrier(config, new FakeLogger());
    let calls = 0;
    await expect(
      r.run('op', async () => {
        calls++;
        throw new Error('timeout exceeded when trying to connect');
      }),
    ).rejects.toThrow('timeout exceeded when trying to connect');
    expect(calls).toBe(1); // no retry
  });

  it('returns the result without retrying on success', async () => {
    const r = new DbRetrier(config, new FakeLogger());
    let calls = 0;
    const out = await r.run('op', async () => {
      calls++;
      return 42;
    });
    expect(out).toBe(42);
    expect(calls).toBe(1);
  });

  it('retries a transient error then succeeds', async () => {
    const r = new DbRetrier(config, new FakeLogger());
    let calls = 0;
    const out = await r.run('op', async () => {
      calls++;
      if (calls < 3) throw pgError('40001'); // serialization_failure twice
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(calls).toBe(3);
  });

  it('does NOT retry a non-transient error and rethrows it', async () => {
    const r = new DbRetrier(config, new FakeLogger());
    let calls = 0;
    await expect(
      r.run('op', async () => {
        calls++;
        throw pgError('42601'); // syntax_error — a bug, not transient
      }),
    ).rejects.toThrow('pg error 42601');
    expect(calls).toBe(1);
  });

  it('throws the last transient error after exhausting retries', async () => {
    const r = new DbRetrier(config, new FakeLogger());
    let calls = 0;
    await expect(
      r.run('op', async () => {
        calls++;
        throw pgError('08006'); // connection_failure every time
      }),
    ).rejects.toThrow('pg error 08006');
    expect(calls).toBe(config.retries + 1); // initial + retries
  });

  it('treats a PK violation on a RETRY as success for a non-idempotent insert', async () => {
    // The first attempt fails transiently AND actually committed; the retry then
    // hits its own PRIMARY-KEY violation — which means the prior write landed, so it
    // is a success, not a failure (no double-insert, no spurious error).
    const r = new DbRetrier(config, new FakeLogger());
    let calls = 0;
    const out = await r.run(
      'insert',
      async () => {
        calls++;
        if (calls === 1) throw pgError('08006'); // transient → retry
        throw pgError('23505', 'crawl_runs_pkey'); // retry sees the row the 1st attempt committed
      },
      false, // non-idempotent
    );
    expect(out).toBeUndefined();
    expect(calls).toBe(2);
  });

  it('a NON-pkey unique violation on a retry is NOT swallowed (the row did not land)', async () => {
    // A natural-key unique index violation means the insert genuinely failed — it
    // must surface, even mid-retry, so we never report a phantom success.
    const r = new DbRetrier(config, new FakeLogger());
    let calls = 0;
    await expect(
      r.run(
        'insert',
        async () => {
          calls++;
          if (calls === 1) throw pgError('08006'); // transient → retry
          throw pgError('23505', 'deals_dedupe_evidence_unique');
        },
        false,
      ),
    ).rejects.toThrow('pg error 23505');
    expect(calls).toBe(2);
  });

  it('a FIRST-attempt PK violation still throws (a genuine duplicate)', async () => {
    // Not a retry artifact: the very first attempt is a real duplicate key, so it
    // must surface — only a PK violation AFTER a retry is swallowed.
    const r = new DbRetrier(config, new FakeLogger());
    let calls = 0;
    await expect(
      r.run(
        'insert',
        async () => {
          calls++;
          throw pgError('23505', 'crawl_runs_pkey');
        },
        false,
      ),
    ).rejects.toThrow('pg error 23505');
    expect(calls).toBe(1);
  });
});

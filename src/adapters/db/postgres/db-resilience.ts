/**
 * DB-op resilience for the Postgres adapter (Pre-C-2). Every external call must be
 * retried with backoff (`architecture.md`: resilience); DB ops were the gap. This
 * classifies *transient* Postgres failures and retries them, keeping writes safe.
 *
 * Idempotency is the hazard with retrying writes: a non-idempotent insert that
 * actually committed but whose ack was lost would double-insert on retry. We avoid
 * that two ways:
 *   - reads + idempotent writes (`onConflictDoNothing`/`onConflictDoUpdate`/`update`
 *     by id) retry freely;
 *   - a write the caller marks non-idempotent that hits a UNIQUE violation on a
 *     RETRY attempt is treated as success — the prior attempt had committed.
 */
import { withRetry } from '../../shared/retry.js';
import type { Logger } from '../../../application/ports/index.js';

/** Postgres SQLSTATEs (and node socket codes) that mean "transient — safe to retry". */
const RETRYABLE_PG_CODES = new Set<string>([
  // Class 08 — connection exceptions (op didn't reach the server or the server went away).
  '08000',
  '08003',
  '08006',
  '08001',
  '08004',
  '08007',
  // Transaction rolled back by the server → re-running is safe.
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  // Server in a transient unavailable state.
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
  // Node socket-level transients (surface on err.code too).
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
]);

/** Postgres unique_violation — a retried non-idempotent insert that already committed. */
const UNIQUE_VIOLATION = '23505';

function pgCode(err: unknown): string | undefined {
  if (err !== null && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** node-postgres surfaces the violated constraint name on `err.constraint`. */
function pgConstraint(err: unknown): string | undefined {
  if (err !== null && typeof err === 'object' && 'constraint' in err) {
    const c = (err as { constraint?: unknown }).constraint;
    if (typeof c === 'string') return c;
  }
  return undefined;
}

export function isTransientDbError(err: unknown): boolean {
  const code = pgCode(err);
  return code !== undefined && RETRYABLE_PG_CODES.has(code);
}

/**
 * A unique violation on the row's own PRIMARY KEY — and ONLY the PK. The
 * retry-time swallow ("the prior attempt committed") is only sound for the
 * client-generated PK, which is identical across retries. A violation of some
 * OTHER unique index (a natural key added later) means the row genuinely did not
 * land, so it must NOT be swallowed — we'd report a phantom success and lose data.
 * Postgres names an inline `PRIMARY KEY` constraint `<table>_pkey`.
 */
export function isPrimaryKeyViolation(err: unknown): boolean {
  if (pgCode(err) !== UNIQUE_VIOLATION) return false;
  const constraint = pgConstraint(err);
  // If the driver didn't surface a constraint name, be conservative and do NOT
  // treat it as a PK violation (don't swallow what we can't positively identify).
  return constraint !== undefined && constraint.endsWith('_pkey');
}

export interface DbRetryConfig {
  retries: number;
  baseDelayMs: number;
}

/**
 * Wraps repo operations with bounded retry on transient errors. `idempotent`
 * defaults to true (reads + conflict-safe writes). Pass `false` for a plain insert:
 * then a UNIQUE violation seen *after at least one retry* is swallowed as success
 * (the earlier attempt committed), while a first-attempt UNIQUE violation still
 * throws (a genuine duplicate, not a retry artifact).
 */
export class DbRetrier {
  constructor(
    private readonly config: DbRetryConfig,
    private readonly logger: Logger,
  ) {}

  async run<T>(op: string, fn: () => Promise<T>, idempotent = true): Promise<T> {
    let attempt = 0;
    return withRetry(
      async () => {
        const current = attempt++;
        try {
          return await fn();
        } catch (err) {
          // A non-idempotent insert that hits its own PRIMARY-KEY violation on a
          // RETRY means the prior attempt committed despite a lost ack — treat as
          // success. Scoped to the PK only: any other unique violation means the
          // row did not land and must surface (no phantom success / data loss).
          if (!idempotent && current > 0 && isPrimaryKeyViolation(err)) {
            this.logger.warn('db: retry hit primary-key violation — prior attempt committed', {
              op,
              attempt: current,
            });
            return undefined as T;
          }
          if (isTransientDbError(err)) {
            this.logger.warn('db: transient error, will retry', {
              op,
              attempt: current,
              code: pgCode(err),
            });
          }
          throw err;
        }
      },
      {
        retries: this.config.retries,
        baseDelayMs: this.config.baseDelayMs,
        isRetryable: isTransientDbError,
      },
    );
  }
}

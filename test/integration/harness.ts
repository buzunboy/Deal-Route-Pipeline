import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { loadConfig, type Config } from '../../src/config/index.js';
import { Container, type ContainerOptions } from '../../src/composition/container.js';

/**
 * Hermetic-integration harness. These tests exercise the REAL composition root
 * and REAL Postgres adapter, but swap the genuinely-external edges (network
 * fetch, LLM, RSS) for deterministic doubles via `Container` overrides — so they
 * verify wiring / migrations / schema / SQL round-trips without touching the
 * network. They run ONLY when `DATABASE_URL_TEST` points at a throwaway Postgres
 * (CI provides one as a service container); otherwise the suite self-skips.
 */
export const DB_URL = process.env.DATABASE_URL_TEST;
export const hasDb = typeof DB_URL === 'string' && DB_URL.trim() !== '';

/** Apply all migrations to the test database (idempotent — drizzle tracks them). */
export async function applyMigrations(): Promise<void> {
  const pool = new pg.Pool({ connectionString: DB_URL });
  try {
    await migrate(drizzle(pool), { migrationsFolder: './drizzle' });
  } finally {
    await pool.end();
  }
}

/**
 * Truncate every domain table so each test starts from a clean slate, then restore the
 * auth REFERENCE seed (the two system roles + their grants + perm_version=0) that the
 * migrations install — TRUNCATE wipes it, but it is reference data, not test fixtures,
 * and both adapters must arrive with the same seeded baseline (LSP). `team_members` was
 * renamed to `users` (migration 0019); the auth tables (`users`, `roles`, `permissions`,
 * `role_permissions`, `refresh_tokens`, `auth_meta`) join the truncate set.
 */
export async function resetDb(): Promise<void> {
  const pool = new pg.Pool({ connectionString: DB_URL });
  try {
    const db = drizzle(pool);
    await db.execute(
      sql`TRUNCATE TABLE reviews, source_reviews, changes, deals, evidence, manual_capture_tasks,
            crawl_runs, field_proposals, sources, subscription_catalog, condition_vocabulary,
            users, alert_events, settings, roles, permissions, role_permissions,
            refresh_tokens, auth_meta
          RESTART IDENTITY CASCADE`,
    );
    await seedAuthBaseline(pool);
  } finally {
    await pool.end();
  }
}

/**
 * Re-install the migration-seeded auth reference data (system roles, the permissions
 * catalog, the grants, perm_version=0) after a TRUNCATE. Derived from the SAME domain
 * constants the in-memory adapter seeds from, so a freshly-reset Postgres equals a fresh
 * `InMemoryDb` (LSP). Idempotent (ON CONFLICT). Exported so the auth port-contract test
 * can reuse it for its own pool reset.
 */
export async function seedAuthBaseline(pool: pg.Pool): Promise<void> {
  const { SYSTEM_ROLES, ALL_PERMISSIONS } = await import('../../src/domain/index.js');
  for (const role of SYSTEM_ROLES) {
    await pool.query(
      `INSERT INTO roles (id, name, description, is_system) VALUES ($1, $2, $3, true)
         ON CONFLICT (id) DO NOTHING`,
      [role.id, role.name, role.description],
    );
  }
  for (const key of ALL_PERMISSIONS) {
    await pool.query(
      `INSERT INTO permissions (key, label) VALUES ($1, $1) ON CONFLICT (key) DO NOTHING`,
      [key],
    );
  }
  for (const role of SYSTEM_ROLES) {
    for (const key of role.permissions) {
      await pool.query(
        `INSERT INTO role_permissions (role_id, permission_key) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
        [role.id, key],
      );
    }
  }
  await pool.query(
    `INSERT INTO auth_meta (key, value) VALUES ('perm_version', '0') ON CONFLICT (key) DO NOTHING`,
  );
}

/**
 * Backdate the `revoked_at` of every revoked refresh_tokens row by `seconds`, so a test can
 * exercise the refresh-reuse grace window against real Postgres without a controllable clock
 * (the Container uses a real clock). Returns the rows touched.
 */
export async function ageRefreshRevocation(seconds: number): Promise<number> {
  const pool = new pg.Pool({ connectionString: DB_URL });
  try {
    const res = await pool.query(
      `UPDATE refresh_tokens SET revoked_at = revoked_at - ($1 || ' seconds')::interval
         WHERE revoked_at IS NOT NULL`,
      [String(seconds)],
    );
    return res.rowCount ?? 0;
  } finally {
    await pool.end();
  }
}

/**
 * Build a real Container against the test Postgres, with deterministic adapter
 * overrides. `usePersistence` is true so the real PostgresDb is used; pg-boss is
 * never started here (the queue isn't exercised by these flows). Evidence uses a
 * fresh temp dir so the local-fs store writes somewhere disposable.
 */
export function makeContainer(
  overrides: NonNullable<ContainerOptions['overrides']>,
  env: NodeJS.ProcessEnv = {},
): Container {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'dealroute-it-evidence-'));
  const config: Config = loadConfig({
    ...process.env,
    LLM_PROVIDER: 'stub', // real LLM is replaced by the override anyway
    FETCHER: 'playwright', // ditto for the fetcher
    EVIDENCE_STORE: 'local',
    EVIDENCE_LOCAL_DIR: evidenceDir,
    DATABASE_URL: DB_URL,
    QUEUE_DATABASE_URL: DB_URL,
    RESPECT_ROBOTS_TXT: 'false', // overridden fetcher doesn't hit the network
    LOG_LEVEL: 'error',
    ...env, // per-test config (e.g. DAILY_BUDGET_EUR, AGENT_MAX_*)
  });
  return new Container(config, { usePersistence: true, overrides });
}

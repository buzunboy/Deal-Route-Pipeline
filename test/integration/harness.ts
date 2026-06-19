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

/** Truncate every domain table so each test starts from a clean slate. */
export async function resetDb(): Promise<void> {
  const pool = new pg.Pool({ connectionString: DB_URL });
  try {
    const db = drizzle(pool);
    await db.execute(
      sql`TRUNCATE TABLE reviews, source_reviews, changes, deals, evidence, manual_capture_tasks,
            crawl_runs, field_proposals, sources, subscription_catalog, condition_vocabulary
          RESTART IDENTITY CASCADE`,
    );
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

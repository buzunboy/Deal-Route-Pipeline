import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { loadConfig } from '../../config/index.js';

/**
 * Apply pending SQL migrations from ./drizzle. Run via `npm run db:migrate`
 * (which uses tsx). Idempotent: drizzle tracks applied migrations.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = new pg.Pool({ connectionString: config.database.url });
  const db = drizzle(pool);
  console.log('Applying migrations from ./drizzle ...');
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('Migrations applied.');
  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});

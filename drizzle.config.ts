import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit config. `db:generate` produces SQL migrations from the schema into
 * ./drizzle; `db:migrate` applies them. DATABASE_URL comes from the environment.
 */
export default defineConfig({
  schema: './src/adapters/db/postgres/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://dealroute:dealroute@localhost:5432/dealroute',
  },
});

import { InMemoryDb } from './in-memory-db.js';
import { databaseContract } from '../../../../test/contracts/database-contract.js';
import { authRepositoriesContract } from '../../../../test/contracts/auth-repositories-contract.js';

databaseContract('InMemoryDb', () => new InMemoryDb());
// Each makeDb() returns a fresh, baseline-seeded store, so no reset hook is needed
// (cases are naturally isolated) — the same suite the Postgres adapter runs (LSP).
authRepositoriesContract('InMemoryDb', () => new InMemoryDb());

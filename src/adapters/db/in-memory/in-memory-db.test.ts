import { InMemoryDb } from './in-memory-db.js';
import { databaseContract } from '../../../../test/contracts/database-contract.js';

databaseContract('InMemoryDb', () => new InMemoryDb());

// Re-export the shippable in-memory Database adapter so tests and the contract
// suite share one implementation (no duplicate fake to drift out of sync).
export { InMemoryDb } from '../../src/adapters/db/in-memory/in-memory-db.js';

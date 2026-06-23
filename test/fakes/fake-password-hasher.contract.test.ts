import { passwordHasherContract } from '../contracts/password-hasher-contract.js';
import { FakePasswordHasher } from './fakes.js';

// The fake hasher used in the auth use-case unit tests must be substitutable behind the
// PasswordHasher port (LSP) — it passes the SAME contract suite the real Argon2idHasher
// does, so a use-case wired to either behaves identically. `makeWeakerHasher` returns a
// different param-version so the `needsRehash` rows exercise the version mismatch.
passwordHasherContract(
  'FakePasswordHasher',
  () => new FakePasswordHasher(2),
  () => new FakePasswordHasher(1),
);

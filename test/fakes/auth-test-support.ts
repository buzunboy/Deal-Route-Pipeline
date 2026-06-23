import { generateKeyPair, exportPKCS8 } from 'jose';
import { JoseTokenIssuer } from '../../src/adapters/security/jose-token-issuer.js';
import type { Clock } from '../../src/application/ports/index.js';
import { InMemoryDb } from '../../src/adapters/db/in-memory/in-memory-db.js';
import {
  SYSTEM_ROLE_ADMIN_ID,
  SYSTEM_ROLE_REVIEWER_ID,
  type User,
  type UserStatus,
} from '../../src/domain/index.js';
import { FakePasswordHasher } from './fakes.js';

export const TEST_ISS = 'dealroute-pipeline';
export const TEST_AUD = 'dealroute-panel';
export const TEST_KID = 'test-key-1';

/**
 * Generate a real ES256 keypair and return a factory for a `JoseTokenIssuer` wired to a
 * given Clock — used by the auth use-case + HTTP unit tests so token signing/verification
 * is REAL (not a divergent fake) but deterministic under a `FixedClock`. One keypair per
 * call; await once in a `beforeAll`.
 */
export async function makeTestTokenIssuerFactory(): Promise<(clock: Clock) => JoseTokenIssuer> {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  const pkcs8 = await exportPKCS8(privateKey);
  return (clock: Clock) =>
    new JoseTokenIssuer(
      {
        privateKey: pkcs8,
        kid: TEST_KID,
        iss: TEST_ISS,
        aud: TEST_AUD,
        clockToleranceSeconds: 5,
      },
      clock,
    );
}

/** The TTL/lockout/realm config the auth use-case tests pass (named, no magic numbers). */
export const TEST_AUTH_TTLS = { accessSeconds: 900, refreshSeconds: 604800 };
export const TEST_LOCKOUT = { maxFailedAttempts: 5, lockoutSeconds: 900 };
export const TEST_REALM = { iss: TEST_ISS, aud: TEST_AUD };

export interface SeedUserOptions {
  id?: string;
  name?: string;
  email: string;
  password?: string;
  roleId?: string;
  status?: UserStatus;
}

/**
 * Seed an `active` reviewer (or admin) into an `InMemoryDb`, hashing the password through
 * the given fake hasher so a later login verifies it. Returns the created `User` + the
 * plaintext password (for the login call). The roles/perms are already seeded by the
 * `InMemoryDb` constructor (the SYSTEM_ROLES baseline).
 */
export async function seedActiveUser(
  db: InMemoryDb,
  hasher: FakePasswordHasher,
  opts: SeedUserOptions,
): Promise<{ user: User; password: string }> {
  const password = opts.password ?? 'correct-horse-battery-staple';
  const user: User = {
    id: opts.id ?? '11111111-1111-4111-8111-111111111111',
    name: opts.name ?? 'Reviewer Rita',
    email: opts.email,
    role_id: opts.roleId ?? SYSTEM_ROLE_REVIEWER_ID,
    status: opts.status ?? 'active',
    auth_provider: 'password',
    google_sub: null,
    token_version: 0,
    created_at: '2026-06-01T00:00:00.000Z',
  };
  await db.users.insert(user, await hasher.hash(password));
  return { user, password };
}

export { SYSTEM_ROLE_ADMIN_ID, SYSTEM_ROLE_REVIEWER_ID };

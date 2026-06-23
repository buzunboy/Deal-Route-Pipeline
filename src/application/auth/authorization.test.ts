import { describe, it, expect, beforeEach } from 'vitest';
import { AuthorizationUseCase } from './authorization.js';
import { InMemoryDb } from '../../adapters/db/in-memory/in-memory-db.js';
import {
  ALL_PERMISSIONS,
  REVIEWER_PERMISSIONS,
  SYSTEM_ROLE_ADMIN_ID,
  SYSTEM_ROLE_REVIEWER_ID,
} from '../../domain/index.js';
import { FakePasswordHasher } from '../../../test/fakes/fakes.js';
import { seedActiveUser } from '../../../test/fakes/auth-test-support.js';

describe('AuthorizationUseCase', () => {
  let db: InMemoryDb;
  let hasher: FakePasswordHasher;
  let uc: AuthorizationUseCase;

  beforeEach(() => {
    db = new InMemoryDb();
    hasher = new FakePasswordHasher();
    uc = new AuthorizationUseCase(db);
  });

  it('an admin user resolves to ALL permissions', async () => {
    const { user } = await seedActiveUser(db, hasher, {
      email: 'admin@dealroute.de',
      roleId: SYSTEM_ROLE_ADMIN_ID,
    });
    const perms = await uc.permissionsForUser(user.id);
    expect(perms.size).toBe(ALL_PERMISSIONS.length);
    for (const p of ALL_PERMISSIONS) expect(perms.has(p)).toBe(true);
  });

  it('a reviewer resolves to exactly the reviewer bundle', async () => {
    const { user } = await seedActiveUser(db, hasher, {
      email: 'rita@dealroute.de',
      roleId: SYSTEM_ROLE_REVIEWER_ID,
    });
    const perms = await uc.permissionsForUser(user.id);
    expect([...perms].sort()).toEqual([...REVIEWER_PERMISSIONS].sort());
    // A reviewer must NOT carry an admin-only permission.
    expect(perms.has('roles:manage')).toBe(false);
    expect(perms.has('team:manage')).toBe(false);
  });

  it('an unknown user → empty set (deny by default)', async () => {
    const perms = await uc.permissionsForUser('00000000-0000-4000-8000-000000000000');
    expect(perms.size).toBe(0);
  });
});

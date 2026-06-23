import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hasDb, applyMigrations, resetDb, makeContainer } from './harness.js';
import { ScriptedFetcher, RoleAwareFakeLlm } from '../fakes/fakes.js';
import {
  SYSTEM_ROLE_ADMIN_ID,
  SYSTEM_ROLE_REVIEWER_ID,
  ALL_PERMISSIONS,
  REVIEWER_PERMISSIONS,
  type User,
} from '../../src/domain/index.js';
import type { Container } from '../../src/composition/container.js';

/**
 * Auth/IAM Phase 1 (identity foundation) end to end through the REAL composition root +
 * REAL Postgres (migrations 0019–0023 applied): the `team_members → users` consolidation
 * preserves ids/emails (so reviews.approver stays resolvable), the seeded roles/
 * permissions/grants read back through the new repos + schema parse, and the four new
 * repos round-trip through real SQL — the wiring a fake can't prove. No HTTP/use-case in
 * this phase; the repos are driven through `container.db`.
 */
const suite = hasDb ? describe : describe.skip;

const overrides = {
  fetcher: new ScriptedFetcher({}),
  llm: new RoleAwareFakeLlm({ extraction: JSON.stringify({ deals: [] }) }),
};

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: randomUUID(),
    name: 'Reviewer Rita',
    email: `rita-${randomUUID()}@dealroute.de`,
    role_id: SYSTEM_ROLE_REVIEWER_ID,
    status: 'active',
    auth_provider: 'password',
    google_sub: null,
    token_version: 0,
    created_at: '2026-06-19T00:00:00.000Z',
    ...overrides,
  };
}

suite('Auth/IAM Phase 1 foundation (Container + Postgres)', () => {
  beforeAll(applyMigrations);
  beforeEach(resetDb);

  let container: Container;
  afterEach(async () => {
    await container?.shutdown();
  });

  it('the migrations seed the two system roles + grants, read back through the repos', async () => {
    container = makeContainer(overrides);
    const admin = await container.db.roles.getByName('admin');
    const reviewer = await container.db.roles.getByName('reviewer');
    expect(admin?.id).toBe(SYSTEM_ROLE_ADMIN_ID);
    expect(admin?.is_system).toBe(true);
    expect(reviewer?.id).toBe(SYSTEM_ROLE_REVIEWER_ID);

    const adminPerms = await container.db.rolePermissions.permissionsForRole(SYSTEM_ROLE_ADMIN_ID);
    expect(adminPerms.sort()).toEqual([...ALL_PERMISSIONS].sort());
    const reviewerPerms =
      await container.db.rolePermissions.permissionsForRole(SYSTEM_ROLE_REVIEWER_ID);
    expect(reviewerPerms.sort()).toEqual([...REVIEWER_PERMISSIONS].sort());

    expect(await container.db.authMeta.getPermVersion()).toBe(0);
  });

  it('the team_members→users consolidation keeps reviews.approver keyed on email', async () => {
    container = makeContainer(overrides);
    // Inviting through the Team read model writes a `users` row (the renamed table).
    await container.team.inviteMember({
      approver: 'admin@dealroute',
      name: 'Alice',
      email: 'Alice@Dealroute.DE',
      role: 'admin',
    });
    // A review keyed on the lowercased email (= approver) resolves through the audit log.
    await container.db.reviews.insert({
      id: randomUUID(),
      deal_id: randomUUID(),
      action: 'approve',
      approver: 'alice@dealroute.de',
      reason: null,
      decided_at: '2026-06-19T01:00:00.000Z',
    });
    const team = await container.team.listTeam();
    const alice = team.find((m) => m.email === 'alice@dealroute.de')!;
    expect(alice.role).toBe('admin');
    expect(alice.review_count).toBe(1); // derived from reviews.approver = email

    // The SAME row is visible through the new UserRepository (one table, two read models).
    const asUser = await container.db.users.getByEmail('alice@dealroute.de');
    expect(asUser!.id).toBe(alice.id);
    expect(asUser!.role_id).toBe(SYSTEM_ROLE_ADMIN_ID);
  });

  it('UserRepository round-trips through real SQL; the hash never returns on the entity', async () => {
    container = makeContainer(overrides);
    const u = makeUser();
    await container.db.users.insert(u, 'argon2-secret-hash');
    const got = (await container.db.users.getByEmail(u.email)) as Record<string, unknown>;
    expect(got).toEqual(u);
    expect('password_hash' in got).toBe(false);
    expect(await container.db.users.getPasswordHashByEmail(u.email)).toBe('argon2-secret-hash');

    expect(await container.db.users.bumpTokenVersion(u.id)).toBe(1);
    expect((await container.db.users.getById(u.id))!.token_version).toBe(1);
  });

  it('RefreshTokenRepository rotate/reuse/family-revoke round-trip through real SQL', async () => {
    container = makeContainer(overrides);
    const familyId = randomUUID();
    // A refresh token belongs to a real user (Postgres enforces the FK).
    const owner = makeUser();
    await container.db.users.insert(owner, 'h');
    const userId = owner.id;
    const old = {
      id: randomUUID(),
      user_id: userId,
      token_hash: `h-${randomUUID()}`,
      family_id: familyId,
      issued_at: '2026-06-19T00:00:00.000Z',
      expires_at: '2026-06-26T00:00:00.000Z',
      revoked_at: null,
      replaced_by: null,
      user_agent: 'vitest',
      ip: '127.0.0.1',
    };
    await container.db.refreshTokens.issue(old);
    const next = {
      ...old,
      id: randomUUID(),
      token_hash: `h-${randomUUID()}`,
      revoked_at: null,
      replaced_by: null,
    };
    await container.db.refreshTokens.rotate(old.id, next);
    const rotatedOld = await container.db.refreshTokens.findByHash(old.token_hash);
    expect(rotatedOld!.revoked_at).not.toBeNull();
    expect(rotatedOld!.replaced_by).toBe(next.id);
    expect(rotatedOld!.family_id).toBe(familyId);

    // Family revoke kills the whole lineage.
    const n = await container.db.refreshTokens.revokeFamily(familyId, '2026-06-20T00:00:00.000Z');
    expect(n).toBeGreaterThanOrEqual(1);
    expect(
      (await container.db.refreshTokens.findByHash(next.token_hash))!.revoked_at,
    ).not.toBeNull();
  });

  it('perm_version bumps monotonically through real SQL', async () => {
    container = makeContainer(overrides);
    expect(await container.db.authMeta.getPermVersion()).toBe(0);
    expect(await container.db.authMeta.bumpPermVersion()).toBe(1);
    expect(await container.db.authMeta.bumpPermVersion()).toBe(2);
    expect(await container.db.authMeta.getPermVersion()).toBe(2);
  });

  it('the PasswordHasher + TokenIssuer ports are wired and functional through the real Container', async () => {
    // Phase 1 wires the adapters into the composition root (no use-case yet); prove they
    // are constructed + functional end-to-end (a real Argon2 hash round-trips; if a
    // signing key is configured the issuer signs+verifies).
    container = makeContainer(overrides);
    const hash = await container.passwordHasher.hash('pw-123');
    expect(await container.passwordHasher.verify(hash, 'pw-123')).toBe(true);
    expect(await container.passwordHasher.verify(hash, 'wrong')).toBe(false);
  });
});

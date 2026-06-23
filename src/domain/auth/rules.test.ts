import { describe, it, expect } from 'vitest';
import {
  permissionsForRole,
  hasPermission,
  lockoutPolicy,
  buildAccessClaims,
  validateRefreshRotation,
  type RolePermissionGrant,
  type LockoutConfig,
} from './rules.js';
import { ALL_PERMISSIONS, Permission } from './permission.js';
import { AccessClaimsSchema } from './access-claims.js';
import type { User } from './user.js';
import type { StoredRefresh } from './refresh-token.js';

const ADMIN_ROLE = '11111111-1111-1111-1111-111111111111';
const REVIEWER_ROLE = '22222222-2222-2222-2222-222222222222';

function grant(roleId: string, key: Permission): RolePermissionGrant {
  return { role_id: roleId, permission_key: key };
}

const user: User = {
  id: '33333333-3333-3333-3333-333333333333',
  name: 'Reviewer Rita',
  email: 'rita@dealroute.de',
  role_id: REVIEWER_ROLE,
  status: 'active',
  auth_provider: 'password',
  google_sub: null,
  token_version: 3,
  created_at: '2026-01-01T00:00:00.000Z',
};

describe('permissionsForRole', () => {
  const grants: RolePermissionGrant[] = [
    grant(ADMIN_ROLE, 'candidate:approve'),
    grant(ADMIN_ROLE, 'roles:manage'),
    grant(REVIEWER_ROLE, 'candidate:approve'),
    grant(REVIEWER_ROLE, 'candidate:reject'),
  ];

  it('resolves only the rows for the asked-for role', () => {
    expect([...permissionsForRole(REVIEWER_ROLE, grants)].sort()).toEqual([
      'candidate:approve',
      'candidate:reject',
    ]);
  });

  it('admin (the all-grants seed) yields every permission', () => {
    const all = ALL_PERMISSIONS.map((p) => grant(ADMIN_ROLE, p));
    const set = permissionsForRole(ADMIN_ROLE, all);
    expect(set.size).toBe(ALL_PERMISSIONS.length);
    for (const p of ALL_PERMISSIONS) expect(set.has(p)).toBe(true);
  });

  it('an unknown role yields the empty set (deny by default)', () => {
    expect(permissionsForRole('no-such-role', grants).size).toBe(0);
  });

  it('is order-independent and deduplicated', () => {
    const dup = [
      grant(REVIEWER_ROLE, 'candidate:approve'),
      grant(REVIEWER_ROLE, 'candidate:approve'),
      grant(REVIEWER_ROLE, 'candidate:reject'),
    ];
    const reversed = [...dup].reverse();
    expect([...permissionsForRole(REVIEWER_ROLE, dup)].sort()).toEqual(
      [...permissionsForRole(REVIEWER_ROLE, reversed)].sort(),
    );
    expect(permissionsForRole(REVIEWER_ROLE, dup).size).toBe(2);
  });
});

describe('hasPermission', () => {
  it('is true when present, false when absent', () => {
    const perms = new Set<Permission>(['candidate:approve']);
    expect(hasPermission(perms, 'candidate:approve')).toBe(true);
    expect(hasPermission(perms, 'roles:manage')).toBe(false);
  });

  it('is false against the empty set for every key (deny by default — exhaustive)', () => {
    const empty = new Set<Permission>();
    for (const p of ALL_PERMISSIONS) expect(hasPermission(empty, p)).toBe(false);
  });

  it('every Permission key is decidable against a full set', () => {
    const full = new Set<Permission>(ALL_PERMISSIONS);
    for (const p of ALL_PERMISSIONS) expect(hasPermission(full, p)).toBe(true);
  });
});

describe('lockoutPolicy', () => {
  const config: LockoutConfig = { maxFailedAttempts: 5, lockoutSeconds: 900 };
  const lastFailed = new Date('2026-06-19T12:00:00.000Z');

  it('not locked below the threshold', () => {
    expect(lockoutPolicy(4, lastFailed, lastFailed, config)).toEqual({
      locked: false,
      lockedUntil: null,
    });
  });

  it('not locked when there is no last-failed timestamp (even at threshold)', () => {
    expect(lockoutPolicy(5, null, lastFailed, config).locked).toBe(false);
  });

  it('locked at the threshold, within the window', () => {
    const now = new Date('2026-06-19T12:05:00.000Z'); // 5 min in, window is 15 min
    const d = lockoutPolicy(5, lastFailed, now, config);
    expect(d.locked).toBe(true);
    expect(d.lockedUntil?.toISOString()).toBe('2026-06-19T12:15:00.000Z');
  });

  it('locked above the threshold too', () => {
    const now = new Date('2026-06-19T12:05:00.000Z');
    expect(lockoutPolicy(9, lastFailed, now, config).locked).toBe(true);
  });

  it('just BEFORE the window edge ⇒ still locked', () => {
    const justBefore = new Date('2026-06-19T12:14:59.999Z');
    expect(lockoutPolicy(5, lastFailed, justBefore, config).locked).toBe(true);
  });

  it('exactly AT the window edge ⇒ unlocked (boundary is elapsed)', () => {
    const atEdge = new Date('2026-06-19T12:15:00.000Z');
    expect(lockoutPolicy(5, lastFailed, atEdge, config)).toEqual({
      locked: false,
      lockedUntil: null,
    });
  });

  it('after the window fully elapses ⇒ unlocked (auto-unlock)', () => {
    const after = new Date('2026-06-19T13:00:00.000Z');
    expect(lockoutPolicy(9, lastFailed, after, config).locked).toBe(false);
  });
});

describe('buildAccessClaims', () => {
  const now = new Date('2026-06-19T00:00:00.000Z'); // iat = 1750000000-ish
  const base = {
    user,
    perms: new Set<Permission>(['candidate:reject', 'candidate:approve']),
    roleName: 'reviewer',
    permVersion: 12,
    now,
    ttlSeconds: 900,
    jti: 'jti-abc',
    iss: 'dealroute-pipeline',
    aud: 'dealroute-panel',
  };

  it('produces the exact pinned claim shape that re-validates', () => {
    const claims = buildAccessClaims(base);
    expect(() => AccessClaimsSchema.parse(claims)).not.toThrow();
    expect(claims.iss).toBe('dealroute-pipeline');
    expect(claims.aud).toBe('dealroute-panel');
    expect(claims.sub).toBe(user.id);
    expect(claims.email).toBe(user.email);
    expect(claims.name).toBe(user.name);
    expect(claims.role).toBe('reviewer');
    expect(claims.token_version).toBe(user.token_version);
    expect(claims.perm_version).toBe(12);
    expect(claims.jti).toBe('jti-abc');
  });

  it('exp === iat + ttl, both whole epoch seconds', () => {
    const claims = buildAccessClaims(base);
    expect(claims.iat).toBe(Math.floor(now.getTime() / 1000));
    expect(claims.exp).toBe(claims.iat + 900);
    expect(Number.isInteger(claims.iat)).toBe(true);
    expect(Number.isInteger(claims.exp)).toBe(true);
  });

  it('perms are deterministically sorted (stable across input order)', () => {
    const a = buildAccessClaims(base);
    const b = buildAccessClaims({
      ...base,
      perms: new Set<Permission>(['candidate:approve', 'candidate:reject']),
    });
    expect(a.perms).toEqual(['candidate:approve', 'candidate:reject']);
    expect(a.perms).toEqual(b.perms);
  });

  it('never carries a secret — keys are exactly the closed claim set', () => {
    const claims = buildAccessClaims(base) as Record<string, unknown>;
    expect(Object.keys(claims).sort()).toEqual(
      [
        'aud',
        'email',
        'exp',
        'iat',
        'iss',
        'jti',
        'name',
        'perm_version',
        'perms',
        'role',
        'sub',
        'token_version',
      ].sort(),
    );
    expect('password_hash' in claims).toBe(false);
  });
});

describe('validateRefreshRotation', () => {
  const now = new Date('2026-06-19T00:00:00.000Z');
  function stored(overrides: Partial<StoredRefresh> = {}): StoredRefresh {
    return {
      id: '44444444-4444-4444-4444-444444444444',
      user_id: user.id,
      token_hash: 'deadbeef',
      family_id: '55555555-5555-5555-5555-555555555555',
      issued_at: '2026-06-18T00:00:00.000Z',
      expires_at: '2026-06-25T00:00:00.000Z',
      revoked_at: null,
      replaced_by: null,
      user_agent: null,
      ip: null,
      ...overrides,
    };
  }

  it('a missing row ⇒ unknown', () => {
    expect(validateRefreshRotation(null, now)).toBe('unknown');
  });

  it('a current, unexpired row ⇒ ok', () => {
    expect(validateRefreshRotation(stored(), now)).toBe('ok');
  });

  it('a revoked row ⇒ reuse', () => {
    expect(validateRefreshRotation(stored({ revoked_at: '2026-06-18T01:00:00.000Z' }), now)).toBe(
      'reuse',
    );
  });

  it('a replaced (rotated-out) row ⇒ reuse', () => {
    expect(
      validateRefreshRotation(stored({ replaced_by: '66666666-6666-6666-6666-666666666666' }), now),
    ).toBe('reuse');
  });

  it('reuse takes precedence over expiry (a replayed-and-expired token is theft)', () => {
    const replayedExpired = stored({
      revoked_at: '2026-06-18T01:00:00.000Z',
      expires_at: '2026-06-18T00:00:00.000Z', // also expired
    });
    expect(validateRefreshRotation(replayedExpired, now)).toBe('reuse');
  });

  it('a current row past its expiry ⇒ expired', () => {
    expect(validateRefreshRotation(stored({ expires_at: '2026-06-18T00:00:00.000Z' }), now)).toBe(
      'expired',
    );
  });

  it('the expiry boundary instant counts as expired', () => {
    expect(validateRefreshRotation(stored({ expires_at: now.toISOString() }), now)).toBe('expired');
  });
});

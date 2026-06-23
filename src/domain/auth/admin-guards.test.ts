import { describe, it, expect } from 'vitest';
import {
  validatePasswordPolicy,
  wouldRemoveLastHolder,
  wouldRoleEditRemoveLastHolder,
  CRITICAL_ADMIN_PERMISSIONS,
  type ActiveUserPermissions,
  type ActiveUserRole,
} from './admin-guards.js';
import type { Permission } from './permission.js';

describe('validatePasswordPolicy', () => {
  it('accepts a password at or above the length floor', () => {
    expect(validatePasswordPolicy('123456789012', { minLength: 12 })).toEqual({ ok: true });
    expect(validatePasswordPolicy('1234567890123', { minLength: 12 })).toEqual({ ok: true });
  });

  it('rejects a password below the floor with a safe reason', () => {
    const r = validatePasswordPolicy('short', { minLength: 12 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('at least 12');
  });

  it('treats the boundary length as the exact off-by-one edge', () => {
    expect(validatePasswordPolicy('12345678901', { minLength: 12 }).ok).toBe(false); // 11
    expect(validatePasswordPolicy('123456789012', { minLength: 12 }).ok).toBe(true); // 12
  });
});

describe('CRITICAL_ADMIN_PERMISSIONS', () => {
  it('protects both the roles and team management keys', () => {
    expect([...CRITICAL_ADMIN_PERMISSIONS].sort()).toEqual(['roles:manage', 'team:manage']);
  });
});

describe('wouldRemoveLastHolder', () => {
  const perms = (...keys: Permission[]): ReadonlySet<Permission> => new Set(keys);
  const users = (...u: ActiveUserPermissions[]): ActiveUserPermissions[] => u;

  it('refuses when the target is the ONLY active holder', () => {
    const active = users({ userId: 'admin', perms: perms('roles:manage', 'team:manage') });
    expect(wouldRemoveLastHolder(active, 'admin', 'roles:manage')).toBe(true);
    expect(wouldRemoveLastHolder(active, 'admin', 'team:manage')).toBe(true);
  });

  it('allows when ANOTHER active user still holds the permission', () => {
    const active = users(
      { userId: 'admin1', perms: perms('roles:manage', 'team:manage') },
      { userId: 'admin2', perms: perms('roles:manage', 'team:manage') },
    );
    expect(wouldRemoveLastHolder(active, 'admin1', 'roles:manage')).toBe(false);
    expect(wouldRemoveLastHolder(active, 'admin1', 'team:manage')).toBe(false);
  });

  it('allows when the target does not hold the permission at all', () => {
    const active = users(
      { userId: 'reviewer', perms: perms('candidate:approve') },
      { userId: 'admin', perms: perms('roles:manage') },
    );
    expect(wouldRemoveLastHolder(active, 'reviewer', 'roles:manage')).toBe(false);
  });

  it('allows when the target is not in the active set (already inactive)', () => {
    const active = users({ userId: 'admin', perms: perms('roles:manage') });
    expect(wouldRemoveLastHolder(active, 'ghost', 'roles:manage')).toBe(false);
  });

  it('counts per-permission independently (last team:manage but not last roles:manage)', () => {
    const active = users(
      // admin1 is the only team:manage holder; admin2 also has roles:manage.
      { userId: 'admin1', perms: perms('roles:manage', 'team:manage') },
      { userId: 'admin2', perms: perms('roles:manage') },
    );
    expect(wouldRemoveLastHolder(active, 'admin1', 'team:manage')).toBe(true); // last team:manage
    expect(wouldRemoveLastHolder(active, 'admin1', 'roles:manage')).toBe(false); // admin2 has it
  });

  it('does not count an empty active set as a holder', () => {
    expect(wouldRemoveLastHolder([], 'anyone', 'roles:manage')).toBe(false);
  });
});

describe('wouldRoleEditRemoveLastHolder', () => {
  const perms = (...keys: Permission[]): ReadonlySet<Permission> => new Set(keys);
  const u = (userId: string, roleId: string, ...keys: Permission[]): ActiveUserRole => ({
    userId,
    roleId,
    perms: perms(...keys),
  });

  it('refuses when the edited role is the ONLY source of the critical perm', () => {
    // Everyone with roles:manage is in role "superadmin"; editing it out empties the perm.
    const active = [u('a1', 'superadmin', 'roles:manage'), u('a2', 'superadmin', 'roles:manage')];
    expect(wouldRoleEditRemoveLastHolder(active, 'superadmin', 'roles:manage')).toBe(true);
  });

  it('allows when an active user OUTSIDE the role still holds the perm', () => {
    const active = [
      u('a1', 'superadmin', 'roles:manage'),
      u('a2', 'admin', 'roles:manage'), // a different role still grants it
    ];
    expect(wouldRoleEditRemoveLastHolder(active, 'superadmin', 'roles:manage')).toBe(false);
  });

  it('allows when no active user in the role holds the perm (nothing to lose)', () => {
    const active = [u('r1', 'reviewer', 'candidate:approve')];
    expect(wouldRoleEditRemoveLastHolder(active, 'reviewer', 'roles:manage')).toBe(false);
  });

  it('does not count a holder in the SAME role as an outside holder', () => {
    // Two users both in the edited role; neither survives the edit ⇒ lockout.
    const active = [u('a1', 'superadmin', 'team:manage'), u('a2', 'superadmin', 'team:manage')];
    expect(wouldRoleEditRemoveLastHolder(active, 'superadmin', 'team:manage')).toBe(true);
  });

  it('empty active set is never a lockout', () => {
    expect(wouldRoleEditRemoveLastHolder([], 'any', 'roles:manage')).toBe(false);
  });
});

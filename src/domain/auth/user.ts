import { z } from 'zod';

/**
 * A user — the login-capable account that supersedes `team-member.ts` (Auth/IAM,
 * the `team_members → users` consolidation in migration 0019). `User` is a strict
 * superset of the old `TeamMember`: every preserved field keeps the SAME name and
 * type, so existing read paths keep working and — critically — `reviews.approver`
 * stays keyed on `email`. `role` (the old inline enum) becomes `role_id` (a FK into
 * the `roles` table) for permission-based RBAC.
 *
 * THE PASSWORD HASH IS NEVER ON THIS ENTITY. It lives only in the `users.password_hash`
 * column, read/written exclusively through the `UserRepository` + `PasswordHasher`
 * boundary — so a hash can never leak through a DTO, a log line, or the claim set.
 */
export const UserStatus = z.enum([
  /** Has signed in / been activated; the only status that may authenticate. */
  'active',
  /** Provisioned but not yet activated. */
  'invited',
  /** Deactivated — a disabled user 401s on every request (see `token_version`). */
  'disabled',
]);
export type UserStatus = z.infer<typeof UserStatus>;

export const AuthProvider = z.enum(['password', 'google']);
export type AuthProvider = z.infer<typeof AuthProvider>;

export const UserSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  /** The auth identity — `reviews.approver` keys on this. UNCHANGED from TeamMember. */
  email: z.string().email(),
  /** FK → roles.id (permission-based RBAC), replacing the old inline role enum. */
  role_id: z.string().uuid(),
  status: UserStatus,
  auth_provider: AuthProvider.default('password'),
  /** OIDC subject (Google SSO, P6); null until SSO links an account. */
  google_sub: z.string().nullable().default(null),
  /** Immediate-revocation lever: bumped on disable / role change / password change. */
  token_version: z.number().int().nonnegative().default(0),
  /** ISO-8601 creation timestamp. UNCHANGED from TeamMember. */
  created_at: z.string().min(1),
});
export type User = z.infer<typeof UserSchema>;

import { Container } from '../../../composition/container.js';
import type { Config } from '../../../config/index.js';
import { UserSchema, type User } from '../../../domain/index.js';
import { newId } from '../../../application/index.js';

/** Args for `seed-user` — everything the command needs to mint one login-capable account. */
export interface SeedUserOptions {
  email: string;
  name: string;
  /** A role NAME ('admin' | 'reviewer' | a custom role). Must already exist. */
  role: string;
  password: string;
}

/**
 * `seed-user` — create ONE login-capable user (email + name + role + password) through the
 * REAL `PasswordHasher` (Argon2id) + `UserRepository`, reusing the Phase-1 system roles that
 * the migrations seed. This is the ops/seed escape hatch the acceptance proof uses to mint a
 * login WITHOUT hand-crafted SQL — it is NOT the Phase-3 admin API (no HTTP, no RBAC checks
 * beyond "the role must exist").
 *
 * Trust: the password is hashed (never stored plain); the role must already exist (a typo is
 * a loud error, not a broken account); a duplicate email is refused (no silent overwrite of
 * an existing reviewer's credentials). Status is `active`, so the user can log in immediately.
 */
export async function seedUser(config: Config, opts: SeedUserOptions): Promise<void> {
  const email = opts.email.trim().toLowerCase();
  const name = opts.name.trim();
  if (name === '') throw new Error('seed-user: --name is required.');
  if (opts.password.length < config.auth.passwordPolicy.minLength) {
    throw new Error(
      `seed-user: --password must be at least ${config.auth.passwordPolicy.minLength} characters.`,
    );
  }

  const container = new Container(config, { usePersistence: true });
  try {
    const role = await container.db.roles.getByName(opts.role.trim());
    if (role === null) {
      const names = (await container.db.roles.list()).map((r) => r.name).join(', ');
      throw new Error(`seed-user: unknown role "${opts.role}". Known roles: ${names || '(none)'}`);
    }

    const existing = await container.db.users.getByEmail(email);
    if (existing !== null) {
      throw new Error(`seed-user: a user already exists with email "${email}".`);
    }

    // Boundary-validate the assembled user through the domain schema before persisting.
    const user: User = UserSchema.parse({
      id: newId(),
      name,
      email,
      role_id: role.id,
      status: 'active',
      auth_provider: 'password',
      google_sub: null,
      token_version: 0,
      created_at: container.clock.nowIso(),
    });
    const passwordHash = await container.passwordHasher.hash(opts.password);
    await container.db.users.insert(user, passwordHash);

    console.log(`Created user ${user.email} (${role.name}) — can now POST /auth/login.`);
  } finally {
    await container.shutdown();
  }
}

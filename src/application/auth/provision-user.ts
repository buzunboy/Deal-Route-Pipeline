import {
  UserSchema,
  validatePasswordPolicy,
  InvalidPatchError,
  UserAlreadyExistsError,
  RoleNotFoundError,
  type User,
  type PasswordPolicy,
} from '../../domain/index.js';
import type { Database, PasswordHasher, Clock, Logger } from '../ports/index.js';
import { randomUUID } from 'node:crypto';

/**
 * Inputs to provision a login-capable user (Auth/IAM, Phase 3). `actor` is the
 * TOKEN-DERIVED admin email (for the audit line) — never a body value. The HTTP layer
 * passes `identity.email`; nothing here trusts a body-supplied actor or role-beyond-self.
 */
export interface ProvisionUserInput {
  actor: string;
  name: string;
  email: string;
  /** A role NAME ('admin' | 'reviewer' | a custom role). Must already exist. */
  roleName: string;
  /** The admin-set initial password (validated against the policy, then Argon2id-hashed). */
  initialPassword: string;
}

/**
 * `ProvisionUserUseCase` (Auth/IAM, Phase 3) — the headline self-service-provisioning
 * use-case. One admin action creates a login-capable account (name/email/role +
 * admin-set initial password): the user can `POST /auth/login` immediately, and their
 * role is enforced on every subsequent pipeline request.
 *
 * Trust paths: a duplicate email is refused (no silent credential overwrite); an unknown
 * role is rejected (a typo can't create a permission-less account); the password is
 * validated against the policy then Argon2id-hashed (never stored plain, never on the
 * returned `User`); the assembled `User` is boundary-validated through the domain schema
 * before it touches the store. Status is `active` (the admin set the password), so it's
 * login-capable at once. Mirrors `TeamUseCase.inviteMember`'s normalisation + validation.
 */
export class ProvisionUserUseCase {
  constructor(
    private readonly db: Database,
    private readonly hasher: PasswordHasher,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly passwordPolicy: PasswordPolicy,
  ) {}

  async provision(input: ProvisionUserInput): Promise<User> {
    const email = input.email.trim().toLowerCase();
    const name = input.name.trim();
    if (name === '') throw new InvalidPatchError('name is required', ['name']);

    // Validate the password BEFORE any DB work so a weak password never half-creates a row.
    const policy = validatePasswordPolicy(input.initialPassword, this.passwordPolicy);
    if (!policy.ok) throw new InvalidPatchError(policy.reason, ['password']);

    // The role must exist (a 404/400, not a dangling FK). Resolve the name → id.
    const role = await this.db.roles.getByName(input.roleName.trim());
    if (role === null) throw new RoleNotFoundError(input.roleName);

    // Refuse a duplicate email (the natural identity / `reviews.approver` key).
    const existing = await this.db.users.getByEmail(email);
    if (existing !== null) throw new UserAlreadyExistsError(email);

    // Boundary-validate the assembled user through the domain schema (rejects a non-email
    // / blank name) before persisting — never trust assembled input at the store boundary.
    const user: User = UserSchema.parse({
      id: randomUUID(),
      name,
      email,
      role_id: role.id,
      status: 'active',
      auth_provider: 'password',
      google_sub: null,
      token_version: 0,
      created_at: this.clock.nowIso(),
    });
    const passwordHash = await this.hasher.hash(input.initialPassword);
    await this.db.users.insert(user, passwordHash);

    this.logger.info('user provisioned', { actor: input.actor, email, role: role.name });
    return user;
  }
}

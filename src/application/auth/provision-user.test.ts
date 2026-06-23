import { describe, it, expect, beforeEach } from 'vitest';
import { ProvisionUserUseCase } from './provision-user.js';
import { InMemoryDb } from '../../adapters/db/in-memory/in-memory-db.js';
import {
  InvalidPatchError,
  UserAlreadyExistsError,
  RoleNotFoundError,
  SYSTEM_ROLE_REVIEWER_ID,
} from '../../domain/index.js';
import { FakePasswordHasher, FakeLogger, FixedClock } from '../../../test/fakes/fakes.js';

const PASSWORD_POLICY = { minLength: 12 };

describe('ProvisionUserUseCase', () => {
  let db: InMemoryDb;
  let hasher: FakePasswordHasher;
  let useCase: ProvisionUserUseCase;

  beforeEach(() => {
    db = new InMemoryDb();
    hasher = new FakePasswordHasher();
    useCase = new ProvisionUserUseCase(
      db,
      hasher,
      new FixedClock(),
      new FakeLogger(),
      PASSWORD_POLICY,
    );
  });

  const validInput = {
    actor: 'admin@dealroute.test',
    name: 'Sam Reviewer',
    email: 'sam@dealroute.test',
    roleName: 'reviewer',
    initialPassword: 'sam-password-123',
  };

  it('creates a login-capable active user with the requested role', async () => {
    const user = await useCase.provision(validInput);
    expect(user.email).toBe('sam@dealroute.test');
    expect(user.role_id).toBe(SYSTEM_ROLE_REVIEWER_ID);
    expect(user.status).toBe('active');
    // The hash is stored (never on the returned entity) and verifies the password.
    expect(user).not.toHaveProperty('password_hash');
    const storedHash = await db.users.getPasswordHashByEmail('sam@dealroute.test');
    expect(storedHash).not.toBeNull();
    expect(await hasher.verify(storedHash!, 'sam-password-123')).toBe(true);
  });

  it('normalises the email (trim + lowercase)', async () => {
    const user = await useCase.provision({ ...validInput, email: '  SAM@Dealroute.Test  ' });
    expect(user.email).toBe('sam@dealroute.test');
  });

  it('rejects a duplicate email with UserAlreadyExistsError', async () => {
    await useCase.provision(validInput);
    await expect(useCase.provision(validInput)).rejects.toBeInstanceOf(UserAlreadyExistsError);
  });

  it('rejects an unknown role with RoleNotFoundError', async () => {
    await expect(useCase.provision({ ...validInput, roleName: 'nope' })).rejects.toBeInstanceOf(
      RoleNotFoundError,
    );
  });

  it('rejects a password below the policy floor (never half-creates a row)', async () => {
    await expect(
      useCase.provision({ ...validInput, initialPassword: 'short' }),
    ).rejects.toBeInstanceOf(InvalidPatchError);
    expect(await db.users.getByEmail('sam@dealroute.test')).toBeNull();
  });

  it('rejects a blank name', async () => {
    await expect(useCase.provision({ ...validInput, name: '   ' })).rejects.toBeInstanceOf(
      InvalidPatchError,
    );
  });

  it('rejects a malformed email at the schema boundary', async () => {
    await expect(useCase.provision({ ...validInput, email: 'not-an-email' })).rejects.toBeTruthy();
    expect(await db.users.list()).toHaveLength(0);
  });
});

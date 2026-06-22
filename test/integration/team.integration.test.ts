import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { hasDb, applyMigrations, resetDb, makeContainer } from './harness.js';
import { ScriptedFetcher, RoleAwareFakeLlm } from '../fakes/fakes.js';
import type { Container } from '../../src/composition/container.js';

/**
 * Team registry + profile (ACR-10 Team / ACR-11 Profile) end to end through the REAL
 * composition root + REAL Postgres (migration 0016 / team_members applied): invite a
 * member, derive its review_count from the reviews audit log, update its profile name.
 */
const suite = hasDb ? describe : describe.skip;

const overrides = {
  fetcher: new ScriptedFetcher({}),
  llm: new RoleAwareFakeLlm({ extraction: JSON.stringify({ deals: [] }) }),
};

suite('team registry + profile (Container + Postgres)', () => {
  beforeAll(applyMigrations);
  beforeEach(resetDb);

  let container: Container;
  afterEach(async () => {
    await container?.shutdown();
  });

  it('invite → listTeam derives review_count → updateProfile renames, over real SQL', async () => {
    container = makeContainer(overrides);
    await container.team.inviteMember({
      approver: 'admin@dealroute',
      name: 'Alice',
      email: 'Alice@Dealroute.DE',
      role: 'admin',
    });
    // a real review by that member (keyed by lowercased email = approver).
    await container.db.reviews.insert({
      id: randomUUID(),
      deal_id: randomUUID(),
      action: 'approve',
      approver: 'alice@dealroute.de',
      reason: null,
      decided_at: new Date().toISOString(),
    });

    const team = await container.team.listTeam();
    const alice = team.find((m) => m.email === 'alice@dealroute.de')!;
    expect(alice.name).toBe('Alice');
    expect(alice.role).toBe('admin');
    expect(alice.review_count).toBe(1); // derived from the audit log

    const updated = await container.team.updateProfile('alice@dealroute.de', 'Alice Müller');
    expect(updated.name).toBe('Alice Müller');
    expect((await container.db.team.getByEmail('alice@dealroute.de'))!.name).toBe('Alice Müller');

    // re-invite same email keeps the id (idempotent on the natural key).
    const reinvited = await container.team.inviteMember({
      approver: 'admin@dealroute',
      name: 'Alice M.',
      email: 'alice@dealroute.de',
    });
    expect(reinvited.id).toBe(alice.id);
  });
});

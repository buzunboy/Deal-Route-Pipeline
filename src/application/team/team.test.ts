import { describe, it, expect, beforeEach } from 'vitest';
import { TeamUseCase } from './team.js';
import { InMemoryDb } from '../../../test/fakes/in-memory-db.js';
import { FixedClock, FakeLogger } from '../../../test/fakes/fakes.js';
import { randomUUID } from 'node:crypto';

describe('TeamUseCase (ACR-10 Team + ACR-11 Profile)', () => {
  let db: InMemoryDb;
  let uc: TeamUseCase;

  beforeEach(() => {
    db = new InMemoryDb();
    uc = new TeamUseCase(db, new FixedClock(), new FakeLogger());
  });

  it('invites a member (lowercased email, default reviewer role, invited status)', async () => {
    const m = await uc.inviteMember({
      approver: 'admin@dealroute',
      name: 'Alice',
      email: 'Alice@Dealroute.DE',
    });
    expect(m.email).toBe('alice@dealroute.de'); // normalised
    expect(m.role).toBe('reviewer'); // default
    expect(m.status).toBe('invited');
    expect((await db.team.getByEmail('alice@dealroute.de'))!.name).toBe('Alice');
  });

  it('listTeam derives review_count per member from the reviews audit log', async () => {
    await uc.inviteMember({
      approver: 'admin',
      name: 'Alice',
      email: 'alice@dealroute.de',
      role: 'admin',
    });
    await uc.inviteMember({ approver: 'admin', name: 'Bob', email: 'bob@dealroute.de' });
    // Alice has 2 decisions, Bob 0 — keyed by email = approver.
    for (const action of ['approve', 'reject'] as const) {
      await db.reviews.insert({
        id: randomUUID(),
        deal_id: randomUUID(),
        action,
        approver: 'alice@dealroute.de',
        reason: null,
        decided_at: '2026-06-19T00:00:00.000Z',
      });
    }
    const team = await uc.listTeam();
    const byEmail = Object.fromEntries(team.map((m) => [m.email, m]));
    expect(byEmail['alice@dealroute.de']!.review_count).toBe(2);
    expect(byEmail['bob@dealroute.de']!.review_count).toBe(0);
  });

  it('updateProfile changes only the name of an existing member', async () => {
    await uc.inviteMember({ approver: 'admin', name: 'Alice', email: 'alice@dealroute.de' });
    const updated = await uc.updateProfile('alice@dealroute.de', 'Alice Müller');
    expect(updated.name).toBe('Alice Müller');
    expect((await db.team.getByEmail('alice@dealroute.de'))!.name).toBe('Alice Müller');
  });

  it('rejects bad input: unknown role, non-email, blank name, missing approver, unknown profile', async () => {
    await expect(
      uc.inviteMember({ approver: 'a', name: 'X', email: 'x@dealroute.de', role: 'superuser' }),
    ).rejects.toThrow(/role/i);
    await expect(
      uc.inviteMember({ approver: 'a', name: 'X', email: 'not-an-email' }),
    ).rejects.toThrow(/email|invalid/i);
    await expect(
      uc.inviteMember({ approver: '  ', name: 'X', email: 'x@dealroute.de' }),
    ).rejects.toThrow(/approver/i);
    await expect(uc.updateProfile('ghost@dealroute.de', 'Name')).rejects.toThrow(/no team member/i);
  });
});

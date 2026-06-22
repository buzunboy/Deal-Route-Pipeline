import { describe, it, expect, beforeEach } from 'vitest';
import { AlertsUseCase } from './alerts.js';
import { InMemoryDb } from '../../../test/fakes/in-memory-db.js';
import { FixedClock, FakeLogger } from '../../../test/fakes/fakes.js';
import { makeSource } from '../../../test/factories/source.js';
import type { AlertRecord } from '../../domain/index.js';
import { randomUUID } from 'node:crypto';

// FixedClock = 2026-06-19T00:00:00Z, so "today" (UTC) = 2026-06-19.
describe('AlertsUseCase (ACR-8, read-time auto-resolve)', () => {
  let db: InMemoryDb;
  let uc: AlertsUseCase;

  beforeEach(() => {
    db = new InMemoryDb();
    uc = new AlertsUseCase(db, new FixedClock(), new FakeLogger());
  });

  const mkAlert = (over: Partial<AlertRecord>): AlertRecord => ({
    id: randomUUID(),
    dedupe_key: `k:${randomUUID()}`,
    kind: 'source_reliability_low',
    severity: 'warning',
    title: 't',
    summary: 's',
    context: {},
    status: 'open',
    created_at: '2026-06-19T00:00:00.000Z',
    updated_at: '2026-06-19T00:00:00.000Z',
    ...over,
  });

  it('budget alert from a PAST UTC day auto-resolves; today stays open', async () => {
    await db.alerts.upsertOpen(
      mkAlert({ kind: 'daily_budget_reached', created_at: '2026-06-18T12:00:00.000Z' }),
    );
    await db.alerts.upsertOpen(
      mkAlert({ kind: 'daily_budget_reached', created_at: '2026-06-19T08:00:00.000Z' }),
    );
    const { alerts, open_count } = await uc.listAlerts();
    const byDay = alerts.map((a) => `${a.at.slice(0, 10)}:${a.status}`);
    expect(byDay).toContain('2026-06-18:resolved'); // past day → auto-resolved
    expect(byDay).toContain('2026-06-19:open'); // today → still open
    expect(open_count).toBe(1);
  });

  it('reliability alert auto-resolves when its source has recovered (≥ threshold)', async () => {
    const recovered = makeSource({ url: 'https://ok.de', reliability_score: 0.8 });
    const stillLow = makeSource({ url: 'https://bad.de', reliability_score: 0.1 });
    await db.sources.upsert(recovered);
    await db.sources.upsert(stillLow);
    const recoveredAlert = mkAlert({
      context: { source_id: recovered.id },
      dedupe_key: `r:${recovered.id}`,
    });
    const lowAlert = mkAlert({
      context: { source_id: stillLow.id },
      dedupe_key: `r:${stillLow.id}`,
    });
    await db.alerts.upsertOpen(recoveredAlert);
    await db.alerts.upsertOpen(lowAlert);

    const { alerts, open_count } = await uc.listAlerts();
    const byId = Object.fromEntries(alerts.map((a) => [a.id, a.status]));
    expect(byId[recoveredAlert.id]).toBe('resolved'); // source recovered → auto-resolved
    expect(byId[lowAlert.id]).toBe('open'); // still below threshold → open
    expect(open_count).toBe(1);
  });

  it('a reliability alert whose source no longer exists auto-resolves', async () => {
    await db.alerts.upsertOpen(mkAlert({ context: { source_id: randomUUID() } }));
    const { open_count } = await uc.listAlerts();
    expect(open_count).toBe(0);
  });

  it('a manual ack/resolve wins over the auto rule (and over open)', async () => {
    const stillLow = makeSource({ url: 'https://bad.de', reliability_score: 0.1 });
    await db.sources.upsert(stillLow);
    const a = mkAlert({ context: { source_id: stillLow.id } });
    await db.alerts.upsertOpen(a);
    await uc.acknowledge(a.id, 'alice');
    const { alerts } = await uc.listAlerts();
    expect(alerts.find((x) => x.id === a.id)!.status).toBe('acknowledged');
  });

  it('acknowledge/resolve require an approver', async () => {
    const a = mkAlert({});
    await db.alerts.upsertOpen(a);
    await expect(uc.acknowledge(a.id, '  ')).rejects.toThrow(/approver/i);
    await expect(uc.resolve(a.id, '')).rejects.toThrow(/approver/i);
  });
});

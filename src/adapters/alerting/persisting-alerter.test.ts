import { describe, it, expect } from 'vitest';
import { PersistingAlerter } from './persisting-alerter.js';
import { InMemoryDb } from '../db/in-memory/in-memory-db.js';
import { FixedClock, FakeLogger } from '../../../test/fakes/fakes.js';
import { sourceReliabilityLowAlert, type AlertEvent } from '../../domain/index.js';
import type { Alerting } from '../../application/ports/index.js';

class RecordingAlerter implements Alerting {
  events: AlertEvent[] = [];
  async alert(event: AlertEvent): Promise<void> {
    this.events.push(event);
  }
}

class ThrowingAlertRepo {
  async upsertOpen(): Promise<void> {
    throw new Error('db down');
  }
}

const event = () =>
  sourceReliabilityLowAlert({
    sourceId: 'src-1',
    url: 'https://x.de',
    reliability: 0.1,
    nextDue: null,
    at: '2026-06-19T00:00:00.000Z',
  });

describe('PersistingAlerter', () => {
  it('persists the alert (open) AND delegates delivery to the inner alerter', async () => {
    const db = new InMemoryDb();
    const inner = new RecordingAlerter();
    const alerter = new PersistingAlerter(inner, db.alerts, new FixedClock(), new FakeLogger());

    await alerter.alert(event());

    // delivered
    expect(inner.events).toHaveLength(1);
    // persisted as an open row
    const stored = await db.alerts.list(10);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.status).toBe('open');
    expect(stored[0]!.dedupe_key).toBe('source_reliability_low:src-1');
  });

  it('still DELIVERS even if persistence throws (best-effort, never throws)', async () => {
    const inner = new RecordingAlerter();
    const alerter = new PersistingAlerter(
      inner,
      new ThrowingAlertRepo() as never,
      new FixedClock(),
      new FakeLogger(),
    );
    // must not reject despite the repo throwing...
    await expect(alerter.alert(event())).resolves.toBeUndefined();
    // ...and delivery still happened.
    expect(inner.events).toHaveLength(1);
  });
});

import { describe, it, expect } from 'vitest';
import { NoopAlerter } from './noop-alerter.js';
import { sourceReliabilityLowAlert } from '../../domain/index.js';
import { FakeLogger } from '../../../test/fakes/fakes.js';
import { alertingContract } from '../../../test/contracts/alerting-contract.js';

// Noop has no failure mode — it returns the same always-resolving adapter for both
// the ok and failing fixtures (it delivers nowhere, so it can never fail).
alertingContract('NoopAlerter', () => {
  const a = new NoopAlerter(new FakeLogger());
  return { ok: a, failing: a };
});

describe('NoopAlerter', () => {
  it('delivers nowhere but logs at debug so an operator sees it would have fired', async () => {
    const logger = new FakeLogger();
    const alerter = new NoopAlerter(logger);
    await alerter.alert(
      sourceReliabilityLowAlert({
        sourceId: 's1',
        url: 'https://x.de',
        reliability: 0.1,
        nextDue: null,
        at: '2026-06-21T00:00:00.000Z',
      }),
    );
    expect(
      logger.entries.some((e) => e.level === 'debug' && /no alerting backend/.test(e.msg)),
    ).toBe(true);
    // No warn/error — the noop path is not a failure.
    expect(logger.entries.some((e) => e.level === 'error')).toBe(false);
  });
});

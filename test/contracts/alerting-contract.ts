import { describe, it, expect } from 'vitest';
import type { Alerting } from '../../src/application/ports/index.js';
import { sourceReliabilityLowAlert, type AlertEvent } from '../../src/domain/index.js';

/**
 * Shared contract suite for the Alerting port. Every adapter (Noop, Webhook, and
 * any future Datadog/CloudWatch) must satisfy it so implementations are
 * substitutable behind the port (LSP, `testing.md`: adapter contract tests).
 *
 * The load-bearing contract is BEST-EFFORT delivery: `alert()` must RESOLVE and
 * never reject — including when the adapter's delivery path fails — so alerting can
 * never crash or stall the lane it observes. `makeFailing` yields an adapter whose
 * transport is guaranteed to fail (a down/erroring backend); the Noop adapter has no
 * failure mode, so it returns the same always-resolving adapter for both.
 */
export interface AlertingFixture {
  /** A normally-working adapter. */
  ok: Alerting;
  /** An adapter whose delivery WILL fail (e.g. webhook URL errors) — still must resolve. */
  failing: Alerting;
}

const SAMPLE: AlertEvent = sourceReliabilityLowAlert({
  sourceId: 'src-contract',
  url: 'https://example.de/x',
  reliability: 0.05,
  nextDue: null,
  at: '2026-06-21T00:00:00.000Z',
});

export function alertingContract(
  name: string,
  makeFixture: () => AlertingFixture | Promise<AlertingFixture>,
): void {
  describe(`Alerting contract: ${name}`, () => {
    it('alert() resolves for a well-shaped event', async () => {
      const { ok } = await makeFixture();
      await expect(ok.alert(SAMPLE)).resolves.toBeUndefined();
    });

    it('alert() RESOLVES even when delivery fails (best-effort — never throws)', async () => {
      const { failing } = await makeFixture();
      // The whole point: a broken backend must not surface as a rejection the lane
      // would have to catch. This is what lets callers `await alerter.alert(...)`
      // with no try/catch in crawl/monitor/discover.
      await expect(failing.alert(SAMPLE)).resolves.toBeUndefined();
    });

    it('alert() RESOLVES for an event whose context is not JSON-serializable', async () => {
      const { ok } = await makeFixture();
      // `context` is an open object — a (future) builder could put a BigInt/circular
      // value in it. Serialization must not be able to throw past the contract, so an
      // adapter that serializes the event still has to resolve (logging + swallowing).
      const unserializable: AlertEvent = {
        ...SAMPLE,
        context: { bad: BigInt(1) as unknown }, // JSON.stringify throws on a BigInt
      };
      await expect(ok.alert(unserializable)).resolves.toBeUndefined();
    });
  });
}

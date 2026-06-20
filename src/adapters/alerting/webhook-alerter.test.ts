import { describe, it, expect } from 'vitest';
import { WebhookAlerter, toWebhookPayload, type FetchFn } from './webhook-alerter.js';
import {
  sourceReliabilityLowAlert,
  dailyBudgetReachedAlert,
  type AlertEvent,
} from '../../domain/index.js';
import { FakeLogger } from '../../../test/fakes/fakes.js';
import { alertingContract } from '../../../test/contracts/alerting-contract.js';

const URL = 'https://hooks.example.com/abc';
const EVENT = sourceReliabilityLowAlert({
  sourceId: 's1',
  url: 'https://x.de',
  reliability: 0.05,
  nextDue: null,
  at: '2026-06-21T00:00:00.000Z',
});

/** A fetch fake that records calls and returns a scripted Response. */
function recordingFetch(status = 200): {
  fetchFn: FetchFn;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    return new Response('ok', { status });
  };
  return { fetchFn, calls };
}

// Contract: ok = a 200 fetch; failing = a fetch that throws (network error).
alertingContract('WebhookAlerter', () => {
  const okAlerter = new WebhookAlerter(
    { url: URL, timeoutMs: 1000, fetchFn: recordingFetch(200).fetchFn },
    new FakeLogger(),
  );
  const failingAlerter = new WebhookAlerter(
    {
      url: URL,
      timeoutMs: 1000,
      fetchFn: async () => {
        throw new Error('ECONNREFUSED');
      },
    },
    new FakeLogger(),
  );
  return { ok: okAlerter, failing: failingAlerter };
});

describe('WebhookAlerter', () => {
  it('POSTs the alert as JSON to the configured URL', async () => {
    const { fetchFn, calls } = recordingFetch(200);
    await new WebhookAlerter({ url: URL, timeoutMs: 1000, fetchFn }, new FakeLogger()).alert(EVENT);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(URL);
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>)['content-type']).toBe(
      'application/json',
    );
    const sent = JSON.parse(calls[0]!.init.body as string);
    expect(sent.kind).toBe('source_reliability_low');
    expect(sent.dedupe_key).toBe('source_reliability_low:s1');
    // Slack renders the top-level `text` directly (no SDK needed).
    expect(sent.text).toContain('[WARNING]');
    expect(sent.text).toContain('Source reliability low');
  });

  it('a non-2xx response is logged + swallowed (resolves, no throw)', async () => {
    const logger = new FakeLogger();
    const { fetchFn } = recordingFetch(500);
    await expect(
      new WebhookAlerter({ url: URL, timeoutMs: 1000, fetchFn }, logger).alert(EVENT),
    ).resolves.toBeUndefined();
    expect(logger.entries.some((e) => e.level === 'warn' && /non-2xx/.test(e.msg))).toBe(true);
  });

  it('a network error is logged + swallowed (resolves, no throw)', async () => {
    const logger = new FakeLogger();
    const fetchFn: FetchFn = async () => {
      throw new Error('ECONNREFUSED');
    };
    await expect(
      new WebhookAlerter({ url: URL, timeoutMs: 1000, fetchFn }, logger).alert(EVENT),
    ).resolves.toBeUndefined();
    expect(logger.entries.some((e) => e.level === 'warn' && /delivery failed/.test(e.msg))).toBe(
      true,
    );
  });

  it('a hung request times out and is swallowed (resolves, no throw)', async () => {
    const logger = new FakeLogger();
    // Never resolves until aborted — withAbortableTimeout must reject, then we swallow.
    const fetchFn: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init.signal;
        signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    await expect(
      new WebhookAlerter({ url: URL, timeoutMs: 20, fetchFn }, logger).alert(EVENT),
    ).resolves.toBeUndefined();
    expect(logger.entries.some((e) => e.level === 'warn' && /delivery failed/.test(e.msg))).toBe(
      true,
    );
  });
});

describe('toWebhookPayload', () => {
  it('carries text + the full structured event, no extra/secret fields', () => {
    const event: AlertEvent = dailyBudgetReachedAlert({
      ceilingEur: 10,
      spentTodayEur: 10.5,
      at: '2026-06-21T12:00:00.000Z',
    });
    const payload = toWebhookPayload(event);
    expect(Object.keys(payload).sort()).toEqual(
      ['at', 'context', 'dedupe_key', 'kind', 'severity', 'summary', 'text', 'title'].sort(),
    );
    expect(payload.text).toContain('Daily budget reached');
    expect(payload.context).toEqual(event.context);
  });
});

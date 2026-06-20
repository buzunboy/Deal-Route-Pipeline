import type { Alerting, Logger } from '../../application/ports/index.js';
import type { AlertEvent } from '../../domain/index.js';
import { withAbortableTimeout } from '../shared/retry.js';

/** Minimal fetch seam — the global `fetch` in prod, a fake in tests (no network). */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface WebhookAlerterOptions {
  /** The webhook endpoint (a Slack incoming webhook URL, or any JSON collector). */
  url: string;
  /** Per-delivery timeout. A slow/hung collector must not stall the lane. */
  timeoutMs: number;
  /** Injected for tests; defaults to the global fetch. */
  fetchFn?: FetchFn;
}

/**
 * Webhook Alerting adapter: POSTs an alert as JSON to a configured endpoint.
 * Enabled via `ALERT_KIND=webhook` + `ALERT_WEBHOOK_URL`. The body carries BOTH a
 * top-level `text` (so a Slack incoming webhook renders it directly, no Slack SDK)
 * AND the full structured `AlertEvent` (so a generic collector / proxy fronting
 * Datadog/CloudWatch — see docs/DealRoute_Observability.md — gets the typed detail).
 *
 * BEST-EFFORT (the port contract): every transport failure — network error, a
 * non-2xx response, or a timeout — is caught and logged, and `alert()` resolves
 * normally. Alerting can never crash or stall the lane it observes.
 */
export class WebhookAlerter implements Alerting {
  private readonly fetchFn: FetchFn;

  constructor(
    private readonly options: WebhookAlerterOptions,
    private readonly logger: Logger,
  ) {
    this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));
  }

  async alert(event: AlertEvent): Promise<void> {
    try {
      // Serialize INSIDE the try: `context` is an open object (z.record(z.unknown())),
      // so a future builder could put a non-serializable value (BigInt/circular) in
      // it — JSON.stringify must not be able to throw past the best-effort boundary.
      const body = JSON.stringify(toWebhookPayload(event));
      const res = await withAbortableTimeout(
        (signal) =>
          this.fetchFn(this.options.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            signal,
          }),
        this.options.timeoutMs,
      );
      if (!res.ok) {
        // A non-2xx is a delivery failure, but NOT fatal — log + swallow.
        this.logger.warn('alert webhook returned a non-2xx status (alert not delivered)', {
          kind: event.kind,
          dedupe_key: event.dedupe_key,
          status: res.status,
        });
      }
    } catch (err) {
      // Network error / timeout — never propagate past the best-effort boundary.
      this.logger.warn('alert webhook delivery failed (swallowed — best-effort)', {
        kind: event.kind,
        dedupe_key: event.dedupe_key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * The webhook body. `text` is the human line (Slack renders it as-is); `severity`,
 * `kind`, `dedupe_key`, `at`, and `context` give a generic collector the structured
 * fields. Deliberately carries no secret — the event's `context` is built from
 * ids/urls/numbers only (see the pure alert builders).
 */
export function toWebhookPayload(event: AlertEvent): Record<string, unknown> {
  return {
    text: `[${event.severity.toUpperCase()}] ${event.title}: ${event.summary}`,
    kind: event.kind,
    severity: event.severity,
    title: event.title,
    summary: event.summary,
    dedupe_key: event.dedupe_key,
    at: event.at,
    context: event.context,
  };
}

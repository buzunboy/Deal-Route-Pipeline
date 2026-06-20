import type { AlertEvent } from '../../domain/index.js';

/**
 * Alerting port (Step 5 — observability). Turns the pipeline's silent-warn points
 * (a source's reliability falling low; the daily €-budget ceiling reached) into a
 * proactive signal a human/ops backend receives. Program to THIS, inject a concrete
 * adapter (Noop / Webhook now; Datadog/CloudWatch later — see
 * docs/DealRoute_Observability.md) from the one composition root.
 *
 * CONTRACT — alerting is BEST-EFFORT and must NEVER affect the lane it observes:
 * `alert()` resolves (never rejects) even when delivery fails. An adapter swallows
 * its own transport errors (logging them) and returns normally, so a misconfigured
 * webhook or a down collector can't crash a `crawl --due` / `monitor --due` batch or
 * abort a budget-stopped discovery run. The caller may `await` it without a try/catch.
 */
export interface Alerting {
  /** Deliver one alert. Best-effort: resolves even on delivery failure (never throws). */
  alert(event: AlertEvent): Promise<void>;
}

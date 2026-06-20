import type { Alerting } from '../../application/ports/index.js';
import type { AlertEvent } from '../../domain/index.js';
import type { Logger } from '../../application/ports/index.js';

/**
 * The default Alerting adapter: it delivers nowhere. Keeps the pipeline DARK by
 * default (like `NoopBrowserAgent` / the stub search provider) — alerting is opt-in
 * via `ALERT_KIND=webhook` + a URL. It logs the alert at debug so an operator can
 * still SEE that an alert WOULD have fired while no backend is wired, without any
 * external delivery. Trivially satisfies the best-effort contract (never throws).
 */
export class NoopAlerter implements Alerting {
  constructor(private readonly logger: Logger) {}

  async alert(event: AlertEvent): Promise<void> {
    this.logger.debug('alert (no alerting backend configured — not delivered)', {
      kind: event.kind,
      dedupe_key: event.dedupe_key,
      summary: event.summary,
    });
  }
}

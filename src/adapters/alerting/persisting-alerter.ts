import type { Alerting, AlertRepository, Clock, Logger } from '../../application/ports/index.js';
import { AlertStatus, type AlertEvent, type AlertRecord } from '../../domain/index.js';
import { newId } from '../../application/shared/id.js';

/**
 * An {@link Alerting} decorator that PERSISTS each alert (ACR-8) before delegating to
 * an inner alerter (Noop / Webhook). The persisted rows back the admin panel's
 * Alerts screen + bell badge (list / acknowledge / resolve); the inner alerter still
 * does the live webhook/Slack delivery — so persistence and notification are
 * independent and neither blocks the other.
 *
 * Best-effort, exactly like the port contract: `alert()` NEVER throws. A persistence
 * failure is logged and swallowed (so a DB hiccup can't crash a crawl/monitor/budget
 * lane), and delivery is still attempted; an inner-alerter failure is its own concern
 * (it already swallows). Dedup is the repository's job (one open row per dedupe_key).
 */
export class PersistingAlerter implements Alerting {
  constructor(
    private readonly inner: Alerting,
    private readonly alerts: AlertRepository,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  async alert(event: AlertEvent): Promise<void> {
    // Persist first (deduped, best-effort) — then always deliver, even if persisting
    // failed, so a storage problem never silences the live notification.
    try {
      const at = this.clock.nowIso();
      const record: AlertRecord = {
        id: newId(),
        dedupe_key: event.dedupe_key,
        kind: event.kind,
        severity: event.severity,
        title: event.title,
        summary: event.summary,
        context: event.context,
        status: AlertStatus.enum.open,
        created_at: event.at, // when the condition was observed
        updated_at: at,
      };
      await this.alerts.upsertOpen(record);
    } catch (err) {
      // Swallow — alerting must never affect the lane it observes (port contract).
      this.logger.error('alert persistence failed (alert still delivered)', {
        dedupe_key: event.dedupe_key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await this.inner.alert(event);
  }
}

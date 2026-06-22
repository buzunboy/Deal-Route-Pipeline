import {
  AlertStatus,
  MissingApproverError,
  toAlertView,
  type AlertRecord,
  type AlertStatus as AlertStatusT,
  type AlertView,
} from '../../domain/index.js';
import type { Database, Clock, Logger } from '../ports/index.js';
import { RELIABILITY_FLAG_THRESHOLD } from '../crawl/source-policy.js';

/** Default page size for the alerts list. */
export const ALERTS_DEFAULT_LIMIT = 100;
/** Hard ceiling on a single alerts page. */
export const ALERTS_MAX_LIMIT = 500;

/**
 * Alerts read/ack/resolve (ACR-8). Sits over the persisted alert store + applies
 * READ-TIME auto-resolution so an alert clears itself when the underlying condition
 * has passed, without a background job:
 *  - `daily_budget_reached`: auto-resolved once its UTC day is in the past (the
 *    ceiling resets each UTC day).
 *  - `source_reliability_low`: auto-resolved when its source's CURRENT reliability is
 *    back at/above the flag threshold (it recovered), or the source no longer exists.
 *
 * The stored `status` is the MANUAL lifecycle; the effective status the panel sees is
 * `max(stored, auto)` — a manual `acknowledged`/`resolved` always wins over `open`,
 * and an auto-resolve turns a still-stored-`open` alert into `resolved` for the view.
 */
export class AlertsUseCase {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  /** The Alerts screen: recent alerts (effective status) + the open count for the bell. */
  async listAlerts(
    limit = ALERTS_DEFAULT_LIMIT,
  ): Promise<{ alerts: AlertView[]; open_count: number }> {
    const bounded = clamp(limit, 1, ALERTS_MAX_LIMIT);
    const records = await this.db.alerts.list(bounded);
    // Resolve the reliability auto-rule against current source reliability — read the
    // active sources ONCE and index by id (avoids an N+1 over the alert list).
    const reliabilityById = await this.sourceReliabilityIndex(records);
    const today = this.clock.nowIso().slice(0, 10); // YYYY-MM-DD (UTC)
    const alerts = records.map((r) =>
      toAlertView(r, this.effectiveStatus(r, today, reliabilityById)),
    );
    const open_count = alerts.filter((a) => a.status === 'open').length;
    return { alerts, open_count };
  }

  /** Acknowledge an alert (manual). No-op-safe if already acknowledged/resolved. */
  async acknowledge(id: string, approver: string): Promise<void> {
    await this.setStatus(id, AlertStatus.enum.acknowledged, approver, 'acknowledge-alert');
  }

  /** Resolve an alert (manual). */
  async resolve(id: string, approver: string): Promise<void> {
    await this.setStatus(id, AlertStatus.enum.resolved, approver, 'resolve-alert');
  }

  private async setStatus(
    id: string,
    status: AlertStatusT,
    approver: string,
    action: string,
  ): Promise<void> {
    if (approver.trim() === '') throw new MissingApproverError(action);
    await this.db.alerts.setStatus(id, status, this.clock.nowIso());
    this.logger.info('alert status changed', { id, status, approver });
  }

  /**
   * The effective status the panel sees: a manual ack/resolve always wins; otherwise
   * apply the per-kind auto-resolve rule to a still-open alert.
   */
  private effectiveStatus(
    r: AlertRecord,
    todayUtc: string,
    reliabilityById: Map<string, number>,
  ): AlertStatusT {
    if (r.status !== AlertStatus.enum.open) return r.status; // manual ack/resolve wins
    if (r.kind === 'daily_budget_reached') {
      const day = r.created_at.slice(0, 10);
      return day < todayUtc ? AlertStatus.enum.resolved : AlertStatus.enum.open;
    }
    if (r.kind === 'source_reliability_low') {
      const sourceId = typeof r.context.source_id === 'string' ? r.context.source_id : null;
      if (sourceId === null) return AlertStatus.enum.open;
      const current = reliabilityById.get(sourceId);
      // Source gone, or recovered to/above the flag threshold → auto-resolved.
      if (current === undefined || current >= RELIABILITY_FLAG_THRESHOLD) {
        return AlertStatus.enum.resolved;
      }
      return AlertStatus.enum.open;
    }
    return AlertStatus.enum.open;
  }

  /** Index current reliability by source id, but only when a reliability alert is open. */
  private async sourceReliabilityIndex(records: AlertRecord[]): Promise<Map<string, number>> {
    const needsSources = records.some(
      (r) => r.kind === 'source_reliability_low' && r.status === AlertStatus.enum.open,
    );
    const index = new Map<string, number>();
    if (!needsSources) return index;
    for (const status of ['active', 'disabled', 'pending_approval', 'rejected'] as const) {
      for (const s of await this.db.sources.listByStatus(status)) {
        index.set(s.id, s.reliability_score);
      }
    }
    return index;
  }
}

/** Clamp `n` into [min, max] — a floor guard for the page size. */
function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

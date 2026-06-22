import { z } from 'zod';
import { AlertKind, AlertSeverity } from './alert-event.js';

/**
 * The PERSISTED alert (ACR-8). The fire-and-forget {@link AlertEvent} is also
 * recorded as one of these so the admin panel can list / acknowledge / resolve
 * alerts. Stored status is the MANUAL lifecycle (`open` → `acknowledged` →
 * `resolved`); the use-case overlays read-time AUTO-resolution (a budget alert from
 * a past UTC day; a reliability alert whose source has recovered) — see
 * {@link effectiveStatus}.
 */
export const AlertStatus = z.enum(['open', 'acknowledged', 'resolved']);
export type AlertStatus = z.infer<typeof AlertStatus>;

export const AlertRecordSchema = z.object({
  id: z.string().uuid(),
  /** Stable occurrence identity (one OPEN row per key) — from the event. */
  dedupe_key: z.string().min(1),
  kind: AlertKind,
  severity: AlertSeverity,
  title: z.string().min(1),
  summary: z.string().min(1),
  context: z.record(z.unknown()),
  /** The stored (manual) status. */
  status: AlertStatus,
  /** ISO-8601 first-seen. */
  created_at: z.string().min(1),
  /** ISO-8601 last update (re-open refresh / ack / resolve). */
  updated_at: z.string().min(1),
});
export type AlertRecord = z.infer<typeof AlertRecordSchema>;

/**
 * One alert as the admin panel sees it (ACR-8). The stored fields PLUS the
 * effective `status` and `at` the panel renders. `at` is `created_at` (when the
 * condition was first observed) — the panel's "N open" pill counts effective-open.
 */
export interface AlertView {
  id: string;
  title: string;
  body: string;
  severity: AlertSeverity;
  status: AlertStatus;
  at: string;
}

/** Project a stored alert + its (already-computed) effective status into the panel view. */
export function toAlertView(record: AlertRecord, status: AlertStatus): AlertView {
  return {
    id: record.id,
    title: record.title,
    body: record.summary,
    severity: record.severity,
    status,
    at: record.created_at,
  };
}

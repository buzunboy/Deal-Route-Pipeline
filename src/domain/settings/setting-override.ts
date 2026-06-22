import { z } from 'zod';

/**
 * A persisted SETTINGS OVERRIDE (ACR-10 Settings). The pipeline's operational config
 * is env-driven (the source of truth for a running process); this table stores the
 * few panel-editable knobs as overrides layered OVER that config. An absent row means
 * "no override — use the live config value".
 *
 * Two writable knobs exist in v1 (see {@link SETTINGS_CATALOG}):
 *  - `affiliate_disclosure` — the review default the approve path applies when a
 *    reviewer omits it. Takes effect IMMEDIATELY (every approve reads the store).
 *  - `daily_budget_queued` — a QUEUED daily-€-budget that the running process can't
 *    adopt mid-life (the budget guard is built once from config at boot). It is
 *    stamped with the `deployment_id` it was written under; at the NEXT deployment's
 *    boot (`Container.init` → `SettingsUseCase.consumeQueuedBudget`), a queued value
 *    stamped with a PRIOR deployment is ADOPTED as that process's budget ceiling and
 *    the row is DELETED (self-clear). The CURRENT effective budget is the read-only
 *    `daily_budget`.
 *
 * Read-only/env-mirror keys are NEVER stored here (a PATCH on them is a 409); they are
 * surfaced from live config by the use-case so the panel can render them view-only.
 */
export const SettingOverrideSchema = z.object({
  /** The setting key (matches a {@link SETTINGS_CATALOG} entry). Primary key. */
  key: z.string().min(1),
  /** The stored override value as text (null = cleared), interpreted per the key. */
  value: z.string().nullable(),
  /**
   * The deployment the override was written under, for keys that only take effect on
   * the next deploy (`daily_budget_queued`). Null for keys that apply immediately.
   */
  deployment_id: z.string().nullable().default(null),
  /** ISO-8601 timestamp of the last write. */
  updated_at: z.string().min(1),
  /** The approver who set it (no anonymous config changes). */
  updated_by: z.string().min(1),
});
export type SettingOverride = z.infer<typeof SettingOverrideSchema>;

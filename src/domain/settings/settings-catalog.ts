import { z } from 'zod';

/**
 * The settings catalog + the pure projection into the admin panel's Settings screen
 * shape (ACR-10 Settings). Backs `GET /api/settings` and validates `PATCH`.
 *
 * Every setting the panel shows is declared here ONCE with its group, label, control,
 * and KIND:
 *  - `writable`  — the panel may PATCH it; the pipeline honours the stored override.
 *  - `read_only` — a faithful mirror of env/derived config the pipeline reads at boot;
 *    a PATCH is a 409 (changing it needs a redeploy / secret change). The panel must
 *    render these as VIEW-ONLY (recorded in the Admin-Panel handoff doc).
 *
 * The panel's row schema is a discriminated union on `control` (`toggle` carries
 * `enabled`, `value` carries `value`); we ADD a `read_only` flag (default false) so the
 * panel knows which rows to disable — additive, the existing union still parses.
 *
 * PURE: the use-case supplies the live config values + the stored overrides; this
 * module owns the grouping, the override-vs-live merge, and the editability flag.
 */

/** A setting's control type (mirrors the panel's discriminated union). */
export const SettingControl = z.enum(['toggle', 'value']);
export type SettingControl = z.infer<typeof SettingControl>;

/** Whether the panel may write a setting, or it's a read-only env/derived mirror. */
export const SettingKind = z.enum(['writable', 'read_only']);
export type SettingKind = z.infer<typeof SettingKind>;

/** One catalog entry — the static definition of a setting (no value). */
export interface SettingDef {
  key: string;
  groupKey: string;
  groupLabel: string;
  label: string;
  hint?: string;
  control: SettingControl;
  kind: SettingKind;
}

/**
 * The complete settings catalog, in display order (grouping is derived from
 * `groupKey`/`groupLabel`, first-seen order preserved). Keep this the single place a
 * setting is declared; adding a knob is one row here + (for a writable one) wiring the
 * override into the consumer.
 */
export const SETTINGS_CATALOG: readonly SettingDef[] = [
  // ── Pipeline ──────────────────────────────────────────────────────────────
  {
    key: 'daily_budget',
    groupKey: 'pipeline',
    groupLabel: 'Pipeline',
    label: 'Daily crawl budget (in effect)',
    hint: 'The per-UTC-day €-ceiling the running pipeline is enforcing now (env-set).',
    control: 'value',
    kind: 'read_only',
  },
  {
    key: 'daily_budget_queued',
    groupKey: 'pipeline',
    groupLabel: 'Pipeline',
    label: 'Daily crawl budget (queued)',
    hint: 'A new €-ceiling that takes effect on the NEXT deployment, then clears. Empty = no change queued.',
    control: 'value',
    kind: 'writable',
  },
  {
    key: 'evidence_store',
    groupKey: 'pipeline',
    groupLabel: 'Pipeline',
    label: 'Evidence store',
    hint: 'Where captured evidence is written (env-set; changing it is a deploy concern).',
    control: 'value',
    kind: 'read_only',
  },
  {
    key: 'respect_robots',
    groupKey: 'pipeline',
    groupLabel: 'Pipeline',
    label: 'Respect robots.txt',
    hint: 'Whether the crawler honours robots disallows (env-set; a legal/policy posture).',
    control: 'toggle',
    kind: 'read_only',
  },
  // ── Review defaults ─────────────────────────────────────────────────────────
  {
    key: 'affiliate_disclosure',
    groupKey: 'review_defaults',
    groupLabel: 'Review defaults',
    label: 'Affiliate disclosure on by default',
    hint: 'Pre-enable the EU-Omnibus disclosure when a reviewer approves without setting it.',
    control: 'toggle',
    kind: 'writable',
  },
  // ── Markets ──────────────────────────────────────────────────────────────────
  {
    key: 'active_markets',
    groupKey: 'markets',
    groupLabel: 'Markets',
    label: 'Active markets',
    hint: 'The countries the pipeline is configured for (derived from the MARKETS registry).',
    control: 'value',
    kind: 'read_only',
  },
  // ── Integrations ─────────────────────────────────────────────────────────────
  {
    key: 'alerting',
    groupKey: 'integrations',
    groupLabel: 'Integrations',
    label: 'Operational alerting',
    hint: 'How reliability/budget alerts are delivered (env-set: noop or webhook/Slack).',
    control: 'value',
    kind: 'read_only',
  },
] as const;

/** The set of writable keys — the allow-list the PATCH boundary checks. */
export const WRITABLE_SETTING_KEYS: ReadonlySet<string> = new Set(
  SETTINGS_CATALOG.filter((s) => s.kind === 'writable').map((s) => s.key),
);

/** True when a key is a known, writable setting (drives the PATCH 409 vs accept). */
export function isWritableSetting(key: string): boolean {
  return WRITABLE_SETTING_KEYS.has(key);
}

/** Look up a catalog entry by key, or undefined. */
export function settingDef(key: string): SettingDef | undefined {
  return SETTINGS_CATALOG.find((s) => s.key === key);
}

/**
 * Validate + normalise a raw PATCH value for a WRITABLE setting into the canonical
 * string stored in the override row. Returns `{ ok, value }` or `{ ok:false, error }`;
 * the caller must already have confirmed the key is writable. Pure — the one place a
 * writable setting's value rules live, so the boundary can't accept a nonsense value.
 *
 *  - `daily_budget_queued`: a non-negative number (euros); stored as a trimmed decimal
 *    string. An empty string clears the queue (override stored as cleared).
 *  - `affiliate_disclosure`: a boolean (accepts a real boolean or the strings
 *    'true'/'false'); stored as 'true'/'false'.
 */
export function validateSettingValue(
  key: string,
  raw: unknown,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (key === 'daily_budget_queued') {
    if (raw === '' || raw === null) return { ok: true, value: null }; // clear the queue
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, error: 'daily_budget_queued must be a non-negative number of euros' };
    }
    return { ok: true, value: n.toFixed(2) };
  }
  if (key === 'affiliate_disclosure') {
    if (raw === true || raw === 'true') return { ok: true, value: 'true' };
    if (raw === false || raw === 'false') return { ok: true, value: 'false' };
    return { ok: false, error: 'affiliate_disclosure must be a boolean' };
  }
  // Defensive: a writable key the catalog declared but this validator doesn't know.
  return { ok: false, error: `no value rule for setting "${key}"` };
}

// ── The panel response shape (a row carries an additive `read_only` flag) ──────

export const SettingRowSchema = z.discriminatedUnion('control', [
  z.object({
    key: z.string(),
    label: z.string(),
    hint: z.string().optional(),
    control: z.literal('toggle'),
    enabled: z.boolean(),
    read_only: z.boolean(),
  }),
  z.object({
    key: z.string(),
    label: z.string(),
    hint: z.string().optional(),
    control: z.literal('value'),
    value: z.string(),
    read_only: z.boolean(),
  }),
]);
export type SettingRow = z.infer<typeof SettingRowSchema>;

export const SettingsGroupSchema = z.object({
  key: z.string(),
  label: z.string(),
  rows: z.array(SettingRowSchema),
});
export type SettingsGroup = z.infer<typeof SettingsGroupSchema>;

export const SettingsViewSchema = z.object({ groups: z.array(SettingsGroupSchema) });
export type SettingsView = z.infer<typeof SettingsViewSchema>;

/**
 * The live (env/derived) display value for each setting key, supplied by the use-case
 * (it owns config access). A `value`-control key maps to a display string; a
 * `toggle`-control key maps to a boolean. The use-case must provide every catalog key.
 */
export type LiveSettingValues = Record<string, string | boolean>;

/**
 * Build the panel's grouped Settings view (pure). For each catalog entry, the row's
 * displayed value is the stored OVERRIDE when present (writable keys only), else the
 * LIVE config value. `read_only` is true for `read_only`-kind keys. Groups preserve
 * first-seen order; rows preserve catalog order.
 *
 * `daily_budget_queued` is special: its override is only "live" when stamped with the
 * CURRENT deployment (a prior-deploy queue has been consumed) — the use-case resolves
 * that and passes the effective override map, so this stays pure.
 */
export function buildSettingsView(
  live: LiveSettingValues,
  overrides: ReadonlyMap<string, string>,
): SettingsView {
  const groups: SettingsGroup[] = [];
  const byGroupKey = new Map<string, SettingsGroup>();

  for (const def of SETTINGS_CATALOG) {
    let group = byGroupKey.get(def.groupKey);
    if (!group) {
      group = { key: def.groupKey, label: def.groupLabel, rows: [] };
      byGroupKey.set(def.groupKey, group);
      groups.push(group);
    }
    const read_only = def.kind === 'read_only';
    const override = def.kind === 'writable' ? overrides.get(def.key) : undefined;

    if (def.control === 'toggle') {
      const enabled =
        override !== undefined ? override === 'true' : Boolean(live[def.key] ?? false);
      group.rows.push({
        key: def.key,
        label: def.label,
        ...(def.hint ? { hint: def.hint } : {}),
        control: 'toggle',
        enabled,
        read_only,
      });
    } else {
      const value = override !== undefined ? override : String(live[def.key] ?? '');
      group.rows.push({
        key: def.key,
        label: def.label,
        ...(def.hint ? { hint: def.hint } : {}),
        control: 'value',
        value,
        read_only,
      });
    }
  }
  return { groups };
}

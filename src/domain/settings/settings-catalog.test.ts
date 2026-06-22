import { describe, it, expect } from 'vitest';
import {
  buildSettingsView,
  validateSettingValue,
  isWritableSetting,
  SETTINGS_CATALOG,
  SettingsViewSchema,
  type LiveSettingValues,
} from './settings-catalog.js';

const live: LiveSettingValues = {
  daily_budget: '€10.00',
  daily_budget_queued: '', // no live value — surfaced only via an override
  evidence_store: 'local',
  respect_robots: false,
  affiliate_disclosure: true,
  active_markets: 'DE',
  alerting: 'noop',
};

describe('settings-catalog', () => {
  describe('isWritableSetting', () => {
    it('allows the two v1 writable keys, refuses read-only + unknown', () => {
      expect(isWritableSetting('affiliate_disclosure')).toBe(true);
      expect(isWritableSetting('daily_budget_queued')).toBe(true);
      expect(isWritableSetting('daily_budget')).toBe(false); // read-only mirror
      expect(isWritableSetting('evidence_store')).toBe(false);
      expect(isWritableSetting('nonsense')).toBe(false);
    });
  });

  describe('validateSettingValue', () => {
    it('normalises a budget to 2dp; empty clears the queue; rejects negatives/garbage', () => {
      expect(validateSettingValue('daily_budget_queued', '15')).toEqual({
        ok: true,
        value: '15.00',
      });
      expect(validateSettingValue('daily_budget_queued', 7.5)).toEqual({ ok: true, value: '7.50' });
      expect(validateSettingValue('daily_budget_queued', '')).toEqual({ ok: true, value: null });
      expect(validateSettingValue('daily_budget_queued', '-1').ok).toBe(false);
      expect(validateSettingValue('daily_budget_queued', 'abc').ok).toBe(false);
    });
    it('accepts boolean or boolean-string for affiliate_disclosure', () => {
      expect(validateSettingValue('affiliate_disclosure', true)).toEqual({
        ok: true,
        value: 'true',
      });
      expect(validateSettingValue('affiliate_disclosure', 'false')).toEqual({
        ok: true,
        value: 'false',
      });
      expect(validateSettingValue('affiliate_disclosure', 'maybe').ok).toBe(false);
    });
  });

  describe('buildSettingsView', () => {
    it('mirrors live values, flags read-only rows, and groups in catalog order', () => {
      const view = buildSettingsView(live, new Map());
      expect(SettingsViewSchema.parse(view)).toEqual(view);
      expect(view.groups.map((g) => g.key)).toEqual([
        'pipeline',
        'review_defaults',
        'markets',
        'integrations',
      ]);
      const rows = view.groups.flatMap((g) => g.rows);
      const budget = rows.find((r) => r.key === 'daily_budget')!;
      expect(budget).toMatchObject({ control: 'value', value: '€10.00', read_only: true });
      const disclosure = rows.find((r) => r.key === 'affiliate_disclosure')!;
      expect(disclosure).toMatchObject({ control: 'toggle', enabled: true, read_only: false });
    });

    it('a stored override wins over the live value for a writable key', () => {
      const overrides = new Map([
        ['affiliate_disclosure', 'false'],
        ['daily_budget_queued', '25.00'],
      ]);
      const view = buildSettingsView(live, overrides);
      const rows = view.groups.flatMap((g) => g.rows);
      expect(rows.find((r) => r.key === 'affiliate_disclosure')).toMatchObject({
        control: 'toggle',
        enabled: false, // override beat the live `true`
      });
      expect(rows.find((r) => r.key === 'daily_budget_queued')).toMatchObject({
        control: 'value',
        value: '25.00',
      });
      // The read-only in-effect budget is untouched by the queued override.
      expect(rows.find((r) => r.key === 'daily_budget')!).toMatchObject({ value: '€10.00' });
    });

    it('every catalog key appears exactly once in the view', () => {
      const view = buildSettingsView(live, new Map());
      const keys = view.groups.flatMap((g) => g.rows.map((r) => r.key)).sort();
      expect(keys).toEqual(SETTINGS_CATALOG.map((s) => s.key).sort());
    });
  });
});

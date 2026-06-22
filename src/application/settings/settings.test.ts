import { describe, it, expect } from 'vitest';
import { SettingsUseCase } from './settings.js';
import { InMemoryDb } from '../../../test/fakes/in-memory-db.js';
import { FakeLogger, FixedClock } from '../../../test/fakes/fakes.js';
import { loadConfig, type Config } from '../../config/index.js';
import {
  SettingNotWritableError,
  MissingApproverError,
  InvalidPatchError,
} from '../../domain/index.js';

/** A config with all defaults, overridable per test (e.g. a fixed DEPLOYMENT_ID). */
function makeConfig(env: NodeJS.ProcessEnv = {}): Config {
  return loadConfig({ DEPLOYMENT_ID: 'deploy-1', ...env });
}

function makeUseCase(config: Config = makeConfig()): { uc: SettingsUseCase; db: InMemoryDb } {
  const db = new InMemoryDb();
  return { uc: new SettingsUseCase(db, config, new FixedClock(), new FakeLogger()), db };
}

describe('SettingsUseCase', () => {
  describe('getSettings (live mirror)', () => {
    it('mirrors env/derived config with read-only flags and no overrides', async () => {
      const { uc } = makeUseCase();
      const view = await uc.getSettings();
      const rows = view.groups.flatMap((g) => g.rows);
      const find = (k: string) => rows.find((r) => r.key === k)!;

      // read-only mirrors of defaults
      expect(find('daily_budget')).toMatchObject({ value: '€10.00', read_only: true });
      expect(find('evidence_store')).toMatchObject({ value: 'local', read_only: true });
      expect(find('active_markets')).toMatchObject({ value: 'DE', read_only: true });
      expect(find('alerting')).toMatchObject({ value: 'noop', read_only: true });
      // writable knobs at their defaults
      expect(find('affiliate_disclosure')).toMatchObject({ enabled: true, read_only: false });
      expect(find('daily_budget_queued')).toMatchObject({ value: '', read_only: false });
    });
  });

  describe('updateSetting (writable knobs)', () => {
    it('rejects a read-only key with a 409-class SettingNotWritableError', async () => {
      const { uc } = makeUseCase();
      await expect(uc.updateSetting('evidence_store', 'alice', 's3')).rejects.toBeInstanceOf(
        SettingNotWritableError,
      );
      await expect(uc.updateSetting('unknown_key', 'alice', 'x')).rejects.toBeInstanceOf(
        SettingNotWritableError,
      );
    });

    it('requires an approver and a valid value', async () => {
      const { uc } = makeUseCase();
      await expect(uc.updateSetting('affiliate_disclosure', '  ', 'false')).rejects.toBeInstanceOf(
        MissingApproverError,
      );
      await expect(
        uc.updateSetting('daily_budget_queued', 'alice', 'not-a-number'),
      ).rejects.toBeInstanceOf(InvalidPatchError);
    });

    it('an affiliate_disclosure override takes effect immediately (no deployment stamp)', async () => {
      const { uc, db } = makeUseCase();
      await uc.updateSetting('affiliate_disclosure', 'alice', false);
      // surfaced in the view + reflected in the approve default helper
      const row = (await uc.getSettings()).groups
        .flatMap((g) => g.rows)
        .find((r) => r.key === 'affiliate_disclosure')!;
      expect(row).toMatchObject({ control: 'toggle', enabled: false });
      expect(await uc.defaultAffiliateDisclosure()).toBe(false);
      // stored without a deployment stamp (it applies now, not next deploy)
      expect((await db.settings.get('affiliate_disclosure'))!.deployment_id).toBeNull();
    });

    it('clearing affiliate_disclosure (empty/cleared) falls back to the default true', async () => {
      const { uc } = makeUseCase();
      await uc.updateSetting('affiliate_disclosure', 'alice', false);
      // re-enable by setting true (validateSettingValue has no "clear" for the toggle)
      await uc.updateSetting('affiliate_disclosure', 'alice', true);
      expect(await uc.defaultAffiliateDisclosure()).toBe(true);
    });
  });

  describe('daily_budget_queued deployment semantics', () => {
    it('a queue stamped with the CURRENT deployment is PENDING (shown, not yet in effect)', async () => {
      const { uc } = makeUseCase(makeConfig({ DEPLOYMENT_ID: 'deploy-1' }));
      await uc.updateSetting('daily_budget_queued', 'alice', '25');
      // consumeQueuedBudget under the SAME deployment → not adopted (set this deploy).
      expect(await uc.consumeQueuedBudget()).toBeNull();
      const rows = (await uc.getSettings()).groups.flatMap((g) => g.rows);
      expect(rows.find((r) => r.key === 'daily_budget_queued')!).toMatchObject({ value: '25.00' });
      // the in-effect budget is unchanged until the next deploy adopts it
      expect(rows.find((r) => r.key === 'daily_budget')!).toMatchObject({ value: '€10.00' });
    });

    it('the NEXT deployment adopts the queued budget, clears it, and shows it in effect', async () => {
      // Write under deploy-1...
      const { db } = makeUseCase(makeConfig({ DEPLOYMENT_ID: 'deploy-1' }));
      await new SettingsUseCase(
        db,
        makeConfig({ DEPLOYMENT_ID: 'deploy-1' }),
        new FixedClock(),
        new FakeLogger(),
      ).updateSetting('daily_budget_queued', 'alice', '25');

      // ...boot under deploy-2 (a later deployment): consume adopts €25 + clears the row.
      const uc2 = new SettingsUseCase(
        db,
        makeConfig({ DEPLOYMENT_ID: 'deploy-2' }),
        new FixedClock(),
        new FakeLogger(),
      );
      expect(await uc2.consumeQueuedBudget()).toBe(25);
      expect(uc2.effectiveDailyBudget()).toBe(25);
      // the row is deleted (self-clear) and the GET now shows €25 in effect, queue empty.
      expect(await db.settings.get('daily_budget_queued')).toBeNull();
      const rows = (await uc2.getSettings()).groups.flatMap((g) => g.rows);
      expect(rows.find((r) => r.key === 'daily_budget')!).toMatchObject({ value: '€25.00' });
      expect(rows.find((r) => r.key === 'daily_budget_queued')!).toMatchObject({ value: '' });
    });

    it('consume is a no-op when nothing is queued', async () => {
      const { uc } = makeUseCase();
      expect(await uc.consumeQueuedBudget()).toBeNull();
      expect(uc.effectiveDailyBudget()).toBe(10); // config default (€10.00)
    });
  });
});

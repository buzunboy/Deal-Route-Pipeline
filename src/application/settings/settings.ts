import {
  buildSettingsView,
  validateSettingValue,
  isWritableSetting,
  MARKET_COUNTRIES,
  MissingApproverError,
  InvalidPatchError,
  SettingNotWritableError,
  type SettingsView,
  type LiveSettingValues,
  type SettingOverride,
} from '../../domain/index.js';
import type { Config } from '../../config/index.js';
import type { Database, Clock, Logger } from '../ports/index.js';

/**
 * Settings use-case (ACR-10 Settings). The pipeline's operational config is env-driven;
 * this surfaces the panel-editable knobs as DB OVERRIDES layered over that config, and
 * mirrors the read-only env/derived settings so the panel can render them view-only.
 *
 * Writable knobs (v1):
 *  - `affiliate_disclosure` — the review default the approve path reads when a reviewer
 *    omits it. Takes effect IMMEDIATELY.
 *  - `daily_budget_queued` — a queued €-budget. The running budget guard is built from
 *    config at boot and can't adopt it mid-life, so the override is stamped with the
 *    current `deploymentId`; a queued value from a PRIOR deployment is treated as
 *    consumed (the next boot's guard reads the new value, then this clears). GET always
 *    reports the CURRENT effective budget via the read-only `daily_budget`.
 *
 * A PATCH on a read-only/unknown key is a {@link SettingNotWritableError} (409).
 */
export class SettingsUseCase {
  constructor(
    private readonly db: Database,
    private readonly config: Config,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  /**
   * The grouped Settings view for the panel: every catalog key with its current value
   * (a stored override wins for a writable key, else the live config value) and a
   * `read_only` flag. A `daily_budget_queued` override is shown as PENDING until a
   * later deployment's boot {@link consumeQueuedBudget} adopts it into the in-effect
   * `daily_budget` and clears the row.
   */
  async getSettings(): Promise<SettingsView> {
    const overrides = await this.db.settings.list();
    const effective = new Map<string, string>();
    for (const o of overrides) {
      if (o.value !== null) effective.set(o.key, o.value);
    }
    return buildSettingsView(this.liveValues(), effective);
  }

  /**
   * Apply a PATCH to one writable setting. Validates the key is writable (else 409) and
   * the value (else 400), then upserts (or deletes, when cleared) the override. The
   * queued budget is stamped with the current deployment; immediate knobs carry no
   * deployment stamp. Returns `{ key, updated: true }`.
   */
  async updateSetting(
    key: string,
    approver: string,
    rawValue: unknown,
  ): Promise<{ key: string; updated: boolean }> {
    if (approver.trim() === '') throw new MissingApproverError('update setting');
    if (!isWritableSetting(key)) throw new SettingNotWritableError(key);

    const validated = validateSettingValue(key, rawValue);
    if (!validated.ok) throw new InvalidPatchError(validated.error, [key]);

    if (validated.value === null) {
      // A cleared knob falls back to the live config value — remove the override row.
      await this.db.settings.delete(key);
      this.logger.info('setting override cleared', { key, approver });
      return { key, updated: true };
    }

    const override: SettingOverride = {
      key,
      value: validated.value,
      // Only the queued budget needs a deployment stamp (next-deploy semantics); the
      // immediate knobs apply now, so they carry no stamp.
      deployment_id: key === 'daily_budget_queued' ? this.config.deploymentId : null,
      updated_at: this.clock.nowIso(),
      updated_by: approver,
    };
    await this.db.settings.upsert(override);
    this.logger.info('setting override set', { key, approver, value: validated.value });
    return { key, updated: true };
  }

  /**
   * The default `affiliate_disclosure` for the approve path when a reviewer omits it:
   * the stored override if set, else the safe-side `true` (over-disclose). Read at
   * approve-time so a panel change takes effect immediately. Exposed so the HTTP approve
   * handler can resolve the default without coupling ReviewUseCase to settings.
   */
  async defaultAffiliateDisclosure(): Promise<boolean> {
    const o = await this.db.settings.get('affiliate_disclosure');
    if (o?.value === 'false') return false;
    if (o?.value === 'true') return true;
    return true; // no override → over-disclose
  }

  /**
   * Boot-time consume of a queued daily-budget override (the next-deploy rule). Called
   * ONCE at process startup ({@link Container.init}). If a `daily_budget_queued` row was
   * stamped with a DIFFERENT (prior) deployment than the current one, THIS deployment
   * adopts it: the queued euros become the effective daily budget for this process AND
   * the row is deleted (self-clear). A row stamped with the CURRENT deployment was set
   * during this same deployment, so it stays pending for the NEXT one.
   *
   * Returns the adopted budget (euros) when a prior-deploy queue was consumed, else null
   * (the caller keeps the config-default ceiling). Records the effective budget so the
   * GET view's read-only `daily_budget` reflects what's actually running.
   */
  async consumeQueuedBudget(): Promise<number | null> {
    const queued = await this.db.settings.get('daily_budget_queued');
    if (!queued || queued.value === null) return null;
    if (queued.deployment_id === this.config.deploymentId) {
      // Set during THIS deployment → not yet effective; leave it for the next boot.
      return null;
    }
    const adopted = Number(queued.value);
    if (!Number.isFinite(adopted) || adopted < 0) {
      // Defensive: a corrupt stored value can't silently become the budget.
      this.logger.warn('ignoring a non-numeric queued daily budget', { value: queued.value });
      await this.db.settings.delete('daily_budget_queued');
      return null;
    }
    // Adopt + self-clear: the queue applied on this (next) deployment, now it's done.
    await this.db.settings.delete('daily_budget_queued');
    this.effectiveDailyBudgetEur = adopted;
    this.logger.info('adopted queued daily budget on deploy', {
      adoptedEur: adopted,
      deploymentId: this.config.deploymentId,
    });
    return adopted;
  }

  /** The daily budget actually IN EFFECT this process: an adopted queue, else config. */
  effectiveDailyBudget(): number {
    return this.effectiveDailyBudgetEur ?? this.config.agent.dailyBudgetEur;
  }

  /** Set when {@link consumeQueuedBudget} adopts a queued budget at boot; else config. */
  private effectiveDailyBudgetEur: number | null = null;

  /** The live (env/derived) display value for every catalog key. */
  private liveValues(): LiveSettingValues {
    const c = this.config;
    return {
      daily_budget: `€${this.effectiveDailyBudget().toFixed(2)}`,
      daily_budget_queued: '', // surfaced only via its override
      evidence_store: c.evidence.kind,
      respect_robots: c.crawl.respectRobotsTxt,
      affiliate_disclosure: true, // the code default; the override beats it in the view
      active_markets: MARKET_COUNTRIES.join(' · '),
      alerting: c.alerting.kind,
    };
  }
}

import {
  dailyBudgetEnabled,
  dailyBudgetExhausted,
  effectiveRunCostCap,
  remainingDailyBudget,
  utcDayStart,
} from '../../domain/index.js';
import type { Database, Clock, Logger } from '../ports/index.js';

/** A budget check for the run about to start. */
export interface BudgetCheck {
  /** When false, today's ceiling is reached — the batch should stop. */
  ok: boolean;
  /** EUR still spendable today (Infinity when the guard is disabled). */
  remainingEur: number;
  /** EUR already spent today across all runs (cent-rounded). */
  spentTodayEur: number;
}

/**
 * Aggregate daily €-budget guard for the agentic/discovery lanes (Pre-C-3). The
 * per-run `AgentBudget.maxCostEur` caps ONE run; this caps the SUM across every
 * run in a UTC day, so a batch (many sources/queries, or a runaway loop) can't
 * blow cost even when each run stays under its own cap.
 *
 * It reads spend-so-far-today from the run ledger (`crawl_runs`, now written by
 * every lane) and decides — pure rules in `domain/metrics/daily-budget` do the
 * arithmetic. The batch loop calls `check()` before each run and, if `ok`, passes
 * `effectiveCostCap()` as that run's per-run cap so a single run is bounded to the
 * day's remaining headroom. Like the per-run cap, the bound is enforced before each
 * extraction (whose cost is only known after), so the daily ceiling is a tight soft
 * ceiling — it can be exceeded by at most one extraction's cost, not a hard stop.
 *
 * Disabled when the configured ceiling is `0` (explicit off-switch): `check()`
 * always returns ok with `Infinity` remaining.
 */
export class DailyBudgetGuard {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly ceilingEur: number,
  ) {}

  get enabled(): boolean {
    return dailyBudgetEnabled(this.ceilingEur);
  }

  /** Today's spend + whether there's headroom for another run. */
  async check(): Promise<BudgetCheck> {
    if (!this.enabled) {
      return { ok: true, remainingEur: Infinity, spentTodayEur: 0 };
    }
    const spentTodayEur = await this.db.crawlRuns.spentSince(utcDayStart(this.clock.now()));
    const remainingEur = remainingDailyBudget(this.ceilingEur, spentTodayEur);
    const ok = !dailyBudgetExhausted(this.ceilingEur, spentTodayEur);
    if (!ok) {
      this.logger.warn('daily budget reached — stopping batch (no further runs today)', {
        ceilingEur: this.ceilingEur,
        spentTodayEur,
      });
    }
    return { ok, remainingEur, spentTodayEur };
  }

  /**
   * The per-run €-cap to actually use: the smaller of the run's configured cap and
   * the budget left today, bounding one run to the day's remaining headroom (a tight
   * soft ceiling — see the class note; a run can still overshoot by one extraction).
   * Returns the configured cap unchanged when the guard is disabled.
   */
  effectiveCostCap(perRunCapEur: number, spentTodayEur: number): number {
    return effectiveRunCostCap(perRunCapEur, this.ceilingEur, spentTodayEur);
  }
}

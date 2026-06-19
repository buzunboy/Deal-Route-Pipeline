import { roundEur } from './cost-summary.js';

/**
 * Pure rules for the aggregate daily €-budget guard (Pre-C-3). The agentic /
 * discovery lane is bounded per-run by `AgentBudget.maxCostEur`; this is the
 * SECOND ceiling — total spend across every run in a UTC day — so a runaway day
 * (many sources/queries, or a misconfigured loop) can't blow cost even if each
 * individual run stays under its per-run cap.
 *
 * A ceiling of `0` means the guard is DISABLED (explicit off-switch): callers
 * treat budget as unlimited. No I/O here — the caller supplies `spentToday`
 * (read from the run ledger) and the per-run cap; these functions just decide.
 */

/** True when the guard is on (a positive ceiling). `0` (or negative) ⇒ disabled. */
export function dailyBudgetEnabled(ceilingEur: number): boolean {
  return ceilingEur > 0;
}

/**
 * EUR still spendable today under the ceiling, never negative. `Infinity` when
 * the guard is disabled (`ceiling <= 0`) so callers can compare uniformly. Rounded
 * to cents so it composes with the cent-rounded `spentToday` from the ledger.
 */
export function remainingDailyBudget(ceilingEur: number, spentTodayEur: number): number {
  if (!dailyBudgetEnabled(ceilingEur)) return Infinity;
  return Math.max(0, roundEur(ceilingEur - spentTodayEur));
}

/**
 * True when today's spend has reached/exceeded the ceiling — the batch must stop
 * before starting another run. Disabled guard never trips.
 */
export function dailyBudgetExhausted(ceilingEur: number, spentTodayEur: number): boolean {
  return remainingDailyBudget(ceilingEur, spentTodayEur) <= 0;
}

/**
 * The effective per-run €-cap: the smaller of the run's own cap and the budget
 * left for today, so a single run is bounded to the day's remaining headroom. As
 * with the per-run cap itself, the bound is checked BEFORE each extraction whose
 * cost is only known AFTER it returns, so the daily ceiling can still be exceeded
 * by at most one extraction's cost — it's a tight soft ceiling, not a hard stop.
 * When the guard is disabled the per-run cap stands unchanged.
 */
export function effectiveRunCostCap(
  perRunCapEur: number,
  ceilingEur: number,
  spentTodayEur: number,
): number {
  return Math.min(perRunCapEur, remainingDailyBudget(ceilingEur, spentTodayEur));
}

/**
 * UTC midnight (start of day) for an instant — the lower bound the budget guard
 * passes to `spentSince` to total today's run cost. Pure: derived only from the
 * given `now`, no ambient clock.
 */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

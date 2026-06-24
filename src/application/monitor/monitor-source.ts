import { createHash, randomUUID } from 'node:crypto';
import {
  DealStatus,
  ManualCaptureReason,
  sourceReliabilityLowAlert,
  type Source,
  type Change,
  type ChangeKind,
} from '../../domain/index.js';
import type { Fetcher, Database, Clock, Logger, Alerting, FetchResult } from '../ports/index.js';
import { CrawlSourceUseCase } from '../crawl/crawl-source.js';
import { nextDueWithBackoffIso, applyCrawlOutcome } from '../crawl/source-policy.js';

export interface MonitorSourceInput {
  sourceId: string;
}

/**
 * The reliability disposition of a monitor pass (plan §7):
 *  - `success`  — the source responded (unchanged / content_changed): raise reliability.
 *  - `failure`  — unreachable / infra error: lower reliability + back off + flag.
 *  - `neutral`  — a blocked wall (manual-capture route, NOT a failure — §9) or a
 *                 robots-disallowed decline: no reliability change, but still reschedule.
 */
type MonitorDisposition = 'success' | 'failure' | 'neutral';

export interface MonitorSourceResult {
  change: Change;
  reQueued: boolean;
  routedToManualCapture: boolean;
  expired: number;
}

/** Rows scanned for the prior hash / expiry sweep. Named to avoid a magic number. */
const SCAN_LIMIT = 1000;

/**
 * Consecutive `disappeared` (unreachable) observations required before we
 * auto-expire a source's published deals. A single transient error must NEVER
 * retract a verified deal, so we debounce: expiry only fires once the page has
 * been unreachable on this many monitor passes in a row.
 */
const CONSECUTIVE_DISAPPEARANCES_TO_EXPIRE = 2;

/**
 * Re-verify a source on its cadence (or on demand): fetch, diff the price/terms
 * region against the last evidence hash, and act on the result:
 *  - content changed → record a change, then re-crawl (CrawlSource), which
 *    captures a FRESH evidence bundle (old bundles are write-once and kept). The
 *    re-crawl surfaces a new candidate for re-review when the deal materially
 *    changed (CrawlSource decides candidate-vs-existing on content, not just key).
 *  - login/captcha/anti-bot → route to the manual-capture queue and record a
 *    `blocked` change. A block is NOT proof the offer is gone, so published deals
 *    are left intact (trust: never silently retract a verified deal).
 *  - unreachable (`error`) → record a `disappeared` change. Auto-expire the
 *    source's published deals ONLY after N consecutive disappearances, so a
 *    single transient failure never expires verified data.
 *  - unchanged → record it.
 *
 * Resilient: the whole body is wrapped so one bad source is logged and contained
 * (returns a result), never throwing past here to crash a `monitor --due` batch.
 */
export class MonitorSourceUseCase {
  constructor(
    private readonly fetcher: Fetcher,
    private readonly db: Database,
    private readonly crawlSource: CrawlSourceUseCase,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly fetchUserAgent: string,
    private readonly fetchTimeoutMs: number,
    private readonly alerting: Alerting,
  ) {}

  async execute(input: MonitorSourceInput): Promise<MonitorSourceResult> {
    const source = await this.requireSource(input.sourceId);
    // Reliability disposition for THIS pass (plan §7: repeated failures lower
    // reliability + flag; reliability decides cadence). Set by each branch:
    //  - 'success'  → the source responded (unchanged / content_changed): raise it.
    //  - 'failure'  → unreachable / infra error: lower it + back off + flag.
    //  - 'neutral'  → blocked wall (manual-capture route, NOT a failure — plan §9)
    //                 or robots-disallowed (a deliberate decline): no reliability
    //                 change, but still advance the schedule off the back-off curve.
    // The content_changed branch re-crawls via CrawlSource, which OWNS the source
    // reliability/next_due update — so we must NOT also advance here (would clobber
    // the back-off next_due the re-crawl just wrote). `scheduledByRecrawl` guards it.
    let disposition: MonitorDisposition = 'neutral';
    let scheduledByRecrawl = false;
    // The post-redirect URL from a SUCCESSFUL fetch — pinned onto the source as
    // resolved_url so future passes match deals by the URL they're keyed by
    // (Prereq A). Left undefined on a failed/blocked/robots pass (no trustworthy
    // final URL), so the prior resolved_url stands.
    let resolvedUrl: string | undefined;
    try {
      const fetched = await this.fetcher.fetch(source.url, {
        timeoutMs: this.fetchTimeoutMs,
        userAgent: this.fetchUserAgent,
      });

      if (fetched.outcome === 'robots_disallowed') {
        // robots.txt now disallows this path — neither a disappearance nor a block.
        // Record `unchanged` (no diff possible) and leave published deals intact.
        // Neutral: a deliberate decline isn't a reliability failure.
        this.logger.info('monitor: skipped by robots.txt (not expiring)', { sourceId: source.id });
        const change = this.recordChange(source, 'unchanged', null, null);
        await this.db.changes.insert(change);
        return { change, reQueued: false, routedToManualCapture: false, expired: 0 };
      }
      if (isBlockedOutcome(fetched)) {
        // A block stays NEUTRAL (manual-capture route, not a fetch failure — §9).
        return await this.handleBlocked(source, fetched);
      }
      if (fetched.outcome !== 'ok') {
        disposition = 'failure';
        return await this.handleUnreachable(source);
      }

      const result = await this.handleOk(source, fetched);
      // content_changed re-crawled (which set reliability + next_due); unchanged did
      // not. Either way the source responded → success disposition.
      disposition = 'success';
      // Record the post-redirect URL so the schedule advance pins it as resolved_url.
      // (If the re-crawl owned the schedule update, IT already pinned resolved_url via
      // its own success path — see crawl-source — so advanceSchedule is skipped below.)
      resolvedUrl = fetched.finalUrl;
      scheduledByRecrawl = result.reQueued;
      return result;
    } catch (err) {
      // Contain any repository/re-crawl failure so one bad source never crashes a
      // `monitor --due` batch. Record an `error` change — NOT `disappeared` — so an
      // infrastructure blip can never count toward auto-expiry of verified deals.
      // This IS a fetch/infra failure → lower reliability.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error('monitor failed', { sourceId: source.id, error: message });
      disposition = 'failure';
      const change = this.recordChange(source, 'error', null, null);
      await this.safeInsert(change);
      return { change, reQueued: false, routedToManualCapture: false, expired: 0 };
    } finally {
      // Advance reliability + cadence on every pass EXCEPT when a re-crawl already
      // owned the update (else we'd clobber its back-off next_due with a stale one).
      if (!scheduledByRecrawl) await this.advanceSchedule(source, disposition, resolvedUrl);
    }
  }

  /**
   * Apply the pass's reliability disposition + reschedule off the back-off curve
   * (plan §7), via the SAME shared policy the crawl lane uses so the two can't
   * diverge. Best-effort — a schedule-write failure is logged, never thrown (it must
   * not crash a `monitor --due` batch).
   *
   *  - success/failure → `applyCrawlOutcome` raises/lowers reliability + backs off
   *    cadence; a sub-threshold source logs the human-attention warning.
   *  - neutral (blocked / robots) → no reliability change, but still advance
   *    `next_due` off the back-off curve at the CURRENT reliability so the source
   *    isn't perpetually due, without rewarding or penalising the pass.
   */
  private async advanceSchedule(
    source: Source,
    disposition: MonitorDisposition,
    resolvedUrl?: string,
  ): Promise<void> {
    try {
      let updated: Source;
      if (disposition === 'neutral') {
        // `last_seen` is deliberately left untouched — a wall/decline is not a
        // sighting of the offer. Selection is by `next_due`, so this is safe.
        // resolved_url is also untouched (a wall/decline saw no final URL).
        updated = {
          ...source,
          next_due: nextDueWithBackoffIso(
            this.clock.now(),
            source.cadence_days,
            source.reliability_score,
          ),
        };
      } else {
        const outcome = applyCrawlOutcome(
          source,
          disposition === 'success',
          this.clock.now(),
          resolvedUrl,
        );
        updated = outcome.source;
        if (outcome.reliabilityLow) {
          this.logger.warn('monitor: source reliability low — backing off cadence', {
            sourceId: source.id,
            url: source.url,
            reliability: updated.reliability_score,
            nextDue: updated.next_due,
          });
          // Proactive alert (Step 5) — best-effort, never throws (the port contract),
          // so it can't crash a `monitor --due` batch even if delivery fails.
          await this.alerting.alert(
            sourceReliabilityLowAlert({
              sourceId: source.id,
              url: source.url,
              reliability: updated.reliability_score,
              nextDue: updated.next_due,
              at: this.clock.nowIso(),
            }),
          );
        }
      }
      await this.db.sources.update(updated);
    } catch (err) {
      this.logger.error('monitor: failed to advance source schedule', {
        sourceId: source.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleOk(source: Source, fetched: FetchResult): Promise<MonitorSourceResult> {
    const currentHash = sha256(fetched.text);
    const previousHash = await this.lastHashForSource(source);

    if (previousHash !== null && previousHash === currentHash) {
      const change = this.recordChange(source, 'unchanged', previousHash, currentHash);
      await this.db.changes.insert(change);
      return { change, reQueued: false, routedToManualCapture: false, expired: 0 };
    }

    // Changed (or first observation): re-extract + re-queue, keeping old evidence.
    const change = this.recordChange(source, 'content_changed', previousHash, currentHash);
    await this.db.changes.insert(change);
    this.logger.info('content changed — re-extracting and re-queueing', { sourceId: source.id });
    await this.crawlSource.execute({ sourceId: source.id });
    return { change, reQueued: true, routedToManualCapture: false, expired: 0 };
  }

  /** A login/captcha/anti-bot wall: never expire — route to manual capture. */
  private async handleBlocked(source: Source, fetched: FetchResult): Promise<MonitorSourceResult> {
    const change = this.recordChange(source, 'blocked', null, null);
    await this.db.changes.insert(change);
    this.logger.warn('source blocked on monitor — routing to manual capture (not expiring)', {
      sourceId: source.id,
      outcome: fetched.outcome,
    });
    await this.db.manualCapture.insert({
      id: randomUUID(),
      source_id: source.id,
      source_url: source.url,
      reason: manualCaptureReason(fetched),
      created_at: this.clock.nowIso(),
      status: 'open',
      note: null,
    });
    return { change, reQueued: false, routedToManualCapture: true, expired: 0 };
  }

  /**
   * The page was unreachable (`error`). Record a `disappeared` change, then
   * auto-expire the source's published deals ONLY if this is the N-th consecutive
   * disappearance — a single transient failure must not retract verified data.
   */
  private async handleUnreachable(source: Source): Promise<MonitorSourceResult> {
    const change = this.recordChange(source, 'disappeared', null, null);
    await this.db.changes.insert(change);

    const consecutive = await this.consecutiveDisappearances(source);
    if (consecutive < CONSECUTIVE_DISAPPEARANCES_TO_EXPIRE) {
      this.logger.warn('source unreachable — not expiring yet (debouncing transient failure)', {
        sourceId: source.id,
        consecutive,
        threshold: CONSECUTIVE_DISAPPEARANCES_TO_EXPIRE,
      });
      return { change, reQueued: false, routedToManualCapture: false, expired: 0 };
    }

    this.logger.warn('source unreachable for N consecutive checks — expiring its published deals', {
      sourceId: source.id,
      consecutive,
    });
    const expired = await this.expirePublishedForSource(source);
    return { change, reQueued: false, routedToManualCapture: false, expired };
  }

  private async expirePublishedForSource(source: Source): Promise<number> {
    // Source-scoped, single-statement expiry — deterministic regardless of how
    // many published deals exist globally (no fetch-N-then-filter scaling cliff).
    // Match on the resolved (post-redirect) URL deals are keyed by — see
    // `dealMatchUrl` (Prereq A: a redirecting source's deals must still match).
    return this.db.deals.expirePublishedBySourceUrl(dealMatchUrl(source), this.clock.nowIso());
  }

  /** Count the trailing run of `disappeared` changes (newest first) for a source. */
  private async consecutiveDisappearances(source: Source): Promise<number> {
    const recent = await this.db.changes.recentForSource(
      source.id,
      CONSECUTIVE_DISAPPEARANCES_TO_EXPIRE + 1,
    );
    let count = 0;
    for (const c of recent) {
      if (c.kind !== 'disappeared') break;
      count++;
    }
    return count;
  }

  private async lastHashForSource(source: Source): Promise<string | null> {
    // Source-scoped lookup of the most recent deal across pre-publish + published
    // states, then its evidence hash — the diff baseline. `in_review` is included
    // so a flagged candidate still anchors the baseline (else every check looks
    // like a first sight). Deterministic regardless of total table size.
    const deals = await this.db.deals.listBySourceUrl(
      dealMatchUrl(source),
      [DealStatus.enum.published, DealStatus.enum.candidate, DealStatus.enum.in_review],
      SCAN_LIMIT,
    );
    for (const match of deals) {
      const evidence = await this.db.evidence.getById(match.evidence_id);
      if (evidence) return evidence.content_hash;
    }
    return null;
  }

  private recordChange(
    source: Source,
    kind: ChangeKind,
    previousHash: string | null,
    currentHash: string | null,
  ): Change {
    return {
      id: randomUUID(),
      deal_id: null,
      source_id: source.id,
      kind,
      previous_hash: previousHash,
      current_hash: currentHash,
      detected_at: this.clock.nowIso(),
    };
  }

  /** Best-effort change insert used on the error path so logging never masks a write failure. */
  private async safeInsert(change: Change): Promise<void> {
    try {
      await this.db.changes.insert(change);
    } catch (err) {
      this.logger.error('failed to record monitor change', {
        sourceId: change.source_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async requireSource(sourceId: string): Promise<Source> {
    const source = await this.db.sources.getById(sourceId);
    if (source === null) throw new Error(`Source not found: ${sourceId}`);
    return source;
  }
}

/** Login/captcha/anti-bot — a wall, not a disappearance. */
function isBlockedOutcome(fetched: FetchResult): boolean {
  return (
    fetched.outcome === 'login_required' ||
    fetched.outcome === 'captcha' ||
    fetched.outcome === 'blocked'
  );
}

function manualCaptureReason(fetched: FetchResult): ManualCaptureReason {
  switch (fetched.outcome) {
    case 'login_required':
      return ManualCaptureReason.enum.login_required;
    case 'captcha':
      return ManualCaptureReason.enum.captcha;
    default:
      return ManualCaptureReason.enum.anti_bot_blocked;
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The URL monitor matches a source's deals by. Deals pin `source_url =
 * fetched.finalUrl` (post-redirect), so once a successful crawl/monitor pass has
 * recorded the source's `resolved_url`, match on THAT; fall back to the configured
 * `url` until first seen (or for a source that doesn't redirect). Prereq A: without
 * this, a redirecting source's expiry/diff-baseline lookups never match its own
 * deals (published deals never auto-expire under unattended scheduling).
 */
function dealMatchUrl(source: Source): string {
  return source.resolved_url ?? source.url;
}

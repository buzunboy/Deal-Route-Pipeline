import { createHash } from 'node:crypto';
import {
  DealStatus,
  ManualCaptureReason,
  type Source,
  type Change,
  type ChangeKind,
} from '../../domain/index.js';
import type { Fetcher, Database, Clock, Logger, FetchResult } from '../ports/index.js';
import { CrawlSourceUseCase } from '../crawl/crawl-source.js';
import { newId } from '../shared/id.js';

export interface MonitorSourceInput {
  sourceId: string;
}

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
  ) {}

  async execute(input: MonitorSourceInput): Promise<MonitorSourceResult> {
    const source = await this.requireSource(input.sourceId);
    try {
      const fetched = await this.fetcher.fetch(source.url, {
        timeoutMs: this.fetchTimeoutMs,
        userAgent: this.fetchUserAgent,
      });

      if (isBlockedOutcome(fetched)) return this.handleBlocked(source, fetched);
      if (fetched.outcome !== 'ok') return this.handleUnreachable(source);

      return await this.handleOk(source, fetched);
    } catch (err) {
      // Contain any repository/re-crawl failure: log with context, record a
      // disappeared change so the run is auditable, and return without expiring.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error('monitor failed', { sourceId: source.id, error: message });
      const change = this.recordChange(source, 'disappeared', null, null);
      await this.safeInsert(change);
      return { change, reQueued: false, routedToManualCapture: false, expired: 0 };
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
      id: newId(),
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
    const published = await this.db.deals.listByStatus(DealStatus.enum.published, SCAN_LIMIT);
    let expired = 0;
    for (const deal of published) {
      if (deal.source_url === source.url) {
        await this.db.deals.updateStatus(
          deal.id,
          DealStatus.enum.expired,
          deal.verified_by,
          this.clock.nowIso(),
        );
        expired++;
      }
    }
    return expired;
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
    // Find the most recent deal for this source (across pre-publish + published
    // states) and read its evidence hash. Kept simple in v1; richer per-region
    // diffing can slot in. `in_review` is included so a flagged candidate still
    // anchors the diff baseline (otherwise every check looks like a first sight).
    for (const status of [
      DealStatus.enum.published,
      DealStatus.enum.candidate,
      DealStatus.enum.in_review,
    ]) {
      const deals = await this.db.deals.listByStatus(status, SCAN_LIMIT);
      const match = deals.find((d) => d.source_url === source.url);
      if (match) {
        const evidence = await this.db.evidence.getById(match.evidence_id);
        if (evidence) return evidence.content_hash;
      }
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
      id: newId(),
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

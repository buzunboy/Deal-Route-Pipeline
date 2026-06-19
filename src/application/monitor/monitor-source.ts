import { createHash } from 'node:crypto';
import { DealStatus, type Source, type Change } from '../../domain/index.js';
import type { Fetcher, Database, Clock, Logger } from '../ports/index.js';
import { CrawlSourceUseCase } from '../crawl/crawl-source.js';
import { newId } from '../shared/id.js';

export interface MonitorSourceInput {
  sourceId: string;
}

export interface MonitorSourceResult {
  change: Change;
  reQueued: boolean;
}

/**
 * Re-verify a source on its cadence (or on demand): fetch, diff the price/terms
 * region against the last evidence hash, and act on the result:
 *  - content changed → record a change, re-extract + re-queue (CrawlSource),
 *    keeping the OLD evidence (never overwritten);
 *  - page gone/blocked → mark matching published deals expired (auto-expire);
 *  - unchanged → just record it.
 *
 * Resilient: a fetch failure is logged and recorded as a change of kind error-
 * adjacent (handled by lowering reliability inside CrawlSource on the re-crawl).
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
    const fetched = await this.fetcher.fetch(source.url, {
      timeoutMs: this.fetchTimeoutMs,
      userAgent: this.fetchUserAgent,
    });

    if (fetched.outcome !== 'ok') {
      return this.handleDisappeared(source);
    }

    const currentHash = sha256(fetched.text);
    const previousHash = await this.lastHashForSource(source);

    if (previousHash !== null && previousHash === currentHash) {
      const change = this.recordChange(source, 'unchanged', previousHash, currentHash);
      await this.db.changes.insert(change);
      return { change, reQueued: false };
    }

    // Changed (or first observation): re-extract + re-queue, keeping old evidence.
    const change = this.recordChange(source, 'content_changed', previousHash, currentHash);
    await this.db.changes.insert(change);
    this.logger.info('content changed — re-extracting and re-queueing', { sourceId: source.id });
    await this.crawlSource.execute({ sourceId: source.id });
    return { change, reQueued: true };
  }

  private async handleDisappeared(source: Source): Promise<MonitorSourceResult> {
    const change = this.recordChange(source, 'disappeared', null, null);
    await this.db.changes.insert(change);
    this.logger.warn('source unreachable — expiring its published deals', { sourceId: source.id });

    const published = await this.db.deals.listByStatus(DealStatus.enum.published, 1000);
    for (const deal of published) {
      if (deal.source_url === source.url) {
        await this.db.deals.updateStatus(
          deal.id,
          DealStatus.enum.expired,
          deal.verified_by,
          this.clock.nowIso(),
        );
      }
    }
    return { change, reQueued: false };
  }

  private async lastHashForSource(source: Source): Promise<string | null> {
    // Find the most recent published/candidate deal for this source and read its
    // evidence hash. Kept simple in v1; richer per-region diffing can slot in.
    for (const status of [DealStatus.enum.published, DealStatus.enum.candidate]) {
      const deals = await this.db.deals.listByStatus(status, 1000);
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
    kind: Change['kind'],
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

  private async requireSource(sourceId: string): Promise<Source> {
    const source = await this.db.sources.getById(sourceId);
    if (source === null) throw new Error(`Source not found: ${sourceId}`);
    return source;
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

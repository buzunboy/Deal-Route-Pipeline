import {
  SourceStatus,
  SourceType,
  SourceTier,
  Country,
  SourceNotFoundError,
  SourceNotReviewableError,
  SourceConflictError,
  MissingApproverError,
  REGISTRY_STATUSES,
  toSourceRegistryEntry,
  InvalidPatchError,
  type Source,
  type SourceReviewRecord,
  type SourceRegistryEntry,
  type SuffixOracle,
} from '../../domain/index.js';
import type { Database, Clock, Logger } from '../ports/index.js';
import { newId } from '../shared/id.js';

/** Inputs to register a new operational source from the admin panel (ACR-10). */
export interface CreateSourceInput {
  approver: string;
  /** The source domain or URL (e.g. `netflix.com` or `https://netflix.com/de`). */
  domain: string;
  /** Source kind (case-insensitive; mapped to the pipeline SourceType). */
  kind: string;
  tier: number;
  /** ISO country; defaults to the active market when omitted (DE v1). */
  country?: string;
  /** Days between re-crawls; defaults to 3 (the seed default). */
  cadenceDays?: number;
}

/** Default re-crawl cadence for a manually-added source (matches the seed default). */
const DEFAULT_CADENCE_DAYS = 3;

/**
 * Human-in-the-loop for the SOURCE-promotion loop (Pre-Phase-C). Discovery and
 * community ingestion surface novel domains as `pending_approval` tier-4 sources;
 * this is the ONLY path by which such a source becomes `active` (crawlable) or
 * `rejected`. Like deal review: a decision requires an approver identity (no
 * anonymous promotion) and is written to an append-only audit log BEFORE the
 * status change (log-before-act), so a mid-call failure can never promote a
 * source with no audit trail.
 */
export class SourceReviewUseCase {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly logger: Logger,
    /**
     * The PSL oracle (Step 6) — pins a manually-registered source's registrable
     * domain so the reliability join + dedupe read a frozen value, exactly as
     * seed-import / discovery do. The default country for a registered source comes
     * from the composition root's configured market (DE v1).
     */
    private readonly suffixOracle: SuffixOracle = (url) => {
      try {
        return new URL(url).hostname || null;
      } catch {
        return null;
      }
    },
    private readonly defaultCountry: string = 'DE',
  ) {}

  /** Sources awaiting human approval (the discovery/ingest proposal queue). */
  async listPending(): Promise<Source[]> {
    return this.db.sources.listByStatus(SourceStatus.enum.pending_approval);
  }

  /**
   * The admin "Sources registry" screen (ACR-10): operational sources (active +
   * disabled — NOT the pending-promotion queue), projected to the panel row shape
   * (domain, capitalised kind, tier, cadence, reliability, last_seen, mapped
   * status). Ordered by domain for a stable, readable list.
   */
  async listRegistry(): Promise<SourceRegistryEntry[]> {
    const groups = await Promise.all(REGISTRY_STATUSES.map((s) => this.db.sources.listByStatus(s)));
    return groups
      .flat()
      .map(toSourceRegistryEntry)
      .sort((a, b) => a.domain.localeCompare(b.domain) || a.id.localeCompare(b.id));
  }

  /**
   * Register a new operational source from the admin "+ Add source" flow (ACR-10).
   * Builds an `active` source from the panel fields, pinning `registrable_domain`
   * via the PSL oracle (so the reliability join matches a frozen value), and upserts
   * it (idempotent on URL — re-adding the same domain updates rather than duplicates,
   * matching seed-import). Requires an approver. Boundary-validates kind/tier/country
   * through the domain enums (never trust raw input). `next_due=null` so the next
   * `crawl --due` picks it up. Returns the created source's id.
   */
  async createSource(input: CreateSourceInput): Promise<{ source: Source; created: boolean }> {
    this.assertApprover(input.approver, 'create-source');
    const url = normaliseToUrl(input.domain);
    const type = parseKind(input.kind);
    const tier = SourceTier.safeParse(input.tier);
    if (!tier.success) {
      throw new InvalidPatchError('tier must be 1, 2, 3 or 4', ['tier']);
    }
    const country = Country.safeParse(input.country ?? this.defaultCountry);
    if (!country.success) {
      throw new InvalidPatchError(`country "${input.country}" is not an in-scope market`, [
        'country',
      ]);
    }

    // Governance guard: never let a manual register OVERRIDE a human decision. A URL
    // that's already `rejected` (a reviewer said no) or `pending_approval` (it must go
    // through the promotion loop) → 409; the admin uses approve/reject, not re-create.
    // An existing `active`/`disabled` URL is a benign idempotent update (we keep its id).
    const existing = await this.db.sources.getByUrl(url);
    if (
      existing &&
      (existing.status === SourceStatus.enum.rejected ||
        existing.status === SourceStatus.enum.pending_approval)
    ) {
      throw new SourceConflictError(url, existing.status);
    }

    const at = this.clock.nowIso();
    const source: Source = {
      // Keep an existing row's id (the upsert does too) so the returned id is the
      // real persisted id, not a stale freshly-minted one.
      id: existing?.id ?? newId(),
      url,
      type,
      tier: tier.data,
      country: country.data,
      subscription_service: existing?.subscription_service ?? null,
      cadence_days: input.cadenceDays ?? existing?.cadence_days ?? DEFAULT_CADENCE_DAYS,
      // Preserve a re-added source's earned reliability; a brand-new one starts neutral.
      reliability_score: existing?.reliability_score ?? 0.5,
      status: SourceStatus.enum.active,
      last_seen: existing?.last_seen ?? null,
      next_due: null, // due now → crawled on the next due sweep
      resolved_url: existing?.resolved_url ?? null,
      registrable_domain: this.suffixOracle(url),
      proposal_reason: existing?.proposal_reason ?? null,
    };
    // Audit the registration (log-before-act, like approve/reject) so an
    // admin-registered source is auditable like every other source decision.
    await this.recordReview(source.id, 'approve', input.approver, 'registered via admin panel', at);
    await this.db.sources.upsert(source);
    this.logger.info('source registered → active', {
      url,
      type,
      tier: tier.data,
      approver: input.approver,
      created: existing === null,
    });
    return { source, created: existing === null };
  }

  /**
   * Promote a proposed source → `active`. Keeps its discovered tier + cadence and
   * sets `next_due=null` so the next `crawl --due` picks it up promptly.
   */
  async approveSource(sourceId: string, approver: string): Promise<Source> {
    this.assertApprover(approver, 'approve-source');
    const source = await this.requirePending(sourceId);

    const at = this.clock.nowIso();
    await this.recordReview(sourceId, 'approve', approver, null, at);
    const updated: Source = {
      ...source,
      status: SourceStatus.enum.active,
      next_due: null, // due now → crawled on the next due sweep
    };
    await this.db.sources.update(updated);
    this.logger.info('source approved → active', { sourceId, url: source.url, approver });
    return updated;
  }

  /**
   * Reject a proposed source → `rejected`. A rejected domain is never crawled and
   * never re-proposed (the discovery/ingest dedup skips `rejected`).
   */
  async rejectSource(sourceId: string, approver: string, reason?: string): Promise<Source> {
    this.assertApprover(approver, 'reject-source');
    const source = await this.requirePending(sourceId);

    const at = this.clock.nowIso();
    const trimmedReason = reason && reason.trim() !== '' ? reason.trim() : null;
    await this.recordReview(sourceId, 'reject', approver, trimmedReason, at);
    const updated: Source = { ...source, status: SourceStatus.enum.rejected };
    await this.db.sources.update(updated);
    this.logger.info('source rejected', {
      sourceId,
      url: source.url,
      approver,
      reason: trimmedReason,
    });
    return updated;
  }

  /** The append-only decision history for one source (newest first). */
  async listReviews(sourceId: string, limit = 50): Promise<SourceReviewRecord[]> {
    return this.db.sourceReviews.listForSource(sourceId, limit);
  }

  private async recordReview(
    sourceId: string,
    action: SourceReviewRecord['action'],
    approver: string,
    reason: string | null,
    at: string,
  ): Promise<void> {
    await this.db.sourceReviews.insert({
      id: newId(),
      source_id: sourceId,
      action,
      approver,
      reason,
      decided_at: at,
    });
  }

  private assertApprover(approver: string, action: string): void {
    if (approver.trim() === '') throw new MissingApproverError(action);
  }

  /** Only a `pending_approval` source can be promoted/rejected. */
  private async requirePending(sourceId: string): Promise<Source> {
    const source = await this.db.sources.getById(sourceId);
    if (source === null) throw new SourceNotFoundError(sourceId);
    if (source.status !== SourceStatus.enum.pending_approval) {
      throw new SourceNotReviewableError(sourceId, source.status);
    }
    return source;
  }
}

/**
 * Normalise a panel-supplied domain or URL into a valid http(s) URL string. A bare
 * domain (`netflix.com`) gets `https://`; an already-qualified URL is validated as-is.
 * Throws {@link InvalidPatchError} (→ 400) on a non-URL value — never trust raw input.
 */
function normaliseToUrl(domain: string): string {
  const trimmed = domain.trim();
  if (trimmed === '') throw new InvalidPatchError('domain is required', ['domain']);
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(candidate).toString();
  } catch {
    throw new InvalidPatchError(`domain "${domain}" is not a valid URL`, ['domain']);
  }
}

/**
 * Map a panel-supplied kind (case-insensitive: `Provider`, `bundler`, …) to a
 * pipeline {@link SourceType}. The panel additionally models `Fintech`/`Bank`, which
 * have no pipeline type — those (or any unknown kind) → 400, never silently coerced.
 */
function parseKind(kind: string): SourceType {
  const parsed = SourceType.safeParse(kind.trim().toLowerCase());
  if (!parsed.success) {
    throw new InvalidPatchError(
      `kind "${kind}" is not a supported source type (provider|bundler|community|discovered|aggregator)`,
      ['kind'],
    );
  }
  return parsed.data;
}

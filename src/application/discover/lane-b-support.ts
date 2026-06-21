import { createHash } from 'node:crypto';
import {
  ManualCaptureReason,
  type Evidence,
  type Source,
  type SuffixOracle,
} from '../../domain/index.js';
import type { Database, Clock, Logger, EvidenceStore, FetchResult } from '../ports/index.js';
import { newId } from '../shared/id.js';

/** Days between re-crawls assigned to a discovered (tier-4) source once approved. */
const DISCOVERED_SOURCE_CADENCE_DAYS = 3;

/** A novel domain surfaced during a Lane-B run, awaiting human approval. */
export interface ProposedDomain {
  url: string;
  rationale: string;
}

/**
 * Shared Lane-B (discovery + community ingestion) collaborator. Both lanes fetch
 * arbitrary public pages, capture evidence, route blocked pages to manual capture,
 * and surface NOVEL domains as `pending_approval` sources for human approval —
 * trust-critical edge logic that must live in ONE place so the two lanes can't
 * drift apart on a guardrail (e.g. proposing an already-known domain).
 */
export class LaneBSupport {
  constructor(
    private readonly evidenceStore: EvidenceStore,
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly suffixOracle: SuffixOracle,
  ) {}

  /** Capture + persist an evidence bundle for a fetched page (caller must be non-dry-run). */
  async captureEvidence(fetched: FetchResult): Promise<Evidence> {
    const evidence = await this.evidenceStore.save({
      sourceUrl: fetched.finalUrl,
      screenshot: fetched.screenshot,
      html: fetched.html,
      termsText: fetched.text,
      capturedAt: this.clock.nowIso(),
      contentHash: sha256(fetched.text),
    });
    await this.db.evidence.insert(evidence);
    return evidence;
  }

  /**
   * True for a wall we still divert to manual capture. Best-effort-read (2026-06-21):
   * only `captcha` qualifies — its body is a challenge, with no offer content to read.
   * Login walls / soft blocks now arrive `ok` (with `fetchSignal`) and are extracted
   * best-effort, so they are NOT blocked outcomes. `login_required`/`blocked` stay in
   * the predicate defensively, in case a fetcher ever surfaces them directly.
   */
  isBlockedOutcome(fetched: FetchResult): boolean {
    return (
      fetched.outcome === 'captcha' ||
      fetched.outcome === 'login_required' ||
      fetched.outcome === 'blocked'
    );
  }

  /** Queue a manual-capture task for a blocked page (discovery/ingest have no source row). */
  async routeToManualCapture(url: string, fetched: FetchResult, dryRun: boolean): Promise<void> {
    const reason =
      fetched.outcome === 'login_required'
        ? ManualCaptureReason.enum.login_required
        : fetched.outcome === 'captcha'
          ? ManualCaptureReason.enum.captcha
          : ManualCaptureReason.enum.anti_bot_blocked;
    this.logger.info('lane-b: routing blocked page to manual capture', { url, reason });
    if (dryRun) return;
    await this.db.manualCapture.insert({
      id: newId(),
      source_id: null,
      source_url: url,
      reason,
      created_at: this.clock.nowIso(),
      status: 'open',
      note: null,
    });
  }

  /** The registrable domains already in the registry (any status) — never re-propose these. */
  async knownDomains(): Promise<Set<string>> {
    const known = new Set<string>();
    // Includes `rejected` so a domain a human declined is never re-proposed.
    for (const status of ['active', 'pending_approval', 'disabled', 'rejected'] as const) {
      for (const s of await this.db.sources.listByStatus(status)) {
        const d = this.suffixOracle(s.url);
        if (d !== null) known.add(d);
      }
    }
    return known;
  }

  /**
   * Persist novel domains as `pending_approval`, tier-4 `discovered` sources for
   * human approval. Deduped by registrable domain against the existing registry so
   * an already-known domain (active provider, pending, or disabled) is never
   * re-proposed.
   */
  async persistProposedSources(proposals: ProposedDomain[]): Promise<void> {
    if (proposals.length === 0) return;
    const known = await this.knownDomains();
    for (const p of proposals) {
      const domain = this.suffixOracle(p.url);
      if (domain === null || known.has(domain)) continue;
      known.add(domain);
      const source: Source = {
        id: newId(),
        url: p.url,
        type: 'discovered',
        tier: 4,
        country: 'DE',
        subscription_service: null,
        cadence_days: DISCOVERED_SOURCE_CADENCE_DAYS,
        reliability_score: 0.5,
        status: 'pending_approval',
        last_seen: null,
        next_due: null,
        resolved_url: null, // set on the first successful crawl after approval
        // Pin the registrable domain now (we already resolved it for the dedupe
        // check above) so the reliability join works the moment it's crawled.
        registrable_domain: domain,
      };
      await this.db.sources.upsert(source);
      this.logger.info('lane-b: proposed novel source (pending approval)', { url: p.url });
    }
  }
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

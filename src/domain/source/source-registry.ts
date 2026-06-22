import type { Source, SourceType, SourceStatus } from './source.js';

/**
 * The admin "Sources registry" screen projection (ACR-10) — the operational source
 * list (distinct from the pending-promotion queue `GET /api/sources/pending`). A
 * curated, Bearer-gated row of the columns the panel renders.
 *
 * Two contract translations the panel's permissive adapter expects:
 *  - `kind`: the panel labels pipeline {@link SourceType} values capitalised
 *    (`provider`→`Provider`, …). The panel additionally models `Fintech`/`Bank`,
 *    which have no pipeline `SourceType` today, so they never appear (honest — we
 *    don't fabricate a kind the pipeline can't store).
 *  - `status`: the panel uses `active | degraded | disabled`. Pipeline `active` with
 *    a reliability below {@link DEGRADED_RELIABILITY_MAX} maps to `degraded` (a
 *    flaky-but-enabled source); `disabled` stays `disabled`. `pending_approval` /
 *    `rejected` sources are NOT in the registry (they live in the promotion queue),
 *    so they're filtered out before projection.
 */

/**
 * An `active` source at/below this reliability is shown as `degraded` (still
 * crawled, but flaky). A domain constant so the projection is deterministic.
 */
export const DEGRADED_RELIABILITY_MAX = 0.3;

/** The pipeline statuses the registry surfaces (operational sources, not the queue). */
export const REGISTRY_STATUSES: readonly SourceStatus[] = ['active', 'disabled'];

/** Panel-facing operational status for a registry row. */
export type RegistryStatus = 'active' | 'degraded' | 'disabled';

/** One row on the admin "Sources registry" screen. */
export interface SourceRegistryEntry {
  id: string;
  /** The registrable domain (eTLD+1) if pinned, else the raw URL. */
  domain: string;
  /** Capitalised source type (Provider/Bundler/Community/Discovered/Aggregator). */
  kind: string;
  tier: number;
  /** Days between re-crawls. */
  cadence: number;
  /** 0–1 reliability score. */
  reliability: number;
  /** ISO-8601 last successful crawl, or null. */
  last_seen_at: string | null;
  status: RegistryStatus;
}

/** Capitalise a pipeline source type for the panel (`provider` → `Provider`). */
export function kindLabel(type: SourceType): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/** Map a source's pipeline status + reliability to the panel registry status. */
export function toRegistryStatus(source: Source): RegistryStatus {
  if (source.status === 'disabled') return 'disabled';
  // active (the only other status reaching here per REGISTRY_STATUSES)
  return source.reliability_score <= DEGRADED_RELIABILITY_MAX ? 'degraded' : 'active';
}

/** Project a source into a registry row (pure). */
export function toSourceRegistryEntry(source: Source): SourceRegistryEntry {
  return {
    id: source.id,
    domain: source.registrable_domain ?? source.url,
    kind: kindLabel(source.type),
    tier: source.tier,
    cadence: source.cadence_days,
    reliability: source.reliability_score,
    last_seen_at: source.last_seen,
    status: toRegistryStatus(source),
  };
}

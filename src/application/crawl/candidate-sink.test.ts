import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { CandidateSink } from './candidate-sink.js';
import { dedupeKey, CURRENT_SCHEMA_VERSION, type Evidence } from '../../domain/index.js';
import type { ExtractedCandidate } from '../extract/extract.js';
import { InMemoryDb } from '../../../test/fakes/in-memory-db.js';
import { FixedClock, FakeLogger } from '../../../test/fakes/fakes.js';
import { makeLlmDeal } from '../../../test/factories/deal.js';

/**
 * Build an evidence bundle for a given source URL + content hash. CandidateSink
 * pins each persisted deal's source_url to evidence.source_url, so the source
 * origin baked into the dedupe key comes from here.
 */
function evidenceFor(sourceUrl: string, contentHash: string): Evidence {
  return {
    id: randomUUID(),
    source_url: sourceUrl,
    screenshot_ref: 's',
    html_ref: 'h',
    terms_ref: 't',
    captured_at: '2026-06-19T00:00:00.000Z',
    content_hash: contentHash,
  };
}

/**
 * Build an ExtractedCandidate the way ExtractUseCase would: the dedupeKey is
 * computed from the TRUSTED fetched source URL (the same URL the evidence bundle
 * carries and that CandidateSink will pin onto the persisted deal). This keeps the
 * extract-time key identical to the recompute-from-row key.
 */
function candidateForSource(sourceUrl: string): ExtractedCandidate {
  const deal = makeLlmDeal();
  return {
    deal,
    trueCostMonthly: 10,
    dedupeKey: dedupeKey(deal, sourceUrl),
    schemaVersion: CURRENT_SCHEMA_VERSION,
    adjustedConfidence: deal.confidence,
    mustReview: false,
    failures: [],
    fieldProposals: [],
  };
}

describe('CandidateSink — split-by-source dedupe', () => {
  let db: InMemoryDb;
  let sink: CandidateSink;

  beforeEach(() => {
    db = new InMemoryDb();
    sink = new CandidateSink(db, new FixedClock(), new FakeLogger());
  });

  it('persists TWO records for the same route reported by two DIFFERENT sources', async () => {
    const telekom = 'https://www.telekom.de/magenta-tv';
    const mydealz = 'https://www.mydealz.de/deals/disney-magentatv-123';

    // SAME content hash on both → if split-by-source were NOT in effect (keys
    // equal), the second persist would collapse to one row via the "already queued
    // for this capture" idempotency path. So two rows can ONLY result from the
    // split — this isolates the behavior under test (the distinct dedupe keys).
    const evA = evidenceFor(telekom, 'SAME_HASH');
    const evB = evidenceFor(mydealz, 'SAME_HASH');
    await db.evidence.insert(evA);
    await db.evidence.insert(evB);

    await sink.persist([candidateForSource(telekom)], evA);
    await sink.persist([candidateForSource(mydealz)], evB);

    const all = await db.deals.listByStatus('candidate', 10);
    expect(all).toHaveLength(2);
    // Each record keeps its own source provenance (split-by-source).
    expect(all.map((d) => d.source_url).sort()).toEqual([mydealz, telekom].sort());
    // And they carry DISTINCT dedupe keys (the actual split mechanism).
    expect(dedupeKey(all[0]!, all[0]!.source_url)).not.toBe(dedupeKey(all[1]!, all[1]!.source_url));
  });

  it('keeps ONE record when the SAME source re-crawls the SAME content (idempotency)', async () => {
    const telekom = 'https://www.telekom.de/magenta-tv';
    const ev = evidenceFor(telekom, 'HASH_A');
    await db.evidence.insert(ev);

    await sink.persist([candidateForSource(telekom)], ev);
    await sink.persist([candidateForSource(telekom)], ev); // identical re-crawl

    const all = await db.deals.listByStatus('candidate', 10);
    expect(all).toHaveLength(1);
  });

  it('collapses host/path variants of the SAME source to one record', async () => {
    // Bare host + different path on the same registrable domain is the SAME source.
    const evA = evidenceFor('https://www.telekom.de/magenta-tv', 'HASH_A');
    const evB = evidenceFor('https://telekom.de/angebote/disney-plus', 'HASH_A');
    await db.evidence.insert(evA);
    await db.evidence.insert(evB);

    await sink.persist([candidateForSource(evA.source_url)], evA);
    await sink.persist([candidateForSource(evB.source_url)], evB);

    const all = await db.deals.listByStatus('candidate', 10);
    expect(all).toHaveLength(1);
  });
});

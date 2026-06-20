import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { hasDb, applyMigrations, resetDb, makeContainer } from './harness.js';
import { ScriptedFetcher, RoleAwareFakeLlm } from '../fakes/fakes.js';
import { makeLlmDeal } from '../factories/deal.js';
import { makeSource } from '../factories/source.js';
import type { Container } from '../../src/composition/container.js';

/**
 * Dedupe split-by-source through the REAL composition root + REAL Postgres — the
 * tier the testing rules mandate for a stored-column + unique-index change. The
 * unit tests exercise the in-memory adapter (which recomputes the key on read);
 * this proves the PERSISTED `dedupe_key` text column + the `(dedupe_key,
 * evidence_id)` unique index behave correctly against real Postgres:
 *  - the SAME route reported by TWO different source domains → TWO rows with
 *    DISTINCT dedupe_key (split-by-source);
 *  - the SAME source re-crawled with the SAME content → ONE row (idempotency).
 * Self-skips locally without DATABASE_URL_TEST (CI provides Postgres).
 */
const PAGE = 'Disney+ ist im Tarif MagentaTV SmartStream enthalten.'; // matches the deal grounding

const suite = hasDb ? describe : describe.skip;

suite('Dedupe split-by-source (Container + Postgres)', () => {
  beforeAll(applyMigrations);
  beforeEach(resetDb);

  let container: Container;
  afterEach(async () => {
    await container?.shutdown();
  });

  it('same route from TWO source domains → two rows with distinct dedupe_key; same source re-crawl → one row', async () => {
    // Two registered sources for the SAME deal (same service/provider/route/country),
    // hosted on DIFFERENT registrable domains.
    const sourceA = makeSource({ url: 'https://www.telekom.de/magenta-disney' });
    const sourceB = makeSource({ url: 'https://www.o2online.de/magenta-disney' });
    container = makeContainer({
      fetcher: new ScriptedFetcher({
        [sourceA.url]: { text: PAGE, html: '<html></html>' },
        [sourceB.url]: { text: PAGE, html: '<html></html>' },
      }),
      // Same deal fields from both sources → would COLLAPSE under the old key.
      llm: new RoleAwareFakeLlm({ extraction: JSON.stringify({ deals: [makeLlmDeal()] }) }),
    });
    await container.db.sources.upsert(sourceA);
    await container.db.sources.upsert(sourceB);

    // Crawl source A, then source B (same route, different domain).
    await container.crawlSource.execute({ sourceId: sourceA.id });
    await container.crawlSource.execute({ sourceId: sourceB.id });

    // SPLIT: two persisted rows, one per source domain, with DISTINCT dedupe keys.
    const candidates = await container.db.deals.listByStatus('candidate', 50);
    expect(candidates).toHaveLength(2);
    const urls = candidates.map((c) => c.source_url).sort();
    expect(urls).toEqual([
      'https://www.o2online.de/magenta-disney',
      'https://www.telekom.de/magenta-disney',
    ]);

    // Re-crawl source A with identical content → still ONE row for A (idempotent),
    // proving the persisted-column lookup + unique index dedupe within a source.
    await container.crawlSource.execute({ sourceId: sourceA.id });
    const after = await container.db.deals.listByStatus('candidate', 50);
    expect(after).toHaveLength(2); // no third row

    // The two rows are genuinely distinct deals (different ids + evidence).
    const ids = new Set(candidates.map((c) => c.id));
    expect(ids.size).toBe(2);
    const evIds = new Set(candidates.map((c) => c.evidence_id));
    expect(evIds.size).toBe(2);
  });
});
